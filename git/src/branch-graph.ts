import type { AuthorIdentitySettings, BranchGraph, BranchGraphBase, BranchGraphBranchNode, BranchGraphMarker, BranchGraphReadOptions, BranchGraphTagNode, BranchGraphVirtualBranch, BranchGraphWorktree, BranchHistoryCommit, BranchHistoryPage, BranchHistoryRequest } from "@laneway/shared"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { graphHistory } from "./graph-history"
import { GitError, type GitTask, redactGitText, type RepositoryDescriptor } from "./index"

interface CommandResult {
    exitCode: number
    stderr: Buffer
    stdout: Buffer
}

interface CommandExecution {
    result: Promise<CommandResult>
    cancel(): void
    wasCancelled(): boolean
}

type StartCommand = (args: string[], input?: string) => CommandExecution

export interface BranchGraphReadCache {
    key: string
    evidence: string
    graph: BranchGraph
}

interface RefRecord {
    ref: string
    objectId: string
    peeledObjectId?: string
    upstreamRef?: string
    symbolicTarget?: string
    authoredAt?: number
    subject?: string
    ahead: number
    behind: number
}

interface StashRecord {
    branch?: string | null
    selector: string
    objectId: string
    parentIds: string[]
    subject: string
}

interface Evidence {
    remotes: string[]
    remoteText: string
    refs: RefRecord[]
    refText: string
    stashes: StashRecord[]
    stashText: string
    worktrees: BranchGraphWorktree[]
    worktreeText: string
}

interface MutableBranch extends BranchGraphBranchNode {
    sourceUpstreams: Map<string, string>
}

interface TopologyCommit {
    objectId: string
    parentIndexes: number[]
}

interface BranchCommitSummary {
    objectId: string
    authoredAt: number
    subject: string
}

interface GraphTopology {
    commits: TopologyCommit[]
    isAncestor(ancestor: string, descendant: string): boolean
    ancestry(roots: string[]): (ancestor: string, descendant: string) => boolean
    mergeBases(branch: MutableBranch, candidates: MutableBranch[]): Array<{ candidate: MutableBranch; objectId: string }>
    exclusiveCommits(branches: MutableBranch[]): string[]
    hasExclusive(commits: Set<string>, tip: string, base: string): boolean
}

interface GraphRunner {
    run(args: string[], acceptedExitCodes?: number[], input?: string): Promise<CommandResult>
}

export function startBranchGraphRead(
    descriptor: RepositoryDescriptor,
    startCommand: StartCommand,
    options: BranchGraphReadOptions,
    cached?: BranchGraphReadCache,
    cache?: (value: BranchGraphReadCache) => void,
): GitTask<BranchGraph> {
    const operation = cancellableRunner(startCommand)
    return {
        cancel: operation.cancel,
        result: readVerifiedGraph(descriptor, operation, options, cached, cache),
    }
}

export function startBranchHistoryRead(
    descriptor: RepositoryDescriptor,
    startCommand: StartCommand,
    request: BranchHistoryRequest,
): GitTask<BranchHistoryPage> {
    const operation = cancellableRunner(startCommand)
    return {
        cancel: operation.cancel,
        result: readHistoryPage(descriptor, operation, request),
    }
}

function cancellableRunner(startCommand: StartCommand): GraphRunner & { cancel(): void } {
    let cancelled = false
    const current = new Set<CommandExecution>()
    return {
        cancel() {
            cancelled = true
            for (const command of current)
                command.cancel()
        },
        async run(args, acceptedExitCodes = [0], input) {
            if (cancelled)
                throw cancelledError()
            const command = startCommand(args, input)
            current.add(command)
            const result = await command.result.finally(() => current.delete(command))
            if (cancelled || command.wasCancelled())
                throw cancelledError()
            if (!acceptedExitCodes.includes(result.exitCode)) {
                throw new GitError(
                    "git.command-failed",
                    redactGitText(result.stderr.toString()) || `Git could not read the Branch Graph (${args[0]}).`,
                    { gitExitCode: result.exitCode },
                )
            }
            return result
        },
    }
}

async function readVerifiedGraph(
    descriptor: RepositoryDescriptor,
    runner: GraphRunner,
    options: BranchGraphReadOptions,
    cached?: BranchGraphReadCache,
    cache?: (value: BranchGraphReadCache) => void,
) {
    const key = graphOptionsKey(options)
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await readEvidence(runner, descriptor)
        const beforeFingerprint = fingerprint(before)
        if (!options.refreshRemote && cached?.key == key && cached.evidence == beforeFingerprint)
            return cached.graph
        const built = await buildGraph(descriptor, runner, options, before, () => readVerificationEvidence(runner))
        if (verificationFingerprint(before) == verificationFingerprint(built.verification)) {
            cache?.({ key, evidence: beforeFingerprint, graph: built.graph })
            return built.graph
        }
    }
    throw new GitError(
        "git.command-failed",
        "Repository refs kept changing while Laneway read the Branch Graph. Laneway will retry while the graph is visible.",
    )
}

