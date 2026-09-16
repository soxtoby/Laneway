import type { BranchGraph, BranchHistoryPage, BranchHistoryRequest, DiffSource } from "@git-workbench/shared"
import { conflictStateRef, readConflictState, temporaryBranchPrefix } from "./conflicts"
import type { RepositoryGit } from "./index"

export async function conflictComparisonSource(repo: RepositoryGit, source: Extract<DiffSource, { kind: "branches" }>): Promise<DiffSource> {
    const state = await readConflictState(repo).catch(() => undefined)
    if (!state?.stacks.some(s => s.branches.some(b => b.ref == source.fromRef || b.ref == source.toRef)))
        return source
    const tips = await Promise.all([source.fromRef, source.toRef].map(async ref => {
        if (!/^refs\/(heads|remotes)\/.+/.test(ref))
            throw new Error("Choose a branch ref.")
        await repo.command(repo.descriptor.mainWorktree, ["check-ref-format", ref])
        const actual = await repo.resolveRef(ref)
        if (!actual)
            throw new Error("A compared branch is unavailable. Retarget or close this comparison.")
        const stack = state.stacks.find(s => s.branches.some(b => b.ref == ref))
        const boundary = stack?.branches.find(b => b.ref == ref)
        return boundary ? boundary == stack!.branches.at(-1) ? await repo.resolveRef(stack!.temporaryRef) ?? boundary.current : boundary.current : actual
    }))
    return { kind: "comparison", fromObjectId: tips[0], toObjectId: tips[1] }
}

