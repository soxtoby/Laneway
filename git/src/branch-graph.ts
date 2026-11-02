import type { AuthorIdentitySettings, BranchGraph, BranchGraphBase, BranchGraphBranchNode, BranchGraphMarker, BranchGraphReadOptions, BranchGraphTagNode, BranchGraphVirtualBranch, BranchGraphWorktree, BranchHistoryCommit, BranchHistoryPage, BranchHistoryRequest } from "@laneway/shared"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { type GraphTopology, readTopology, type TopologyCache } from "./branch-topology"
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

interface CachedGraph {
    key: string
    evidence: string
    graph: BranchGraph
}

export interface BranchGraphReadCache extends CachedGraph {
    recent: CachedGraph[]
    topology: TopologyCache
    authors: AuthorCache
    analysis: BranchAnalysis
}

interface BranchAnalysis {
    shape: string
    tips: Map<string, string>
    bases: Map<string, BranchGraphBase>
    exclusive: string[]
}

interface AuthorCache {
    key: string
    matches: Map<string, boolean>
}

interface GraphContext {
    fingerprint: string
    topology: string
    authors: string
    email?: string
    shallow: boolean
    /** The upstream tip each branch last pulled, by branch ref, kept only while a Laneway fetch has moved it since. */
    pulledUpstreams: Map<string, string>
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
    context: GraphContext
}

export interface MutableBranch extends BranchGraphBranchNode {
    sourceUpstreams: Map<string, string>
    /** Tips of this branch's own remote refs, including an upstream that has diverged. */
    ownRemoteTips: string[]
}

interface BranchCommitSummary {
    objectId: string
    authoredAt: number
    subject: string
}

export interface GraphRunner {
    run(args: string[], acceptedExitCodes?: number[], input?: string): Promise<CommandResult>
    checkCancelled(): void
}

export function startBranchGraphRead(
    descriptor: RepositoryDescriptor,
    startCommand: StartCommand,
    options: BranchGraphReadOptions,
    cached?: BranchGraphReadCache,
    cache?: (value: BranchGraphReadCache) => void,
): GitTask<BranchGraph> {
    let operation = cancellableRunner(startCommand)
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
    let operation = cancellableRunner(startCommand)
    return {
        cancel: operation.cancel,
        result: readHistoryPage(descriptor, operation, request),
    }
}

function cancellableRunner(startCommand: StartCommand): GraphRunner & { cancel(): void } {
    let cancelled = false
    let current = new Set<CommandExecution>()
    return {
        cancel() {
            cancelled = true
            for (let command of current)
                command.cancel()
        },
        checkCancelled() {
            if (cancelled)
                throw cancelledError()
        },
        async run(args, acceptedExitCodes = [0], input) {
            if (cancelled)
                throw cancelledError()
            let command = startCommand(args, input)
            current.add(command)
            let result = await command.result.finally(() => current.delete(command))
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
    let key = graphOptionsKey(options)
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let before = await readEvidence(runner, descriptor)
        let beforeFingerprint = fingerprint(before)
        runner.checkCancelled()
        let previous = cached && [cached, ...cached.recent].find(value => value.key == key && value.evidence == beforeFingerprint)
        if (!options.refreshRemote && previous)
            return structuredClone(previous.graph)
        let built = await buildGraph(descriptor, runner, options, before, () => readVerificationEvidence(runner, descriptor), cached)
        if (verificationFingerprint(before) == verificationFingerprint(built.verification)) {
            runner.checkCancelled()
            cache?.({
                key,
                evidence: beforeFingerprint,
                graph: structuredClone(built.graph),
                topology: built.topology,
                authors: built.authors,
                analysis: built.analysis,
                // Keep small display results for undo/redo, without retaining several full ancestry indexes.
                recent: cached
                    ? [{ key: cached.key, evidence: cached.evidence, graph: cached.graph }, ...cached.recent]
                        .filter(value => value.key != key || value.evidence != beforeFingerprint).slice(0, 7)
                    : [],
            })
            return built.graph
        }
    }
    throw new GitError(
        "git.command-failed",
        "Repository refs kept changing while Laneway read the Branch Graph. Laneway will retry while the graph is visible.",
    )
}

async function readVerificationEvidence(runner: GraphRunner, descriptor: RepositoryDescriptor) {
    let [refResult, worktreeResult, context] = await Promise.all([
        runner.run([
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(symref)%00%(authordate:unix)%00%(contents:subject)%00%(upstream:track,nobracket)%00",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/stash",
            process.env.GIT_REPLACE_REF_BASE ?? "refs/replace",
        ]),
        runner.run(["worktree", "list", "--porcelain", "-z"]),
        readGraphContext(runner, descriptor),
    ])
    return { refText: text(refResult), worktreeText: text(worktreeResult), context }
}

function graphOptionsKey(options: BranchGraphReadOptions) {
    return JSON.stringify({
        authorIdentities: options.authorIdentities,
        selectedRemote: options.selectedRemote,
        remotePatterns: options.remotePatterns,
        allBranches: options.allBranches == true,
    })
}

async function readEvidence(runner: GraphRunner, descriptor: RepositoryDescriptor): Promise<Evidence> {
    let [remoteResult, refResult, worktreeResult, stashResult, context] = await Promise.all([
        runner.run(["remote"]),
        runner.run([
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(symref)%00%(authordate:unix)%00%(contents:subject)%00%(upstream:track,nobracket)%00",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/stash",
            process.env.GIT_REPLACE_REF_BASE ?? "refs/replace",
        ]),
        runner.run(["worktree", "list", "--porcelain", "-z"]),
        runner.run(["stash", "list", "--format=%gd%x00%H%x00%P%x00%gs"], [0]),
        readGraphContext(runner, descriptor),
    ])
    let remoteText = text(remoteResult)
    let refText = text(refResult)
    let worktreeText = text(worktreeResult)
    let stashText = text(stashResult)

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
        context,
    }
}

