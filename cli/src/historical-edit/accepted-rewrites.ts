import { type readStoredHistoricalEdits, replayTree, type RepositoryGit, storeHistoricalEdit } from "@laneway/git"
import { type ConflictState, HistoricalEditSessionSchema, type UnresolvedStack } from "@laneway/shared"
import { workingTree } from "../composition/composition-source"

type StoredEdit = Awaited<ReturnType<typeof readStoredHistoricalEdits>>[number]

/**
 * Accepting a conflict rewrites the provisional commits after it, so each session these stacks pause follows its commit's
 * rewrite with its Historical Working Changes. Once a stack is published, its branch tip becomes the session's new pin.
 * `sessions` are read before acceptance moves anything; `previous` maps each step to its commit from then.
 */
export async function followAcceptedRewrites(
    repo: RepositoryGit,
    sessions: StoredEdit[],
    stacks: UnresolvedStack[],
    previous: Map<string, string>,
    state: ConflictState,
    changes: Map<string, string | null>,
) {
    let rewritten = new Map(stacks.flatMap(stack => stack.steps).map(step => [previous.get(step.id), step.current]))
    let paused = sessions.filter(({ edit }) => edit.state == "paused" && stacks.some(stack => stack.temporaryRef == edit.unresolved))
    for (let { ref, value, edit } of paused) {
        let commit = rewritten.get(edit.commit) ?? edit.commit
        if (commit != edit.commit)
            await moveDetached(repo, edit.path, edit.commit, commit)

        let published = !state.stacks.some(stack => stack.temporaryRef == edit.unresolved)
        let session = HistoricalEditSessionSchema.parse({
            ...edit,
            commit,
            tip: published ? changes.get(edit.branch) ?? edit.tip : edit.tip,
            unresolved: published ? undefined : edit.unresolved,
        })
        let after = await storeHistoricalEdit(repo, session)
        await repo.updateRefs([{ ref, before: value, after }])
        changes.set(ref, after)
    }
}

async function moveDetached(repo: RepositoryGit, path: string, from: string, to: string) {
    let index = (await repo.command(path, ["write-tree"])).toString().trim()
    let current = await workingTree(repo, path)
    let files = await replayTree(repo, from, to, current, crypto.randomUUID())
    let staged = await replayTree(repo, from, to, index, crypto.randomUUID())
    // Rare enough not to defer as a Working Changes Conflict: the user can apply or drop the overlapping changes first.
    if (files.conflict || staged.conflict)
        throw new Error(`The Historical Working Changes in ${path} overlap this resolution. Apply or drop them, then accept it again.`)

    // Tracking the current untracked files first lets the checkout replace them where the rewrite changes them.
    await repo.command(path, ["read-tree", current])
    await repo.command(path, ["read-tree", "--reset", "-u", files.tree])
    await repo.command(path, ["read-tree", staged.tree])
    await repo.command(path, ["update-ref", "--no-deref", "HEAD", to, from])
}