async function readVerificationEvidence(runner: GraphRunner) {
    const [refResult, worktreeResult] = await Promise.all([
        runner.run([
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(symref)%00%(authordate:unix)%00%(contents:subject)%00%(upstream:track,nobracket)%00",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/stash",
        ]),
        runner.run(["worktree", "list", "--porcelain", "-z"]),
    ])
    return { refText: text(refResult), worktreeText: text(worktreeResult) }
}

function graphOptionsKey(options: BranchGraphReadOptions) {
    return JSON.stringify({
        authorIdentities: options.authorIdentities,
        selectedRemote: options.selectedRemote,
        remotePatterns: options.remotePatterns,
    })
}

async function readEvidence(runner: GraphRunner, descriptor: RepositoryDescriptor): Promise<Evidence> {
    const [remoteResult, refResult, worktreeResult, stashResult] = await Promise.all([
        runner.run(["remote"]),
        runner.run([
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(symref)%00%(authordate:unix)%00%(contents:subject)%00%(upstream:track,nobracket)%00",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/stash",
        ]),
        runner.run(["worktree", "list", "--porcelain", "-z"]),
        runner.run(["stash", "list", "--format=%gd%x00%H%x00%P%x00%gs"], [0]),
    ])
    const remoteText = text(remoteResult)
    const refText = text(refResult)
    const worktreeText = text(worktreeResult)
    const stashText = text(stashResult)
    let associations: Record<string, string | null> = {}
    try {
        associations = JSON.parse(await readFile(join(descriptor.commonDirectory, "laneway-local.json"), "utf8")).stashes ?? {}
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code != "ENOENT")
            throw error
    }
    return {
        remotes: remoteText.split("\n").filter(Boolean).sort(naturalCompare),
        remoteText,
        refs: parseRefs(refText),
        refText,
        stashes: parseStashes(stashText).map(stash => ({
            ...stash,
            ...(Object.hasOwn(associations, stash.objectId) ? { branch: associations[stash.objectId] } : {}),
        })),
        stashText: stashText + JSON.stringify(associations),
        worktrees: parseWorktrees(worktreeText),
        worktreeText,
    }
}

async function buildGraph(
    descriptor: RepositoryDescriptor,
    runner: GraphRunner,
    options: BranchGraphReadOptions,
    evidence: Evidence,
    verify: () => Promise<Pick<Evidence, "refText" | "worktreeText">>,
) {
    const availableRemotes = [...new Set([...evidence.remotes, ...listRefRemotes(evidence.refs)])].sort(naturalCompare)
    const selectedRemote = options.selectedRemote && availableRemotes.includes(options.selectedRemote)
        ? options.selectedRemote
        : availableRemotes.length == 1
        ? availableRemotes[0]
        : undefined
    const tips = graphTips(evidence.refs)
    const topologyPromise = readTopology(runner, tips)
    const effectiveAuthorEmail = optionalText(await runner.run(["config", "--get", "user.email"], [0, 1]))
    const authorIdentities = effectiveIdentities(options.authorIdentities, effectiveAuthorEmail)
    const [primaryBranch, topology] = await Promise.all([
        readPrimaryBranch(runner, evidence.refs, selectedRemote, options.refreshRemote == true),
        topologyPromise,
    ])
    const branches = createBranches(evidence.refs, evidence.worktrees, primaryBranch.ref)
    const summaries = new Map(
        evidence.refs.filter(ref =>
            (ref.ref.startsWith("refs/heads/") || ref.ref.startsWith("refs/remotes/"))
            && ref.authoredAt != undefined
            && ref.subject != undefined
        )
            .map(ref => [ref.objectId, { objectId: ref.objectId, authoredAt: ref.authoredAt!, subject: ref.subject! }]),
    )

    inferBases(branches, branches, topology)
    const exclusiveCommits = topology.exclusiveCommits(branches)
    const [authoredCommits, verification] = await Promise.all([readAuthoredCommits(runner, exclusiveCommits, authorIdentities), verify()])
    enrichBranches(topology, branches, authorIdentities, authoredCommits, summaries)

    const patterns = options.remotePatterns.map(globPattern)
    const included = new Set(
        branches.filter(branch =>
            !branch.remoteOnly
            || branch.primary
            || branch.involvement == "involved"
            || branch.remoteRefs.some(ref => patterns.some(pattern => pattern.test(shortRef(ref))))
        ).map(branch => branch.id),
    )
    includeBaseRelationships(branches, included)
    const visibleBranches = branches.filter(branch => included.has(branch.id)).sort(compareBranches)

    attachStashes(visibleBranches, evidence.stashes)
    const { branchTags, tagNodes } = placeTags(evidence.refs, visibleBranches, topology)
    for (const [branchId, tags] of branchTags) {
        const branch = visibleBranches.find(candidate => candidate.id == branchId)
        if (branch)
            branch.tags = tags
    }

    const primary = visibleBranches.find(branch => branch.primary)
    for (const branch of visibleBranches)
        branch.merged = Boolean(primary && branch.id != primary.id && topology.isAncestor(branch.tip, primary.tip))
    const virtualBranches = createVirtualBranches(evidence.worktrees)
    const history = graphHistory(topology.commits, [
        ...[...visibleBranches].sort((left, right) => Number(right.primary) - Number(left.primary))
            .map(branch => ({ objectId: branch.tip, lineId: branch.id, connect: !branch.primary })),
        ...tagNodes.map(tag => ({ objectId: tag.objectId, lineId: tag.parentBranchId ?? tag.id, connect: false })),
        ...virtualBranches.map(branch => ({ objectId: branch.objectId, lineId: branch.id, connect: false })),
    ])

    return {
        verification,
        graph: {
            repositoryId: descriptor.id,
            primaryBranch,
            availableRemotes,
            selectedRemote,
            remotePatterns: options.remotePatterns,
            authorIdentities,
            effectiveAuthorEmail,
            branches: visibleBranches.map(withoutInternals),
            history,
            tags: tagNodes.filter(tag => !tag.parentBranchId || visibleBranches.some(branch => branch.id == tag.parentBranchId)),
            virtualBranches,
            unassignedStashes: unassignedStashes(visibleBranches, evidence.stashes),
            limited: [
                ...(descriptor.shallow ? ["shallow" as const] : []),
                ...(descriptor.partial ? ["partial" as const] : []),
                ...(descriptor.sparse ? ["sparse" as const] : []),
            ],
        },
    }
}