async function readGraphContext(runner: GraphRunner, descriptor: RepositoryDescriptor): Promise<GraphContext> {
    let contents = async (path: string) =>
        readFile(path).catch(error => {
            if ((error as NodeJS.ErrnoException).code == "ENOENT")
                return Buffer.alloc(0)
            throw error
        })
    let [configuration, mailmap, shallow, grafts] = await Promise.all([
        runner.run(["config", "--null", "--list", "--includes"]),
        contents(join(descriptor.mainWorktree, ".mailmap")),
        contents(resolve(descriptor.mainWorktree, process.env.GIT_SHALLOW_FILE ?? join(descriptor.commonDirectory, "shallow"))),
        contents(resolve(descriptor.mainWorktree, process.env.GIT_GRAFT_FILE ?? join(descriptor.commonDirectory, "info", "grafts"))),
    ])
    let values = new Map(
        configuration.stdout.toString().split("\0").filter(Boolean).map(record => {
            let separator = record.indexOf("\n")
            return separator < 0 ? [record, ""] : [record.slice(0, separator), record.slice(separator + 1)]
        }),
    )
    let [extraMailmap, mailmapBlob] = await Promise.all([
        values.get("mailmap.file")
            ? runner.run(["config", "--path", "--get", "mailmap.file"]).then(result => contents(resolve(descriptor.mainWorktree, text(result))))
            : Buffer.alloc(0),
        values.get("mailmap.blob")
            ? runner.run(["rev-parse", "--verify", "--quiet", `${values.get("mailmap.blob")}^{blob}`], [0, 1, 128]).then(result => result.stdout)
            : Buffer.alloc(0),
    ])
    let topology = digest([
        shallow,
        grafts,
        values.get("core.usereplacerefs") ?? "",
        process.env.GIT_NO_REPLACE_OBJECTS ?? "",
        process.env.GIT_REPLACE_REF_BASE ?? "",
    ])
    let authors = digest([configuration.stdout, mailmap, extraMailmap, mailmapBlob])

    return {
        fingerprint: digest([configuration.stdout, topology, authors]),
        topology,
        authors,
        email: values.get("user.email") || undefined,
        shallow: Boolean(shallow.length),
        pulledUpstreams: pulledUpstreams(values),
    }
}

// Pull latest records these in branch configuration (cli/src/pulled-upstreams.ts). Git lists the variable name in
// lower case but keeps the branch name as written; an empty value records an upstream that had not been fetched.
function pulledUpstreams(values: Map<string, string>) {
    let records = new Map<string, string>()
    for (let [key, value] of values) {
        let name = /^branch\.(.+)\.lanewaypulledupstream$/.exec(key)?.[1]
        if (name)
            records.set(`refs/heads/${name}`, value)
    }
    return records
}

function digest(parts: Array<string | Buffer>) {
    let hash = createHash("sha256")
    for (let part of parts)
        hash.update(String(Buffer.byteLength(part))).update("\0").update(part)
    return hash.digest("hex")
}

