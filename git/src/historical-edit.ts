import { type BranchGraph, type ConflictState, type HistoricalEdit, type HistoricalEditSession, HistoricalEditSessionSchema, type RegisteredWorktree } from "@laneway/shared"
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

/**
 * Keeps a session's worktree in its original branch's column, where it would otherwise be a Virtual Branch, and
 * marks the worktree with its session wherever it shows. A branch's column shows one worktree, so once another
 * worktree checks the branch out (Git allows it while the session is detached), the session stays a Virtual Branch.
 * Damaged session metadata shows no sessions here; the Engine explains it when the worktree is next used.
 */
export async function projectHistoricalEdits(repo: RepositoryGit, graph: BranchGraph) {
    let edits = await readHistoricalEdits(repo).catch(() => [])
    for (let edit of edits) {
        let subject = await gitText(repo, ["log", "-1", "--format=%s", edit.commit])
        let detached = graph.virtualBranches.find(virtual => virtual.worktree.id == edit.worktreeId)
        let branch = graph.branches.find(candidate => candidate.localRefs.includes(edit.branch))
        if (detached && branch && !branch.checkedOut.some(worktree => worktree.branchRef == edit.branch)) {
            graph.virtualBranches = graph.virtualBranches.filter(virtual => virtual != detached)
            graph.history = graph.history.filter(point => point.lineId != detached.id)
            branch.checkedOut = [...branch.checkedOut, { ...detached.worktree, branchRef: edit.branch }]
        }
        let worktrees = [...graph.branches.flatMap(candidate => candidate.checkedOut), ...graph.virtualBranches.map(virtual => virtual.worktree)]
        for (let worktree of worktrees.filter(candidate => candidate.id == edit.worktreeId))
            worktree.historicalEdit = { ...edit, subject }
    }
    return graph
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
    if (session.unresolved && conflicts.stacks.some(stack => stack.temporaryRef == session.unresolved))
        return { state: "paused" as const, reason: `Resolve the conflicts on ${name} to continue.` }

    let tip = await repo.resolveRef(session.branch)
    if (!tip)
        return stale(`${name} no longer exists.`)
    // Accepting the last conflict of the session's own Unresolved Stack advances the branch; the session resumes there.
    let resumed = session.unresolved != undefined
        && !(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", session.commit, tip])).exitCode
    if (tip != session.tip && !resumed)
        return stale(`${name} moved outside this Historical Edit.`)
    return { state: "active" as const }
}

function stale(reason: string) {
    return { state: "stale" as const, reason }
}