function createBranches(refs: RefRecord[], worktrees: BranchGraphWorktree[], primaryRef?: string): MutableBranch[] {
    const localRefs = refs.filter(ref => ref.ref.startsWith("refs/heads/"))
    const remoteRefs = refs.filter(ref => ref.ref.startsWith("refs/remotes/") && !ref.symbolicTarget)
    const remoteByName = new Map(remoteRefs.map(ref => [ref.ref, ref]))
    const consumedRemoteRefs = new Set<string>()
    const seeds: Array<{
        tip: string
        refs: RefRecord[]
        sourceUpstreams: Map<string, string>
    }> = []

    for (const local of localRefs) {
        const seedRefs = [local]
        const sourceUpstreams = new Map<string, string>()
        if (local.upstreamRef) {
            sourceUpstreams.set(local.ref, local.upstreamRef)
            const upstream = remoteByName.get(local.upstreamRef)
            if (upstream) {
                seedRefs.push(upstream)
                consumedRemoteRefs.add(upstream.ref)
            }
        }
        seeds.push({ tip: local.objectId, refs: seedRefs, sourceUpstreams })
    }
    for (const remote of remoteRefs) {
        if (!consumedRemoteRefs.has(remote.ref))
            seeds.push({ tip: remote.objectId, refs: [remote], sourceUpstreams: new Map() })
    }

    const grouped = new Map<string, typeof seeds>()
    for (const seed of seeds)
        grouped.set(seed.tip, [...grouped.get(seed.tip) ?? [], seed])
    return [...grouped.entries()].map(([tip, matchingSeeds]) => {
        const matchingRefs = unique(matchingSeeds.flatMap(seed => seed.refs), ref => ref.ref)
        const local = matchingRefs.filter(ref => ref.ref.startsWith("refs/heads/"))
        const remote = matchingRefs.filter(ref => ref.ref.startsWith("refs/remotes/"))
        const checkedOutRefs = new Set(worktrees.flatMap(worktree => worktree.branchRef ? [worktree.branchRef] : []))
        const preferred = [...local].sort((left, right) => {
            const checkout = Number(checkedOutRefs.has(right.ref)) - Number(checkedOutRefs.has(left.ref))
            return checkout || naturalCompare(shortRef(left.ref), shortRef(right.ref))
        })[0] ?? [...remote].sort((left, right) => naturalCompare(shortRef(left.ref), shortRef(right.ref)))[0]!
        const sourceUpstreams = new Map(matchingSeeds.flatMap(seed => [...seed.sourceUpstreams]))
        const upstreamRef = sourceUpstreams.get(preferred.ref)
        const upstreamTip = upstreamRef ? remoteByName.get(upstreamRef)?.objectId : undefined
        const allRefs = matchingRefs.map(ref => ref.ref).sort(naturalCompare)
        const id = `branch:${preferred.ref}`
        return {
            kind: "branch",
            id,
            name: shortRef(preferred.ref),
            preferredRef: preferred.ref,
            refs: allRefs,
            aliases: allRefs.map(shortRef),
            localRefs: local.map(ref => ref.ref).sort(naturalCompare),
            remoteRefs: remote.map(ref => ref.ref).sort(naturalCompare),
            tip,
            upstreamRef,
            upstreamTip,
            ahead: preferred.ahead,
            behind: preferred.behind,
            base: { status: "unknown", candidates: [] },
            involvement: "unknown",
            checkedOut: worktrees.filter(worktree => worktree.branchRef && local.some(ref => ref.ref == worktree.branchRef)),
            markers: [],
            tags: [],
            primary: primaryRef ? allRefs.includes(primaryRef) : false,
            remoteOnly: local.length == 0,
            merged: false,
            sourceUpstreams,
        }
    })
}