async function buildGraph(
    descriptor: RepositoryDescriptor,
    runner: GraphRunner,
    options: BranchGraphReadOptions,
    evidence: Evidence,
    verify: () => Promise<Pick<Evidence, "refText" | "worktreeText" | "context">>,
    cached?: BranchGraphReadCache,
) {
    let availableRemotes = [...new Set([...evidence.remotes, ...listRefRemotes(evidence.refs)])].sort(naturalCompare)
    let selectedRemote = options.selectedRemote && availableRemotes.includes(options.selectedRemote)
        ? options.selectedRemote
        : availableRemotes.length == 1
        ? availableRemotes[0]
        : undefined
    let tips = graphTips(evidence.refs)
    let replacements = evidence.refs.filter(ref => ref.ref.startsWith(process.env.GIT_REPLACE_REF_BASE ?? "refs/replace/")).map(
        ref => [ref.ref, ref.objectId],
    )
    let topologyKey = evidence.context.topology + JSON.stringify(replacements)
    let topologyPromise = readTopology(runner, tips, topologyKey, cached?.topology)
    let effectiveAuthorEmail = evidence.context.email
    let authorIdentities = effectiveIdentities(options.authorIdentities, effectiveAuthorEmail)
    let [primaryBranch, topologyCache] = await Promise.all([
        readPrimaryBranch(runner, evidence.refs, selectedRemote, options.refreshRemote == true),
        topologyPromise,
    ])
    let topology = topologyCache.graph
    let verificationPromise = verify()
    let branches = createBranches(evidence.refs, evidence.worktrees, evidence.context.pulledUpstreams, primaryBranch.ref)
    let summaries = new Map(
        evidence.refs.filter(ref =>
            (ref.ref.startsWith("refs/heads/") || ref.ref.startsWith("refs/remotes/"))
            && ref.authoredAt != undefined
            && ref.subject != undefined
        )
            .map(ref => [ref.objectId, { objectId: ref.objectId, authoredAt: ref.authoredAt!, subject: ref.subject! }]),
    )

    let analysis = analyzeBranches(branches, evidence.refs, topologyCache, cached)
    let exclusiveCommits = analysis.exclusive
    let authorKey = topologyKey + evidence.context.authors + JSON.stringify(authorIdentities)
    let [authors, verification] = await Promise.all([
        readAuthoredCommits(runner, exclusiveCommits, authorIdentities, authorKey, cached?.authors),
        verificationPromise,
    ])
    let authoredCommits = new Set(exclusiveCommits.filter(objectId => authors.matches.get(objectId)))
    enrichBranches(topology, branches, authorIdentities, authoredCommits, summaries)

    let patterns = options.remotePatterns.map(globPattern)
    let included = new Set(
        branches.filter(branch =>
            options.allBranches
            || !branch.remoteOnly
            || branch.primary
            || branch.involvement == "involved"
            || branch.remoteRefs.some(ref => patterns.some(pattern => pattern.test(shortRef(ref))))
        ).map(branch => branch.id),
    )
    includeBaseRelationships(branches, included)
    let visibleBranches = branches.filter(branch => included.has(branch.id)).sort(compareBranches)

    attachStashes(visibleBranches, evidence.stashes)
    let { branchTags, tagNodes } = placeTags(evidence.refs, visibleBranches, topology)
    for (let [branchId, tags] of branchTags) {
        let branch = visibleBranches.find(candidate => candidate.id == branchId)
        if (branch)
            branch.tags = tags
    }

    let primary = visibleBranches.find(branch => branch.primary)
    let remoteTips = unique(
        evidence.refs.filter(ref => ref.ref.startsWith("refs/remotes/") && !ref.symbolicTarget).map(ref => ref.objectId),
        objectId => objectId,
    )
    for (let branch of visibleBranches) {
        branch.merged = Boolean(primary && branch.id != primary.id && topology.isAncestor(branch.tip, primary.tip))
        branch.published = branch.ownRemoteTips.some(remoteTip => topology.isAncestor(branch.tip, remoteTip))
    }
    let virtualBranches = createVirtualBranches(evidence.worktrees)
    let history = graphHistory(topology.commits, [
        ...[...visibleBranches].sort((left, right) => Number(right.primary) - Number(left.primary))
            .map(branch => ({ objectId: branch.tip, lineId: branch.id, connect: !branch.primary })),
        ...tagNodes.map(tag => ({ objectId: tag.objectId, lineId: tag.parentBranchId ?? tag.id, connect: false })),
        ...virtualBranches.map(branch => ({ objectId: branch.objectId, lineId: branch.id, connect: false })),
    ])

    return {
        verification,
        topology: topologyCache,
        authors,
        analysis,
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
            remoteTips,
            limited: [
                ...(evidence.context.shallow ? ["shallow" as const] : []),
                ...(descriptor.partial ? ["partial" as const] : []),
                ...(descriptor.sparse ? ["sparse" as const] : []),
            ],
        },
    }
}

