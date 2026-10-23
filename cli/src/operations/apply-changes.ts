import { GitError, normalize, pathExists, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import { rm, writeFile } from "node:fs/promises"
import { applyStashConflict, dropStash } from "../conflicts/conflict-operations"
import { moveRegistration, recreateRegistration, registrationObjects, removeRegistration, setRegistrationLock } from "../worktrees/worktree-registration"
import { type ChangeRecorder, worktreeTrees } from "./change-recorder"
import { OperationRuntimeError } from "./operation-contracts"
import type { Change } from "./operation-record"
import { metadataPath, readStashList } from "./repository-snapshot"

export interface ApplyContext {
    operationId: string
    action: "apply" | "undo" | "redo"
}

/** The same changes in the other direction. */
export function invertChanges(changes: Change[]): Change[] {
    return changes.map(change => ({ ...change, before: change.after, after: change.before } as Change))
}

/** Objects retention must keep reachable: every side that a later reversal may need. */
export function changeObjects(changes: Change[]) {
    let objects: Array<string | null | undefined> = []
    for (let change of changes) {
        switch (change.type) {
            case "ref":
                objects.push(change.before, change.after)
                break
            case "head":
                objects.push(...[change.before, change.after].filter(head => !head.startsWith("refs/")))
                break
            case "tree":
                objects.push(change.before.index, change.before.files, change.after.index, change.after.files)
                break
            case "stashes":
                objects.push(...change.before.map(s => s.object), ...change.after.map(s => s.object))
                break
            case "worktree":
                objects.push(...(change.before ? registrationObjects(change.before) : []), ...(change.after ? registrationObjects(change.after) : []))
                break
        }
    }
    return [...new Set(objects.filter((object): object is string => Boolean(object)))]
}

/** The same changes with a worktree at another path, for undoing a removal whose original path is occupied. */
export function relocateChanges(changes: Change[], from: string, to: string): Change[] {
    let moved = (path: string) => normalize(path) == normalize(from) ? to : path
    return changes.map(change => {
        switch (change.type) {
            case "head":
            case "tree":
                return { ...change, path: moved(change.path) }
            case "worktree":
                return {
                    ...change,
                    before: change.before && { ...change.before, path: moved(change.before.path) },
                    after: change.after && { ...change.after, path: moved(change.after.path) },
                }
            default:
                return change
        }
    })
}

/** The changes of one type. */
export function ofType<T extends Change["type"]>(changes: Change[], type: T) {
    return changes.filter((change): change is Extract<Change, { type: T }> => change.type == type)
}

/** The refs a change list expects to find in place, with the values it expects. */
export function expectedRefs(changes: Change[]) {
    return ofType(changes, "ref").filter(change => change.ref != "refs/stash").map(change => ({ ref: change.ref, expected: change.before }))
}

/**
 * Applies changes to the repository as it is now. Refs move in one transaction that expects the values the changes
 * start from, and that is the only check made: a worktree that has moved on is left alone, files are merged, and the
 * rest is applied on top of whatever is there ([ADR 0023](../../../docs/adr/0023-undo-reverses-recorded-changes.md)).
 */
export async function applyChanges(repo: RepositoryGit, changes: Change[], recorder: ChangeRecorder, context: ApplyContext) {
    let registrations = ofType(changes, "worktree")
    for (let change of registrations) {
        if (change.after && !change.before)
            await recreateRegistration(repo, change.after)
        else if (change.before && change.after)
            await applyRegistrationMove(repo, change)
    }

    await applyRefs(repo, ofType(changes, "ref").filter(change => change.ref != "refs/stash"), context.action)

    for (let change of ofType(changes, "head"))
        await applyHead(repo, change)
    for (let change of ofType(changes, "tree"))
        await applyTree(repo, change, recorder, context.action)
    for (let change of ofType(changes, "stashes"))
        await applyStashes(repo, change)
    for (let change of ofType(changes, "config")) {
        await repo.run(repo.descriptor.mainWorktree, ["config", "--local", "--unset-all", change.key])
        for (let value of change.after)
            await repo.command(repo.descriptor.mainWorktree, ["config", "--local", "--add", change.key, value])
    }
    for (let change of ofType(changes, "metadata")) {
        if (change.after == null)
            await rm(metadataPath(repo), { force: true })
        else
            await writeFile(metadataPath(repo), change.after)
    }

    for (let change of registrations) {
        if (change.before && !change.after) {
            let retained = await removeRegistration(repo, change.before, context.operationId)
            if (retained)
                recorder.removing.set(change.id, retained)
        }
    }
}

async function applyRefs(repo: RepositoryGit, changes: Extract<Change, { type: "ref" }>[], action: string) {
    if (!changes.length)
        return
    try {
        await repo.updateRefs(changes.map(change => ({ ref: change.ref, before: change.before, after: change.after })))
    } catch (error) {
        if (!(error instanceof GitError))
            throw error
        for (let change of changes) {
            let actual = await repo.resolveRef(change.ref)
            if (actual != change.before)
                throw refMoved(change.ref, action, change.before, actual)
        }
        throw new OperationRuntimeError("operation.precondition-failed", `Git refused to move refs for ${action}: ${error.message}`, { reason: "ref-changed" })
    }
}

export function refMoved(ref: string, action: string, expected: string | null, actual: string | null) {
    let name = ref.replace(/^refs\/heads\//, "")
    return new OperationRuntimeError(
        "operation.precondition-failed",
        `${name} moved outside Laneway, so this operation cannot be ${action == "undo" ? "undone" : action == "redo" ? "redone" : "applied"}.`,
        { reason: "ref-changed", ref, expected, actual },
    )
}

async function applyHead(repo: RepositoryGit, change: Extract<Change, { type: "head" }>) {
    let worktree = (await readRegisteredWorktrees(repo)).find(w => !w.missing && normalize(w.path) == normalize(change.path))
    if (!worktree)
        return
    let current = worktree.branchRef ?? worktree.head
    // A worktree that has since checked out something else keeps it; its branch still moves.
    if (current != change.before || current == change.after)
        return
    if (change.after.startsWith("refs/"))
        await repo.command(worktree.path, ["symbolic-ref", "HEAD", change.after])
    else
        await repo.command(worktree.path, ["update-ref", "--no-deref", "HEAD", change.after])
}

/**
 * Moves a worktree's index and files to the trees the change leaves. Working Changes made since the trees it starts
 * from are stashed first and reapplied over the result under the Working Changes contract, so edits on other paths
 * stay in place and colliding ones become a Working Changes Conflict.
 */
async function applyTree(repo: RepositoryGit, change: Extract<Change, { type: "tree" }>, recorder: ChangeRecorder, action: string) {
    let worktree = (await readRegisteredWorktrees(repo)).find(w => !w.missing && normalize(w.path) == normalize(change.path))
    if (!worktree || !await pathExists(worktree.path))
        return
    let path = worktree.path
    let current = await worktreeTrees(repo, path)
    if (current.index == change.after.index && current.files == change.after.files)
        return
    let exact = current.index == change.before.index && current.files == change.before.files

    // Tracking the current untracked files first lets the checkout remove or replace them.
    await repo.command(path, ["read-tree", current.files])
    await repo.command(path, ["read-tree", "--reset", "-u", change.after.files])
    await repo.command(path, ["read-tree", change.after.index])
    recorder.tree(path, current, change.after)
    if (exact)
        return

    let head = (await repo.run(path, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.toString().trim()
    let base = await commitTree(repo, path, change.before.files, head ? [head] : [], "Files before the Working Changes made since\n")
    let index = await commitTree(repo, path, current.index, [base], "Index with the Working Changes made since\n")
    let stash = await commitTree(repo, path, current.files, [base, index], `Working Changes kept through ${action}\n`)
    await repo.command(path, ["stash", "store", "-m", `Working Changes kept through ${action}`, stash])
    if (!await applyStashConflict(repo, path, stash, recorder, true))
        await dropStash(repo, stash, recorder)
    recorder.tree(path, change.after, await worktreeTrees(repo, path))
}

async function commitTree(repo: RepositoryGit, path: string, tree: string, parents: string[], message: string) {
    let identity = {
        GIT_AUTHOR_NAME: "Laneway",
        GIT_AUTHOR_EMAIL: "undo@laneway.invalid",
        GIT_COMMITTER_NAME: "Laneway",
        GIT_COMMITTER_EMAIL: "undo@laneway.invalid",
    }
    return (await repo.command(path, ["commit-tree", tree, ...parents.flatMap(p => ["-p", p])], message, identity)).toString().trim()
}

/** Removes the entries the change drops and restores the ones it adds at their recorded positions, keeping the rest. */
async function applyStashes(repo: RepositoryGit, change: Extract<Change, { type: "stashes" }>) {
    let current = await readStashList(repo)
    let dropped = new Set(change.before.filter(entry => !change.after.some(next => next.object == entry.object)).map(entry => entry.object))
    let next = current.filter(entry => !dropped.has(entry.object))
    change.after.forEach((entry, position) => {
        if (!change.before.some(old => old.object == entry.object) && !next.some(item => item.object == entry.object))
            next.splice(Math.min(position, next.length), 0, entry)
    })
    if (JSON.stringify(next) == JSON.stringify(current))
        return
    await repo.run(repo.descriptor.mainWorktree, ["update-ref", "-d", "refs/stash"])
    for (let entry of [...next].reverse())
        await repo.command(repo.descriptor.mainWorktree, ["stash", "store", "-m", entry.message, entry.object])
}

async function applyRegistrationMove(repo: RepositoryGit, change: Extract<Change, { type: "worktree" }>) {
    let before = change.before!, after = change.after!
    let worktree = (await readRegisteredWorktrees(repo)).find(w => w.id == change.id)
    if (!worktree)
        return
    if (normalize(before.path) != normalize(after.path) && normalize(worktree.path) == normalize(before.path)) {
        await moveRegistration(repo, worktree, after.path)
        worktree = { ...worktree, path: after.path }
    }
    if (before.locked != after.locked && worktree.locked == before.locked)
        await setRegistrationLock(repo, worktree, after.locked, after.lockReason)
}