function inferBases(branches: MutableBranch[], candidates: MutableBranch[], topology: GraphTopology) {
    const mergeBasesByBranch = new Map<MutableBranch, Array<{ candidate: MutableBranch; objectId: string }>>()
    for (const branch of branches) {
        if (branch.primary) {
            branch.base = { status: "unknown", candidates: [] }
            continue
        }
        mergeBasesByBranch.set(branch, topology.mergeBases(branch, candidates))
    }
    const baseObjectIds = unique([...mergeBasesByBranch.values()].flat().map(entry => entry.objectId), objectId => objectId)
    const isAncestor = topology.ancestry(baseObjectIds)
    const candidatesById = new Map(candidates.map(candidate => [candidate.id, candidate]))
    const excluded = new Map<MutableBranch, Set<string>>()
    const closestBase = (mergeBases: Array<{ candidate: MutableBranch; objectId: string }>) =>
        chooseBase(lowestCandidates(closestMergeBases(mergeBases, isAncestor), topology.isAncestor))
    const infer = (branch: MutableBranch) => {
        const mergeBases = mergeBasesByBranch.get(branch)!
        const skippedTips = [...excluded.get(branch) ?? []].map(id => candidatesById.get(id)!.tip)
        const base = closestBase(mergeBases.filter(entry => !skippedTips.some(tip => topology.isAncestor(tip, entry.candidate.tip))))
        branch.base = base.status == "unknown" && skippedTips.length > 0 ? closestBase(mergeBases) : base
    }
    for (const branch of mergeBasesByBranch.keys())
        infer(branch)

    // Siblings diverging from a commit that no other branch holds each see the other as a closest candidate.
    // Neither owns the shared commits, so both fall back to the next Base below the fork,
    // skipping the other and any branches stacked on it. Without a Base below the fork, they stay candidates.
    for (let pending = [...mergeBasesByBranch.keys()]; pending.length > 0;) {
        const affected = new Set<MutableBranch>()
        for (const branch of pending) {
            for (const baseId of baseCandidateIds(branch.base)) {
                const base = candidatesById.get(baseId)
                if (!base || !mergeBasesByBranch.has(base) || excluded.get(branch)?.has(base.id) || !baseCandidateIds(base.base).includes(branch.id))
                    continue
                excluded.set(branch, (excluded.get(branch) ?? new Set()).add(base.id))
                excluded.set(base, (excluded.get(base) ?? new Set()).add(branch.id))
                affected.add(branch).add(base)
            }
        }
        for (const branch of affected)
            infer(branch)
        pending = [...affected]
    }
}

function baseCandidateIds(base: BranchGraphBase) {
    return base.status == "known" ? [base.branchId] : base.candidates.map(candidate => candidate.branchId)
}

function closestMergeBases(
    mergeBases: Array<{ candidate: MutableBranch; objectId: string }>,
    isAncestor: (ancestor: string, descendant: string) => boolean,
) {
    const closest: typeof mergeBases = []
    const frontier: string[] = []
    for (const entry of mergeBases) {
        if (frontier.some(objectId => entry.objectId != objectId && isAncestor(entry.objectId, objectId)))
            continue
        closest.push(entry)
        if (!frontier.includes(entry.objectId))
            frontier.push(entry.objectId)
    }
    return closest
}

// Candidates stacked on another candidate only reach the shared commits through it.
function lowestCandidates(
    mergeBases: Array<{ candidate: MutableBranch; objectId: string }>,
    isAncestor: (ancestor: string, descendant: string) => boolean,
) {
    return mergeBases.filter(entry =>
        !mergeBases.some(other => other.candidate.tip != entry.candidate.tip && isAncestor(other.candidate.tip, entry.candidate.tip))
    )
}

function chooseBase(entries: Array<{ candidate: MutableBranch; objectId: string }>): BranchGraphBase {
    const uniqueCandidates = unique(entries, entry => entry.candidate.id)
    if (uniqueCandidates.length == 0)
        return { status: "unknown", candidates: [] }
    if (uniqueCandidates.length == 1)
        return knownBase(uniqueCandidates[0].candidate)
    const sameTopology = new Set(uniqueCandidates.map(entry => entry.objectId)).size == 1
    const primary = sameTopology ? uniqueCandidates.find(entry => entry.candidate.primary) : undefined
    if (primary)
        return knownBase(primary.candidate)
    return {
        status: "ambiguous",
        candidates: uniqueCandidates.map(entry => baseCandidate(entry.candidate)).sort((left, right) => naturalCompare(left.name, right.name)),
    }
}

function knownBase(branch: MutableBranch): BranchGraphBase {
    return { status: "known", ...baseCandidate(branch) }
}

function baseCandidate(branch: MutableBranch) {
    return { branchId: branch.id, name: branch.name, ref: branch.preferredRef, tip: branch.tip }
}

function enrichBranches(
    topology: GraphTopology,
    branches: MutableBranch[],
    identities: AuthorIdentitySettings,
    authoredCommits: Set<string>,
    summaries: Map<string, BranchCommitSummary>,
) {
    const hasIdentities = Boolean(identities.primary || identities.secondary.length > 0)
    for (const branch of branches) {
        if (branch.base.status != "known") {
            branch.involvement = "unknown"
            branch.lastUniqueCommit = undefined
            continue
        }
        branch.lastUniqueCommit = summaries.get(branch.tip)
        if (!hasIdentities) {
            branch.involvement = "unknown"
            continue
        }
        const baseTip = branch.base.tip
        branch.involvement = topology.hasExclusive(authoredCommits, branch.tip, baseTip) ? "involved" : "uninvolved"
    }
}

