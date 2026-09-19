import { gitText, type RepositoryGit } from "@git-workbench/git"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

// Hooks see the actual proposed commit in an isolated checkout and index. Their
// configured commands and filters still come from the destination repository.
export async function compositionCommit(repo: RepositoryGit, parent: string, tree: string, source?: string, message = "", cancelled = () => false) {
    const root = resolve(tmpdir()), scratch = await mkdtemp(join(root, "workbench-composition-hook-"))
    let retain = false
    try {
        await repo.command(scratch, ["init", "-q", `--object-format=${repo.descriptor.objectFormat}`])
        const config = (await repo.command(repo.descriptor.mainWorktree, ["config", "--null", "--list", "--includes"])).toString().split("\0").filter(Boolean)
            .map(record => {
                const index = record.indexOf("\n")
                return [record.slice(0, index), record.slice(index + 1)]
            })
            .filter(([key]) => !["core.worktree", "core.bare"].includes(key))
        const hooks = await gitText(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
        config.push(["core.hooksPath", hooks], ["core.bare", "false"])
        const env: Record<string, string> = {
            GIT_DIR: join(scratch, ".git"),
            GIT_WORK_TREE: scratch,
            GIT_INDEX_FILE: join(scratch, ".git", "index"),
            GIT_OBJECT_DIRECTORY: join(repo.descriptor.commonDirectory, "objects"),
            GIT_EDITOR: ":",
            GIT_CONFIG_COUNT: String(config.length),
        }
        config.forEach(([key, value], i) => {
            env[`GIT_CONFIG_KEY_${i}`] = key
            env[`GIT_CONFIG_VALUE_${i}`] = value
        })
        if (source) {
            const raw = (await repo.command(repo.descriptor.mainWorktree, ["cat-file", "commit", source])).toString()
            const split = raw.indexOf("\n\n"), author = /^author (.*) <([^>]*)> (.+)$/m.exec(raw.slice(0, split))!
            env.GIT_AUTHOR_NAME = author[1]
            env.GIT_AUTHOR_EMAIL = author[2]
            env.GIT_AUTHOR_DATE = author[3]
            message = raw.slice(split + 2)
        }
        const run = (args: string[], input?: string) => repo.command(scratch, args, input, env)
        await run(["update-ref", "HEAD", parent])
        await run(["read-tree", "--reset", "-u", tree])
        const original = (await run(["diff", "--binary", "--no-ext-diff", "--no-textconv"])).toString()
        const messagePath = join(scratch, ".git", "COMMIT_EDITMSG")
        await writeFile(messagePath, source ? message : message + "\n")
        for (const args of [["pre-commit"], ["prepare-commit-msg", "--", messagePath, "message"], ["commit-msg", "--", messagePath]]) {
            if (cancelled())
                throw new Error("Transfer cancelled while preparing commits.")
            await run(["hook", "run", "--ignore-missing", ...args])
        }
        const proposed = (await run(["write-tree"])).toString().trim()
        const changed = (await run(["diff", "--binary", "--no-ext-diff", "--no-textconv"])).toString()
        if (proposed != tree || changed != original || (await run(["ls-files", "--others", "--exclude-standard"])).length) {
            const names = (await run(["diff", "--name-only", tree])).toString().trim()
            throw new Error(`Commit hooks changed content (${names || "index or working files"}). Review the saved hook checkout, then retry composition.`)
        }
        const cleanup = (await repo.run(repo.descriptor.mainWorktree, ["config", "--get", "commit.cleanup"])).stdout.toString().trim()
        const rawMessage = await readFile(messagePath, "utf8")
        const prepared = source || cleanup == "verbatim"
            ? rawMessage
            : (await run(["stripspace", ...(cleanup == "strip" ? ["--strip-comments"] : [])], rawMessage)).toString()
        if (!source && !prepared.trim())
            throw new Error("A commit message is required.")
        const signing = (await repo.run(repo.descriptor.mainWorktree, ["config", "--bool", "--get", "commit.gpgsign"])).stdout.toString().trim() == "true"
        const commit = (await run(["commit-tree", tree, "-p", parent, ...(signing ? ["-S"] : [])], prepared)).toString().trim()
        return commit
    } catch (error) {
        retain = true
        throw new Error(`${error instanceof Error ? error.message : String(error)} Saved checkout: ${scratch}`)
    } finally {
        if (!resolve(scratch).startsWith(root + sep))
            throw new Error("Invalid hook checkout path")
        if (!retain)
            await rm(scratch, { recursive: true, force: true })
    }
}
