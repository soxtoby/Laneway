import { gitText, historicalEditRef, normalize, pathExists, populatedSubmodules, readConflictState, readRegisteredWorktrees, readStoredHistoricalEdits, type RepositoryGit, storeHistoricalEdit, temporaryBranchPrefix } from "@laneway/git"
import { type HistoricalEditRequest, HistoricalEditSessionSchema, type RegisteredWorktree } from "@laneway/shared"
import { join } from "node:path"
import { verifyIgnoredFiles } from "../composition/composition"
import { applyStashConflict, dropStash } from "../conflicts/conflict-operations"
import { checkStashApplication } from "../local-mutations"

type Changes = Map<string, string | null>
export type HistoricalEditMutation = Exclude<HistoricalEditRequest, { action: "status" }>
type StoredEdit = Awaited<ReturnType<typeof readStoredHistoricalEdits>>[number]

/** A validated Historical Edit transition: what it touches, and whether it is a Laneway Operation of its own. */
export interface HistoricalEditPlan {
    request: HistoricalEditMutation
    worktree: RegisteredWorktree
    stored?: StoredEdit
    summary: string
    /** Checkout alone creates no operation; only Drop and Bring along enter Operation History. */
    recorded: boolean
}

let originalStashMessage = "Working Changes before Historical Edit"

export async function prepareHistoricalEdit(repo: RepositoryGit, request: HistoricalEditMutation): Promise<HistoricalEditPlan> {
    if (repo.descriptor.shallow || repo.descriptor.partial || repo.descriptor.sparse)
        throw new Error("Historical Edit requires a complete, non-sparse repository.")

    let worktrees = await readRegisteredWorktrees(repo)
    let worktree = worktrees.find(w => !w.missing && normalize(w.path) == normalize(request.path))
    if (!worktree)
        throw new Error("Choose an available Registered Worktree.")
    let stored = (await readStoredHistoricalEdits(repo)).find(item => item.edit.worktreeId == worktree.id)
    await requireNoGitOperation(repo, worktree)

    if (request.action == "enter")
        return prepareEntry(repo, request, worktree, stored)
    if (!stored)
        throw new Error("This worktree is not in a Historical Edit.")
    return request.action == "return"
        ? prepareReturn(repo, request, worktree, worktrees, stored)
        : prepareRestart(repo, request, worktree, stored)
}

export async function mutateHistoricalEdit(repo: RepositoryGit, plan: HistoricalEditPlan, changes: Changes) {
    if (plan.request.action == "enter")
        return enter(repo, plan.worktree, plan.request.commit)
    if (plan.request.action == "return")
        return returnToBranch(repo, plan, plan.request.mode, changes)
    return restart(repo, plan.worktree, plan.stored!)
}

async function prepareEntry(
    repo: RepositoryGit,
    request: Extract<HistoricalEditMutation, { action: "enter" }>,
    worktree: RegisteredWorktree,
    stored: StoredEdit | undefined,
): Promise<HistoricalEditPlan> {
    let branch = worktree.branchRef
    if (stored)
        throw new Error("This worktree is already in a Historical Edit. Return to its branch first.")
    if (!branch)
        throw new Error("Historical Edit starts from a worktree with its branch checked out.")
    if (branch.startsWith(temporaryBranchPrefix))
        throw new Error("Resolve this Unresolved Stack before editing its history.")
    await requireNoWorkingConflict(repo, worktree)
    if ((await populatedSubmodules(repo, worktree.path)).length)
        throw new Error("Historical Edit is unavailable in a worktree with populated submodules.")
    await requireUniqueCommit(repo, request.commit, branch)
    await verifyIgnoredFiles(repo, worktree.path, await gitText(repo, ["rev-parse", `${request.commit}^{tree}`]))

    return { request, worktree, summary: `Edit ${request.commit.slice(0, 8)} from ${display(branch)}`, recorded: false }
}