function escapeRegularExpression(value: string) {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
}

function includeBaseRelationships(branches: MutableBranch[], included: Set<string>) {
    let changed = true
    while (changed) {
        changed = false
        for (const branch of branches.filter(candidate => included.has(candidate.id))) {
            const baseIds = baseCandidateIds(branch.base)
            for (const id of baseIds) {
                if (!included.has(id)) {
                    included.add(id)
                    changed = true
                }
            }
        }
    }
}

function attachStashes(branches: MutableBranch[], stashes: StashRecord[]) {
    for (const stash of stashes) {
        if (stash.branch === null)
            continue
        const branchName = stash.branch ?? /^(?:WIP on|On) ([^:]+):/.exec(stash.subject)?.[1]
        const named = branchName ? branches.find(branch => branch.aliases.includes(branchName)) : undefined
        const parent = stash.parentIds[0]
        const exactParents = parent ? branches.filter(branch => branch.tip == parent) : []
        const owner = named ?? (stash.branch === undefined && exactParents.length == 1 ? exactParents[0] : undefined)
        if (owner)
            owner.markers.push(stashMarker(stash))
    }
}

function unassignedStashes(branches: MutableBranch[], stashes: StashRecord[]) {
    const assigned = new Set(branches.flatMap(branch => branch.markers.map(marker => marker.id)))
    return stashes.map(stashMarker).filter(marker => !assigned.has(marker.id))
}

function placeTags(refs: RefRecord[], branches: MutableBranch[], topology: GraphTopology) {
    const branchTags = new Map<string, string[]>()
    const tagNodes: BranchGraphTagNode[] = []
    for (const tag of refs.filter(ref => ref.ref.startsWith("refs/tags/"))) {
        const target = tag.peeledObjectId || tag.objectId
        const head = branches.find(branch => branch.tip == target)
        if (head) {
            branchTags.set(head.id, [...branchTags.get(head.id) ?? [], shortRef(tag.ref)].sort(naturalCompare))
            continue
        }
        const possibleParents: MutableBranch[] = []
        for (const branch of branches) {
            if (!topology.isAncestor(target, branch.tip))
                continue
            if (branch.base.status == "known" && topology.isAncestor(target, branch.base.tip))
                continue
            possibleParents.push(branch)
        }
        possibleParents.sort(compareBranches)
        tagNodes.push({
            kind: "tag",
            id: `tag:${tag.ref}`,
            name: shortRef(tag.ref),
            objectId: target,
            parentBranchId: possibleParents[0]?.id,
            tooltip: `Tag ${shortRef(tag.ref)} at ${shortObjectId(target)}`,
        })
    }
    return { branchTags, tagNodes: tagNodes.sort((left, right) => naturalCompare(left.name, right.name)) }
}

function createVirtualBranches(worktrees: BranchGraphWorktree[]): BranchGraphVirtualBranch[] {
    return worktrees.filter(worktree => !worktree.branchRef || /^0+$/.test(worktree.head)).map(worktree => ({
        kind: "virtual",
        id: `virtual:${worktree.path}`,
        name: worktree.name,
        objectId: worktree.head,
        worktree,
        tooltip: /^0+$/.test(worktree.head) ? "No commits yet" : `detached at ${shortObjectId(worktree.head)}`,
    }))
}

function graphTips(refs: RefRecord[]) {
    return unique(
        refs.filter(ref =>
            ref.ref.startsWith("refs/heads/")
            || ref.ref.startsWith("refs/remotes/") && !ref.symbolicTarget
        ).map(ref => ref.objectId),
        objectId => objectId,
    )
}