function analyzeBranches(branches: MutableBranch[], refs: RefRecord[], topology: TopologyCache, cached?: BranchGraphReadCache): BranchAnalysis {
    let shape = JSON.stringify(branches.map(branch => [branch.id, branch.refs, branch.primary, [...branch.sourceUpstreams]]))
    let tips = new Map(
        refs.filter(ref => ref.ref.startsWith("refs/heads/") || ref.ref.startsWith("refs/remotes/") && !ref.symbolicTarget).map(ref => [ref.ref, ref.objectId]),
    )
    let reusable = !!cached && cached.analysis.shape == shape && equivalentBranchEnds(cached.topology, topology, cached.analysis.tips, tips)
    let exclusive: string[]

    if (cached && reusable) {
        let byId = new Map(branches.map(branch => [branch.id, branch]))
        for (let branch of branches) {
            let base = cached.analysis.bases.get(branch.id)!
            branch.base = base.status == "known" ? knownBase(byId.get(base.branchId)!) : {
                status: base.status,
                candidates: base.candidates.map(candidate => baseCandidate(byId.get(candidate.branchId)!)),
            }
        }
        let added = topology.records.filter(record => !cached.topology.indexes.has(record.objectId)).map(record => record.objectId)
        exclusive = [...cached.analysis.exclusive.filter(objectId => topology.indexes.has(objectId)), ...topology.graph.exclusiveCommits(branches, added)]
    } else {
        inferBases(branches, branches, topology.graph)
        exclusive = topology.graph.exclusiveCommits(branches)
    }

    return { shape, tips, bases: structuredClone(new Map(branches.map(branch => [branch.id, branch.base]))), exclusive }
}

/** Adding or replacing an unshared linear suffix cannot change relationships among branch roots. */
function equivalentBranchEnds(before: TopologyCache, after: TopologyCache, oldRefs: Map<string, string>, newRefs: Map<string, string>) {
    if (before.key != after.key || oldRefs.size != newRefs.size)
        return false

    let mapping = new Map<string, string>()
    for (let [ref, oldTip] of oldRefs) {
        let newTip = newRefs.get(ref)
        if (!newTip || mapping.has(oldTip) && mapping.get(oldTip) != newTip)
            return false
        mapping.set(oldTip, newTip)
    }
    if (new Set(mapping.values()).size != mapping.size)
        return false

    let unshared = (cache: TopologyCache, objectId: string, tip: string) => !cache.tips.some(other => other != tip && cache.graph.isAncestor(objectId, other))
    for (let [oldTip, newTip] of mapping) {
        if (oldTip == newTip)
            continue
        if (!unshared(before, oldTip, oldTip) || !unshared(after, newTip, newTip))
            return false
        let boundary = newTip
        while (!before.indexes.has(boundary)) {
            let record = after.records[after.indexes.get(boundary)!]
            if (!record || record.parentIds.length != 1 || !unshared(after, boundary, newTip))
                return false
            boundary = record.parentIds[0]
        }
        let old = oldTip
        while (old != boundary) {
            let record = before.records[before.indexes.get(old)!]
            if (!record || record.parentIds.length != 1 || !unshared(before, old, oldTip))
                return false
            old = record.parentIds[0]
        }
    }
    return true
}

