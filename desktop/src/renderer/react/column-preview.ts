import type { AvailableOpenRepository, BranchGraphBranchNode, BranchGraphMarker, BranchGraphWorktree, BranchHistoryCommit, ChangedFile } from "@laneway/shared"

type Api = Window["laneway"]

/**
 * One worktree's column as the spike drew it: its checked-out branch, Working Changes, stashes, and
 * recent commits. Workspace Columns replace this when they move (migration step 3).
 */
export interface WorktreeColumn {
    id: string
    worktree: BranchGraphWorktree
    branch: BranchGraphBranchNode
    branchName: string
    stashes: BranchGraphMarker[]
    changes: ChangedFile[]
    commits: BranchHistoryCommit[]
}

export type ColumnPreview = { status: "loading" } | { status: "ready"; columns: WorktreeColumn[] } | { status: "failed"; error: string }

/** Reads a column for every checked-out worktree of an available repository, the Main Worktree first. */
export async function readColumnPreview(api: Api, repository: AvailableOpenRepository): Promise<ColumnPreview> {
    let graphResult = await api.readBranchGraph(repository.id)
    if (!graphResult.ok)
        return { status: "failed", error: graphResult.error.message }
    let graph = graphResult.graph

    let checkedOut = graph.branches.flatMap(branch => branch.checkedOut.map(worktree => ({ branch, worktree })))
    checkedOut.sort((a, b) => Number(b.worktree.main) - Number(a.worktree.main))
    let columns = await Promise.all(checkedOut.map(async ({ branch, worktree }): Promise<WorktreeColumn> => {
        let baseTips = branch.base.status == "known" ? [branch.base.tip] : branch.base.candidates.map(candidate => candidate.tip)
        let [changes, history] = await Promise.all([
            api.readChanges(repository.id, `preview:changes:${worktree.path}`, { source: { kind: "working", worktreePath: worktree.path } }),
            api.readBranchHistory(repository.id, {
                requestId: `preview:history:${worktree.path}`,
                branchRef: branch.preferredRef,
                tip: branch.tip,
                baseTips,
                remoteTips: graph.remoteTips,
                limit: 50,
            }),
        ])
        return {
            id: worktree.path,
            worktree,
            branch,
            // Branches at the same commit share a node; the worktree knows which one it has checked out.
            branchName: worktree.branchRef?.replace(/^refs\/heads\//, "") ?? branch.name,
            stashes: branch.markers.filter(marker => marker.kind == "stash"),
            changes: changes.ok ? changes.inventory.files : [],
            commits: history.ok ? history.page.commits : [],
        }
    }))
    return { status: "ready", columns }
}
