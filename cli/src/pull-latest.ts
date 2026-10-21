import { gitText, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import type { BranchGraphBranchNode, BranchGraphReadOptions, PullFetch, PullRequest, PullStackOutcome } from "@laneway/shared"
import { isAncestor, readActiveStack } from "./active-stack"
import { type ConflictSession, gitHead, openConflictSession, rewriteStack, type StackRewritePlan } from "./conflicts/conflict-operations"

type Changes = Map<string, string | null>
export type PullProgressReporter = (message: string, completed: number, total: number) => void

interface ScopedBranch {
    ref: string
    name: string
    tip: string
    remoteOnly: boolean
    upstream?: { ref: string; remote: string }
}
interface ScopedStack {
    id: string
    // Stack order: the Base Branch first, the column's branch last.
    branches: ScopedBranch[]
}
export type PullPreparation =
    | { kind: "no-remotes" }
    | { kind: "cancelled"; fetches: PullFetch[] }
    | {
        kind: "prepared"
        fetches: PullFetch[]
        stacks: ScopedStack[]
        blocked: PullStackOutcome[]
        upstreamBefore: Map<string, string | null>
        remotesFor: (stack: ScopedStack) => string[]
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
        ref,
        name: shortName(ref),
        tip: branch.tip,
        remoteOnly: branch.remoteOnly,
        upstream: branch.remoteOnly ? undefined : upstreams.get(ref),
    })

    let stacks: ScopedStack[] = []
    let blocked: PullStackOutcome[] = []
    for (let ref of [...new Set(request.branches)]) {
        let stack = await readActiveStack(repo, graph, ref)
        if (!stack)
            continue
        let chain = stack.branches.map(item => scoped(item.node, item.ref))
        let id = crypto.randomUUID()
        if (stack.ambiguous) {
            let message = `The Base of ${stack.ambiguous} is ambiguous. Choose its Base in the Branch Graph, then pull again.`
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

    let upstreamBefore = new Map<string, string | null>()
    for (let branch of stacks.flatMap(stack => stack.branches)) {
        if (branch.upstream && !upstreamBefore.has(branch.upstream.ref))
            upstreamBefore.set(branch.upstream.ref, await repo.resolveRef(branch.upstream.ref))
    }

    let total = toFetch.length + stacks.length
    let fetches: PullFetch[] = []
    for (let [index, remote] of toFetch.entries()) {
        if (cancelled())
            return { kind: "cancelled", fetches }
        progress(`Fetching ${remote}…`, index, total)
        let result = await repo.run(main(repo), ["fetch", "--prune", "--no-write-fetch-head", "--", remote])
        if (result.exitCode == 0)
            fetches.push({ remote, status: "fetched" })
        else
            fetches.push({ remote, status: "failed", message: result.stderr.toString().trim() || `Git could not fetch ${remote}.` })
    }
    return { kind: "prepared", fetches, stacks, blocked, upstreamBefore, remotesFor }
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

    let failedRemotes = new Set(prepared.fetches.filter(fetch => fetch.status == "failed").map(fetch => fetch.remote))
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
            let failed = prepared.remotesFor(stack).filter(remote => failedRemotes.has(remote))
            if (failed.length) {
                let messages = prepared.fetches.filter(fetch => failed.includes(fetch.remote)).map(fetch => `${fetch.remote}: ${fetch.message}`)
                throw new PullSkip(`Fetching ${failed.join(", ")} failed, so this stack was not updated. ${messages.join(" ")}`)
            }
            outcomes.push(await updateStack(repo, session, stack, prepared.upstreamBefore, processed, changes, cancelled, working))
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

async function updateStack(
    repo: RepositoryGit,
    session: ConflictSession,
    stack: ScopedStack,
    upstreamBefore: Map<string, string | null>,
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
        sources: string[]
        existing: boolean
        incoming: boolean
    }
    let planned: Planned[] = []
    for (let branch of stack.branches.slice(position + 1)) {
        let existing = Boolean(stackOf(branch.ref))
        let local = await currentTip(branch)
        let upstream = await upstreamTip(branch)
        let previousUpstream = branch.upstream ? upstreamBefore.get(branch.upstream.ref) ?? null : null
        // The provisional tip of an Unresolved Stack already carries its retained steps.
        let retainedTip = existing ? (await repo.resolveRef(stackOf(branch.ref)!.temporaryRef)) ?? local : local
        let sources: string[]
        let incoming = false
        if (!upstream || upstream == local || await isAncestor(repo, upstream, local))
            sources = existing ? [] : await linear(repo, [local], placed)
        else if (await isAncestor(repo, local, upstream)) {
            sources = await linear(repo, [upstream], existing ? [...placed, local] : placed)
            incoming = true
        } else if (upstream == previousUpstream) {
            // Local history was rewritten since the last fetch and its publication is pending; nothing new arrived.
            sources = existing ? [] : await linear(repo, [local], placed)
        } else {
            let rewritten = Boolean(previousUpstream) && !(await isAncestor(repo, previousUpstream!, upstream))
            if (rewritten) {
                if (!(await isAncestor(repo, local, previousUpstream!))) {
                    throw new PullSkip(
                        `${shortName(branch.upstream!.ref)} was rewritten and ${branch.name} has local commits. `
                            + "Laneway cannot identify which local commits to retain. Inspect both histories, reconcile explicitly, then pull again.",
                    )
                }
                sources = await linear(repo, [upstream], existing ? [...placed, local] : placed)
            } else if (existing) {
                // Only upstream commits whose changes are not already retained in the provisional stack are incoming.
                let novel = await cherryNovel(repo, retainedTip, upstream)
                sources = (await linear(repo, [upstream], [...placed, local])).filter(commit => novel.has(commit))
            } else {
                // Incoming history first, then local-only commits; patch-equivalent local commits already upstream are dropped.
                let incomingCommits = await linear(repo, [upstream], placed)
                let novel = await cherryNovel(repo, upstream, local)
                let localOnly = (await linear(repo, [local], [...placed, upstream])).filter(commit => novel.has(commit))
                sources = [...incomingCommits, ...localOnly]
            }
            incoming = true
        }
        planned.push({ branch, local, sources, existing, incoming })
        placed.push(local)
        if (upstream)
            placed.push(upstream)
    }

    if (!changed && baseOld == baseNew && planned.every(item => !item.incoming)) {
        for (let item of planned)
            processed.set(item.branch.ref, { before: item.local, current: item.local })
        return { id: stack.id, branches: names, base: baseOutcome, status: "current", message: "Already current." }
    }

    // Existing Unresolved Stacks update as one unit; other branches form new stacks per Active Stack.
    let runs: Array<{ items: Planned[]; existing: boolean }> = []
    for (let index = 0; index < planned.length;) {
        let unresolved = stackOf(planned[index]!.branch.ref)
        if (unresolved) {
            let refs = unresolved.branches.map(branch => branch.ref)
            let items = planned.slice(index, index + refs.length)
            if (JSON.stringify(items.map(item => item.branch.ref)) != JSON.stringify(refs)) {
                throw new PullSkip(
                    `${shortName(refs.at(-1)!)} belongs to an Unresolved Stack (${refs.map(shortName).join(", ")}) that does not match this stack. `
                        + "Resolve or update that stack first.",
                )
            }
            runs.push({ items, existing: true })
            index += refs.length
        } else {
            let items: Planned[] = []
            while (index < planned.length && !stackOf(planned[index]!.branch.ref))
                items.push(planned[index++]!)
            runs.push({ items, existing: false })
        }
    }

    let parent = baseNew
    let completedRuns = 0
    for (let run of runs) {
        if (cancelled())
            break
        let plan: StackRewritePlan = { refs: run.items.map(item => item.branch.ref), base: parent, sources: run.items.map(item => item.sources) }
        let result = await rewriteStack(repo, session, plan, changes, cancelled)
        for (let branch of result.branches)
            processed.set(branch.ref, { before: branch.before, current: branch.current })
        parent = result.branches.at(-1)!.current
        completedRuns++
    }

    let refs = new Set(stack.branches.map(branch => branch.ref))
    let conflicts = state.stacks.filter(item => item.branches.some(branch => refs.has(branch.ref)))
        .flatMap(item => item.steps).filter(step => step.conflict).length
    let workingConflicts = Math.max(0, state.working.length - workingBefore)
    if (completedRuns < runs.length) {
        return {
            id: stack.id,
            branches: names,
            base: baseOutcome,
            status: "cancelled",
            message: `Cancelled after ${completedRuns == 0 && !changed ? "fetching" : "updating part of this stack"}. Pull again to continue.`,
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
