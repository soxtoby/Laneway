import { gitText, type RepositoryGit } from "@laneway/git"
import { constants } from "node:fs"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

/** Repository facts every composed commit needs, read once per operation rather than once per commit. */
export interface CommitContext {
    repo: RepositoryGit
    config: Array<[string, string]>
    hooks: string
    hasHooks: boolean
    signing: boolean
    cleanup: string
}

export async function prepareCommitContext(repo: RepositoryGit): Promise<CommitContext> {
    let cwd = repo.descriptor.mainWorktree
    let [configuration, hooks, signing, cleanup] = await Promise.all([
        repo.command(cwd, ["config", "--null", "--list", "--includes"]),
        gitText(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]),
        repo.run(cwd, ["config", "--bool", "--get", "commit.gpgsign"]),
        repo.run(cwd, ["config", "--get", "commit.cleanup"]),
    ])
    let config = configuration.toString().split("\0").filter(Boolean).map(record => {
        let index = record.indexOf("\n")
        return [record.slice(0, index), record.slice(index + 1)] as [string, string]
    }).filter(([key]) => !["core.worktree", "core.bare"].includes(key))
    let hasHooks = config.some(([key]) => key.startsWith("hook."))
        || (await Promise.all(["pre-commit", "prepare-commit-msg", "commit-msg"].map(async name => {
            try {
                await access(join(hooks, name), process.platform == "win32" ? constants.F_OK : constants.X_OK)
                return true
            } catch (error) {
                if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
                    return false
                throw error
            }
        }))).some(Boolean)

    return {
        repo,
        config,
        hooks,
        hasHooks,
        signing: signing.stdout.toString().trim() == "true",
        cleanup: cleanup.stdout.toString().trim(),
    }
}

// Commit objects are immutable, so one read per commit serves every author and message lookup in a process.
let rawCommits = new Map<string, Promise<string>>()

/** The raw commit object: headers, a blank line, then the message. */
export function rawCommit(repo: RepositoryGit, commit: string) {
    let key = `${repo.descriptor.commonDirectory}\0${commit}`
    let cached = rawCommits.get(key)
    if (!cached) {
        cached = repo.command(repo.descriptor.mainWorktree, ["cat-file", "commit", commit]).then(raw => raw.toString())
        rawCommits.set(key, cached)
        cached.catch(() => rawCommits.delete(key))
    }
    return cached
}

/** A source commit's author identity as commit environment, and its message. */
export async function commitAuthor(repo: RepositoryGit, source: string) {
    let raw = await rawCommit(repo, source)
    let split = raw.indexOf("\n\n")
    let author = /^author (.*) <([^>]*)> (.+)$/m.exec(raw.slice(0, split))!
    return {
        env: { GIT_AUTHOR_NAME: author[1], GIT_AUTHOR_EMAIL: author[2], GIT_AUTHOR_DATE: author[3] },
        message: raw.slice(split + 2),
    }
}

// Hooks see the actual proposed commit in an isolated checkout and index. Their
// configured commands and filters still come from the destination repository.
// A source commit supplies the author and, unless a message is given, the message.
export async function compositionCommit(context: CommitContext, parent: string, tree: string, source?: string, message = "", cancelled = () => false) {
    let { repo } = context
    if (!context.hasHooks)
        return commitWithoutHooks(context, parent, tree, source, message, cancelled)

    let root = resolve(tmpdir()), scratch = await mkdtemp(join(root, "laneway-composition-hook-"))
    let retain = false
    try {
        await repo.command(scratch, ["init", "-q", `--object-format=${repo.descriptor.objectFormat}`])
        let config = [...context.config, ["core.hooksPath", context.hooks], ["core.bare", "false"]]
        let env: Record<string, string> = {
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
            let author = await commitAuthor(repo, source)
            Object.assign(env, author.env)
            message ||= author.message
        }

        let run = (args: string[], input?: string) => repo.command(scratch, args, input, env)
        await run(["update-ref", "HEAD", parent])
        await run(["read-tree", "--reset", "-u", tree])
        let original = (await run(["diff", "--binary", "--no-ext-diff", "--no-textconv"])).toString()
        let messagePath = join(scratch, ".git", "COMMIT_EDITMSG")
        await writeFile(messagePath, source ? message : message + "\n")
        for (let args of [["pre-commit"], ["prepare-commit-msg", "--", messagePath, "message"], ["commit-msg", "--", messagePath]]) {
            if (cancelled())
                throw new Error("Transfer cancelled while preparing commits.")
            await run(["hook", "run", "--ignore-missing", ...args])
        }

        let proposed = (await run(["write-tree"])).toString().trim()
        let changed = (await run(["diff", "--binary", "--no-ext-diff", "--no-textconv"])).toString()
        if (proposed != tree || changed != original || (await run(["ls-files", "--others", "--exclude-standard"])).length) {
            let names = (await run(["diff", "--name-only", tree])).toString().trim()
            throw new Error(`Commit hooks changed content (${names || "index or working files"}). Review the saved hook checkout, then retry composition.`)
        }

        let rawMessage = await readFile(messagePath, "utf8")
        let prepared = source || context.cleanup == "verbatim"
            ? rawMessage
            : (await run(["stripspace", ...(context.cleanup == "strip" ? ["--strip-comments"] : [])], rawMessage)).toString()
        if (!source && !prepared.trim())
            throw new Error("A commit message is required.")

        let commit = (await run(["commit-tree", tree, "-p", parent, ...(context.signing ? ["-S"] : [])], prepared)).toString().trim()
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

async function commitWithoutHooks(
    context: CommitContext,
    parent: string,
    tree: string,
    source: string | undefined,
    message: string,
    cancelled: () => boolean,
) {
    let { repo } = context
    let env: Record<string, string> = {}
    if (source) {
        let author = await commitAuthor(repo, source)
        env = author.env
        message ||= author.message
    } else if (context.cleanup != "verbatim") {
        message = (await repo.command(
            repo.descriptor.mainWorktree,
            ["stripspace", ...(context.cleanup == "strip" ? ["--strip-comments"] : [])],
            message + "\n",
        )).toString()
    } else {
        message += "\n"
    }

    if (!source && !message.trim())
        throw new Error("A commit message is required.")
    if (cancelled())
        throw new Error("Transfer cancelled while preparing commits.")

    return gitText(repo, ["commit-tree", tree, "-p", parent, ...(context.signing ? ["-S"] : [])], message, env)
}
