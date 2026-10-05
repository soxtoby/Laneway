import { normalize, pathExists, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import type { LocalPreview, LocalRequest, LocalResult } from "@laneway/shared"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { mutateComposition, prepareComposition } from "./composition/composition"
import { applyStashConflict } from "./conflicts/conflict-operations"
import { captureGitCheckpoint, checkpointIdentity, type GitCheckpoint } from "./operations/git-checkpoint"
import { captureWorktreeState as captureHookFiles } from "./worktrees/worktree-state"

interface LocalMetadata {
    stashes: Record<string, string | null>
    hook?: { token: string; path: string; title: string; message: string; preparedMessage: string; tree: string; head: string | null }
}
export class LocalPreconditionError extends Error {}
export async function prepareLocal(
    repository: RepositoryGit,
    request: LocalRequest,
    prefix: string,
    expectedToken?: string,
): Promise<{ preview: LocalPreview; before: GitCheckpoint }> {
    if (request.action == "compose")
        return prepareComposition(repository, request, expectedToken)
    if (repository.descriptor.shallow || repository.descriptor.partial || repository.descriptor.sparse)
        throw new Error("Local mutations require a complete, non-sparse repository.")

    let worktrees = await readRegisteredWorktrees(repository)
    let current = "path" in request && request.path ? worktrees.find(item => normalize(item.path) == normalize(request.path!)) : undefined
    if ("path" in request && request.path && (!current || current.missing))
        throw new Error("Choose an available Registered Worktree.")

    let path = current?.path ?? repository.descriptor.mainWorktree
    for (let marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
        if (current && await pathExists(join(current.gitDirectory, marker)))
            throw new Error("Finish or abort the existing Git operation first.")
    }
    if ((await repository.command(path, ["ls-files", "--unmerged", "-z"])).length)
        throw new Error("Resolve existing index conflicts first.")

    let branch = current?.branchRef?.replace(/^refs\/heads\//, "")
    let suggestedBranch = branch ?? `${prefix}${basename(path).replace(/[^\w.-]+/g, "-")}`
    if (!branch) {
        let base = suggestedBranch
        for (let n = 2; await repository.resolveRef(`refs/heads/${suggestedBranch}`); n++)
            suggestedBranch = `${base}-${n}`
    }

    let uniqueCommits = false
    if (request.action.startsWith("branch-")) {
        let name = "name" in request ? request.name : ""
        await repository.command(path, ["check-ref-format", "--branch", name])
        if (name.startsWith("-") || name.startsWith("refs/"))
            throw new Error("Use a local branch name.")
        let existing = await repository.resolveRef(`refs/heads/${name}`)
        if (request.action == "branch-create") {
            if (existing)
                throw new Error("That branch already exists.")
            if (request.commit)
                await repository.command(path, ["cat-file", "-e", `${request.commit}^{commit}`])
            if (!request.commit && !current)
                throw new Error("Choose a commit or worktree as the branch source.")
        } else {
            if (!existing)
                throw new Error("The branch no longer exists.")
            if (worktrees.some(item => item.branchRef == `refs/heads/${name}` && item.missing))
                throw new Error("Locate the worktree holding this branch first.")
            if (request.action == "branch-rename") {
                await repository.command(path, ["check-ref-format", "--branch", request.newName])
                if (request.newName.startsWith("-") || request.newName.startsWith("refs/") || await repository.resolveRef(`refs/heads/${request.newName}`))
                    throw new Error("Choose an unused local branch name.")
            } else {
                let refs = (await text(repository, path, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]))
                    .split("\n").filter(ref => ref && ref != `refs/heads/${name}`)
                uniqueCommits = Boolean((await repository.command(path, ["rev-list", "--max-count=1", existing, "--not", ...refs])).length)
            }
        }
    }

    let affected = worktrees.filter(item => !item.missing).map(item => item.path)
    let before = await captureGitCheckpoint(repository, affected, undefined, worktrees)
    let files = (await repository.command(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toString().split("\0").filter(Boolean)
    let stagedResult = await repository.run(path, ["diff", "--cached", "--quiet", "--exit-code"])
    let refs = await repository.command(path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"])
    let token = createHash("sha256").update(checkpointIdentity(before)).update(refs).digest("hex")

    return {
        before,
        preview: {
            token,
            affected,
            uniqueCommits,
            branch,
            unborn: !await head(repository, path),
            suggestedBranch,
            staged: stagedResult.exitCode == 1,
            files,
            stashes: await localStashes(repository),
            worktrees: worktrees.filter(item => !item.missing).map(item => ({ path: item.path, name: item.name, branch: item.branchRef?.slice(11) })),
        },
    }
}

export async function mutateLocal(
    repository: RepositoryGit,
    request: LocalRequest,
    before: GitCheckpoint,
    preview: LocalPreview,
    expectedRefs: Map<string, string | null>,
    cancelled?: () => boolean,
): Promise<LocalResult> {
    if (request.action == "compose")
        return mutateComposition(repository, request, preview, expectedRefs, cancelled)

    let path = "path" in request && request.path ? request.path : repository.descriptor.mainWorktree
    let data = await metadata(repository)
    let result: LocalResult = { type: "result", command: "local", status: "performed" }
    let run = (args: string[], input?: string) => repository.command(path, args, input)

    let updateRefs = async (changes: Parameters<RepositoryGit["updateRefs"]>[0]) => {
        try {
            await repository.updateRefs(changes)
        } catch (error) {
            throw new LocalPreconditionError(error instanceof Error ? error.message : String(error))
        }
        for (let change of changes)
            expectedRefs.set(change.ref, change.after)
    }

    if (request.action == "stage") {
        let files = request.files
        if (files?.some(file => isAbsolute(file) || relative(path, resolve(path, file)).startsWith("..") || file.includes("\0")))
            throw new Error("Choose files inside this worktree.")
        if (files && !files.length)
            throw new Error("Choose at least one file.")

        if (request.unstage) {
            if (await head(repository, path))
                await run(["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...(files ?? ["."])])
            else
                await run(["--literal-pathspecs", "rm", "--cached", "-r", "-f", "--ignore-unmatch", "--", ...(files ?? ["."])])
        } else {
            await run(["--literal-pathspecs", "add", "-A", "--", ...(files ?? ["."])])
        }
    } else if (request.action == "branch-create") {
        let parent = request.commit ?? await head(repository, path)
        if (parent)
            await updateRefs([{ ref: `refs/heads/${request.name}`, before: null, after: parent }])
        if (request.path)
            await run(["symbolic-ref", "HEAD", `refs/heads/${request.name}`])
    } else if (request.action == "branch-rename" || request.action == "branch-delete") {
        if (request.action == "branch-delete" && preview.uniqueCommits && !request.confirmed)
            throw new Error("Confirm deleting the branch's unique commits first.")

        let oldRef = `refs/heads/${request.name}`
        let old = before.refs[oldRef]
        let holders = (await readRegisteredWorktrees(repository)).filter(item => item.branchRef == oldRef)

        if (request.action == "branch-rename") {
            // Ref CAS is separate from branch configuration and symbolic HEAD updates; the journal retains all three.
            await updateRefs([{ ref: oldRef, before: old, after: null }, { ref: `refs/heads/${request.newName}`, before: null, after: old }])
            let configured = await repository.run(path, [
                "config",
                "--local",
                "--get-regexp",
                `^branch\\.${request.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`,
            ])
            if (!configured.exitCode)
                await run(["config", "--local", "--rename-section", `branch.${request.name}`, `branch.${request.newName}`])
            for (let holder of holders)
                await repository.command(holder.path, ["symbolic-ref", "HEAD", `refs/heads/${request.newName}`])
        } else {
            for (let holder of holders)
                await repository.command(holder.path, ["update-ref", "--no-deref", "HEAD", old, old])
            await updateRefs([{ ref: oldRef, before: old, after: null }])
            await repository.run(path, ["config", "--local", "--remove-section", `branch.${request.name}`])
        }

        for (let stash of preview.stashes) {
            if (stash.branch == request.name)
                data.stashes[stash.objectId] = request.action == "branch-rename" ? request.newName : null
        }

        await saveMetadata(repository, data)
    } else if (request.action == "stash-create") {
        if (!preview.files.length)
            throw new Error("There are no Working Changes to stash.")

        await run(["stash", "push", "--include-untracked", "-m", request.label.trim() || "Working Changes"])
        let stash = await repository.resolveRef("refs/stash")

        expectedRefs.set("refs/stash", stash)
        if (stash)
            data.stashes[stash] = preview.branch ?? null

        await saveMetadata(repository, data)
    } else if (request.action == "stash-apply" || request.action == "stash-drop") {
        if (!preview.stashes.some(stash => stash.objectId == request.objectId))
            throw new Error("The stash no longer exists.")

        if (request.action == "stash-apply") {
            if (preview.files.length)
                throw new Error("Apply requires a clean worktree. Commit or stash its Working Changes first.")
            if (!await checkStashApplication(repository, path, request.objectId)) {
                await applyStashConflict(repository, path, request.objectId, expectedRefs)
                return result
            }
            await run(["stash", "apply", "--index", request.objectId])
        }

        let stashes = await localStashes(repository)
        let index = stashes.findIndex(stash => stash.objectId == request.objectId)
        if (index < 0 || JSON.stringify(stashes.map(stash => stash.objectId)) != JSON.stringify(preview.stashes.map(stash => stash.objectId)))
            throw new LocalPreconditionError("The stash list changed during this operation. Its state was retained for recovery.")
        await run(["stash", "drop", `stash@{${index}}`])
        let remaining = stashes.filter((_, position) => position != index).map(stash => stash.objectId)
        if (JSON.stringify((await localStashes(repository)).map(stash => stash.objectId)) != JSON.stringify(remaining))
            throw new LocalPreconditionError("The stash list changed during removal. Its original state was retained for recovery.")

        expectedRefs.set("refs/stash", remaining[0] ?? null)
        delete data.stashes[request.objectId]

        await saveMetadata(repository, data)
    } else if (request.action == "commit") {
        if (!preview.branch)
            throw new Error("Create a branch for this worktree before committing.")

        let parent = await head(repository, path)
        let env: Record<string, string> = { GIT_EDITOR: ":" }
        for (let role of ["AUTHOR", "COMMITTER"]) {
            let identity = /^(.*) <([^>]*)> (.+)$/.exec(await text(repository, path, ["var", `GIT_${role}_IDENT`]))
            if (!identity)
                throw new Error(`Configure a valid Git ${role.toLowerCase()} identity.`)
            env[`GIT_${role}_NAME`] = identity[1]
            env[`GIT_${role}_EMAIL`] = identity[2]
            env[`GIT_${role}_DATE`] = identity[3]
        }

        let hookRun = (args: string[]) => repository.command(path, ["hook", "run", "--ignore-missing", ...args], undefined, env)
        let preparedMessage: string
        if (request.acceptHooks) {
            if (
                !data.hook || data.hook.token != request.acceptHooks || normalize(data.hook.path) != normalize(path)
                || data.hook.title != request.title || data.hook.message != request.message || data.hook.head != parent
                || data.hook.tree != await text(repository, path, ["write-tree"])
            ) {
                throw new Error("The reviewed hook result changed. Review the commit again.")
            }
            preparedMessage = data.hook.preparedMessage
        } else {
            if (!preview.staged)
                await run(["add", "--all"])
            let initialTree = await text(repository, path, ["write-tree"])
            let initialFiles = await captureHookFiles(repository, [path])
            await hookRun(["pre-commit"])
            let gitDirectory = await text(repository, path, ["rev-parse", "--absolute-git-dir"])
            let messagePath = join(gitDirectory, "COMMIT_EDITMSG")
            await writeFile(messagePath, `${request.title}\n\n${request.message}\n`)
            await hookRun(["prepare-commit-msg", "--", messagePath, "message"])
            await hookRun(["commit-msg", "--", messagePath])

            let cleanup = (await repository.run(path, ["config", "--get", "commit.cleanup"])).stdout.toString().trim() || "whitespace"
            let rawMessage = await readFile(messagePath, "utf8")
            preparedMessage = cleanup == "verbatim"
                ? rawMessage
                : (await run(["stripspace", ...(cleanup == "strip" ? ["--strip-comments"] : [])], rawMessage)).toString()

            let afterHooks = await captureHookFiles(repository, [path])
            if (JSON.stringify(afterHooks.refs) != JSON.stringify(initialFiles.refs))
                throw new LocalPreconditionError("A ref changed while commit hooks ran. Its state was preserved for recovery.")
            let changedFiles = afterHooks.roots.filter(root => root.kind == "working").flatMap(root => {
                let original = initialFiles.roots.find(item => item.path == root.path)
                return [...new Set([...root.files.map(file => file.name), ...(original?.files.map(file => file.name) ?? [])])].filter(name =>
                    root.files.find(file => file.name == name)?.object != original?.files.find(file => file.name == name)?.object
                    || root.files.find(file => file.name == name)?.mode != original?.files.find(file => file.name == name)?.mode
                )
            })

            let tree = await text(repository, path, ["write-tree"])
            if (tree != initialTree) {
                let indexChanges = (await run(["diff", "--name-only", "-z", initialTree, tree])).toString().split("\0").filter(Boolean)
                for (let file of indexChanges) {
                    if (!changedFiles.includes(file))
                        changedFiles.push(file)
                }
            }

            if (tree != initialTree || changedFiles.length) {
                data.hook = { token: crypto.randomUUID(), path, title: request.title, message: request.message, preparedMessage, tree, head: parent }
                await saveMetadata(repository, data)
                return { ...result, status: "hook-review", changedFiles, hookToken: data.hook.token }
            }
        }

        let tree = await text(repository, path, ["write-tree"])
        let parentTree = parent
            ? await text(repository, path, ["rev-parse", `${parent}^{tree}`])
            : await text(repository, path, ["hash-object", "-t", "tree", "--stdin"])
        if (tree == parentTree || !preparedMessage.trim())
            throw new Error("A commit requires a message and at least one content change.")

        let commit = await createCommitObject(repository, path, tree, parent, preparedMessage, env)
        if (
            await text(repository, path, ["symbolic-ref", "HEAD"]) != `refs/heads/${preview.branch}` || await head(repository, path) != parent
            || await text(repository, path, ["write-tree"]) != tree
        ) {
            throw new LocalPreconditionError("HEAD or the index changed while preparing the commit. No branch was updated.")
        }

        await updateRefs([{ ref: `refs/heads/${preview.branch}`, before: parent, after: commit }])
        delete data.hook

        await saveMetadata(repository, data)

        let post = await repository.run(path, ["hook", "run", "--ignore-missing", "post-commit"], undefined, env)
        if (post.exitCode)
            result.message = `Commit created, but the post-commit hook failed: ${post.stderr.toString().trim()}`
    }

    return result
}
async function saveMetadata(repository: RepositoryGit, value: LocalMetadata) {
    let path = join(repository.descriptor.commonDirectory, "laneway-local.json")
    await writeFile(`${path}.tmp`, JSON.stringify(value))
    await rename(`${path}.tmp`, path)
}
async function head(repository: RepositoryGit, path: string) {
    let result = await repository.run(path, ["rev-parse", "--verify", "HEAD"])

    return result.exitCode ? null : result.stdout.toString().trim()
}
export async function localStashes(repository: RepositoryGit) {
    let data = await metadata(repository)
    let output = await text(repository, repository.descriptor.mainWorktree, ["stash", "list", "--format=%H%x00%gs"])
    return output.split("\n").filter(Boolean).map(line => {
        let [objectId, label] = line.split("\0")
        let inferred = /^(?:On|WIP on) (.+?):/.exec(label)?.[1]
        return { objectId, label, branch: Object.hasOwn(data.stashes, objectId) ? data.stashes[objectId] : inferred ?? null }
    })
}
async function metadata(repository: RepositoryGit): Promise<LocalMetadata> {
    let path = join(repository.descriptor.commonDirectory, "laneway-local.json")
    return await pathExists(path) ? JSON.parse(await readFile(path, "utf8")) : { stashes: {} }
}

// Shared new-commit seam: callers prepare the destination tree and explicit parent first.
export async function createCommitObject(
    repository: RepositoryGit,
    path: string,
    tree: string,
    parent: string | null,
    message: string,
    env?: Record<string, string>,
) {
    let signing = await repository.run(path, ["config", "--bool", "--get", "commit.gpgsign"])
    return (await repository.command(
        path,
        ["commit-tree", tree, ...(parent ? ["-p", parent] : []), ...(signing.stdout.toString().trim() == "true" ? ["-S"] : [])],
        message,
        env,
    )).toString().trim()
}

async function checkStashApplication(repository: RepositoryGit, path: string, objectId: string) {
    let root = resolve(tmpdir())
    let scratch = await mkdtemp(join(root, "laneway-stash-"))
    try {
        let gitDirectory = await text(repository, path, ["rev-parse", "--absolute-git-dir"])
        let worktree = join(scratch, "worktree")
        await mkdir(worktree)

        let env = { GIT_DIR: gitDirectory, GIT_WORK_TREE: worktree, GIT_INDEX_FILE: join(scratch, "index") }
        await repository.command(worktree, ["read-tree", "--reset", "-u", "HEAD"], undefined, env)
        let result = await repository.run(worktree, ["stash", "apply", "--index", objectId], undefined, env)
        return result.exitCode == 0
    } finally {
        if (!resolve(scratch).startsWith(root + sep))
            throw new Error("Invalid scratch path.")
        await rm(scratch, { recursive: true, force: true })
    }
}

async function text(repository: RepositoryGit, path: string, args: string[]) {
    return (await repository.command(path, args)).toString().trim()
}
