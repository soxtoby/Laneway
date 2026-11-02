import type { BranchGraph, BranchHistoryPage, BranchHistoryRequest, ComparisonRef, DiffSource } from "@laneway/shared"
import { conflictStateRef, readConflictState, temporaryBranchPrefix } from "./conflicts"
import type { RepositoryGit } from "./index"

/** Resolves a comparison whose branches sit in an unresolved stack to the stack's provisional tips. */
export async function conflictComparisonSource(repo: RepositoryGit, source: Extract<DiffSource, { kind: "refs" }>): Promise<DiffSource> {
    let state = await readConflictState(repo).catch(() => undefined)
    let refs = [source.from, source.to].flatMap(branchRefs)
    if (!state?.stacks.some(s => s.branches.some(b => refs.includes(b.ref))))
        return source

    let tip = async (ref: string) => {
        if (!/^refs\/(heads|remotes)\/.+/.test(ref))
            throw new Error("Choose a branch ref.")
        await repo.command(repo.descriptor.mainWorktree, ["check-ref-format", ref])
        let actual = await repo.resolveRef(ref)
        if (!actual)
            throw new Error("A compared branch is unavailable. Close this comparison.")

        let stack = state.stacks.find(s => s.branches.some(b => b.ref == ref))
        let boundary = stack?.branches.find(b => b.ref == ref)
        return boundary ? boundary == stack!.branches.at(-1) ? await repo.resolveRef(stack!.temporaryRef) ?? boundary.current : boundary.current : actual
    }
    let resolve = async (ref: ComparisonRef) => {
        if (ref.kind == "commit")
            return ref.objectId
        else if (ref.kind == "branch")
            return tip(ref.ref)
        else {
            let result = await repo.run(repo.descriptor.mainWorktree, ["merge-base", await tip(ref.ref), await tip(ref.withRef)])
            let mergeBase = result.stdout.toString().trim()
            if (result.exitCode != 0 || !mergeBase)
                throw new Error("The compared branches share no history.")
            return mergeBase
        }
    }

    return { kind: "comparison", fromObjectId: await resolve(source.from), toObjectId: await resolve(source.to) }
}

function branchRefs(ref: ComparisonRef) {
    return ref.kind == "commit" ? [] : ref.kind == "branch" ? [ref.ref] : [ref.ref, ref.withRef]
}

export async function projectConflictGraph(repo: RepositoryGit, graph: BranchGraph) {
    let state = await readConflictState(repo).catch(() => undefined)
    if (!state) {
        for (let branch of graph.branches)
            branch.unresolved = { subjects: [], recovery: "Conflict metadata is damaged. Use Operation History to restore the last recorded state." }
        return graph
    }

    let internal = new Set(state.stacks.map(s => s.temporaryRef))
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

    let mapping = new Map<string, string>()
    for (let stack of state.stacks) {
        let actual = await repo.resolveRef(stack.temporaryRef)
        let temporary = graph.branches.find(b => b.refs.includes(stack.temporaryRef))
        for (let boundary of stack.branches) {
            let branch = graph.branches.find(b => b.refs.includes(boundary.ref))
            if (!branch)
                continue

            let isTip = boundary == stack.branches.at(-1)
            let tip = isTip && actual ? actual : boundary.current
            let previous = branch.tip
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

            let index = stack.branches.indexOf(boundary)
            let base = index > 0 ? stack.branches[index - 1] : undefined
            if (base) {
                let node = graph.branches.find(b => b.refs.includes(base.ref))
                if (node)
                    branch.base = { status: "known", branchId: node.id, name: node.name, ref: base.ref, tip: base.current }
            } else {
                let baseNode = graph.branches.find(b =>
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
    let retained = [
        ...state.retainedConflicts,
        ...state.stacks.flatMap(s => s.steps).filter(s => s.conflict).map(s => ({ commit: s.current, conflict: s.conflict! })),
    ]
    let containing = await branchTipsContaining(repo, retained.map(conflict => conflict.commit))
    for (let branch of graph.branches) {
        if (branch.base.status != "known")
            branch.base.candidates = branch.base.candidates.filter(candidate => !internal.has(candidate.ref))

        let subjects = state.working.filter(w => w.branch && branch.refs.includes(w.branch)).map(w => w.conflict.id)
        if (subjects.length)
            branch.unresolved = { ...branch.unresolved, subjects: [...(branch.unresolved?.subjects ?? []), ...subjects] }

        if (!branch.unresolved) {
            let inherited = retained.filter(conflict => containing.get(conflict.commit)!.has(branch.tip)).map(conflict => conflict.conflict.id)
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

/**
 * The branch tips whose history holds each commit, by commit. Branches checked for inherited conflicts sit at their
 * refs' tips, so one ref query per commit replaces a history comparison per branch, which cost a Git launch each.
 */
async function branchTipsContaining(repo: RepositoryGit, commits: string[]) {
    let result = new Map<string, Set<string>>()
    for (let commit of new Set(commits)) {
        let output = await repo.run(repo.descriptor.mainWorktree, [
            "for-each-ref",
            "--format=%(objectname)",
            `--contains=${commit}`,
            "refs/heads/",
            "refs/remotes/",
        ])
        // A commit Git no longer has is in no branch's history.
        result.set(commit, new Set(output.exitCode ? [] : output.stdout.toString().split("\n").filter(Boolean)))
    }
    return result
}

export async function conflictHistoryRequest(repo: RepositoryGit, request: BranchHistoryRequest) {
    let readRefs = async () =>
        new Map(
            (await repo.command(repo.descriptor.mainWorktree, ["for-each-ref", "--format=%(refname) %(objectname)", conflictStateRef, temporaryBranchPrefix]))
                .toString().trim().split("\n").filter(Boolean).map(line => line.trim().split(" ") as [string, string]),
        )

    let before = await readRefs()
    let token = before.get(conflictStateRef) ?? null
    let state = await readConflictState(repo, token).catch(() => undefined)
    let stack = state?.stacks.find(s => s.branches.some(b => b.ref == request.branchRef))
    if (!stack)
        return { request, decorate: (page: BranchHistoryPage) => page }

    let boundary = stack.branches.find(b => b.ref == request.branchRef)!
    let temporaryTip = before.get(stack.temporaryRef) ?? null
    let tip = boundary == stack.branches.at(-1) ? temporaryTip ?? boundary.current : boundary.current
    if (tip != request.tip)
        throw new Error("The provisional branch changed. Refresh its history.")

    return {
        request: { ...request, branchRef: tip },
        async decorate(page: BranchHistoryPage) {
            let after = await readRefs()
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