async function prepareReturn(
    repo: RepositoryGit,
    request: Extract<HistoricalEditMutation, { action: "return" }>,
    worktree: RegisteredWorktree,
    worktrees: RegisteredWorktree[],
    stored: StoredEdit,
): Promise<HistoricalEditPlan> {
    let { edit } = stored, name = display(edit.branch)
    if (edit.state == "paused")
        throw new Error(`Resolve the conflicts on ${name} before returning. Your earlier Working Changes are restored only after them.`)
    let tip = await repo.resolveRef(edit.branch)
    if (!tip)
        throw new Error(`${name} no longer exists. Restore it before returning.`)
    let holder = worktrees.find(w => w.branchRef == edit.branch)
    if (holder)
        throw new Error(`${name} is checked out in ${holder.path}. Switch that worktree away before returning.`)
    if (await hasNewCommits(repo, worktree, edit.commit))
        throw new Error("Create a branch for the commits made during this Historical Edit before returning.")
    await requireNoWorkingConflict(repo, worktree)
    await verifyIgnoredFiles(repo, worktree.path, await gitText(repo, ["rev-parse", `${tip}^{tree}`]))

    let dirty = await isDirty(repo, worktree.path)
    if (dirty && request.mode == "clean")
        throw new Error("Choose whether to drop the remaining Historical Working Changes or bring them along.")
    let summary = !dirty ? `Return to ${name}` : request.mode == "drop"
        ? `Drop Historical Working Changes and return to ${name}`
        : `Bring Historical Working Changes to ${name}`
    return { request, worktree, stored, summary, recorded: dirty }
}

async function prepareRestart(
    repo: RepositoryGit,
    request: Extract<HistoricalEditMutation, { action: "restart" }>,
    worktree: RegisteredWorktree,
    stored: StoredEdit,
): Promise<HistoricalEditPlan> {
    let { edit } = stored, name = display(edit.branch)
    if (edit.state != "stale")
        throw new Error("This Historical Edit is already up to date.")
    let tip = await repo.resolveRef(edit.branch)
    if (!tip)
        throw new Error(`${name} no longer exists. Restore it, or return to another branch.`)
    if (worktree.branchRef || !await isAncestor(repo, worktree.head, tip))
        throw new Error(`The edited commit is no longer part of ${name}. Return to ${name} and bring your changes along instead.`)

    return { request, worktree, stored, summary: `Restart editing ${worktree.head.slice(0, 8)} on the latest ${name}`, recorded: false }
}

async function enter(repo: RepositoryGit, worktree: RegisteredWorktree, commit: string) {
    let path = worktree.path, branch = worktree.branchRef!
    let stash: string | undefined
    // An ordinary stash on the original branch keeps these changes visible as its Branch Marker during the session.
    if (await isDirty(repo, path)) {
        await repo.command(path, ["stash", "push", "--include-untracked", "--quiet", "-m", originalStashMessage])
        stash = (await repo.resolveRef("refs/stash"))!
    }
    await repo.command(path, ["checkout", "--quiet", "--detach", "--no-overwrite-ignore", commit])

    let session = { version: 1 as const, worktreeId: worktree.id, path, branch, tip: worktree.head, selected: commit, commit, stash }
    await repo.updateRefs([{ ref: historicalEditRef(worktree.id), before: null, after: await storeHistoricalEdit(repo, session) }])
    return `Editing ${commit.slice(0, 8)} from ${display(branch)}. Apply changes to rewrite it, then return to ${display(branch)}.`
}

/** Original Working Changes are restored before Historical Working Changes, so each restore conflict is its own. */
async function returnToBranch(repo: RepositoryGit, plan: HistoricalEditPlan, mode: "clean" | "drop" | "bring", changes: Changes) {
    let { worktree } = plan, { ref, value, edit } = plan.stored!
    let path = worktree.path, name = display(edit.branch)
    let label = `Historical Working Changes from ${edit.commit.slice(0, 8)} ${await gitText(repo, ["show", "-s", "--format=%s", edit.commit])}`

    let historical: string | undefined
    if (mode == "bring" && await isDirty(repo, path))
        historical = await setAside(repo, path, label)
    else if (mode == "drop") {
        // Operation History retains the dropped files for undo.
        await repo.command(path, ["reset", "--hard", "--quiet"])
        await repo.command(path, ["clean", "-fd", "--quiet"])
    }
    await repo.command(path, ["switch", "--quiet", "--no-guess", "--no-overwrite-ignore", name])
    await repo.updateRefs([{ ref, before: value, after: null }])

    let notes = [`Returned to ${name}.`]
    let originalConflict = edit.stash != undefined && await restoreStash(repo, path, edit.stash, `On ${name}: ${originalStashMessage}`, changes)
    if (originalConflict)
        notes.push(`Your earlier Working Changes conflict with ${name}; resolve them in its column.`)
    if (historical && originalConflict) {
        await repo.command(path, ["stash", "store", "-m", `On ${name}: ${label}`, historical])
        notes.push(`The Historical Working Changes are kept stashed as "${label}" until then.`)
    } else if (historical && await restoreStash(repo, path, historical, `On ${name}: ${label}`, changes)) {
        notes.push(`The Historical Working Changes conflict with ${name}; resolve them in its column.`)
    }
    return notes.join(" ")
}