function createBranches(
    refs: RefRecord[],
    worktrees: BranchGraphWorktree[],
    pulledUpstreams: Map<string, string>,
    primaryRef?: string,
): MutableBranch[] {
    let localRefs = refs.filter(ref => ref.ref.startsWith("refs/heads/"))
    let remoteRefs = refs.filter(ref => ref.ref.startsWith("refs/remotes/") && !ref.symbolicTarget)
    let remoteByName = new Map(remoteRefs.map(ref => [ref.ref, ref]))
    let consumedRemoteRefs = new Set<string>()
    let seeds: Array<{
        tip: string
        refs: RefRecord[]
        sourceUpstreams: Map<string, string>
    }> = []

    for (let local of localRefs) {
        let seedRefs = [local]
        let sourceUpstreams = new Map<string, string>()
        if (local.upstreamRef) {
            sourceUpstreams.set(local.ref, local.upstreamRef)
            let upstream = remoteByName.get(local.upstreamRef)
            if (upstream) {
                seedRefs.push(upstream)
                consumedRemoteRefs.add(upstream.ref)
            }
        }
        seeds.push({ tip: local.objectId, refs: seedRefs, sourceUpstreams })
    }
    for (let remote of remoteRefs) {
        if (!consumedRemoteRefs.has(remote.ref))
            seeds.push({ tip: remote.objectId, refs: [remote], sourceUpstreams: new Map() })
    }

    let grouped = new Map<string, typeof seeds>()
    for (let seed of seeds)
        grouped.set(seed.tip, [...grouped.get(seed.tip) ?? [], seed])

    return [...grouped.entries()].map(([tip, matchingSeeds]) => {
        let matchingRefs = unique(matchingSeeds.flatMap(seed => seed.refs), ref => ref.ref)
        let local = matchingRefs.filter(ref => ref.ref.startsWith("refs/heads/"))
        let remote = matchingRefs.filter(ref => ref.ref.startsWith("refs/remotes/"))
        let checkedOutRefs = new Set(worktrees.flatMap(worktree => worktree.branchRef ? [worktree.branchRef] : []))
        let preferred = [...local].sort((left, right) => {
            let checkout = Number(checkedOutRefs.has(right.ref)) - Number(checkedOutRefs.has(left.ref))
            return checkout || naturalCompare(shortRef(left.ref), shortRef(right.ref))
        })[0] ?? [...remote].sort((left, right) => naturalCompare(shortRef(left.ref), shortRef(right.ref)))[0]!
        let sourceUpstreams = new Map(matchingSeeds.flatMap(seed => [...seed.sourceUpstreams]))
        let upstreamRef = sourceUpstreams.get(preferred.ref)
        let upstreamTip = upstreamRef ? remoteByName.get(upstreamRef)?.objectId : undefined
        let allRefs = matchingRefs.map(ref => ref.ref).sort(naturalCompare)
        let id = `branch:${preferred.ref}`

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
            // As Pull latest decides: a diverged branch whose upstream is still the one it last pulled was rewritten
            // locally, and has nothing new to bring in.
            upstreamIncoming: preferred.behind > 0
                && (preferred.ahead == 0 || pulledUpstreams.has(preferred.ref) && pulledUpstreams.get(preferred.ref) != upstreamTip),
            base: { status: "unknown", candidates: [] },
            behindBase: false,
            involvement: "unknown",
            checkedOut: worktrees.filter(worktree => worktree.branchRef && local.some(ref => ref.ref == worktree.branchRef)),
            markers: [],
            tags: [],
            primary: primaryRef ? allRefs.includes(primaryRef) : false,
            remoteOnly: local.length == 0,
            published: false,
            merged: false,
            sourceUpstreams,
            ownRemoteTips: unique(remote.map(ref => ref.objectId), objectId => objectId),
        }
    })
}

