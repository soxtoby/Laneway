import type { BranchGraph, BranchGraphBranchNode, WorkspaceColumn, WorktreeRecovery } from "@laneway/shared"

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
        const refs = [ref, ...(ref == branch.preferredRef ? branch.remoteRefs : [])]
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

/** The Branch Node holding a local branch identity, which carries its Base relationships. */
export function branchNodeFor(graph: BranchGraph, id: string) {
    return graph.branches.find(branch => branch.id == id || branch.localRefs.some(ref => `branch:${ref}` == id))
}

export function recoveryColumnId(recovery: WorktreeRecovery) {
    return `recovery:${recovery.operationId}`
}

export function recoveryWorkspaceColumn(recovery: WorktreeRecovery, width = 380): WorkspaceColumn {
    const common = { id: recoveryColumnId(recovery), worktreePath: recovery.path, worktreeId: recovery.worktreeId, lastSeenObjectId: recovery.head, width }
    return recovery.branchRef ? { ...common, kind: "branch", ref: recovery.branchRef } : { ...common, kind: "virtual" }
}

export function reconcileWorktreeColumns(columns: WorkspaceColumn[], graph: BranchGraph, focused?: string, recoveries: WorktreeRecovery[] = []) {
    graph = workspaceGraph(graph)
    const nodes = [...graph.branches, ...graph.virtualBranches]
    const replacements = new Map<string, string | undefined>()
    const retained = new Set<string>()
    for (const column of columns.filter(column => column.worktreePath)) {
        const current = nodes.find(node => {
            const worktrees = node.kind == "branch" ? node.checkedOut : [node.worktree]
            return worktrees.some(worktree =>
                column.id.startsWith("recovery:")
                    ? equalPath(worktree.path, column.worktreePath!)
                    : column.worktreeId && worktree.id
                    ? worktree.id == column.worktreeId
                    : equalPath(worktree.path, column.worktreePath!)
            )
        })
        const recovery = recoveries.find(item => item.worktreeId == column.worktreeId || equalPath(item.path, column.worktreePath!))
        const id = recovery ? recoveryColumnId(recovery) : current?.id
        replacements.set(column.id, id)
        if (id)
            retained.add(id)
    }
    const result: WorkspaceColumn[] = []
    for (const column of columns) {
        if (!replacements.has(column.id) && retained.has(column.id))
            continue
        const id = replacements.has(column.id) ? replacements.get(column.id) : column.id
        if (!id)
            continue
        const recovery = recoveries.find(item => recoveryColumnId(item) == id)
        if (recovery) {
            result.push({ ...column, ...recoveryWorkspaceColumn(recovery, column.width) })
            continue
        }
        const node = nodes.find(node => node.id == id)
        if (!node)
            continue
        const worktree = node.kind == "virtual"
            ? node.worktree
            : node.checkedOut.find(item => item.id == column.worktreeId || equalPath(item.path, column.worktreePath ?? "")) ?? node.checkedOut[0]
        const common = {
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
    for (const recovery of recoveries) {
        if (!result.some(column => column.id == recoveryColumnId(recovery)))
            result.push(recoveryWorkspaceColumn(recovery))
    }
    return { columns: result, focused: focused && replacements.has(focused) ? replacements.get(focused) : focused }
}

function equalPath(a: string, b: string) {
    return a.replaceAll("\\", "/").toLowerCase() == b.replaceAll("\\", "/").toLowerCase()
}
