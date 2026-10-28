import { gitText, readConflictState, readHistoricalEditSessions, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import type { BranchGraphReadOptions, FetchRequest, PullFetch } from "@laneway/shared"
import { readActiveStack } from "./active-stack"
import { fetchRemote } from "./pull-latest"
import { forgetPulledUpstream, readRemoteTips } from "./pulled-upstreams"

export type FetchProgressReporter = (message: string, completed: number, total: number) => void

export type FetchPreparation =
    | { kind: "no-remotes" }
    // Remote-tracking tips from before fetching, for recording the upstreams the fetches moved.
    | { kind: "fetched" | "cancelled"; fetches: PullFetch[]; trackingBefore: Map<string, string> }

/** Fetches the requested or selected remote and every remote a local branch tracks, once each, with pruning. */
export async function fetchLatest(
    repo: RepositoryGit,
    request: FetchRequest,
    graphOptions: BranchGraphReadOptions,
    cancelled: () => boolean,
    progress: FetchProgressReporter,
): Promise<FetchPreparation> {
    let remotes = (await gitText(repo, ["remote"])).split("\n").filter(Boolean)
    if (!remotes.length)
        return { kind: "no-remotes" }

    let tracked = (await gitText(repo, ["for-each-ref", "--format=%(upstream:remotename)", "refs/heads/"])).split("\n")
    let selected = request.remote ?? graphOptions.selectedRemote
    let toFetch = remotes.filter(remote => remote == selected || tracked.includes(remote))
    if (!toFetch.length)
        toFetch.push(...remotes.slice(0, 1))

    let trackingBefore = await readRemoteTips(repo)
    let fetches: PullFetch[] = []
    for (let [index, remote] of toFetch.entries()) {
        if (cancelled())
            return { kind: "cancelled", fetches, trackingBefore }
        progress(`Fetching ${remote}…`, index, toFetch.length)
        fetches.push(await fetchRemote(repo, remote))
    }
    return { kind: "fetched", fetches, trackingBefore }
}

/**
 * Moves each local branch strictly behind its upstream to the upstream's tip, outside Operation History. A branch is
 * left for Pull latest when a worktree holds it, when it belongs to the Active Stack of an open column or of a branch
 * a worktree holds, or when an Unresolved Stack or Historical Edit includes it. Called under the mutation lock.
 */
export async function fastForwardBranches(repo: RepositoryGit, request: FetchRequest, graphOptions: BranchGraphReadOptions) {
    let lines = await gitText(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:trackshort)", "refs/heads/"])
    let behind = lines.split("\n").filter(Boolean).map(line => line.split("\0") as [string, string, string, string])
        .filter(([, , upstream, track]) => upstream.startsWith("refs/remotes/") && track == "<")
    if (!behind.length)
        return []

    let worktrees = await readRegisteredWorktrees(repo)
    let held = worktrees.flatMap(worktree => worktree.branchRef ? [worktree.branchRef] : [])
    let left = new Set([
        ...held,
        ...(await readConflictState(repo)).stacks.flatMap(stack => stack.branches.map(branch => branch.ref)),
        ...(await readHistoricalEditSessions(repo)).map(({ session }) => session.branch),
    ])
    // Reading the Branch Graph costs most, so it waits until a branch could move.
    if (behind.some(([ref]) => !left.has(ref))) {
        let graph = await repo.startReadBranchGraph({ ...graphOptions, refreshRemote: false }).result
        for (let ref of new Set([...request.branches, ...held])) {
            for (let item of (await readActiveStack(repo, graph, ref))?.branches ?? [])
                left.add(item.ref)
        }
    }

    let moved: string[] = []
    for (let [ref, local, upstream] of behind.filter(([ref]) => !left.has(ref))) {
        let tip = await repo.resolveRef(upstream)
        if (!tip)
            continue
        // A branch that moved since it was read keeps its new tip.
        let result = await repo.run(repo.descriptor.mainWorktree, ["update-ref", "-m", `laneway: fast-forward to ${upstream.slice(13)}`, ref, tip, local])
        if (result.exitCode == 0) {
            await forgetPulledUpstream(repo, ref)
            moved.push(ref)
        }
    }
    return moved
}