async function readTopology(runner: GraphRunner, tips: string[]): Promise<GraphTopology> {
    if (tips.length == 0)
        return emptyTopology()
    const output = await runner.run(["rev-list", "--topo-order", "--parents", ...tips])
    const records = parseTopology(output.stdout.toString())
    const commitIndexes = new Map(records.map((commit, index) => [commit.objectId, index]))
    const commits: TopologyCommit[] = records.map(commit => ({
        objectId: commit.objectId,
        parentIndexes: commit.parentIds.map(parentId => commitIndexes.get(parentId))
            .filter((index): index is number => index != undefined),
    }))
    const tipIndexes = new Map(tips.map((objectId, index) => [objectId, index]))
    const wordCount = Math.ceil(tips.length / 32)
    const reachability = new Uint32Array(commits.length * wordCount)

    for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
        const commit = commits[commitIndex]
        const tipIndex = tipIndexes.get(commit.objectId)
        if (tipIndex != undefined)
            reachability[commitIndex * wordCount + Math.floor(tipIndex / 32)] |= 1 << tipIndex % 32
        for (const parentIndex of commit.parentIndexes) {
            for (let word = 0; word < wordCount; word += 1)
                reachability[parentIndex * wordCount + word] |= reachability[commitIndex * wordCount + word]
        }
    }

    const ancestorCache = new Map<string, boolean>()
    const hasReach = (commitIndex: number, tipIndex: number) => (reachability[commitIndex * wordCount + Math.floor(tipIndex / 32)] & 1 << tipIndex % 32) != 0
    const isAncestor = (ancestor: string, descendant: string) => {
        if (ancestor == descendant)
            return true
        const ancestorIndex = commitIndexes.get(ancestor)
        const descendantIndex = commitIndexes.get(descendant)
        if (ancestorIndex == undefined || descendantIndex == undefined || ancestorIndex < descendantIndex)
            return false
        const descendantTipIndex = tipIndexes.get(descendant)
        if (descendantTipIndex != undefined)
            return hasReach(ancestorIndex, descendantTipIndex)
        const key = `${ancestor}\0${descendant}`
        const cached = ancestorCache.get(key)
        if (cached != undefined)
            return cached
        const pending = [descendantIndex]
        const visited = new Set<number>()
        let found = false
        while (pending.length > 0 && !found) {
            const current = pending.pop()!
            if (current == ancestorIndex) {
                found = true
                break
            }
            if (current > ancestorIndex || visited.has(current))
                continue
            visited.add(current)
            pending.push(...commits[current].parentIndexes)
        }
        ancestorCache.set(key, found)
        return found
    }

    return {
        commits,
        isAncestor,
        ancestry(roots) {
            const uniqueRoots = unique(roots, objectId => objectId)
            const rootIndexes = new Map(uniqueRoots.map((objectId, index) => [objectId, index]))
            const rootWordCount = Math.ceil(uniqueRoots.length / 32)
            const rootReachability = new Uint32Array(commits.length * rootWordCount)
            for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
                const rootIndex = rootIndexes.get(commits[commitIndex].objectId)
                if (rootIndex != undefined)
                    rootReachability[commitIndex * rootWordCount + Math.floor(rootIndex / 32)] |= 1 << rootIndex % 32
                for (const parentIndex of commits[commitIndex].parentIndexes) {
                    for (let word = 0; word < rootWordCount; word += 1)
                        rootReachability[parentIndex * rootWordCount + word] |= rootReachability[commitIndex * rootWordCount + word]
                }
            }
            return (ancestor: string, descendant: string) => {
                if (ancestor == descendant)
                    return true
                const ancestorIndex = commitIndexes.get(ancestor)
                const descendantRootIndex = rootIndexes.get(descendant)
                if (ancestorIndex == undefined || descendantRootIndex == undefined)
                    return false
                return (rootReachability[ancestorIndex * rootWordCount + Math.floor(descendantRootIndex / 32)] & 1 << descendantRootIndex % 32) != 0
            }
        },
        mergeBases(branch, candidates) {
            const branchTipIndex = tipIndexes.get(branch.tip)
            if (branchTipIndex == undefined)
                return []
            const unresolved = new Uint32Array(wordCount)
            const candidatesByTipIndex = new Map<number, MutableBranch>()
            for (const candidate of candidates) {
                const candidateTipIndex = tipIndexes.get(candidate.tip)
                if (
                    candidate.id == branch.id
                    || candidate.tip == branch.tip
                    || candidateTipIndex == undefined
                    || isAncestor(branch.tip, candidate.tip)
                ) {
                    continue
                }
                unresolved[Math.floor(candidateTipIndex / 32)] |= 1 << candidateTipIndex % 32
                candidatesByTipIndex.set(candidateTipIndex, candidate)
            }
            let unresolvedCount = candidatesByTipIndex.size
            const result: Array<{ candidate: MutableBranch; objectId: string }> = []
            for (let commitIndex = 0; commitIndex < commits.length && unresolvedCount > 0; commitIndex += 1) {
                if (!hasReach(commitIndex, branchTipIndex))
                    continue
                const offset = commitIndex * wordCount
                for (let word = 0; word < wordCount; word += 1) {
                    let matching = (reachability[offset + word] & unresolved[word]) >>> 0
                    while (matching != 0) {
                        const lowest = (matching & -matching) >>> 0
                        const bit = 31 - Math.clz32(lowest)
                        const candidate = candidatesByTipIndex.get(word * 32 + bit)
                        if (candidate)
                            result.push({ candidate, objectId: commits[commitIndex].objectId })
                        unresolved[word] &= ~lowest
                        unresolvedCount -= 1
                        matching = (matching & (matching - 1)) >>> 0
                    }
                }
            }
            return result
        },
        exclusiveCommits(branches) {
            const ranges = branches.flatMap(branch => {
                if (branch.base.status != "known")
                    return []
                const tipIndex = tipIndexes.get(branch.tip)
                const baseIndex = tipIndexes.get(branch.base.tip)
                return tipIndex == undefined || baseIndex == undefined ? [] : [{ tipIndex, baseIndex }]
            })
            const result: string[] = []
            for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
                for (const range of ranges) {
                    if (hasReach(commitIndex, range.tipIndex) && !hasReach(commitIndex, range.baseIndex)) {
                        result.push(commits[commitIndex].objectId)
                        break
                    }
                }
            }
            return result
        },
        hasExclusive(objectIds, tip, base) {
            const tipIndex = tipIndexes.get(tip)
            const baseIndex = tipIndexes.get(base)
            if (tipIndex == undefined || baseIndex == undefined)
                return false
            for (const objectId of objectIds) {
                const commitIndex = commitIndexes.get(objectId)
                if (commitIndex != undefined && hasReach(commitIndex, tipIndex) && !hasReach(commitIndex, baseIndex))
                    return true
            }
            return false
        },
    }
}