export async function projectConflictGraph(repo: RepositoryGit, graph: BranchGraph) {
    const state = await readConflictState(repo).catch(() => undefined)
    if (!state) {
        for (const branch of graph.branches)
            branch.unresolved = { subjects: [], recovery: "Conflict metadata is damaged. Use Operation History to restore the last recorded state." }
        return graph
    }
    const internal = new Set(state.stacks.map(s => s.temporaryRef))
    graph.branches = graph.branches.flatMap(branch => {
        if (branch.localRefs.length < 2 || !branch.refs.some(ref => internal.has(ref)))
            return [branch]
        return branch.localRefs.map(ref => ({
            ...branch,
            id: `branch:${ref}`,
            name: ref.slice(11),
            preferredRef: ref,
            localRefs: [ref],
            refs: [ref, ...(ref == branch.preferredRef ? branch.remoteRefs : [])],
            aliases: [ref.slice(11)],
            checkedOut: branch.checkedOut.filter(worktree => worktree.branchRef == ref),
        }))
    })
    const mapping = new Map<string, string>()
    for (const stack of state.stacks) {
        const actual = await repo.resolveRef(stack.temporaryRef)
        const temporary = graph.branches.find(b => b.refs.includes(stack.temporaryRef))
        for (const boundary of stack.branches) {
            const branch = graph.branches.find(b => b.refs.includes(boundary.ref))
            if (!branch)
                continue
            const isTip = boundary == stack.branches.at(-1)
            const tip = isTip && actual ? actual : boundary.current
            const previous = branch.tip
            branch.tip = tip
            mapping.set(previous, tip)
            branch.unresolved = {
                stackId: stack.id,
                subjects: stack.steps.flatMap(s => s.conflict ? [s.conflict.id] : []),
                temporaryRef: stack.temporaryRef,
                ...(!actual ? { recovery: "The unresolved branch is missing." } : {}),
            }
            branch.involvement = "involved"
            branch.merged = false
            if (isTip && temporary) {
                branch.checkedOut = [...branch.checkedOut, ...temporary.checkedOut.map(w => ({ ...w, branchRef: boundary.ref }))]
                mapping.set(temporary.id, branch.id)
            }
            const index = stack.branches.indexOf(boundary)
            const base = index > 0 ? stack.branches[index - 1] : undefined
            if (base) {
                const node = graph.branches.find(b => b.refs.includes(base.ref))
                if (node)
                    branch.base = { status: "known", branchId: node.id, name: node.name, ref: base.ref, tip: base.current }
            } else {
                const baseNode = graph.branches.find(b =>
                    !b.refs.some(ref => internal.has(ref)) && (b.tip == stack.base || stack.dependency?.branch && b.refs.includes(stack.dependency.branch))
                )
                if (baseNode)
                    branch.base = { status: "known", branchId: baseNode.id, name: baseNode.name, ref: baseNode.preferredRef, tip: stack.base }
                else if (branch.base.status == "known")
                    branch.base.tip = stack.base
            }
        }
    }
    graph.branches = graph.branches.filter(b => !b.refs.some(ref => internal.has(ref)))
    for (const branch of graph.branches) {
        if (branch.base.status != "known")
            branch.base.candidates = branch.base.candidates.filter(candidate => !internal.has(candidate.ref))
        const subjects = state.working.filter(w => w.branch && branch.refs.includes(w.branch)).map(w => w.conflict.id)
        if (subjects.length)
            branch.unresolved = { ...branch.unresolved, subjects: [...(branch.unresolved?.subjects ?? []), ...subjects] }
        if (!branch.unresolved) {
            const inherited: string[] = []
            const retained = [
                ...state.retainedConflicts,
                ...state.stacks.flatMap(s => s.steps).filter(s => s.conflict).map(s => ({ commit: s.current, conflict: s.conflict! })),
            ]
            for (const conflict of retained) {
                if (!(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", conflict.commit, branch.tip])).exitCode)
                    inherited.push(conflict.conflict.id)
            }
            if (inherited.length) {
                branch.unresolved = {
                    subjects: [...new Set(inherited)],
                    recovery: "This branch contains an unresolved commit. Rebase this branch to replay its remaining conflicts before publishing.",
                }
            }
        }
        if (branch.refs.some(ref => ref.startsWith(temporaryBranchPrefix)) && !branch.unresolved)
            branch.unresolved = { subjects: [], recovery: "Conflict metadata is unavailable." }
    }
    graph.history = graph.history.map(point => ({
        ...point,
        objectId: mapping.get(point.objectId) ?? point.objectId,
        lineId: mapping.get(point.lineId) ?? point.lineId,
        parentIds: point.parentIds.map(parent => mapping.get(parent) ?? parent),
    }))
    graph.history = graph.history.filter((point, index, points) =>
        points.findIndex(p => p.objectId == point.objectId) == index && !point.parentIds.includes(point.objectId)
    )
    return graph
}

export async function conflictHistoryRequest(repo: RepositoryGit, request: BranchHistoryRequest) {
    const readRefs = async () =>
        new Map(
            (await repo.command(repo.descriptor.mainWorktree, ["for-each-ref", "--format=%(refname) %(objectname)", conflictStateRef, temporaryBranchPrefix]))
                .toString().trim().split("\n").filter(Boolean).map(line => line.trim().split(" ") as [string, string]),
        )
    const before = await readRefs()
    const token = before.get(conflictStateRef) ?? null
    const state = await readConflictState(repo, token).catch(() => undefined)
    const stack = state?.stacks.find(s => s.branches.some(b => b.ref == request.branchRef))
    if (!stack)
        return { request, decorate: (page: BranchHistoryPage) => page }
    const boundary = stack.branches.find(b => b.ref == request.branchRef)!
    const temporaryTip = before.get(stack.temporaryRef) ?? null
    const tip = boundary == stack.branches.at(-1) ? temporaryTip ?? boundary.current : boundary.current
    if (tip != request.tip)
        throw new Error("The provisional branch changed. Refresh its history.")
    return {
        request: { ...request, branchRef: tip },
        async decorate(page: BranchHistoryPage) {
            const after = await readRefs()
            if ((after.get(conflictStateRef) ?? null) != token || (after.get(stack.temporaryRef) ?? null) != temporaryTip)
                throw new Error("Conflict history changed while loading. Refresh the branch.")
            return {
                ...page,
                branchRef: request.branchRef,
                commits: page.commits.map(commit => ({ ...commit, conflictId: stack.steps.find(s => s.current == commit.objectId)?.conflict?.id })),
            }
        },
    }
}
