import type { BranchGraph, ComparisonRef, FileHistorySource } from "@laneway/shared"

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
}

export function comparisonColumnId(from: ComparisonRef, to: ComparisonRef) {
    return `comparison:${refKey(from)}..${refKey(to)}`
}

export function comparisonNode(id: string, comparison: { from: ComparisonRef; to: ComparisonRef }, graph: BranchGraph): ComparisonColumnNode {
    let fromName = refName(comparison.from, graph), toName = refName(comparison.to, graph)

    return {
        kind: "comparison",
        id,
        name: `${fromName} → ${toName}`,
        description: comparison.from.kind == "merge-base" && comparison.from.withRef == refOf(comparison.to)
            ? `Changes on ${toName} since it left ${fromName}`
            : `Compare ${fromName} to ${toName}`,
        from: comparison.from,
        to: comparison.to,
        fromName,
        toName,
    }
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

/** The branch or commit whose history explains one end of the comparison. */
export function comparisonHistorySource(ref: ComparisonRef): FileHistorySource {
    return ref.kind == "commit" ? { kind: "commit", objectId: ref.objectId } : { kind: "branch", ref: ref.ref }
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