function parseTopology(output: string) {
    const records: Array<{ objectId: string; parentIds: string[] }> = []
    let lineStart = 0
    while (lineStart < output.length) {
        let lineEnd = output.indexOf("\n", lineStart)
        if (lineEnd < 0)
            lineEnd = output.length
        const separator = output.indexOf(" ", lineStart)
        const objectEnd = separator < 0 || separator > lineEnd ? lineEnd : separator
        const parentIds: string[] = []
        let parentStart = objectEnd + 1
        while (parentStart < lineEnd) {
            const nextSeparator = output.indexOf(" ", parentStart)
            const parentEnd = nextSeparator < 0 || nextSeparator > lineEnd ? lineEnd : nextSeparator
            parentIds.push(output.slice(parentStart, parentEnd))
            parentStart = parentEnd + 1
        }
        if (objectEnd > lineStart)
            records.push({ objectId: output.slice(lineStart, objectEnd), parentIds })
        lineStart = lineEnd + 1
    }
    return records
}

function emptyTopology(): GraphTopology {
    return {
        commits: [],
        isAncestor: () => false,
        ancestry: () => () => false,
        mergeBases: () => [],
        exclusiveCommits: () => [],
        hasExclusive: () => false,
    }
}

async function readAuthoredCommits(runner: GraphRunner, commits: string[], identities: AuthorIdentitySettings) {
    const emails = [identities.primary, ...identities.secondary].filter((email): email is string => Boolean(email))
    if (emails.length == 0 || commits.length == 0)
        return new Set<string>()
    const authorArguments = emails.flatMap(email => ["--author", `<${escapeRegularExpression(email)}>$`])
    const output = text(
        await runner.run(
            ["log", "--stdin", "--no-walk", "--use-mailmap", "--regexp-ignore-case", "--format=%H", ...authorArguments],
            [0, 128],
            `${commits.join("\n")}\n`,
        ),
    )
    return new Set(output.split("\n").filter(Boolean))
}

async function readPrimaryBranch(runner: GraphRunner, refs: RefRecord[], remote: string | undefined, refreshRemote: boolean) {
    if (!remote)
        return { status: "unknown" as const, reason: "Choose a remote to infer the Primary Branch." }
    const cached = refs.find(ref => ref.ref == `refs/remotes/${remote}/HEAD`)?.symbolicTarget
    let branchName = cached?.replace(`refs/remotes/${remote}/`, "")
    let remoteFailure: string | undefined
    if (refreshRemote) {
        const result = await runner.run(["ls-remote", "--symref", remote, "HEAD"], [0, 1, 2, 128])
        if (result.exitCode == 0)
            branchName = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(text(result))?.[1] ?? branchName
        else
            remoteFailure = redactGitText(result.stderr.toString()) || `Could not read ${remote}/HEAD.`
    }
    if (!branchName) {
        return {
            status: "unknown" as const,
            remote,
            reason: remoteFailure ?? `${remote} does not advertise a default branch in local Git data.`,
        }
    }
    const ref = `refs/remotes/${remote}/${branchName}`
    if (!refs.some(candidate => candidate.ref == ref)) {
        return {
            status: "unknown" as const,
            remote,
            ref,
            reason: `${remote}/${branchName} has not been fetched.`,
        }
    }
    return { status: "known" as const, remote, ref, ...(remoteFailure ? { reason: remoteFailure } : {}) }
}

async function readHistoryPage(descriptor: RepositoryDescriptor, runner: GraphRunner, request: BranchHistoryRequest): Promise<BranchHistoryPage> {
    validateObjectId(descriptor, request.tip)
    for (const baseTip of request.baseTips)
        validateObjectId(descriptor, baseTip)
    const before = request.branchRef == request.tip
        ? request.tip
        : optionalText(await runner.run(["rev-parse", "--verify", "--quiet", request.branchRef], [0, 1]))
    if (before != request.tip)
        throw new GitError("git.command-failed", "The branch moved before Laneway could expand its commits. Refresh the Branch Graph and try again.")
    const offset = Math.max(0, request.offset ?? 0)
    const limit = Math.min(200, Math.max(1, request.limit ?? 100))
    const output = text(
        await runner.run([
            "log",
            "--use-mailmap",
            "--topo-order",
            "--first-parent",
            `--skip=${offset}`,
            `--max-count=${limit + 1}`,
            "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%s",
            request.tip,
            ...(request.baseTips.length > 0 ? ["--not", ...request.baseTips] : []),
        ]),
    )
    const commits = parseHistory(output)
    const after = request.branchRef == request.tip
        ? request.tip
        : optionalText(await runner.run(["rev-parse", "--verify", "--quiet", request.branchRef], [0, 1]))
    if (after != request.tip)
        throw new GitError("git.command-failed", "The branch moved while Laneway expanded its commits. Refresh the Branch Graph and try again.")
    return {
        branchRef: request.branchRef,
        tip: request.tip,
        baseTips: request.baseTips,
        commits: commits.slice(0, limit),
        ...(commits.length > limit ? { nextOffset: offset + limit } : {}),
    }
}

