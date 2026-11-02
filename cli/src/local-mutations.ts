import { normalize, pathExists, readRegisteredWorktrees, redactGitText, type RepositoryGit } from "@laneway/git"
import type { LocalPreview, LocalRequest, LocalResult } from "@laneway/shared"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { mutateComposition, prepareComposition } from "./composition/composition"
import { commitAuthor, rawCommit } from "./composition/composition-commits"
import { applyStashConflict } from "./conflicts/conflict-operations"
import { type ChangeRecorder, worktreeTrees } from "./operations/change-recorder"
import { readRecordedRefs } from "./operations/repository-snapshot"
import { captureWorktreeState as captureHookFiles } from "./worktrees/worktree-state"

interface LocalMetadata {
    stashes: Record<string, string | null>
    hook?: { token: string; path: string; title: string; message: string; amend?: boolean; preparedMessage: string; tree: string; head: string | null }
}
export class LocalPreconditionError extends Error {}
export async function prepareLocal(
    repository: RepositoryGit,
    request: LocalRequest,
    prefix: string,
    expectedToken?: string,
): Promise<{ preview: LocalPreview; before: { refs: Record<string, string> } }> {
    if (request.action == "compose" || request.action == "reword")
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

    if (request.action == "tag-create")
        await checkTag(repository, request)
    let commitCount = request.action == "move-into-base" ? await movableCommits(repository, request, worktrees) : undefined

    let affected = worktrees.filter(item => !item.missing).map(item => item.path)
    let before = { refs: await readRecordedRefs(repository) }
    let last = await lastCommit(repository, path)
    let files = (await repository.command(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).toString().split("\0").filter(Boolean)
    let stagedResult = await repository.run(path, ["diff", "--cached", "--quiet", "--exit-code"])
    let refs = await repository.command(path, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"])
    // The token covers the refs, every worktree's HEAD, and the content of the worktree the request works in.
    let token = createHash("sha256")
        .update(
            JSON.stringify([before.refs, worktrees.map(w => [w.id, w.path, w.head, w.branchRef ?? null, w.missing]), await worktreeTrees(repository, path)]),
        )
        .update(refs).digest("hex")

    return {
        before,
        preview: {
            token,
            affected,
            uniqueCommits,
            commitCount,
            branch,
            unborn: !last,
            lastCommit: last,
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
    preview: LocalPreview,
    expectedRefs: ChangeRecorder,
    cancelled?: () => boolean,
): Promise<LocalResult> {
    if (request.action == "compose" || request.action == "reword")
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

        await expectedRefs.worktree(path, async () => {
            if (request.unstage) {
                if (await head(repository, path))
                    await run(["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...(files ?? ["."])])
                else
                    await run(["--literal-pathspecs", "rm", "--cached", "-r", "-f", "--ignore-unmatch", "--", ...(files ?? ["."])])
            } else {
                await run(["--literal-pathspecs", "add", "-A", "--", ...(files ?? ["."])])
            }
        })
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
        let old = (await repository.resolveRef(oldRef))!
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
    } else if (request.action == "move-into-base") {
        let base = request.base.slice("refs/heads/".length)
        let update = [{ ref: request.base, before: request.baseTip, after: request.tip }]
        let holder = preview.worktrees.find(item => item.branch == base)
        // A worktree with the base checked out brings its files along, keeping Working Changes as a checkout does.
        if (holder) {
            await expectedRefs.worktree(holder.path, async () => {
                await repository.command(holder.path, ["read-tree", "-m", "-u", request.baseTip, request.tip])
                await updateRefs(update)
            })
        } else {
            await updateRefs(update)
        }
        result.message = `Moved ${preview.commitCount} commit${preview.commitCount == 1 ? "" : "s"} into ${base}.`
    } else if (request.action == "tag-create") {
        let ref = `refs/tags/${request.name}`
        // Git makes the tag, so its tag signing and message cleanup apply; an editor it would open closes at once.
        await repository.command(path, ["tag", ...(request.message.trim() ? ["-a", "-m", request.message] : []), request.name, request.commit], undefined, {
            GIT_EDITOR: ":",
        })
        let tag = (await repository.resolveRef(ref))!
        expectedRefs.set(ref, tag)
        if (request.remote) {
            let pushed = await repository.run(path, ["push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", request.remote, `${ref}:${ref}`])
            // A tag the remote refused goes again, so trying later starts from nothing rather than a tag only here.
            if (pushed.exitCode) {
                await updateRefs([{ ref, before: tag, after: null }])
                return {
                    ...result,
                    status: "failed",
                    message: tagPushFailure(request.name, request.remote, pushed.stdout.toString(), pushed.stderr.toString()),
                }
            }
        }
        result.message = request.remote ? `Created tag ${request.name} here and on ${request.remote}.` : `Created tag ${request.name}.`
    } else if (request.action == "stash-create") {
        if (!preview.files.length)
            throw new Error("There are no Working Changes to stash.")

        await expectedRefs.worktree(path, () => run(["stash", "push", "--include-untracked", "-m", request.label.trim() || "Working Changes"]))
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
            await expectedRefs.worktree(path, () => run(["stash", "apply", "--index", request.objectId]))
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
        return expectedRefs.worktree(path, async (): Promise<LocalResult> => {
            let previous = await head(repository, path)
            if (request.amend && !previous)
                throw new Error("There is no commit to amend yet.")
            // An amend replaces HEAD with a commit on HEAD's own parents, keeping its author, as Git's does.
            let amended = request.amend && previous ? await rawCommit(repository, previous) : undefined
            let parents = amended
                ? [...amended.slice(0, amended.indexOf("\n\n")).matchAll(/^parent (\S+)$/gm)].map(match => match[1])
                : previous
                ? [previous]
                : []
            let env: Record<string, string> = { GIT_EDITOR: ":" }
            for (let role of ["AUTHOR", "COMMITTER"]) {
                let identity = /^(.*) <([^>]*)> (.+)$/.exec(await text(repository, path, ["var", `GIT_${role}_IDENT`]))
                if (!identity)
                    throw new Error(`Configure a valid Git ${role.toLowerCase()} identity.`)
                env[`GIT_${role}_NAME`] = identity[1]
                env[`GIT_${role}_EMAIL`] = identity[2]
                env[`GIT_${role}_DATE`] = identity[3]
            }
            if (amended)
                Object.assign(env, (await commitAuthor(repository, previous!)).env)

            // Snapshotting every worktree file to see what hooks changed costs seconds in a large
            // repository, so a repository without commit hooks skips the hooks and the snapshots.
            let hooks = await installedHooks(repository, path, ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"])
            let hookRun = async (name: string, ...args: string[]) => {
                if (hooks.has(name))
                    await repository.command(path, ["hook", "run", "--ignore-missing", name, ...args], undefined, env)
            }
            let preparedMessage: string
            if (request.acceptHooks) {
                if (
                    !data.hook || data.hook.token != request.acceptHooks || normalize(data.hook.path) != normalize(path)
                    || data.hook.title != request.title || data.hook.message != request.message || Boolean(data.hook.amend) != Boolean(request.amend)
                    || data.hook.head != previous
                    || data.hook.tree != await text(repository, path, ["write-tree"])
                ) {
                    throw new Error("The reviewed hook result changed. Review the commit again.")
                }
                preparedMessage = data.hook.preparedMessage
            } else {
                if (!preview.staged)
                    await run(["add", "--all"])
                let initialTree = await text(repository, path, ["write-tree"])
                let initialFiles = hooks.size ? await captureHookFiles(repository, [path]) : undefined
                await hookRun("pre-commit")
                let gitDirectory = await text(repository, path, ["rev-parse", "--absolute-git-dir"])
                let messagePath = join(gitDirectory, "COMMIT_EDITMSG")
                await writeFile(messagePath, `${request.title}\n\n${request.message}\n`)
                await hookRun("prepare-commit-msg", "--", messagePath, "message")
                await hookRun("commit-msg", "--", messagePath)

                let cleanup = (await repository.run(path, ["config", "--get", "commit.cleanup"])).stdout.toString().trim() || "whitespace"
                let rawMessage = await readFile(messagePath, "utf8")
                preparedMessage = cleanup == "verbatim"
                    ? rawMessage
                    : (await run(["stripspace", ...(cleanup == "strip" ? ["--strip-comments"] : [])], rawMessage)).toString()

                let changedFiles: string[] = []
                if (initialFiles) {
                    let afterHooks = await captureHookFiles(repository, [path])
                    if (JSON.stringify(afterHooks.refs) != JSON.stringify(initialFiles.refs))
                        throw new LocalPreconditionError("A ref changed while commit hooks ran. Its state was preserved for recovery.")
                    changedFiles = afterHooks.roots.filter(root => root.kind == "working").flatMap(root => {
                        let original = initialFiles.roots.find(item => item.path == root.path)
                        return [...new Set([...root.files.map(file => file.name), ...(original?.files.map(file => file.name) ?? [])])].filter(name =>
                            root.files.find(file => file.name == name)?.object != original?.files.find(file => file.name == name)?.object
                            || root.files.find(file => file.name == name)?.mode != original?.files.find(file => file.name == name)?.mode
                        )
                    })
                }

                let tree = initialFiles ? await text(repository, path, ["write-tree"]) : initialTree
                if (tree != initialTree) {
                    let indexChanges = (await run(["diff", "--name-only", "-z", initialTree, tree])).toString().split("\0").filter(Boolean)
                    for (let file of indexChanges) {
                        if (!changedFiles.includes(file))
                            changedFiles.push(file)
                    }
                }

                if (tree != initialTree || changedFiles.length) {
                    data.hook = {
                        token: crypto.randomUUID(),
                        path,
                        title: request.title,
                        message: request.message,
                        amend: request.amend,
                        preparedMessage,
                        tree,
                        head: previous,
                    }
                    await saveMetadata(repository, data)
                    return { ...result, status: "hook-review", changedFiles, hookToken: data.hook.token }
                }
            }

            let tree = await text(repository, path, ["write-tree"])
            let parentTree = parents[0]
                ? await text(repository, path, ["rev-parse", `${parents[0]}^{tree}`])
                : await text(repository, path, ["hash-object", "-t", "tree", "--stdin"])
            if (tree == parentTree || !preparedMessage.trim())
                throw new Error(`${request.amend ? "An amended commit" : "A commit"} requires a message and at least one content change.`)

            let commit = await createCommitObject(repository, path, tree, parents, preparedMessage, env)
            if (
                await text(repository, path, ["symbolic-ref", "HEAD"]) != `refs/heads/${preview.branch}` || await head(repository, path) != previous
                || await text(repository, path, ["write-tree"]) != tree
            ) {
                throw new LocalPreconditionError("HEAD or the index changed while preparing the commit. No branch was updated.")
            }

            await updateRefs([{ ref: `refs/heads/${preview.branch}`, before: previous, after: commit }])
            delete data.hook

            await saveMetadata(repository, data)

            if (hooks.has("post-commit")) {
                let post = await repository.run(path, ["hook", "run", "--ignore-missing", "post-commit"], undefined, env)
                if (post.exitCode)
                    result.message = `${request.amend ? "Commit amended" : "Commit created"}, but the post-commit hook failed: ${post.stderr.toString().trim()}`
            }
            return result
        })
    }

    return result
}
/** A Move into Base only adds commits to its base, so the base's tip must be in the branch's history. */
async function movableCommits(
    repository: RepositoryGit,
    request: Extract<LocalRequest, { action: "move-into-base" }>,
    worktrees: Awaited<ReturnType<typeof readRegisteredWorktrees>>,
) {
    let branch = request.branch.replace(/^refs\/(heads|remotes)\//, ""), base = request.base.slice("refs/heads/".length)
    if (await repository.resolveRef(request.branch) != request.tip || await repository.resolveRef(request.base) != request.baseTip)
        throw new Error("A branch moved. Try again.")
    if (worktrees.some(item => item.branchRef == request.base && item.missing))
        throw new Error("Locate the worktree holding this branch first.")

    let counts = await text(repository, repository.descriptor.mainWorktree, ["rev-list", "--left-right", "--count", `${request.baseTip}...${request.tip}`])
    let [behind, ahead] = counts.split(/\s+/).map(Number)
    if (behind)
        throw new Error(`${base} has commits ${branch} doesn't. Rebase ${branch} onto ${base} first.`)
    if (!ahead)
        throw new Error(`${base} already holds ${branch}'s commits.`)
    return ahead
}
/** A new tag needs an unused name, a commit, and, in a repository with remotes, the remote to create it on as well. */
async function checkTag(repository: RepositoryGit, request: Extract<LocalRequest, { action: "tag-create" }>) {
    let main = repository.descriptor.mainWorktree
    if (
        request.name.startsWith("-") || request.name.startsWith("refs/")
        || (await repository.run(main, ["check-ref-format", `refs/tags/${request.name}`])).exitCode
    ) {
        throw new Error(`${request.name} isn't a valid tag name.`)
    }
    if (await repository.resolveRef(`refs/tags/${request.name}`))
        throw new Error(`There's already a tag named ${request.name}.`)
    await repository.command(main, ["cat-file", "-e", `${request.commit}^{commit}`])
    let remotes = (await text(repository, main, ["remote"])).split("\n").filter(Boolean)
    if (request.remote && !remotes.includes(request.remote))
        throw new Error(`There is no remote named ${request.remote}.`)
    if (!request.remote && remotes.length)
        throw new Error("Choose a remote in the Branch Graph's settings to create the tag on.")
}
/** The remote's reason for refusing a tag, from Git's porcelain line for it and anything the remote said. */
function tagPushFailure(name: string, remote: string, stdout: string, stderr: string) {
    let refused = stdout.split("\n").map(line => line.split("\t")).find(parts => parts.length == 3 && parts[0] == "!")?.[2]
    if (refused && /already exists/.test(refused))
        return `${remote} already has a tag named ${name}.`
    let said = stderr.split("\n").filter(line => line.startsWith("remote: ")).map(line => line.slice(8).trim()).filter(Boolean)
    let reason = redactGitText((refused ? [refused, ...said] : [stderr]).join("\n")).trim()
    return `Couldn't create tag ${name} on ${remote}${reason ? `: ${reason}` : "."}`
}
/** Hook files present in the worktree's hooks directory, honoring core.hooksPath like Git does. */
async function installedHooks(repository: RepositoryGit, path: string, names: string[]) {
    let directory = resolve(path, await text(repository, path, ["rev-parse", "--git-path", "hooks"]))
    let present = await Promise.all(names.map(name => pathExists(join(directory, name))))

    return new Set(names.filter((_, index) => present[index]))
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
/** HEAD's commit, with its message split as the commit form shows it: the subject's lines joined, as Git's %s joins them, then the rest. */
async function lastCommit(repository: RepositoryGit, path: string) {
    let result = await repository.run(path, ["log", "-1", "--no-show-signature", "--format=%H%x00%B", "HEAD"])
    if (result.exitCode)
        return undefined
    let [objectId, raw = ""] = result.stdout.toString().split("\0")
    let body = raw.trim(), split = body.search(/\n[ \t]*\n/)
    let subject = split < 0 ? body : body.slice(0, split)

    return { objectId, title: subject.split("\n").map(line => line.trim()).join(" "), message: split < 0 ? "" : body.slice(split).trim() }
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
    parents: string[],
    message: string,
    env?: Record<string, string>,
) {
    let signing = await repository.run(path, ["config", "--bool", "--get", "commit.gpgsign"])
    return (await repository.command(
        path,
        ["commit-tree", tree, ...parents.flatMap(parent => ["-p", parent]), ...(signing.stdout.toString().trim() == "true" ? ["-S"] : [])],
        message,
        env,
    )).toString().trim()
}

export async function checkStashApplication(repository: RepositoryGit, path: string, objectId: string) {
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
