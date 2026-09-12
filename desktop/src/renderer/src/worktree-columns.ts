import type { BranchGraph, WorkspaceColumn } from "@git-workbench/shared"

export function reconcileWorktreeColumns(columns: WorkspaceColumn[], graph: BranchGraph, focused?: string) {
    const nodes = [...graph.branches, ...graph.virtualBranches]
    const replacements = new Map<string, string | undefined>()
    const retained = new Set<string>()
    for (const column of columns.filter(column => column.worktreePath)) {
        const current = nodes.find(node => {
            const worktrees = node.kind == "branch" ? node.checkedOut : [node.worktree]
            return worktrees.some(worktree =>
                column.worktreeId && worktree.id ? worktree.id == column.worktreeId : equalPath(worktree.path, column.worktreePath!)
            )
        })
        replacements.set(column.id, current?.id)
        if (current)
            retained.add(current.id)
    }
    const result: WorkspaceColumn[] = []
    for (const column of columns) {
        if (!replacements.has(column.id) && retained.has(column.id))
            continue
        const id = replacements.has(column.id) ? replacements.get(column.id) : column.id
        if (!id)
            continue
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
    return { columns: result, focused: focused && replacements.has(focused) ? replacements.get(focused) : focused }
}

function equalPath(a: string, b: string) {
    return a.replaceAll("\\", "/").toLowerCase() == b.replaceAll("\\", "/").toLowerCase()
}