function parseRefs(output: string): RefRecord[] {
    return output.split("\n").map(line => line.replace(/\0$/, "")).filter(Boolean).map(line => {
        const [ref, objectId, peeledObjectId, upstreamRef, symbolicTarget, authoredAt, subject, tracking] = line.split("\0")
        return {
            ref,
            objectId,
            peeledObjectId: peeledObjectId || undefined,
            upstreamRef: upstreamRef || undefined,
            symbolicTarget: symbolicTarget || undefined,
            authoredAt: authoredAt ? Number(authoredAt) : undefined,
            subject: subject || undefined,
            ahead: Number(/ahead (\d+)/.exec(tracking)?.[1] ?? 0),
            behind: Number(/behind (\d+)/.exec(tracking)?.[1] ?? 0),
        }
    })
}

function parseWorktrees(output: string): BranchGraphWorktree[] {
    return output.split("\0\0").map(record => record.split("\0").filter(Boolean)).filter(fields => fields.length > 0).map((fields, index) => {
        const values = new Map(fields.map(field => {
            const separator = field.indexOf(" ")
            return separator < 0 ? [field, ""] : [field.slice(0, separator), field.slice(separator + 1)]
        }))
        const path = values.get("worktree") ?? ""
        return {
            path,
            name: basename(path),
            head: values.get("HEAD") ?? "",
            branchRef: values.get("branch") || undefined,
            main: index == 0,
        }
    })
}

function parseStashes(output: string): StashRecord[] {
    return output.split("\n").filter(Boolean).map(line => {
        const [selector, objectId, parents, subject] = line.split("\0")
        return { selector, objectId, parentIds: parents.split(" ").filter(Boolean), subject }
    })
}

function parseHistory(output: string): BranchHistoryCommit[] {
    return output.split("\n").filter(Boolean).map(line => {
        const [objectId, parents, authorName, authorEmail, authoredAt, subject] = line.split("\0")
        return {
            objectId,
            parentIds: parents.split(" ").filter(Boolean),
            authorName,
            authorEmail,
            authoredAt: Number(authoredAt),
            subject,
        }
    })
}

function effectiveIdentities(configured: AuthorIdentitySettings, effectiveEmail: string | undefined): AuthorIdentitySettings {
    return {
        primary: configured.primary ?? effectiveEmail,
        secondary: configured.secondary,
    }
}

function stashMarker(stash: StashRecord): BranchGraphMarker {
    return {
        branchName: stash.branch === undefined ? /^(?:WIP on|On) ([^:]+):/.exec(stash.subject)?.[1] : stash.branch,
        id: `stash:${stash.selector}`,
        kind: "stash",
        label: stash.selector,
        objectId: stash.objectId,
        tooltip: stash.subject,
    }
}

function listRefRemotes(refs: RefRecord[]) {
    return refs.filter(ref => ref.ref.startsWith("refs/remotes/")).map(ref => ref.ref.split("/")[2]).filter(Boolean)
}

function globPattern(value: string) {
    let source = ""
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]
        if (character == "*" && value[index + 1] == "*") {
            source += ".*"
            index += 1
        } else if (character == "*")
            source += "[^/]*"
        else if (character == "?")
            source += "[^/]"
        else
            source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    }
    return new RegExp(`^${source}$`, "i")
}

function compareBranches(left: MutableBranch, right: MutableBranch) {
    return (right.lastUniqueCommit?.authoredAt ?? 0) - (left.lastUniqueCommit?.authoredAt ?? 0)
        || naturalCompare(left.name, right.name)
}

function naturalCompare(left: string, right: string) {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}

function shortRef(ref: string) {
    return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "").replace(/^refs\/tags\//, "")
}

function shortObjectId(objectId: string) {
    return objectId.slice(0, 10)
}

function fingerprint(evidence: Evidence) {
    return `${evidence.remoteText}\0${evidence.refText}\0${evidence.worktreeText}\0${evidence.stashText}`
}

function verificationFingerprint(evidence: Pick<Evidence, "refText" | "worktreeText">) {
    return `${evidence.refText}\0${evidence.worktreeText}`
}

function text(result: CommandResult) {
    return result.stdout.toString().trim()
}

function optionalText(result: CommandResult) {
    const value = text(result)
    return value || undefined
}

function unique<T>(values: T[], key: (value: T) => string) {
    return [...new Map(values.map(value => [key(value), value])).values()]
}

function withoutInternals(branch: MutableBranch): BranchGraphBranchNode {
    const { sourceUpstreams, ...result } = branch
    void sourceUpstreams
    return result
}

function validateObjectId(descriptor: RepositoryDescriptor, objectId: string) {
    const length = descriptor.objectFormat == "sha1" ? 40 : 64
    if (!new RegExp(`^[0-9a-f]{${length}}$`).test(objectId))
        throw new GitError("git.command-failed", `Laneway received an invalid ${descriptor.objectFormat} object ID.`)
}

function cancelledError() {
    return new GitError("git.cancelled", "Branch Graph read cancelled.")
}
