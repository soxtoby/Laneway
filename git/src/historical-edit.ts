import { type ConflictState, type HistoricalEdit, type HistoricalEditSession, HistoricalEditSessionSchema, type RegisteredWorktree } from "@laneway/shared"
import { gitText, readConflictState, retainedDocument } from "./conflicts"
import type { RepositoryGit } from "./index"
import { readRegisteredWorktrees } from "./worktrees"

/** Each worktree's Historical Edit lives at its own private ref, so sessions in different worktrees never share a CAS target. */
export let historicalEditPrefix = "refs/laneway/historical-edits/"

export function historicalEditRef(worktreeId: string) {
    return historicalEditPrefix + worktreeId
}

export async function readHistoricalEdits(repo: RepositoryGit): Promise<HistoricalEdit[]> {
    return (await readStoredHistoricalEdits(repo)).map(stored => stored.edit)
}

/** Sessions with their computed state, and the ref values that guard updating them. */
export async function readStoredHistoricalEdits(repo: RepositoryGit) {
    let sessions = await readHistoricalEditSessions(repo)
    if (!sessions.length)
        return []

    let [worktrees, conflicts] = await Promise.all([readRegisteredWorktrees(repo), readConflictState(repo)])
    return Promise.all(sessions.map(async ({ ref, value, session }) => ({
        ref,
        value,
        edit: { ...session, ...await sessionState(repo, session, worktrees, conflicts) } as HistoricalEdit,
    })))
}

export async function readHistoricalEditSessions(repo: RepositoryGit) {
    let output = await gitText(repo, ["for-each-ref", "--format=%(refname) %(objectname)", historicalEditPrefix])
    return Promise.all(
        output.split("\n").filter(Boolean).map(async line => {
            let [ref, value] = line.split(" ") as [string, string]
            try {
                let session = HistoricalEditSessionSchema.parse(JSON.parse(await gitText(repo, ["show", `${value}:state.json`])))
                return { ref, value, session }
            } catch {
                throw new Error(`Historical Edit metadata at ${ref} is damaged. The worktree and its stashes were left as they are.`)
            }
        }),
    )
}

/** The session document's parents keep its commits and original stash reachable through Git garbage collection. */
export async function storeHistoricalEdit(repo: RepositoryGit, session: HistoricalEditSession) {
    let parents = new Set([session.commit, session.tip, session.selected, ...(session.stash ? [session.stash] : [])])
    return retainedDocument(repo, session, new Map(), [...parents])
}

async function sessionState(repo: RepositoryGit, session: HistoricalEditSession, worktrees: RegisteredWorktree[], conflicts: ConflictState) {
    let worktree = worktrees.find(w => w.id == session.worktreeId)
    let name = session.branch.slice("refs/heads/".length)
    if (!worktree || worktree.missing)
        return stale("The worktree is unavailable.")
    if (worktree.branchRef || worktree.head != session.commit)
        return stale("The worktree's HEAD moved outside Laneway.")

    // Accepting the last conflict of a pausing Unresolved Stack re-pins the session, so any other movement is external.
    let tip = await repo.resolveRef(session.branch)
    if (!tip)
        return stale(`${name} no longer exists.`)
    if (tip != session.tip)
        return stale(`${name} moved outside this Historical Edit.`)
    if (session.unresolved && conflicts.stacks.some(stack => stack.temporaryRef == session.unresolved))
        return { state: "paused" as const, reason: `Resolve the conflicts on ${name} to continue.` }
    return { state: "active" as const }
}

function stale(reason: string) {
    return { state: "stale" as const, reason }
}