function inferBases(branches: MutableBranch[], candidates: MutableBranch[], topology: GraphTopology) {
    let mergeBasesByBranch = new Map<MutableBranch, Array<{ candidate: MutableBranch; objectId: string }>>()
    let primary = candidates.find(candidate => candidate.primary)
    for (let branch of branches) {
        if (branch.primary) {
            branch.base = { status: "unknown", candidates: [] }
            continue
        }
        // A branch the Primary Branch already reaches has no unique commits, so the Primary Branch is its Base.
        // Candidates reaching its tip are otherwise skipped, which would leave only unrelated siblings forked beneath it.
        if (primary && topology.isAncestor(branch.tip, primary.tip)) {
            branch.base = knownBase(primary)
            continue
        }
        mergeBasesByBranch.set(branch, topology.mergeBases(branch, candidates))
    }
    let baseObjectIds = unique([...mergeBasesByBranch.values()].flat().map(entry => entry.objectId), objectId => objectId)
    let isAncestor = topology.ancestry(baseObjectIds)
    let candidatesById = new Map(candidates.map(candidate => [candidate.id, candidate]))
    let excluded = new Map<MutableBranch, Set<string>>()
    let closestBase = (mergeBases: Array<{ candidate: MutableBranch; objectId: string }>) =>
        chooseBase(closestMergeBases(mergeBases, isAncestor), topology.isAncestor)
    let infer = (branch: MutableBranch) => {
        let mergeBases = mergeBasesByBranch.get(branch)!
        let skippedTips = [...excluded.get(branch) ?? []].map(id => candidatesById.get(id)!.tip)
        let base = closestBase(mergeBases.filter(entry => !skippedTips.some(tip => topology.isAncestor(tip, entry.candidate.tip))))
        branch.base = base.status == "unknown" && skippedTips.length > 0 ? closestBase(mergeBases) : base
    }
    for (let branch of mergeBasesByBranch.keys())
        infer(branch)
    let holdsFork = (branch: MutableBranch, other: MutableBranch) =>
        mergeBasesByBranch.get(other)!.some(entry => entry.candidate == branch && branch.ownRemoteTips.includes(entry.objectId))

    // Siblings diverging from a commit that no other branch holds each see the other as a closest candidate.
    // Neither owns the shared commits, so both fall back to the next Base below the fork,
    // skipping the other and any branches stacked on it. Without a Base below the fork, they stay candidates.
    for (let pending = [...mergeBasesByBranch.keys()]; pending.length > 0;) {
        let affected = new Set<MutableBranch>()
        for (let branch of pending) {
            for (let baseId of baseCandidateIds(branch.base)) {
                let base = candidatesById.get(baseId)
                if (!base || !mergeBasesByBranch.has(base) || excluded.get(branch)?.has(base.id) || !baseCandidateIds(base.base).includes(branch.id))
                    continue
                // A sibling whose own remote ref sits at the fork holds the shared commits, so it stays the
                // other's Base and only stops seeing the branch stacked on it.
                let holders = [branch, base].filter(sibling => holdsFork(sibling, sibling == branch ? base : branch))
                if (holders.length == 1) {
                    let [holder] = holders
                    let stacked = holder == branch ? base : branch
                    excluded.set(holder, (excluded.get(holder) ?? new Set()).add(stacked.id))
                    affected.add(holder)
                    continue
                }
                excluded.set(branch, (excluded.get(branch) ?? new Set()).add(base.id))
                excluded.set(base, (excluded.get(base) ?? new Set()).add(branch.id))
                affected.add(branch).add(base)
            }
        }
        for (let branch of affected)
            infer(branch)
        pending = [...affected]
    }
}

function closestMergeBases(
    mergeBases: Array<{ candidate: MutableBranch; objectId: string }>,
    isAncestor: (ancestor: string, descendant: string) => boolean,
) {
    let closest: typeof mergeBases = []
    let frontier: string[] = []

    for (let entry of mergeBases) {
        if (!frontier.some(objectId => entry.objectId != objectId && isAncestor(entry.objectId, objectId))) {
            closest.push(entry)
            if (!frontier.includes(entry.objectId))
                frontier.push(entry.objectId)
        }
    }

    return closest
}

function chooseBase(
    entries: Array<{ candidate: MutableBranch; objectId: string }>,
    isAncestor: (ancestor: string, descendant: string) => boolean,
): BranchGraphBase {
    let uniqueCandidates = unique(entries, entry => entry.candidate.id)
    if (uniqueCandidates.length == 0)
        return { status: "unknown", candidates: [] }

    // Candidates sharing one fork point are equally close, so the Primary Branch wins the tie
    // before stacking is considered: branches merged beneath its tip never displace it.
    let sameTopology = new Set(uniqueCandidates.map(entry => entry.objectId)).size == 1
    let primary = sameTopology ? uniqueCandidates.find(entry => entry.candidate.primary) : undefined
    if (primary)
        return knownBase(primary.candidate)
    let lowest = lowestCandidates(uniqueCandidates, isAncestor)
    if (lowest.length == 1)
        return knownBase(lowest[0].candidate)
    return {
        status: "ambiguous",
        candidates: lowest.map(entry => baseCandidate(entry.candidate)).sort((left, right) => naturalCompare(left.name, right.name)),
    }
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
    let hasIdentities = Boolean(identities.primary || identities.secondary.length > 0)

    for (let branch of branches) {
        if (branch.base.status != "known") {
            branch.behindBase = false
            branch.involvement = "unknown"
            branch.lastUniqueCommit = undefined
        } else {
            branch.behindBase = !topology.isAncestor(branch.base.tip, branch.tip)
            branch.lastUniqueCommit = summaries.get(branch.tip)
            branch.involvement = !hasIdentities
                ? "unknown"
                : topology.hasExclusive(authoredCommits, branch.tip, branch.base.tip)
                ? "involved"
                : "uninvolved"
        }
    }
}

