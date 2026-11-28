import { gitText, normalize, readConflictState, readHistoricalEditSessions, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
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
 * Moves each local branch strictly behind its upstream to the upstream's tip, outside Operation History. A worktree
 * holding the branch has its files brought along, as long as it has no Working Changes. A branch is left for Pull
 * latest when it lies between the Base and the top of the Active Stack of an open column or of a branch a worktree
 * holds, when the worktree holding it has Working Changes or a Working Changes Conflict, or when an Unresolved Stack or
 * Historical Edit includes it. Called under the mutation lock.
 */
export async function fastForwardBranches(repo: RepositoryGit, request: FetchRequest, graphOptions: BranchGraphReadOptions) {
    let lines = await gitText(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:trackshort)", "refs/heads/"])
    let behind = lines.split("\n").filter(Boolean).map(line => line.split("\0") as [string, string, string, string])
        .filter(([, , upstream, track]) => upstream.startsWith("refs/remotes/") && track == "<")
    if (!behind.length)
        return []

    let worktrees = await readRegisteredWorktrees(repo)
    let held = new Set(worktrees.flatMap(worktree => worktree.branchRef ? [worktree.branchRef] : []))
    let conflicts = await readConflictState(repo)
    let left = new Set([
        ...conflicts.stacks.flatMap(stack => stack.branches.map(branch => branch.ref)),
        ...(await readHistoricalEditSessions(repo)).map(({ session }) => session.branch),
    ])
    // A held branch moves only when its files can come along: one worktree, still on disk, with no Working Changes
    // Conflict recorded against its HEAD.
    let conflicted = new Set(conflicts.working.map(conflict => normalize(conflict.path)))
    for (let ref of held) {
        let [holder, ...others] = worktrees.filter(worktree => worktree.branchRef == ref)
        if (others.length || holder!.missing || conflicted.has(normalize(holder!.path)))
            left.add(ref)
    }
    // Reading the Branch Graph costs most, so it waits until a branch could move.
    if (behind.some(([ref]) => !left.has(ref))) {
        let graph = await repo.startReadBranchGraph({ ...graphOptions, refreshRemote: false }).result
        for (let ref of new Set([...request.branches, ...held])) {
            // Moving a branch between the Base and the top would leave the branches built on it behind, so those wait for
            // Pull latest, which carries them along. A Base only moves forward, as Pull latest would move it, leaving the
            // stack on it to Restack.
            for (let item of (await readActiveStack(repo, graph, ref))?.branches.slice(1, -1) ?? [])
                left.add(item.ref)
        }
    }

    let moved: string[] = []
    for (let [ref, local, upstream] of behind.filter(([ref]) => !left.has(ref))) {
        let tip = await repo.resolveRef(upstream)
        if (!tip)
            continue
        let holder = worktrees.find(worktree => worktree.branchRef == ref)
        if (holder && !await moveWorktreeFiles(repo, holder.path, ref, local, tip))
            continue
        // A branch that moved since it was read keeps its new tip. Updating it from its worktree logs the move in that
        // worktree's HEAD reflog too, as Git's own fast-forward would.
        let result = await repo.run(holder?.path ?? repo.descriptor.mainWorktree, [
            "update-ref",
            "-m",
            `laneway: fast-forward to ${upstream.slice(13)}`,
            ref,
            tip,
            local,
        ])
        if (result.exitCode == 0) {
            await forgetPulledUpstream(repo, ref)
            moved.push(ref)
        } else if (holder) {
            await repo.run(holder.path, ["read-tree", "-m", "-u", tip, local])
        }
    }
    return moved
}

/**
 * Brings a worktree's index and files from `local` to `tip` as a checkout would, while the worktree is still on `ref` at
 * `local` with no Working Changes. Status takes Git's optional locks here so it refreshes the index's cached file stats,
 * without which read-tree would take a file whose stats alone changed for an edit and refuse.
 */
async function moveWorktreeFiles(repo: RepositoryGit, path: string, ref: string, local: string, tip: string) {
    let status = await repo.run(path, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=none"])
    if (status.exitCode)
        return false
    let entries = status.stdout.toString().split("\0").filter(Boolean)
    let header = (name: string) => entries.find(entry => entry.startsWith(`# branch.${name} `))?.slice(`# branch.${name} `.length)
    if (entries.some(entry => !entry.startsWith("# ")) || header("oid") != local || header("head") != ref.slice("refs/heads/".length))
        return false
    return (await repo.run(path, ["read-tree", "-m", "-u", local, tip])).exitCode == 0
}
