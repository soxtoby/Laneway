import { branchSlug, hasUniqueCommits, normalize, populatedSubmodules, type RepositoryGit } from "@laneway/git"
import type { RegisteredWorktree, WorktreePreview } from "@laneway/shared"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { ChangeRecorder } from "../operations/change-recorder"
import { recoveryBackupPath, removeLinkedWorktree } from "./worktree-directory"

export async function mutateWorktree(repository: RepositoryGit, preview: WorktreePreview, operationId: string, branchPrefix: string, changes: ChangeRecorder) {
    let changedRefs = new Set<string>()
    let { request, worktrees, destination } = preview
    let main = repository.descriptor.mainWorktree
    let current = "path" in request ? worktrees.find(item => normalize(item.path) == normalize(request.path))! : undefined

    if (request.action == "create" || request.action == "switch") {
        let branch = request.branch?.replace(/^refs\/heads\//, "")
        let holder = branch ? worktrees.find(item => item.branchRef == `refs/heads/${branch}` && item.id != current?.id) : undefined
        if (holder && !request.move)
            throw new Error(`The branch is checked out in ${holder.path}. Confirm moving it first.`)

        if (holder) {
            await changes.worktree(holder.path, async () => {
                await preserveBeforeSwitch(repository, holder, branchPrefix, changedRefs)
                await repository.command(holder.path, ["checkout", "--detach", holder.head])
            })
        }

        if (current) {
            await changes.worktree(current.path, async () => {
                await preserveBeforeSwitch(repository, current, branchPrefix, changedRefs)
                await repository.command(current.path, ["checkout", branch!])
            })
        } else {
            await mkdir(dirname(destination!), { recursive: true })
            await repository.command(main, [
                "worktree",
                "add",
                ...(branch ? [] : ["--detach"]),
                "--",
                destination!,
                branch ?? (request.action == "create" ? request.commit! : ""),
            ])
        }
    } else if (request.action == "rename")
        await repository.command(main, ["worktree", "move", "--", current!.path, destination!])
    else if (request.action == "repair")
        await repository.command(main, ["worktree", "repair", "--", destination!])
    else if (request.action == "unlock")
        await repository.command(main, ["worktree", "unlock", "--", current!.path])
    else if (request.action == "remove") {
        // A worktree another program is using fails here with nothing to undo. An interrupted removal
        // leaves the directory where the recovery column expects its backup.
        try {
            await removeLinkedWorktree(current!, recoveryBackupPath(current!.path, operationId), async () => {
                if (!request.preserve)
                    return
                if (current!.missing) {
                    if (await hasUniqueCommits(repository, current!))
                        await protectBranch(repository, current!, branchPrefix, changedRefs)
                } else {
                    await preserveBeforeSwitch(repository, current!, branchPrefix, changedRefs)
                }
            })
        } finally {
            repository.forgetReads()
        }
    }

    return changedRefs
}

export async function preserveBeforeSwitch(repository: RepositoryGit, worktree: RegisteredWorktree, branchPrefix: string, changedRefs: Set<string>) {
    let branch = worktree.branchRef?.replace(/^refs\/heads\//, "")
    let paths = [...await populatedSubmodules(repository, worktree.path)].reverse()
    let dirty = (await repository.command(worktree.path, ["status", "--porcelain", "--untracked-files=all"])).length > 0

    if (!branch && (dirty || await hasUniqueCommits(repository, worktree))) {
        branch = await protectBranch(repository, worktree, branchPrefix, changedRefs)
        await repository.command(worktree.path, ["symbolic-ref", "HEAD", `refs/heads/${branch}`])
    }

    for (let path of [...paths, worktree.path]) {
        let status = await repository.command(path, ["status", "--porcelain", "--untracked-files=all"])
        if (status.length) {
            await repository.command(path, ["stash", "push", "--include-untracked", "-m", `Laneway: ${branch ?? worktree.name}`])
            if (path == worktree.path)
                changedRefs.add("refs/stash")
        }
    }
}

async function protectBranch(repository: RepositoryGit, worktree: RegisteredWorktree, prefix: string, changedRefs: Set<string>) {
    let base = `${prefix}${branchSlug(worktree.name)}-${worktree.head.slice(0, 8)}`
    let branch = base
    for (let suffix = 2; await repository.resolveRef(`refs/heads/${branch}`); suffix++)
        branch = `${base}-${suffix}`

    await repository.command(repository.descriptor.mainWorktree, ["branch", branch, worktree.head])
    changedRefs.add(`refs/heads/${branch}`)

    return branch
}