function includeBaseRelationships(branches: MutableBranch[], included: Set<string>) {
    let changed = true
    while (changed) {
        changed = false
        for (let branch of branches.filter(candidate => included.has(candidate.id))) {
            let baseIds = baseCandidateIds(branch.base)
            for (let id of baseIds) {
                if (!included.has(id)) {
                    included.add(id)
                    changed = true
                }
            }
        }
    }
}

function baseCandidateIds(base: BranchGraphBase) {
    return base.status == "known" ? [base.branchId] : base.candidates.map(candidate => candidate.branchId)
}

function attachStashes(branches: MutableBranch[], stashes: StashRecord[]) {
    for (let stash of stashes.filter(stash => stash.branch !== null)) {
        let branchName = stash.branch ?? /^(?:WIP on|On) ([^:]+):/.exec(stash.subject)?.[1]
        let named = branchName ? branches.find(branch => branch.aliases.includes(branchName)) : undefined
        let parent = stash.parentIds[0]
        let exactParents = parent ? branches.filter(branch => branch.tip == parent) : []
        let owner = named ?? (stash.branch === undefined && exactParents.length == 1 ? exactParents[0] : undefined)

        if (owner)
            owner.markers.push(stashMarker(stash))
    }
}

function unassignedStashes(branches: MutableBranch[], stashes: StashRecord[]) {
    let assigned = new Set(branches.flatMap(branch => branch.markers.map(marker => marker.id)))
    return stashes.map(stashMarker).filter(marker => !assigned.has(marker.id))
}