async function restart(repo: RepositoryGit, worktree: RegisteredWorktree, { ref, value, edit }: StoredEdit) {
    let tip = (await repo.resolveRef(edit.branch))!
    let session = HistoricalEditSessionSchema.parse({ ...edit, tip, commit: worktree.head, unresolved: undefined })
    await repo.updateRefs([{ ref, before: value, after: await storeHistoricalEdit(repo, session) }])
    return `Editing ${worktree.head.slice(0, 8)} on the latest ${display(edit.branch)}.`
}

/** Stashes and clears the worktree's changes, returning the stash commit without leaving it in the stash list. */
async function setAside(repo: RepositoryGit, path: string, label: string) {
    await repo.command(path, ["stash", "push", "--include-untracked", "--quiet", "-m", label])
    let stash = (await repo.resolveRef("refs/stash"))!
    await repo.command(path, ["stash", "drop", "--quiet", "stash@{0}"])
    return stash
}

/** Applies a stash to the worktree and consumes it, or leaves it as a Working Changes Conflict. Returns whether it conflicted. */
async function restoreStash(repo: RepositoryGit, path: string, stash: string, message: string, changes: Changes) {
    // The session retains the original stash, so even a copy dropped elsewhere is restored rather than lost.
    if (!(await gitText(repo, ["stash", "list", "--format=%H"])).split("\n").includes(stash))
        await repo.command(path, ["stash", "store", "-m", message, stash])

    if (!await isDirty(repo, path) && await checkStashApplication(repo, path, stash))
        await repo.command(path, ["stash", "apply", "--index", "--quiet", stash])
    else if (await applyStashConflict(repo, path, stash, changes, true))
        return true
    await dropStash(repo, stash, changes)
    return false
}

async function requireUniqueCommit(repo: RepositoryGit, commit: string, branch: string) {
    let parents = (await gitText(repo, ["show", "-s", "--format=%P", commit])).split(" ").filter(Boolean)
    if (parents.length != 1)
        throw new Error("Historical Edit is unavailable for root and merge commits.")
    if (!await isAncestor(repo, commit, branch))
        throw new Error(`The commit is not part of ${display(branch)}.`)

    let graph = await repo.startReadBranchGraph({ authorIdentities: { secondary: [] }, remotePatterns: [] }).result
    let { ref, remote } = graph.primaryBranch
    let local = ref && remote ? `refs/heads/${ref.slice(`refs/remotes/${remote}/`.length)}` : undefined
    for (let primary of [ref, local].filter(value => value && value != branch)) {
        if (await repo.resolveRef(primary!) && await isAncestor(repo, commit, primary!))
            throw new Error(`${commit.slice(0, 8)} is already on the Primary Branch. Historical Edit works on commits unique to this stack.`)
    }
}

async function requireNoGitOperation(repo: RepositoryGit, worktree: RegisteredWorktree) {
    for (let marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
        if (await pathExists(join(worktree.gitDirectory, marker)))
            throw new Error("Finish or abort the existing Git operation first.")
    }
    if ((await repo.command(worktree.path, ["ls-files", "--unmerged", "-z"])).length)
        throw new Error("Resolve existing index conflicts first.")
}

async function requireNoWorkingConflict(repo: RepositoryGit, worktree: RegisteredWorktree) {
    let state = await readConflictState(repo)
    if (state.working.some(w => !w.suspended && normalize(w.path) == normalize(worktree.path)))
        throw new Error("Resolve this worktree's Working Changes Conflict first.")
}

/** An external rewrite can leave the session's own snapshot off every branch, so only commits made on top of it count. */
async function hasNewCommits(repo: RepositoryGit, worktree: RegisteredWorktree, snapshot: string) {
    return (await gitText(repo, ["rev-list", "--max-count=1", worktree.head, "--not", "--branches", "--tags", snapshot])).length > 0
}

async function isDirty(repo: RepositoryGit, path: string) {
    return (await repo.command(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length > 0
}

async function isAncestor(repo: RepositoryGit, ancestor: string, descendant: string) {
    return !(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", ancestor, descendant])).exitCode
}

function display(ref: string) {
    return ref.replace(/^refs\/heads\//, "")
}
