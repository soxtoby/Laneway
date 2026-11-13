import { gitText, readHistoricalEditSessions, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import type { BranchGraphBranchNode, BranchGraphReadOptions, PullFetch, PullRequest, PullStackOutcome } from "@laneway/shared"
import { isAncestor, readActiveStack } from "./active-stack"
import { type ConflictSession, gitHead, openConflictSession, rewriteStack, type StackRewritePlan } from "./conflicts/conflict-operations"
import type { ChangeRecorder } from "./operations/change-recorder"
import { forgetPulledUpstream, laneFetch, readPulledUpstreams, readRemoteTips, savePulledUpstream } from "./pulled-upstreams"

type Changes = ChangeRecorder
export type PullProgressReporter = (message: string, completed: number, total: number) => void

interface ScopedBranch {
    /** Its Branch Node, which branches sharing its tip share. */
    id: string
    ref: string
    name: string
    tip: string
    remoteOnly: boolean
    primary: boolean
    upstream?: { ref: string; remote: string }
}
interface ScopedStack {
    id: string
    // Stack order: the Base Branch first, the column's branch last.
    branches: ScopedBranch[]
}
export type PullPreparation =
    | { kind: "no-remotes" }
    // Remote-tracking tips from before fetching, for recording the upstreams the fetches moved.
    | { kind: "cancelled"; fetches: PullFetch[]; trackingBefore: Map<string, string> }
    | {
        kind: "prepared"
        fetches: PullFetch[]
        trackingBefore: Map<string, string>
        stacks: ScopedStack[]
        blocked: PullStackOutcome[]
        remotesFor: (stack: ScopedStack) => string[]
        /**
         * Each local branch's upstream, with the Branch Node its stack rests on the Primary Branch by. While the
         * upstream exists the branch is published, and a pull leaves that node where it is while the Primary Branch only
         * moves forward. Empty when the pull was asked to restack those too.
         */
        anchors: Array<{ upstream: string; anchor: string }>
    }

// Explains why a stack was left untouched; anything else is reported as a failure.
class PullSkip extends Error {}

export async function preparePull(
    repo: RepositoryGit,
    request: PullRequest,
    graphOptions: BranchGraphReadOptions,
    cancelled: () => boolean,
    progress: PullProgressReporter,
): Promise<PullPreparation> {
    let remotes = (await gitText(repo, ["remote"])).split("\n").filter(Boolean)
    if (!remotes.length)
        return { kind: "no-remotes" }

    let graph = await repo.startReadBranchGraph({ ...graphOptions, refreshRemote: false }).result
    let upstreams = new Map<string, { ref: string; remote: string }>()
    let tracking = await gitText(repo, ["for-each-ref", "--format=%(refname)%00%(upstream)%00%(upstream:remotename)", "refs/heads/"])
    for (let line of tracking.split("\n").filter(Boolean)) {
        let [ref, upstream, remote] = line.split("\0")
        if (ref && upstream && remote)
            upstreams.set(ref, { ref: upstream, remote })
    }
    let remoteOf = (remoteRef: string) =>
        remotes.filter(remote => remoteRef.startsWith(`refs/remotes/${remote}/`)).sort((left, right) => right.length - left.length)[0]
    let scoped = (branch: BranchGraphBranchNode, ref: string): ScopedBranch => ({
        id: branch.id,
        ref,
        name: shortName(ref),
        tip: branch.tip,
        remoteOnly: branch.remoteOnly,
        primary: branch.primary,
        upstream: branch.remoteOnly ? undefined : upstreams.get(ref),
    })

    // Read from the whole graph, so a published branch holds what it is built on whether or not its column is open.
    let anchors: Array<{ upstream: string; anchor: string }> = []
    let nodes = new Map(graph.branches.map(branch => [branch.id, branch]))
    for (let branch of request.restack ? [] : graph.branches) {
        let tracked = branch.localRefs.flatMap(ref => upstreams.get(ref)?.ref ?? [])
        let seen = new Set<string>()
        for (let current = branch; tracked.length && current.base.status == "known" && !seen.has(current.id);) {
            seen.add(current.id)
            let base = nodes.get(current.base.branchId)
            if (!base || base.remoteOnly && !base.primary)
                break
            if (base.primary) {
                anchors.push(...tracked.map(upstream => ({ upstream, anchor: current.id })))
                break
            }
            current = base
        }
    }

    let candidates: Array<{ chain: ScopedBranch[]; ambiguous?: string }> = []
    for (let ref of [...new Set([...request.branches, ...request.open ?? []])]) {
        let stack = await readActiveStack(repo, graph, ref)
        if (stack)
            candidates.push({ chain: stack.branches.map(item => scoped(item.node, item.ref)), ambiguous: stack.ambiguous })
    }
    // An open stack joins one in scope when they share a branch above their Bases, which the pull may replace; a
    // shared Base only moves forward, leaving the stacks on it intact.
    let inScope = candidates.filter(candidate => request.branches.includes(candidate.chain.at(-1)!.ref))
    let own = new Set(inScope.flatMap(candidate => candidate.chain.slice(1).map(branch => branch.ref)))
    for (let joined = true; joined;) {
        joined = false
        for (let candidate of candidates.filter(candidate => !inScope.includes(candidate))) {
            if (candidate.chain.slice(1).some(branch => own.has(branch.ref))) {
                inScope.push(candidate)
                for (let branch of candidate.chain.slice(1))
                    own.add(branch.ref)
                joined = true
            }
        }
    }

    let stacks: ScopedStack[] = []
    let blocked: PullStackOutcome[] = []
    for (let { chain, ambiguous } of inScope) {
        let id = crypto.randomUUID()
        if (ambiguous) {
            let message = `The Base of ${ambiguous} is ambiguous. Choose its Base in the Branch Graph, then pull again.`
            blocked.push({ id, branches: chain.map(item => item.name), status: "skipped", message })
        } else {
            stacks.push({ id, branches: chain })
        }
    }

    // Longer chains first so an Active Stack that extends another synchronizes the shared prefix as one unit.
    stacks.sort((left, right) => right.branches.length - left.branches.length)

    let remotesFor = (stack: ScopedStack) => {
        let needed = new Set<string>()
        for (let branch of stack.branches) {
            if (branch.upstream)
                needed.add(branch.upstream.remote)
            let remote = branch.remoteOnly ? remoteOf(branch.ref) : undefined
            if (remote)
                needed.add(remote)
        }
        return [...needed]
    }
    let selected = request.remote && remotes.includes(request.remote) ? request.remote : graph.selectedRemote
    let toFetch = [...new Set([...(selected ? [selected] : []), ...stacks.flatMap(remotesFor)])].filter(remote => remotes.includes(remote))
    if (!toFetch.length)
        toFetch.push(...remotes.slice(0, 1))

    let trackingBefore = await readRemoteTips(repo)
    let total = toFetch.length + stacks.length
    let fetches: PullFetch[] = []
    for (let [index, remote] of toFetch.entries()) {
        if (cancelled())
            return { kind: "cancelled", fetches, trackingBefore }
        progress(`Fetching ${remote}…`, index, total)
        fetches.push(await fetchRemote(repo, remote))
    }
    return { kind: "prepared", fetches, trackingBefore, stacks, blocked, remotesFor, anchors }
}

export async function fetchRemote(repo: RepositoryGit, remote: string): Promise<PullFetch> {
    let result = await repo.run(main(repo), [...laneFetch, "--", remote])
    return result.exitCode == 0
        ? { remote, status: "fetched" }
        : { remote, status: "failed", message: result.stderr.toString().trim() || `Git could not fetch ${remote}.` }
}

export async function executePull(
    repo: RepositoryGit,
    prepared: Extract<PullPreparation, { kind: "prepared" }>,
    changes: Changes,
    cancelled: () => boolean,
    progress: PullProgressReporter,
): Promise<PullStackOutcome[]> {
    let session = await openConflictSession(repo, changes)
    let initialState = JSON.stringify(session.state)
    let worktrees = (await readRegisteredWorktrees(repo)).filter(worktree => !worktree.missing)
    let headsBefore = new Map<string, string>()
    for (let worktree of worktrees)
        headsBefore.set(worktree.path, await gitHead(repo, worktree.path))

    let editing = new Map((await readHistoricalEditSessions(repo)).map(({ session }) => [session.branch, session]))
    let held = heldBranches(prepared.stacks, editing)
    let failedRemotes = new Set(prepared.fetches.filter(fetch => fetch.status == "failed").map(fetch => fetch.remote))
    let pulled = await readPulledUpstreams(repo)
    // An upstream the fetch pruned no longer publishes its branch.
    let remoteTips = prepared.anchors.length ? await readRemoteTips(repo) : new Map<string, string>()
    let anchors = new Set(prepared.anchors.filter(item => remoteTips.has(item.upstream)).map(item => item.anchor))
    let processed = new Map<string, { before: string; current: string }>()
    let outcomes: PullStackOutcome[] = [...prepared.blocked]

    let total = prepared.fetches.length + prepared.stacks.length

    for (let [index, stack] of prepared.stacks.entries()) {
        let names = stack.branches.map(branch => branch.name)
        if (cancelled()) {
            outcomes.push({ id: stack.id, branches: names, status: "cancelled", message: "Cancelled before this stack was updated." })
            continue
        }
        progress(`Updating ${names.at(-1)}…`, prepared.fetches.length + index, total)
        let snapshot = new Map(changes)
        let working = session.state.working.length
        try {
            let own = stack.branches.slice(1)
            if (own.some(branch => held.has(branch.ref))) {
                let edit = own.map(branch => editing.get(branch.ref)).find(Boolean)
                throw new PullSkip(
                    edit
                        ? `${edit.branch.slice(11)} is in a Historical Edit in ${edit.path}, so this stack was not updated.`
                        : "This stack overlaps one in a Historical Edit, so it was not updated.",
                )
            }
            let failed = prepared.remotesFor(stack).filter(remote => failedRemotes.has(remote))
            if (failed.length) {
                let messages = prepared.fetches.filter(fetch => failed.includes(fetch.remote)).map(fetch => `${fetch.remote}: ${fetch.message}`)
                throw new PullSkip(`Fetching ${failed.join(", ")} failed, so this stack was not updated. ${messages.join(" ")}`)
            }
            outcomes.push(await updateStack(repo, session, stack, pulled, anchors, processed, changes, cancelled, working))
        } catch (error) {
            if ([...changes].some(([ref, value]) => !snapshot.has(ref) || snapshot.get(ref) != value))
                throw error
            let message = error instanceof Error ? error.message : String(error)
            outcomes.push(
                error instanceof PullSkip
                    ? { id: stack.id, branches: names, status: "skipped", message }
                    : /changed during replay|moved while preparing/i.test(message)
                    ? { id: stack.id, branches: names, status: "failed", message: `Changed during pull—retry. ${message}` }
                    : { id: stack.id, branches: names, status: "failed", message },
            )
        }
    }

    // Keep existing Working Changes Conflicts resolvable on worktrees whose HEAD moved with their branch.
    for (let conflict of session.state.working.filter(item => !item.suspended)) {
        let before = headsBefore.get(conflict.path)
        if (before == undefined || before != conflict.head)
            continue
        let after = await gitHead(repo, conflict.path)
        if (after != before) {
            conflict.head = after
            conflict.beforeTree = undefined
            conflict.beforeIndex = undefined
            conflict.afterIndex = undefined
        }
    }

    if (JSON.stringify(session.state) != initialState)
        await session.persist()

    return outcomes
}

/**
 * The branches of every stack holding a Historical Edit, found before any update so that processing order doesn't matter.
 * Stacks sharing one are skipped with it; a shared Base alone is not an overlap.
 */
function heldBranches(stacks: ScopedStack[], editing: Map<string, unknown>) {
    let own = stacks.map(stack => stack.branches.slice(1).map(branch => branch.ref))
    return new Set(own.filter(refs => refs.some(ref => editing.has(ref))).flat())
}

async function updateStack(
    repo: RepositoryGit,
    session: ConflictSession,
    stack: ScopedStack,
    pulled: Map<string, string | null>,
    // The Branch Nodes that published branches rest on the Primary Branch by.
    anchors: Set<string>,
    processed: Map<string, { before: string; current: string }>,
    changes: Changes,
    cancelled: () => boolean,
    workingBefore: number,
): Promise<PullStackOutcome> {
    let { state } = session
    let names = stack.branches.map(branch => branch.name)
    let stackOf = (ref: string) => state.stacks.find(item => item.branches.some(branch => branch.ref == ref))
    let currentTip = async (branch: ScopedBranch) => {
        let unresolved = stackOf(branch.ref)?.branches.find(item => item.ref == branch.ref)
        let tip = unresolved?.before ?? await repo.resolveRef(branch.ref)
        if (!tip)
            throw new PullSkip(`${branch.name} no longer exists.`)
        if (!unresolved && tip != branch.tip)
            throw new Error("Changed during pull—retry. A branch moved after this pull was prepared.")
        return tip
    }
    let upstreamTip = async (branch: ScopedBranch) => {
        if (!branch.upstream)
            return null
        // A vanished upstream leaves nothing to incorporate; the branch still synchronizes onto its Base.
        return repo.resolveRef(branch.upstream.ref)
    }
    // Inside the pull's operation, so undoing the pull restores what the branch last pulled.
    let forget = async (ref: string) => {
        if (pulled.delete(ref))
            await forgetPulledUpstream(repo, ref)
    }
    // A branch replayed onto another Base holds copies of its upstream's commits, so only the record says it pulled them.
    let settle = async (ref: string, upstream: string, tip: string) => {
        if (!pulled.has(ref))
            return
        if (await isAncestor(repo, upstream, tip))
            return forget(ref)
        pulled.set(ref, upstream)
        await savePulledUpstream(repo, ref, upstream)
    }

    // Branches already synchronized by an overlapping stack in this pull form the effective Base.
    let position = 0
    for (let index = stack.branches.length - 1; index >= 0; index--) {
        if (processed.has(stack.branches[index]!.ref)) {
            position = index
            break
        }
    }
    // A single-branch stack also has position 0 at its last index, so check the tip itself was processed.
    if (processed.has(stack.branches.at(-1)!.ref)) {
        let refs = new Set(stack.branches.map(branch => branch.ref))
        let conflicts = state.stacks.filter(item => item.branches.some(branch => refs.has(branch.ref)))
            .flatMap(item => item.steps).filter(step => step.conflict).length
        let moved = stack.branches.some(branch => {
            let entry = processed.get(branch.ref)
            return entry != undefined && entry.before != entry.current
        })
        return {
            id: stack.id,
            branches: names,
            status: conflicts ? "needs-resolution" : moved ? "updated" : "current",
            message: conflicts
                ? `${conflicts} commit conflict${conflicts == 1 ? "" : "s"} deferred for inline resolution.`
                : moved
                ? "Updated with an overlapping stack."
                : "Already current.",
            conflicts,
        }
    }

    let baseOld: string, baseNew: string
    let changed = false
    let base = stack.branches[position]!
    let baseOutcome: PullStackOutcome["base"] = { ref: base.ref, before: null, after: null }
    if (processed.has(base.ref)) {
        ;({ before: baseOld, current: baseNew } = processed.get(base.ref)!)
    } else if (base.remoteOnly) {
        let tip = await repo.resolveRef(base.ref)
        if (!tip)
            throw new PullSkip(`${base.name} no longer exists on its remote, so this stack has no Base to synchronize onto.`)
        baseOld = baseNew = tip
    } else {
        if (stackOf(base.ref))
            throw new PullSkip(`${base.name} is part of an Unresolved Stack. Resolve it before using it as a Base.`)
        let local = await currentTip(base)
        let upstream = await upstreamTip(base)
        baseOld = local
        if (!upstream || upstream == local || await isAncestor(repo, upstream, local))
            baseNew = local
        else if (await isAncestor(repo, local, upstream)) {
            if (cancelled())
                return { id: stack.id, branches: names, status: "cancelled", message: "Cancelled before this stack was updated." }
            await rewriteStack(repo, session, { refs: [base.ref], base: upstream, sources: [[]] }, changes, cancelled)
            await forget(base.ref)
            baseNew = upstream
            changed = true
        } else {
            throw new PullSkip(
                `Base has diverged. ${base.name} and ${shortName(base.upstream!.ref)} both have new commits. `
                    + "Reconcile the Base explicitly, then pull again.",
            )
        }
    }

    baseOutcome.before = baseOld
    baseOutcome.after = baseNew
    processed.set(base.ref, { before: baseOld, current: baseNew })

    // Plan each feature branch: incoming upstream history first, then local-only commits.
    let placed = [...new Set([baseOld, baseNew])]
    interface Planned {
        branch: ScopedBranch
        local: string
        upstream: string | null
        sources: string[]
        existing: boolean
        incoming: boolean
        /** The stack's anchor with nothing arriving: it stays as it is. */
        held: boolean
        /** The anchor's upstream tip, which its replay starts from in place of the Base's tip. */
        onto?: string
    }
    let planned: Planned[] = []
    // A branch that is published, or has a published branch built on it, stays where it is while the Primary Branch under
    // it only moves forward, since moving it would rewrite published history; it still takes its own upstream's commits.
    // Only the lowest branch can stay: the Primary Branch remains a branch's Base however far it moves on, but any other
    // branch stops being one once it moves past the fork, so the branches above follow the one below them as ever.
    let lowest = stack.branches[position + 1]
    let anchored = position == 0 && base.primary && lowest != undefined && anchors.has(lowest.id)
        && (baseOld == baseNew || await isAncestor(repo, baseOld, baseNew))
    for (let branch of stack.branches.slice(position + 1)) {
        let existing = Boolean(stackOf(branch.ref))
        let stays = anchored && branch == lowest
        let local = await currentTip(branch)
        let upstream = await upstreamTip(branch)
        let previousUpstream = pulled.has(branch.ref) ? pulled.get(branch.ref)! : upstream
        // The provisional tip of an Unresolved Stack already carries its retained steps.
        let retainedTip = existing ? (await repo.resolveRef(stackOf(branch.ref)!.temporaryRef)) ?? local : local
        let sources: string[] = []
        let incoming = false
        let held = false
        let onto: string | undefined
        let lacking = upstream != null && upstream != local && !(await isAncestor(repo, upstream, local))
        let behind = lacking && await isAncestor(repo, local, upstream!)
        if (!upstream || !lacking || !behind && upstream == previousUpstream) {
            // Nothing arrived: the branch holds its upstream's commits, or its local history was rewritten since the
            // last pull and its publication is pending.
            if (stays)
                held = true
            else if (!existing)
                sources = await linear(repo, [local], placed)
        } else if (behind) {
            if (stays && !existing)
                onto = upstream
            else
                sources = await linear(repo, [upstream], existing ? [...placed, local] : placed)
            incoming = true
        } else {
            let rewritten = Boolean(previousUpstream) && !(await isAncestor(repo, previousUpstream!, upstream))
            if (rewritten) {
                if (!(await isAncestor(repo, local, previousUpstream!))) {
                    throw new PullSkip(
                        `${shortName(branch.upstream!.ref)} was rewritten and ${branch.name} has local commits. `
                            + "Laneway cannot identify which local commits to retain. Inspect both histories, reconcile explicitly, then pull again.",
                    )
                }
                if (stays && !existing)
                    onto = upstream
                else
                    sources = await linear(repo, [upstream], existing ? [...placed, local] : placed)
            } else if (existing) {
                // Only upstream commits whose changes are not already retained in the provisional stack are incoming.
                let novel = await cherryNovel(repo, retainedTip, upstream)
                sources = (await linear(repo, [upstream], [...placed, local])).filter(commit => novel.has(commit))
            } else {
                // Incoming history first, then local-only commits; patch-equivalent local commits already upstream are dropped.
                let novel = await cherryNovel(repo, upstream, local)
                let localOnly = (await linear(repo, [local], [...placed, upstream])).filter(commit => novel.has(commit))
                if (stays) {
                    onto = upstream
                    sources = localOnly
                } else {
                    sources = [...await linear(repo, [upstream], placed), ...localOnly]
                }
            }
            incoming = true
        }
        planned.push({ branch, local, upstream, sources, existing, incoming, held, onto })
        placed.push(local)
        if (upstream)
            placed.push(upstream)
    }
    // An Unresolved Stack updates as one unit, so one with a held anchor holds only while nothing arrives for any of its branches.
    let heldUnit = planned[0]?.held ? stackOf(planned[0].branch.ref) : undefined
    if (heldUnit) {
        let unit = planned.filter(item => stackOf(item.branch.ref) == heldUnit)
        let holds = unit.every(item => !item.incoming)
        for (let item of unit)
            item.held = holds
    }

    // The tip the next branch up is built on while this one stays as it is.
    let ownTip = (item: Planned) => stackOf(item.branch.ref)?.branches.find(branch => branch.ref == item.branch.ref)!.current ?? item.local

    // Replay changes nothing only when each branch that isn't held already sits on its parent's tip, however long ago
    // the Base moved.
    let current = !changed && planned.every(item => !item.incoming)
    let parentTip = baseNew
    for (let item of planned) {
        let unresolved = stackOf(item.branch.ref)
        current &&= item.held
            || (unresolved
                ? unresolved.branches[0]!.ref != item.branch.ref || unresolved.base == parentTip
                : await isAncestor(repo, parentTip, item.local))
        parentTip = ownTip(item)
    }
    if (current) {
        for (let item of planned)
            processed.set(item.branch.ref, { before: item.local, current: item.local })
        return { id: stack.id, branches: names, base: baseOutcome, status: "current", message: "Already current." }
    }

    // Existing Unresolved Stacks update as one unit; other branches form new stacks per Active Stack, starting from the
    // anchor's upstream when it takes that. A held branch is in no run.
    let runs: Array<{ items: Planned[]; held?: boolean; onto?: string }> = []
    for (let index = 0; index < planned.length;) {
        let first = planned[index]!
        let unresolved = stackOf(first.branch.ref)
        if (unresolved) {
            let refs = unresolved.branches.map(branch => branch.ref)
            let items = planned.slice(index, index + refs.length)
            if (JSON.stringify(items.map(item => item.branch.ref)) != JSON.stringify(refs)) {
                throw new PullSkip(
                    `${shortName(refs.at(-1)!)} belongs to an Unresolved Stack (${refs.map(shortName).join(", ")}) that does not match this stack. `
                        + "Resolve or update that stack first.",
                )
            }
            runs.push({ items, held: first.held })
            index += refs.length
        } else if (first.held) {
            runs.push({ items: [first], held: true })
            index++
        } else {
            let items = [first]
            for (index++; index < planned.length; index++) {
                let next = planned[index]!
                if (stackOf(next.branch.ref) || next.held || next.onto)
                    break
                items.push(next)
            }
            runs.push({ items, onto: first.onto })
        }
    }

    let parent = baseNew
    let rewrites = 0
    let stopped = false
    for (let run of runs) {
        if (run.held) {
            for (let item of run.items)
                processed.set(item.branch.ref, { before: item.local, current: ownTip(item) })
            parent = ownTip(run.items.at(-1)!)
            continue
        }
        if (cancelled()) {
            stopped = true
            break
        }
        let plan: StackRewritePlan = { refs: run.items.map(item => item.branch.ref), base: run.onto ?? parent, sources: run.items.map(item => item.sources) }
        let result = await rewriteStack(repo, session, plan, changes, cancelled)
        for (let branch of result.branches)
            processed.set(branch.ref, { before: branch.before, current: branch.current })
        // Each branch with an upstream has now pulled its tip, or deliberately replaces it; a vanished one keeps its record.
        for (let item of run.items) {
            let tip = result.branches.find(branch => branch.ref == item.branch.ref)?.current
            if (item.upstream && tip)
                await settle(item.branch.ref, item.upstream, tip)
        }
        parent = result.branches.at(-1)!.current
        rewrites++
    }

    let refs = new Set(stack.branches.map(branch => branch.ref))
    let conflicts = state.stacks.filter(item => item.branches.some(branch => refs.has(branch.ref)))
        .flatMap(item => item.steps).filter(step => step.conflict).length
    let workingConflicts = Math.max(0, state.working.length - workingBefore)
    if (stopped) {
        return {
            id: stack.id,
            branches: names,
            base: baseOutcome,
            status: "cancelled",
            message: `Cancelled after ${rewrites == 0 && !changed ? "fetching" : "updating part of this stack"}. Pull again to continue.`,
            conflicts,
            workingConflicts,
        }
    }
    return {
        id: stack.id,
        branches: names,
        base: baseOutcome,
        status: conflicts || workingConflicts ? "needs-resolution" : "updated",
        message: conflicts
            ? `${conflicts} commit conflict${conflicts == 1 ? "" : "s"} deferred for inline resolution.`
            : workingConflicts
            ? "Working Changes could not be reapplied cleanly; resolve the Working Changes Conflict inline."
            : undefined,
        conflicts,
        workingConflicts,
    }
}

// Commits in head but not upstream whose patch is not already present in upstream.
async function cherryNovel(repo: RepositoryGit, upstream: string, head: string) {
    let output = await gitText(repo, ["cherry", upstream, head])
    return new Set(output.split("\n").filter(line => line.startsWith("+ ")).map(line => line.slice(2).trim()))
}

// Commits reachable from tips but not from placed, oldest first. Merge commits are outside this replay.
async function linear(repo: RepositoryGit, tips: string[], placed: string[]) {
    let output = await gitText(repo, ["rev-list", "--reverse", "--topo-order", "--parents", ...tips, "--not", ...placed])
    let lines = output.split("\n").filter(Boolean)
    if (lines.some(line => line.split(" ").length != 2)) {
        throw new PullSkip(
            "This stack contains merge commits. Laneway replays linear history only; rebase or flatten the merges explicitly, then pull again.",
        )
    }
    return lines.map(line => line.split(" ")[0]!)
}

function main(repo: RepositoryGit) {
    return repo.descriptor.mainWorktree
}

function shortName(ref: string) {
    return ref.replace(/^refs\/(heads|remotes)\//, "")
}