function placeTags(refs: RefRecord[], branches: MutableBranch[], topology: GraphTopology) {
    let branchTags = new Map<string, string[]>()
    let tagNodes: BranchGraphTagNode[] = []
    for (let tag of refs.filter(ref => ref.ref.startsWith("refs/tags/"))) {
        let target = tag.peeledObjectId || tag.objectId
        let head = branches.find(branch => branch.tip == target)
        if (head) {
            branchTags.set(head.id, [...branchTags.get(head.id) ?? [], shortRef(tag.ref)].sort(naturalCompare))
            continue
        }
        let possibleParents: MutableBranch[] = []
        for (let branch of branches) {
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

async function readAuthoredCommits(
    runner: GraphRunner,
    commits: string[],
    identities: AuthorIdentitySettings,
    key: string,
    cached?: AuthorCache,
): Promise<AuthorCache> {
    let emails = [identities.primary, ...identities.secondary].filter((email): email is string => Boolean(email))
    if (emails.length == 0 || commits.length == 0)
        return { key, matches: new Map() }
    let known = cached?.key == key ? cached.matches : new Map<string, boolean>()
    let missing = commits.filter(objectId => !known.has(objectId))
    let authorArguments = emails.flatMap(email => ["--author", `<${escapeRegularExpression(email)}>$`])
    let output = missing.length
        ? text(
            await runner.run(
                ["log", "--stdin", "--no-walk", "--use-mailmap", "--regexp-ignore-case", "--format=%H", ...authorArguments],
                [0],
                `${missing.join("\n")}\n`,
            ),
        )
        : ""
    let matched = new Set(output.split("\n").filter(Boolean))

    return { key, matches: new Map(commits.map(objectId => [objectId, known.get(objectId) ?? matched.has(objectId)])) }
}

function escapeRegularExpression(value: string) {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
}

async function readPrimaryBranch(runner: GraphRunner, refs: RefRecord[], remote: string | undefined, refreshRemote: boolean) {
    if (!remote)
        return { status: "unknown" as const, reason: "Choose a remote to infer the Primary Branch." }

    let cached = refs.find(ref => ref.ref == `refs/remotes/${remote}/HEAD`)?.symbolicTarget
    let branchName = cached?.replace(`refs/remotes/${remote}/`, "")
    let remoteFailure: string | undefined
    if (refreshRemote) {
        let result = await runner.run(["ls-remote", "--symref", remote, "HEAD"], [0, 1, 2, 128])
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

    let ref = `refs/remotes/${remote}/${branchName}`
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
    for (let baseTip of request.baseTips)
        validateObjectId(descriptor, baseTip)
    let remoteTips = request.remoteTips ?? []
    for (let remoteTip of remoteTips)
        validateObjectId(descriptor, remoteTip)

    let before = request.branchRef == request.tip
        ? request.tip
        : optionalText(await runner.run(["rev-parse", "--verify", "--quiet", request.branchRef], [0, 1]))
    if (before != request.tip)
        throw new GitError("git.command-failed", "The branch moved before Laneway could expand its commits. Refresh the Branch Graph and try again.")

    let offset = Math.max(0, request.offset ?? 0)
    let limit = Math.min(200, Math.max(1, request.limit ?? 100))
    let output = text(
        await runner.run([
            "log",
            "--use-mailmap",
            "--topo-order",
            "--first-parent",
            `--skip=${offset}`,
            `--max-count=${limit + 1}`,
            // Bodies span lines, so records end in NUL as well and the fields are read in groups of seven.
            "-z",
            "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%s%x00%b",
            request.tip,
            ...(request.baseTips.length > 0 ? ["--not", ...request.baseTips] : []),
        ]),
    )
    let commits = parseHistory(output)

    if (remoteTips.includes(request.tip)) {
        for (let commit of commits)
            commit.remote = true
    } else if (remoteTips.length > 0) {
        // Only unpublished commits are listed, so the walk stays as short as the branch's lead over its remotes.
        // Repositories can have many remote branches, so their tips go through stdin rather than the command line.
        let exclusions = [...remoteTips, ...request.baseTips].map(objectId => `^${objectId}\n`).join("")
        let local = new Set(text(await runner.run(["rev-list", "--stdin", request.tip], [0], exclusions)).split("\n").filter(Boolean))
        for (let commit of commits)
            commit.remote = !local.has(commit.objectId)
    }

    let after = request.branchRef == request.tip
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
        let [ref, objectId, peeledObjectId, upstreamRef, symbolicTarget, authoredAt, subject, tracking] = line.split("\0")
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
        let values = new Map(fields.map(field => {
            let separator = field.indexOf(" ")
            return separator < 0 ? [field, ""] : [field.slice(0, separator), field.slice(separator + 1)]
        }))
        let path = values.get("worktree") ?? ""
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
        let [selector, objectId, parents, subject] = line.split("\0")
        return { selector, objectId, parentIds: parents.split(" ").filter(Boolean), subject }
    })
}

function parseHistory(output: string): BranchHistoryCommit[] {
    let fields = output.split("\0")
    let commits: BranchHistoryCommit[] = []
    for (let index = 0; index + 6 < fields.length; index += 7) {
        let [objectId, parents, authorName, authorEmail, authoredAt, subject, body] = fields.slice(index, index + 7)
        commits.push({
            objectId,
            parentIds: parents.split(" ").filter(Boolean),
            authorName,
            authorEmail,
            authoredAt: Number(authoredAt),
            subject,
            body: body.trimEnd(),
        })
    }
    return commits
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
        let character = value[index]
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

function verificationFingerprint(evidence: Pick<Evidence, "refText" | "worktreeText" | "context">) {
    return `${evidence.refText}\0${evidence.worktreeText}\0${evidence.context.fingerprint}`
}

function fingerprint(evidence: Evidence) {
    return `${evidence.remoteText}\0${evidence.refText}\0${evidence.worktreeText}\0${evidence.stashText}\0${evidence.context.fingerprint}`
}

function optionalText(result: CommandResult) {
    let value = text(result)
    return value || undefined
}

function text(result: CommandResult) {
    return result.stdout.toString().trim()
}

function unique<T>(values: T[], key: (value: T) => string) {
    return [...new Map(values.map(value => [key(value), value])).values()]
}

function withoutInternals(branch: MutableBranch): BranchGraphBranchNode {
    let { sourceUpstreams, ownRemoteTips, ...result } = branch
    void sourceUpstreams
    void ownRemoteTips
    return result
}

function validateObjectId(descriptor: RepositoryDescriptor, objectId: string) {
    let length = descriptor.objectFormat == "sha1" ? 40 : 64
    if (!new RegExp(`^[0-9a-f]{${length}}$`).test(objectId))
        throw new GitError("git.command-failed", `Laneway received an invalid ${descriptor.objectFormat} object ID.`)
}

function cancelledError() {
    return new GitError("git.cancelled", "Branch Graph read cancelled.")
}
