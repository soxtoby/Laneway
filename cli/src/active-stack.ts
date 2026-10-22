import type { RepositoryGit } from "@laneway/git"
import type { BranchGraph, BranchGraphBranchNode } from "@laneway/shared"

export interface ActiveStack {
    // Stack order: the Base Branch first, the column's branch last.
    branches: Array<{ node: BranchGraphBranchNode; ref: string }>
    // The branch whose Base is ambiguous; the chain stops at it.
    ambiguous?: string
}

// The Active Stack ending at a local branch, derived from Branch Graph Base inference.
export async function readActiveStack(repo: RepositoryGit, graph: BranchGraph, ref: string): Promise<ActiveStack | undefined> {
    let branch = graph.branches.find(candidate => candidate.localRefs.includes(ref))
    if (!branch)
        return undefined

    let stack: ActiveStack = { branches: [{ node: branch, ref }] }
    let members = new Set([branch.id])
    let current = branch
    for (;;) {
        let known = current.base
        // Branches that diverged from each other name each other as Base. Below the loop, use the
        // next closest branch outside this chain so the stack still reaches its integration target.
        if (known.status == "known" && members.has(known.branchId))
            known = await nearestBase(repo, graph, current, members)
        if (known.status == "ambiguous") {
            stack.ambiguous = current.name
            break
        }
        if (known.status != "known")
            break
        let base = graph.branches.find(candidate => candidate.id == known.branchId)
        if (!base)
            break
        stack.branches.unshift({ node: base, ref: base.preferredRef })
        members.add(base.id)
        if (base.primary || base.remoteOnly)
            break
        current = base
    }
    return stack
}

export async function isAncestor(repo: RepositoryGit, ancestor: string, descendant: string) {
    let result = await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", ancestor, descendant])
    if (result.exitCode == 0)
        return true
    if (result.exitCode == 1)
        return false
    throw new Error(result.stderr.toString().trim() || "Git could not compare histories.")
}

// Mirrors Branch Graph Base inference restricted to branches outside the current chain.
async function nearestBase(
    repo: RepositoryGit,
    graph: { branches: BranchGraphBranchNode[] },
    branch: BranchGraphBranchNode,
    excluded: Set<string>,
): Promise<BranchGraphBranchNode["base"]> {
    let candidates: Array<{ candidate: BranchGraphBranchNode; objectId: string }> = []
    for (let candidate of graph.branches) {
        if (excluded.has(candidate.id) || candidate.tip == branch.tip)
            continue
        let result = await repo.run(repo.descriptor.mainWorktree, ["merge-base", branch.tip, candidate.tip])
        if (result.exitCode == 0)
            candidates.push({ candidate, objectId: result.stdout.toString().trim() })
    }

    let closest: typeof candidates = []
    for (let entry of candidates) {
        let dominated = false
        for (let other of candidates) {
            if (other.objectId != entry.objectId && await isAncestor(repo, entry.objectId, other.objectId)) {
                dominated = true
                break
            }
        }
        if (!dominated)
            closest.push(entry)
    }

    let unique = [...new Map(closest.map(entry => [entry.candidate.id, entry])).values()]
    if (!unique.length)
        return { status: "unknown", candidates: [] }

    let preferred = unique.length == 1
        ? unique[0]
        : new Set(unique.map(entry => entry.objectId)).size == 1
        ? unique.find(entry => entry.candidate.primary)
        : undefined
    if (preferred) {
        let { candidate } = preferred
        return { status: "known", branchId: candidate.id, name: candidate.name, ref: candidate.preferredRef, tip: candidate.tip }
    }
    return {
        status: "ambiguous",
        candidates: unique.map(({ candidate }) => ({ branchId: candidate.id, name: candidate.name, ref: candidate.preferredRef, tip: candidate.tip })),
    }
}
