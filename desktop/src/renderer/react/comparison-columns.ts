import type { BranchGraph, BranchGraphWorktree, ComparisonRef, FileHistorySource } from "@laneway/shared"

/** A Branch Comparison Column's identity: the refs name it, so opening the same comparison twice reuses the column. */
export interface ComparisonColumnNode {
    kind: "comparison"
    id: string
    name: string
    description: string
    from: ComparisonRef
    to: ComparisonRef
    fromName: string
    toName: string
    /** Whether it ends at `worktree`'s files, its Working Changes included, while there is one. */
    includeWorking: boolean
    /** The available worktree `to` is checked out in, whose Working Changes it can include. */
    worktree?: BranchGraphWorktree
}

/** What a column persists of a comparison: its ends, and whether it includes the Working Changes of the worktree `to` is checked out in. */
export interface Comparison {
    from: ComparisonRef
    to: ComparisonRef
    includeWorking?: boolean
}

export function comparisonColumnId(from: ComparisonRef, to: ComparisonRef) {
    return `comparison:${refKey(from)}..${refKey(to)}`
}

export function comparisonNode(id: string, comparison: Comparison, graph: BranchGraph): ComparisonColumnNode {
    let fromName = refName(comparison.from, graph), toName = refName(comparison.to, graph)
    let worktree = comparisonWorktree(comparison.to, graph)
    let includeWorking = comparison.includeWorking == true
    let description = comparison.from.kind == "merge-base" && comparison.from.withRef == refOf(comparison.to)
        ? `Changes on ${toName} since it left ${fromName}`
        : `Compare ${fromName} to ${toName}`

    return {
        kind: "comparison",
        id,
        name: `${fromName} → ${toName}`,
        description: includeWorking && worktree ? `${description}, with its Working Changes` : description,
        from: comparison.from,
        to: comparison.to,
        fromName,
        toName,
        includeWorking,
        ...(worktree ? { worktree } : {}),
    }
}

/** The worktree a comparison reads its end from: the one `to` is checked out in, when it includes its Working Changes. */
export function comparisonWorktreePath(comparison: ComparisonColumnNode) {
    return comparison.includeWorking ? comparison.worktree?.path : undefined
}

function comparisonWorktree(ref: ComparisonRef, graph: BranchGraph) {
    if (ref.kind != "branch")
        return undefined
    return graph.branches.find(branch => branch.refs.includes(ref.ref))?.checkedOut.find(worktree => worktree.branchRef == ref.ref && !worktree.missing)
}

/** Changes whenever a compared branch moves, so the comparison re-reads. */
export function comparisonKey(graph: BranchGraph, from: ComparisonRef, to: ComparisonRef) {
    return JSON.stringify(
        [from, to].flatMap(branchRefs).map(ref => {
            let branch = graph.branches.find(branch => branch.refs.includes(ref))
            return branch ? ref == branch.upstreamRef ? branch.upstreamTip : branch.tip : null
        }),
    )
}

export function renameComparisonRef(ref: ComparisonRef, oldRef: string, newRef: string): ComparisonRef {
    let rename = (candidate: string) => candidate == oldRef ? newRef : candidate
    return ref.kind == "commit"
        ? ref
        : ref.kind == "branch"
        ? { kind: "branch", ref: rename(ref.ref) }
        : { kind: "merge-base", ref: rename(ref.ref), withRef: rename(ref.withRef) }
}

/** The branch, commit, or worktree whose history explains one end of the comparison. */
export function comparisonHistorySource(ref: ComparisonRef, worktreePath?: string): FileHistorySource {
    return worktreePath
        ? { kind: "worktree", worktreePath }
        : ref.kind == "commit"
        ? { kind: "commit", objectId: ref.objectId }
        : { kind: "branch", ref: ref.ref }
}

function refName(ref: ComparisonRef, graph: BranchGraph) {
    if (ref.kind == "commit")
        return ref.objectId.slice(0, 8)

    return graph.branches.find(branch => branch.refs.includes(ref.ref))?.name ?? ref.ref.replace(/^refs\/(heads|remotes)\//, "")
}

function refOf(ref: ComparisonRef) {
    return ref.kind == "commit" ? undefined : ref.ref
}

function refKey(ref: ComparisonRef) {
    return ref.kind == "commit" ? ref.objectId : ref.kind == "branch" ? ref.ref : `merge-base(${ref.ref},${ref.withRef})`
}

function branchRefs(ref: ComparisonRef) {
    return ref.kind == "commit" ? [] : ref.kind == "branch" ? [ref.ref] : [ref.ref, ref.withRef]
}
