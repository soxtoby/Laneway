import type { AuthorIdentitySettings, BranchGraph, BranchGraphBase, BranchGraphBranchNode, BranchGraphMarker, BranchGraphReadOptions, BranchGraphTagNode, BranchGraphVirtualBranch, BranchGraphWorktree, BranchHistoryCommit, BranchHistoryPage, BranchHistoryRequest } from "@laneway/shared"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
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

interface TopologyRecord {
    objectId: string
    parentIds: string[]
}

interface TopologyCache {
    key: string
    tips: string[]
    records: TopologyRecord[]
    indexes: Map<string, number>
    graph: GraphTopology
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

interface MutableBranch extends BranchGraphBranchNode {
    sourceUpstreams: Map<string, string>
    /** Tips of this branch's own remote refs, including an upstream that has diverged. */
    ownRemoteTips: string[]
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
    exclusiveCommits(branches: MutableBranch[], candidates?: string[]): string[]
    hasExclusive(commits: Set<string>, tip: string, base: string): boolean
}

interface GraphRunner {
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
        checkCancelled() {
            if (cancelled)
                throw cancelledError()
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
        runner.checkCancelled()
        const previous = cached && [cached, ...cached.recent].find(value => value.key == key && value.evidence == beforeFingerprint)
        if (!options.refreshRemote && previous)
            return structuredClone(previous.graph)
        const built = await buildGraph(descriptor, runner, options, before, () => readVerificationEvidence(runner, descriptor), cached)
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
    const [refResult, worktreeResult, context] = await Promise.all([
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
    })
}

async function readEvidence(runner: GraphRunner, descriptor: RepositoryDescriptor): Promise<Evidence> {
    const [remoteResult, refResult, worktreeResult, stashResult, context] = await Promise.all([
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
        context,
    }
}

async function readGraphContext(runner: GraphRunner, descriptor: RepositoryDescriptor): Promise<GraphContext> {
    const contents = async (path: string) =>
        readFile(path).catch(error => {
            if ((error as NodeJS.ErrnoException).code == "ENOENT")
                return Buffer.alloc(0)
            throw error
        })
    const [configuration, mailmap, shallow, grafts] = await Promise.all([
        runner.run(["config", "--null", "--list", "--includes"]),
        contents(join(descriptor.mainWorktree, ".mailmap")),
        contents(resolve(descriptor.mainWorktree, process.env.GIT_SHALLOW_FILE ?? join(descriptor.commonDirectory, "shallow"))),
        contents(resolve(descriptor.mainWorktree, process.env.GIT_GRAFT_FILE ?? join(descriptor.commonDirectory, "info", "grafts"))),
    ])
    const values = new Map(
        configuration.stdout.toString().split("\0").filter(Boolean).map(record => {
            const separator = record.indexOf("\n")
            return separator < 0 ? [record, ""] : [record.slice(0, separator), record.slice(separator + 1)]
        }),
    )
    const [extraMailmap, mailmapBlob] = await Promise.all([
        values.get("mailmap.file")
            ? runner.run(["config", "--path", "--get", "mailmap.file"]).then(result => contents(resolve(descriptor.mainWorktree, text(result))))
            : Buffer.alloc(0),
        values.get("mailmap.blob")
            ? runner.run(["rev-parse", "--verify", "--quiet", `${values.get("mailmap.blob")}^{blob}`], [0, 1, 128]).then(result => result.stdout)
            : Buffer.alloc(0),
    ])
    const topology = digest([
        shallow,
        grafts,
        values.get("core.usereplacerefs") ?? "",
        process.env.GIT_NO_REPLACE_OBJECTS ?? "",
        process.env.GIT_REPLACE_REF_BASE ?? "",
    ])
    const authors = digest([configuration.stdout, mailmap, extraMailmap, mailmapBlob])
    return {
        fingerprint: digest([configuration.stdout, topology, authors]),
        topology,
        authors,
        email: values.get("user.email") || undefined,
        shallow: Boolean(shallow.length),
    }
}

function digest(parts: Array<string | Buffer>) {
    const hash = createHash("sha256")
    for (const part of parts)
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
    const availableRemotes = [...new Set([...evidence.remotes, ...listRefRemotes(evidence.refs)])].sort(naturalCompare)
    const selectedRemote = options.selectedRemote && availableRemotes.includes(options.selectedRemote)
        ? options.selectedRemote
        : availableRemotes.length == 1
        ? availableRemotes[0]
        : undefined
    const tips = graphTips(evidence.refs)
    const replacements = evidence.refs.filter(ref => ref.ref.startsWith(process.env.GIT_REPLACE_REF_BASE ?? "refs/replace/")).map(
        ref => [ref.ref, ref.objectId],
    )
    const topologyKey = evidence.context.topology + JSON.stringify(replacements)
    const topologyPromise = readTopology(runner, tips, topologyKey, cached?.topology)
    const effectiveAuthorEmail = evidence.context.email
    const authorIdentities = effectiveIdentities(options.authorIdentities, effectiveAuthorEmail)
    const [primaryBranch, topologyCache] = await Promise.all([
        readPrimaryBranch(runner, evidence.refs, selectedRemote, options.refreshRemote == true),
        topologyPromise,
    ])
    const topology = topologyCache.graph
    const verificationPromise = verify()
    const branches = createBranches(evidence.refs, evidence.worktrees, primaryBranch.ref)
    const summaries = new Map(
        evidence.refs.filter(ref =>
            (ref.ref.startsWith("refs/heads/") || ref.ref.startsWith("refs/remotes/"))
            && ref.authoredAt != undefined
            && ref.subject != undefined
        )
            .map(ref => [ref.objectId, { objectId: ref.objectId, authoredAt: ref.authoredAt!, subject: ref.subject! }]),
    )

    const analysis = analyzeBranches(branches, evidence.refs, topologyCache, cached)
    const exclusiveCommits = analysis.exclusive
    const authorKey = topologyKey + evidence.context.authors + JSON.stringify(authorIdentities)
    const [authors, verification] = await Promise.all([
        readAuthoredCommits(runner, exclusiveCommits, authorIdentities, authorKey, cached?.authors),
        verificationPromise,
    ])
    const authoredCommits = new Set(exclusiveCommits.filter(objectId => authors.matches.get(objectId)))
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
    const remoteTips = unique(
        evidence.refs.filter(ref => ref.ref.startsWith("refs/remotes/") && !ref.symbolicTarget).map(ref => ref.objectId),
        objectId => objectId,
    )
    for (const branch of visibleBranches) {
        branch.merged = Boolean(primary && branch.id != primary.id && topology.isAncestor(branch.tip, primary.tip))
        branch.published = branch.ownRemoteTips.some(remoteTip => topology.isAncestor(branch.tip, remoteTip))
    }
    const virtualBranches = createVirtualBranches(evidence.worktrees)
    const history = graphHistory(topology.commits, [
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
    const shape = JSON.stringify(branches.map(branch => [branch.id, branch.refs, branch.primary, [...branch.sourceUpstreams]]))
    const tips = new Map(
        refs.filter(ref => ref.ref.startsWith("refs/heads/") || ref.ref.startsWith("refs/remotes/") && !ref.symbolicTarget).map(ref => [ref.ref, ref.objectId]),
    )
    const reusable = cached?.analysis.shape == shape && equivalentBranchEnds(cached.topology, topology, cached.analysis.tips, tips)
    let exclusive: string[]
    if (reusable) {
        const byId = new Map(branches.map(branch => [branch.id, branch]))
        for (const branch of branches) {
            const base = cached.analysis.bases.get(branch.id)!
            branch.base = base.status == "known" ? knownBase(byId.get(base.branchId)!) : {
                status: base.status,
                candidates: base.candidates.map(candidate => baseCandidate(byId.get(candidate.branchId)!)),
            }
        }
        const added = topology.records.filter(record => !cached.topology.indexes.has(record.objectId)).map(record => record.objectId)
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
    const mapping = new Map<string, string>()
    for (const [ref, oldTip] of oldRefs) {
        const newTip = newRefs.get(ref)
        if (!newTip || mapping.has(oldTip) && mapping.get(oldTip) != newTip)
            return false
        mapping.set(oldTip, newTip)
    }
    if (new Set(mapping.values()).size != mapping.size)
        return false
    const unshared = (cache: TopologyCache, objectId: string, tip: string) => !cache.tips.some(other => other != tip && cache.graph.isAncestor(objectId, other))
    for (const [oldTip, newTip] of mapping) {
        if (oldTip == newTip)
            continue
        if (!unshared(before, oldTip, oldTip) || !unshared(after, newTip, newTip))
            return false
        let boundary = newTip
        while (!before.indexes.has(boundary)) {
            const record = after.records[after.indexes.get(boundary)!]
            if (!record || record.parentIds.length != 1 || !unshared(after, boundary, newTip))
                return false
            boundary = record.parentIds[0]
        }
        let old = oldTip
        while (old != boundary) {
            const record = before.records[before.indexes.get(old)!]
            if (!record || record.parentIds.length != 1 || !unshared(before, old, oldTip))
                return false
            old = record.parentIds[0]
        }
    }
    return true
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
            published: false,
            merged: false,
            sourceUpstreams,
            ownRemoteTips: unique(remote.map(ref => ref.objectId), objectId => objectId),
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
        chooseBase(closestMergeBases(mergeBases, isAncestor), topology.isAncestor)
    const infer = (branch: MutableBranch) => {
        const mergeBases = mergeBasesByBranch.get(branch)!
        const skippedTips = [...excluded.get(branch) ?? []].map(id => candidatesById.get(id)!.tip)
        const base = closestBase(mergeBases.filter(entry => !skippedTips.some(tip => topology.isAncestor(tip, entry.candidate.tip))))
        branch.base = base.status == "unknown" && skippedTips.length > 0 ? closestBase(mergeBases) : base
    }
    for (const branch of mergeBasesByBranch.keys())
        infer(branch)
    const holdsFork = (branch: MutableBranch, other: MutableBranch) =>
        mergeBasesByBranch.get(other)!.some(entry => entry.candidate == branch && branch.ownRemoteTips.includes(entry.objectId))

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
                // A sibling whose own remote ref sits at the fork holds the shared commits, so it stays the
                // other's Base and only stops seeing the branch stacked on it.
                const holders = [branch, base].filter(sibling => holdsFork(sibling, sibling == branch ? base : branch))
                if (holders.length == 1) {
                    const [holder] = holders
                    const stacked = holder == branch ? base : branch
                    excluded.set(holder, (excluded.get(holder) ?? new Set()).add(stacked.id))
                    affected.add(holder)
                    continue
                }
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

function chooseBase(
    entries: Array<{ candidate: MutableBranch; objectId: string }>,
    isAncestor: (ancestor: string, descendant: string) => boolean,
): BranchGraphBase {
    const uniqueCandidates = unique(entries, entry => entry.candidate.id)
    if (uniqueCandidates.length == 0)
        return { status: "unknown", candidates: [] }
    // Candidates sharing one fork point are equally close, so the Primary Branch wins the tie
    // before stacking is considered: branches merged beneath its tip never displace it.
    const sameTopology = new Set(uniqueCandidates.map(entry => entry.objectId)).size == 1
    const primary = sameTopology ? uniqueCandidates.find(entry => entry.candidate.primary) : undefined
    if (primary)
        return knownBase(primary.candidate)
    const lowest = lowestCandidates(uniqueCandidates, isAncestor)
    if (lowest.length == 1)
        return knownBase(lowest[0].candidate)
    return {
        status: "ambiguous",
        candidates: lowest.map(entry => baseCandidate(entry.candidate)).sort((left, right) => naturalCompare(left.name, right.name)),
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

async function readTopology(runner: GraphRunner, tips: string[], key: string, cached?: TopologyCache): Promise<TopologyCache> {
    const reusable = cached?.key == key ? cached : undefined
    if (reusable && tips.length == reusable.tips.length && tips.every(tip => reusable.tips.includes(tip)))
        return reusable
    let records: TopologyRecord[] | undefined
    if (reusable) {
        const added = tips.filter(tip => !reusable.indexes.has(tip))
        const result = added.length
            ? await runner.run(
                ["rev-list", "--topo-order", "--parents", "--stdin"],
                [0, 128],
                [...added, ...reusable.tips.map(tip => `^${tip}`), ""].join("\n"),
            )
            : undefined
        if (!result?.exitCode) {
            // New records precede the cached ancestry; both portions remain topologically ordered.
            const addedRecords = result ? parseTopology(result.stdout.toString()) : []
            const byId = new Map(addedRecords.map(record => [record.objectId, record]))
            const reachable = new Set<string>(), pending = [...tips]
            while (pending.length) {
                const objectId = pending.pop()!
                if (reachable.has(objectId))
                    continue
                reachable.add(objectId)
                const record = byId.get(objectId) ?? reusable.records[reusable.indexes.get(objectId)!]
                pending.push(...record?.parentIds ?? [])
            }
            records = [...addedRecords, ...reusable.records.filter(record => reachable.has(record.objectId))]
        }
    }
    // An excluded old tip may have been collected after an external rewrite. Re-read current roots.
    records ??= tips.length ? parseTopology(text(await runner.run(["rev-list", "--topo-order", "--parents", "--stdin"], [0], tips.join("\n") + "\n"))) : []
    const indexes = new Map(records.map((record, index) => [record.objectId, index]))
    return { key, tips, records, indexes, graph: createTopology(records, tips, indexes) }
}

function createTopology(records: TopologyRecord[], tips: string[], commitIndexes: Map<string, number>): GraphTopology {
    if (!tips.length)
        return emptyTopology()
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
        exclusiveCommits(branches, candidates) {
            const ranges = branches.flatMap(branch => {
                if (branch.base.status != "known")
                    return []
                const tipIndex = tipIndexes.get(branch.tip)
                const baseIndex = tipIndexes.get(branch.base.tip)
                return tipIndex == undefined || baseIndex == undefined ? [] : [{ tipIndex, baseIndex }]
            })
            const result: string[] = []
            const indexes = candidates ? candidates.map(objectId => commitIndexes.get(objectId)!).filter(index => index != undefined) : commits.keys()
            for (const commitIndex of indexes) {
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
    const records: TopologyRecord[] = []
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

async function readAuthoredCommits(
    runner: GraphRunner,
    commits: string[],
    identities: AuthorIdentitySettings,
    key: string,
    cached?: AuthorCache,
): Promise<AuthorCache> {
    const emails = [identities.primary, ...identities.secondary].filter((email): email is string => Boolean(email))
    if (emails.length == 0 || commits.length == 0)
        return { key, matches: new Map() }
    const known = cached?.key == key ? cached.matches : new Map<string, boolean>()
    const missing = commits.filter(objectId => !known.has(objectId))
    const authorArguments = emails.flatMap(email => ["--author", `<${escapeRegularExpression(email)}>$`])
    const output = missing.length
        ? text(
            await runner.run(
                ["log", "--stdin", "--no-walk", "--use-mailmap", "--regexp-ignore-case", "--format=%H", ...authorArguments],
                [0],
                `${missing.join("\n")}\n`,
            ),
        )
        : ""
    const matched = new Set(output.split("\n").filter(Boolean))
    return { key, matches: new Map(commits.map(objectId => [objectId, known.get(objectId) ?? matched.has(objectId)])) }
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
    const remoteTips = request.remoteTips ?? []
    for (const remoteTip of remoteTips)
        validateObjectId(descriptor, remoteTip)
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
    if (remoteTips.includes(request.tip)) {
        for (const commit of commits)
            commit.remote = true
    } else if (remoteTips.length > 0) {
        // Only unpublished commits are listed, so the walk stays as short as the branch's lead over its remotes.
        // Repositories can have many remote branches, so their tips go through stdin rather than the command line.
        const exclusions = [...remoteTips, ...request.baseTips].map(objectId => `^${objectId}\n`).join("")
        const local = new Set(text(await runner.run(["rev-list", "--stdin", request.tip], [0], exclusions)).split("\n").filter(Boolean))
        for (const commit of commits)
            commit.remote = !local.has(commit.objectId)
    }
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
    return `${evidence.remoteText}\0${evidence.refText}\0${evidence.worktreeText}\0${evidence.stashText}\0${evidence.context.fingerprint}`
}

function verificationFingerprint(evidence: Pick<Evidence, "refText" | "worktreeText" | "context">) {
    return `${evidence.refText}\0${evidence.worktreeText}\0${evidence.context.fingerprint}`
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
    const { sourceUpstreams, ownRemoteTips, ...result } = branch
    void sourceUpstreams
    void ownRemoteTips
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
