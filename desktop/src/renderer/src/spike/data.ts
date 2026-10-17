import type { BranchGraphBranchNode, BranchGraphMarker, BranchGraphWorktree, BranchHistoryCommit, ChangedFile, OpenRepository } from "@laneway/shared"

type Api = Window["laneway"]

/** One worktree's column: its checked-out branch, Working Changes, stashes, and recent commits. */
export interface WorktreeColumn {
    id: string
    worktree: BranchGraphWorktree
    branch: BranchGraphBranchNode
    branchName: string
    stashes: BranchGraphMarker[]
    changes: ChangedFile[]
    commits: BranchHistoryCommit[]
}

export interface RepositoryView {
    repositories: OpenRepository[]
    activeRepositoryId?: string
    columns: WorktreeColumn[]
    appearance: "light" | "dark"
    error?: string
}

/** Reads what the spike renders. Framework-free, so the same module would back the real controllers. */
export async function readRepositoryView(api: Api): Promise<RepositoryView> {
    let state = await api.getState()
    let repositories = state.workspace.repositories
    let active = repositories.find(repository => repository.id == state.workspace.activeRepositoryId) ?? repositories[0]
    let appearance: "light" | "dark" = state.appearance == "dark" ? "dark" : "light"
    if (!active || active.status != "available")
        return { repositories, appearance, columns: [], error: active ? active.error.message : undefined }

    let graphResult = await api.readBranchGraph(active.id)
    if (!graphResult.ok)
        return { repositories, activeRepositoryId: active.id, appearance, columns: [], error: graphResult.error.message }
    let graph = graphResult.graph

    let checkedOut = graph.branches.flatMap(branch => branch.checkedOut.map(worktree => ({ branch, worktree })))
    checkedOut.sort((a, b) => Number(b.worktree.main) - Number(a.worktree.main))
    let columns = await Promise.all(checkedOut.map(async ({ branch, worktree }): Promise<WorktreeColumn> => {
        let baseTips = branch.base.status == "known" ? [branch.base.tip] : branch.base.candidates.map(candidate => candidate.tip)
        let [changes, history] = await Promise.all([
            api.readChanges(active.id, `spike:changes:${worktree.path}`, { source: { kind: "working", worktreePath: worktree.path } }),
            api.readBranchHistory(active.id, {
                requestId: `spike:history:${worktree.path}`,
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
    return { repositories, activeRepositoryId: active.id, appearance, columns }
}

/** The name shown for a repository: its label when set, otherwise its Main Worktree's folder name. */
export function repositoryName(repository: OpenRepository) {
    if (repository.label)
        return repository.label
    if (repository.status != "available")
        return repository.name
    let path = repository.info.mainWorktree
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}
