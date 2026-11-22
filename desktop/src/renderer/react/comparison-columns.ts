import type { BranchGraph, CommitDetails, ComparisonRef, FileHistorySource } from "@laneway/shared"
import { shortBranchRef } from "./worktree-columns"

interface ComparisonSide {
    ref: ComparisonRef
    label: string
    worktreePath?: string
    includeWorking: boolean
}

/** The column ID stays stable as its ordered endpoints change. */
export interface ComparisonColumnNode {
    kind: "comparison"
    id: string
    name: string
    description: string
    from: ComparisonSide
    to: ComparisonSide
}

/** The ordered refs and per-side Working Changes choices that persist with the column. */
export interface Comparison {
    from: ComparisonRef
    to: ComparisonRef
    includeWorking?: boolean
    includeFromWorking?: boolean
}

export function findComparisonId(comparisons: Record<string, Comparison>, from: ComparisonRef, to: ComparisonRef) {
    return Object.keys(comparisons).find(id => refKey(comparisons[id]!.from) == refKey(from) && refKey(comparisons[id]!.to) == refKey(to))
}

export function comparisonNode(id: string, comparison: Comparison, graph: BranchGraph): ComparisonColumnNode {
    let baseComparison = comparison.from.kind == "merge-base" && comparison.to.kind == "branch" && comparison.from.withRef == comparison.to.ref
    let from = comparisonSide(comparison.from, graph, comparison.includeFromWorking)
    let to = comparisonSide(comparison.to, graph, comparison.includeWorking)
    if (baseComparison && comparison.from.kind == "merge-base")
        from.label = shortBranchRef(comparison.from.ref)

    if (from.label == to.label && from.ref.kind == "commit" && to.ref.kind == "commit" && from.ref.objectId != to.ref.objectId) {
        for (let side of [from, to]) {
            if (side.ref.kind == "commit" && side.ref.details)
                side.label += ` · ${commitCredit(side.ref.details)}`
        }
    }

    let description = baseComparison ? `Changes on ${to.label} since it left ${from.label}` : `Compare ${from.label} to ${to.label}`
    for (let side of [from, to]) {
        if (includedWorktreePath(side))
            description += baseComparison ? ", with its Working Changes" : `, with Working Changes on ${side.label}`
    }
    return { kind: "comparison", id, name: `${from.label} → ${to.label}`, description, from, to }
}

function comparisonSide(ref: ComparisonRef, graph: BranchGraph, includeWorking = false): ComparisonSide {
    let worktree = ref.kind == "branch"
        ? graph.branches.find(branch => branch.refs.includes(ref.ref))?.checkedOut.find(worktree => worktree.branchRef == ref.ref && !worktree.missing)
        : undefined
    return { ref, label: refName(ref), worktreePath: worktree?.path, includeWorking }
}

export function includedWorktreePath(side: ComparisonSide) {
    return side.includeWorking ? side.worktreePath : undefined
}

/** Changes whenever a compared branch moves, so the comparison re-reads. */
export function comparisonTips(graph: BranchGraph, from: ComparisonRef, to: ComparisonRef) {
    return [from, to].flatMap(branchRefs).map(ref => {
        let branch = graph.branches.find(branch => branch.refs.includes(ref))
        return branch ? ref == branch.upstreamRef ? branch.upstreamTip : branch.tip : null
    })
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
export function comparisonHistorySource(side: ComparisonSide, resolvedId?: string): FileHistorySource {
    let { ref } = side
    let worktreePath = includedWorktreePath(side)
    return worktreePath
        ? { kind: "worktree", worktreePath }
        : ref.kind == "commit"
        ? { kind: "commit", objectId: ref.objectId }
        : ref.kind == "merge-base" && resolvedId
        ? { kind: "commit", objectId: resolvedId }
        : { kind: "branch", ref: ref.ref }
}

export function refName(ref: ComparisonRef) {
    if (ref.kind == "commit")
        return ref.tag ?? (ref.details?.subject || "Commit")

    return ref.kind == "branch" ? shortBranchRef(ref.ref) : `merge base of ${shortBranchRef(ref.ref)} and ${shortBranchRef(ref.withRef)}`
}

export function commitCredit(details: CommitDetails) {
    return `${details.authorName} · ${new Date(details.authoredAt * 1000).toLocaleString()}`
}

export function comparisonCommit({ objectId, subject, authorName, authoredAt }: CommitDetails & { objectId: string }): ComparisonRef {
    return { kind: "commit", objectId, details: { subject, authorName, authoredAt } }
}

function refKey(ref: ComparisonRef) {
    return ref.kind == "commit" ? ref.objectId : ref.kind == "branch" ? ref.ref : JSON.stringify([ref.ref, ref.withRef])
}

function branchRefs(ref: ComparisonRef) {
    return ref.kind == "commit" ? [] : ref.kind == "branch" ? [ref.ref] : [ref.ref, ref.withRef]
}
