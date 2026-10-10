import type { BranchGraph, BranchGraphBranchNode, WorkspaceColumn, WorktreeRecovery } from "@laneway/shared"

export function columnWorktree(column: BranchGraph["branches"][number] | BranchGraph["virtualBranches"][number], path?: string) {
    return column.kind == "branch" ? column.checkedOut.find(worktree => worktree.path == path) : column.worktree
}

/** The Branch Node holding a local branch identity, which carries its Base relationships. */
export function branchNodeFor(graph: BranchGraph, id: string) {
    return graph.branches.find(branch => branch.id == id || branch.localRefs.some(ref => `branch:${ref}` == id))
}

export function reconcileWorktreeColumns(columns: WorkspaceColumn[], graph: BranchGraph, focused?: string, recoveries: WorktreeRecovery[] = []) {
    graph = workspaceGraph(graph)
    let nodes = [...graph.branches, ...graph.virtualBranches]
    let replacements = new Map<string, string | undefined>()
    let retained = new Set<string>()
    for (let column of columns.filter(column => column.worktreePath)) {
        let current = nodes.find(node => {
            let worktrees = node.kind == "branch" ? node.checkedOut : [node.worktree]
            return worktrees.some(worktree =>
                column.id.startsWith("recovery:")
                    ? equalPath(worktree.path, column.worktreePath!)
                    : column.worktreeId && worktree.id
                    ? worktree.id == column.worktreeId
                    : equalPath(worktree.path, column.worktreePath!)
            )
        })
        let recovery = recoveries.find(item => item.worktreeId == column.worktreeId || equalPath(item.path, column.worktreePath!))
        let id = recovery ? recoveryColumnId(recovery) : current?.id
        replacements.set(column.id, id)
        if (id)
            retained.add(id)
    }
    let result: WorkspaceColumn[] = []
    for (let column of columns) {
        if (!replacements.has(column.id) && retained.has(column.id))
            continue
        let id = replacements.has(column.id) ? replacements.get(column.id) : column.id
        if (!id)
            continue
        let recovery = recoveries.find(item => recoveryColumnId(item) == id)
        if (recovery) {
            result.push({ ...column, ...recoveryWorkspaceColumn(recovery, column.width) })
            continue
        }
        let node = nodes.find(node => node.id == id)
        if (!node)
            continue
        let worktree = node.kind == "virtual"
            ? node.worktree
            : node.checkedOut.find(item => item.id == column.worktreeId || equalPath(item.path, column.worktreePath ?? "")) ?? node.checkedOut[0]
        let common = {
            id,
            width: column.width,
            collapsed: column.collapsed,
            diffLayout: column.diffLayout,
            worktreePath: worktree?.path,
            worktreeId: worktree?.id,
        }
        result.push(
            node.kind == "branch"
                ? { ...common, kind: "branch", ref: node.preferredRef, lastSeenObjectId: node.tip }
                : { ...common, kind: "virtual", worktreePath: node.worktree.path, lastSeenObjectId: node.objectId },
        )
    }
    for (let recovery of recoveries) {
        if (!result.some(column => column.id == recoveryColumnId(recovery)))
            result.push(recoveryWorkspaceColumn(recovery))
    }

    return { columns: result, focused: focused && replacements.has(focused) ? replacements.get(focused) : focused }
}

// The Git module coalesces equivalent refs into one Branch Node. Graph rows and Workspace Columns retain each local branch identity.
export function workspaceGraph(graph: BranchGraph): BranchGraph {
    if (graph.branches.every(branch => branch.localRefs.length < 2))
        return graph
    return { ...graph, branches: graph.branches.flatMap(branch => localIdentities(graph, branch)) }
}

/** Each local branch sharing a Branch Node's tip, led by the node's preferred ref so it keeps the node's place. */
export function localIdentities(graph: BranchGraph, branch: BranchGraphBranchNode): BranchGraphBranchNode[] {
    if (branch.localRefs.length < 2)
        return [branch]
    return [branch.preferredRef, ...branch.localRefs.filter(ref => ref != branch.preferredRef)].map(ref => {
        let refs = [ref, ...(ref == branch.preferredRef ? branch.remoteRefs : [])]
        return {
            ...branch,
            id: `branch:${ref}`,
            name: ref.slice(11),
            preferredRef: ref,
            localRefs: [ref],
            refs,
            aliases: refs.map(ref => ref.replace(/^refs\/(heads|remotes)\//, "")),
            checkedOut: branch.checkedOut.filter(worktree => worktree.branchRef == ref),
            markers: branch.markers.filter(marker => marker.branchName ? marker.branchName == ref.slice(11) : ref == branch.preferredRef),
            // Tags belong to the shared commit, so they show once, beside the identity that leads it.
            tags: ref == branch.preferredRef ? branch.tags : [],
            primary: branch.primary
                && (graph.primaryBranch.ref == ref || !branch.localRefs.includes(graph.primaryBranch.ref ?? "") && ref == branch.preferredRef),
            ...(ref == branch.preferredRef ? {} : { remoteRefs: [], upstreamRef: undefined, upstreamTip: undefined, ahead: 0, behind: 0 }),
        }
    })
}

export function recoveryWorkspaceColumn(recovery: WorktreeRecovery, width = 380): WorkspaceColumn {
    let common = { id: recoveryColumnId(recovery), worktreePath: recovery.path, worktreeId: recovery.worktreeId, lastSeenObjectId: recovery.head, width }
    return recovery.branchRef ? { ...common, kind: "branch", ref: recovery.branchRef } : { ...common, kind: "virtual" }
}

export function recoveryColumnId(recovery: WorktreeRecovery) {
    return `recovery:${recovery.operationId}`
}

function equalPath(a: string, b: string) {
    return a.replaceAll("\\", "/").toLowerCase() == b.replaceAll("\\", "/").toLowerCase()
}
