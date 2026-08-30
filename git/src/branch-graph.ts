import type { AuthorIdentitySettings, BranchGraph, BranchGraphBase, BranchGraphBranchNode, BranchGraphMarker, BranchGraphReadOptions, BranchGraphTagNode, BranchGraphVirtualBranch, BranchGraphWorktree, BranchHistoryCommit, BranchHistoryPage, BranchHistoryRequest } from "@git-workbench/shared"
import { basename } from "node:path"
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

type StartCommand = (args: string[]) => CommandExecution

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
}

interface StashRecord {
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

interface GraphRunner {
    run(args: string[], acceptedExitCodes?: number[]): Promise<CommandResult>
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
    let current: CommandExecution | undefined
    return {
        cancel() {
            cancelled = true
            current?.cancel()
        },
        async run(args, acceptedExitCodes = [0]) {
            if (cancelled)
                throw cancelledError()
            current = startCommand(args)
            const result = await current.result
            if (cancelled || current.wasCancelled())
                throw cancelledError()
            current = undefined
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
        const before = await readEvidence(runner)
        const beforeFingerprint = fingerprint(before)
        if (!options.refreshRemote && cached?.key == key && cached.evidence == beforeFingerprint)
            return cached.graph
        const graph = await buildGraph(descriptor, runner, options, before)
        const after = await readEvidence(runner)
        if (beforeFingerprint == fingerprint(after)) {
            cache?.({ key, evidence: beforeFingerprint, graph })
            return graph
        }
    }
    throw new GitError(
        "git.command-failed",
        "Repository refs kept changing while Workbench read the Branch Graph. Workbench will retry while the graph is visible.",
    )
}

function graphOptionsKey(options: BranchGraphReadOptions) {
    return JSON.stringify({
        authorIdentities: options.authorIdentities,
        selectedRemote: options.selectedRemote,
        remotePatterns: options.remotePatterns,
    })
}

async function readEvidence(runner: GraphRunner): Promise<Evidence> {
    const remoteText = text(await runner.run(["remote"]))
    const refText = text(
        await runner.run([
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(symref)%00",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/stash",
        ]),
    )
    const worktreeText = text(await runner.run(["worktree", "list", "--porcelain", "-z"]))
    const stashResult = await runner.run(["stash", "list", "--format=%gd%x00%H%x00%P%x00%gs"], [0])
    const stashText = text(stashResult)
    return {
        remotes: remoteText.split("\n").filter(Boolean).sort(naturalCompare),
        remoteText,
        refs: parseRefs(refText),
        refText,
        stashes: parseStashes(stashText),
        stashText,
        worktrees: parseWorktrees(worktreeText),
        worktreeText,
    }
}

async function buildGraph(
    descriptor: RepositoryDescriptor,
    runner: GraphRunner,
    options: BranchGraphReadOptions,
    evidence: Evidence,
): Promise<BranchGraph> {
    const availableRemotes = [...new Set([...evidence.remotes, ...listRefRemotes(evidence.refs)])].sort(naturalCompare)
    const selectedRemote = options.selectedRemote && availableRemotes.includes(options.selectedRemote)
        ? options.selectedRemote
        : availableRemotes.length == 1
        ? availableRemotes[0]
        : undefined
    const effectiveAuthorEmail = optionalText(await runner.run(["config", "--get", "user.email"], [0, 1]))
    const authorIdentities = effectiveIdentities(options.authorIdentities, effectiveAuthorEmail)
    const primaryBranch = await readPrimaryBranch(runner, evidence.refs, selectedRemote, options.refreshRemote == true)
    const branches = createBranches(evidence.refs, evidence.worktrees, primaryBranch.ref)
    const ancestry = ancestryReader(runner)

    await inferBases(branches, branches, ancestry)
    await enrichBranches(runner, branches, authorIdentities)

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
    let visibleBranches = branches.filter(branch => included.has(branch.id))
    await inferBases(visibleBranches, visibleBranches, ancestry)
    await enrichBranches(runner, visibleBranches, authorIdentities)
    includeBaseRelationships(visibleBranches, included)
    visibleBranches = visibleBranches.filter(branch => included.has(branch.id))

    attachStashes(visibleBranches, evidence.stashes)
    const { branchTags, tagNodes } = await placeTags(evidence.refs, visibleBranches, ancestry)
    for (const [branchId, tags] of branchTags) {
        const branch = visibleBranches.find(candidate => candidate.id == branchId)
        if (branch)
            branch.tags = tags
    }

    const primary = visibleBranches.find(branch => branch.primary)
    const referencedBases = new Set(
        visibleBranches.flatMap(branch => branch.base.status == "known" ? [branch.base.branchId] : branch.base.candidates.map(candidate => candidate.branchId)),
    )
    visibleBranches = (await filterMergedInactive(visibleBranches, primary, referencedBases, ancestry))
        .sort(compareBranches)

    return {
        repositoryId: descriptor.id,
        primaryBranch,
        availableRemotes,
        selectedRemote,
        remotePatterns: options.remotePatterns,
        authorIdentities,
        effectiveAuthorEmail,
        branches: visibleBranches.map(withoutInternals),
        tags: tagNodes.filter(tag => !tag.parentBranchId || visibleBranches.some(branch => branch.id == tag.parentBranchId)),
        virtualBranches: createVirtualBranches(evidence.worktrees),
        unassignedStashes: unassignedStashes(visibleBranches, evidence.stashes),
        limited: [
            ...(descriptor.shallow ? ["shallow" as const] : []),
            ...(descriptor.partial ? ["partial" as const] : []),
            ...(descriptor.sparse ? ["sparse" as const] : []),
        ],
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
            ahead: 0,
            behind: 0,
            base: { status: "unknown", candidates: [] },
            involvement: "unknown",
            checkedOut: worktrees.filter(worktree => worktree.branchRef && local.some(ref => ref.ref == worktree.branchRef)),
            markers: [],
            tags: [],
            primary: primaryRef ? allRefs.includes(primaryRef) : false,
            remoteOnly: local.length == 0,
            sourceUpstreams,
        }
    })
}

async function inferBases(branches: MutableBranch[], candidates: MutableBranch[], ancestry: ReturnType<typeof ancestryReader>) {
    for (const branch of branches) {
        if (branch.primary) {
            branch.base = { status: "unknown", candidates: [] }
            continue
        }
        const mergeBases: Array<{ candidate: MutableBranch; objectId: string }> = []
        for (const candidate of candidates) {
            if (candidate.id == branch.id || candidate.tip == branch.tip)
                continue
            if (await ancestry.isAncestor(branch.tip, candidate.tip))
                continue
            const objectId = await ancestry.mergeBase(branch.tip, candidate.tip)
            if (objectId)
                mergeBases.push({ candidate, objectId })
        }
        const closest: typeof mergeBases = []
        for (const entry of mergeBases) {
            let dominated = false
            for (const other of mergeBases) {
                if (entry.objectId != other.objectId && await ancestry.isAncestor(entry.objectId, other.objectId)) {
                    dominated = true
                    break
                }
            }
            if (!dominated)
                closest.push(entry)
        }
        branch.base = chooseBase(closest)
    }
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

async function enrichBranches(runner: GraphRunner, branches: MutableBranch[], identities: AuthorIdentitySettings) {
    for (const branch of branches) {
        if (branch.upstreamRef && branch.upstreamTip && branch.localRefs.length > 0) {
            const divergence = text(await runner.run(["rev-list", "--left-right", "--count", `${branch.tip}...${branch.upstreamTip}`], [0, 1]))
                .split(/\s+/).map(Number)
            branch.ahead = Number.isFinite(divergence[0]) ? divergence[0] : 0
            branch.behind = Number.isFinite(divergence[1]) ? divergence[1] : 0
        }
        if (branch.base.status != "known") {
            branch.involvement = "unknown"
            branch.lastUniqueCommit = undefined
            continue
        }
        const range = `${branch.base.tip}..${branch.tip}`
        const latest = optionalText(
            await runner.run([
                "log",
                "--use-mailmap",
                "-1",
                "--format=%H%x00%at%x00%s",
                range,
            ], [0, 128]),
        )
        branch.lastUniqueCommit = latest ? parseCommitSummary(latest) : undefined
        const emails = [identities.primary, ...identities.secondary].filter((email): email is string => Boolean(email))
        if (emails.length == 0) {
            branch.involvement = "unknown"
            continue
        }
        const authorArguments = emails.flatMap(email => ["--author", `<${escapeRegularExpression(email)}>$`])
        const involved = optionalText(
            await runner.run([
                "log",
                "--use-mailmap",
                "--regexp-ignore-case",
                "-1",
                "--format=%H",
                ...authorArguments,
                range,
            ], [0, 128]),
        )
        branch.involvement = involved ? "involved" : "uninvolved"
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
            const baseIds = branch.base.status == "known" ? [branch.base.branchId] : branch.base.candidates.map(candidate => candidate.branchId)
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
        const branchName = /^(?:WIP on|On) ([^:]+):/.exec(stash.subject)?.[1]
        const named = branchName ? branches.find(branch => branch.aliases.includes(branchName)) : undefined
        const parent = stash.parentIds[0]
        const exactParents = parent ? branches.filter(branch => branch.tip == parent) : []
        const owner = named ?? (exactParents.length == 1 ? exactParents[0] : undefined)
        if (owner)
            owner.markers.push(stashMarker(stash))
    }
}

function unassignedStashes(branches: MutableBranch[], stashes: StashRecord[]) {
    const assigned = new Set(branches.flatMap(branch => branch.markers.map(marker => marker.id)))
    return stashes.map(stashMarker).filter(marker => !assigned.has(marker.id))
}

async function placeTags(refs: RefRecord[], branches: MutableBranch[], ancestry: ReturnType<typeof ancestryReader>) {
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
            if (!await ancestry.isAncestor(target, branch.tip))
                continue
            if (branch.base.status == "known" && await ancestry.isAncestor(target, branch.base.tip))
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

async function filterMergedInactive(
    branches: MutableBranch[],
    primary: MutableBranch | undefined,
    referencedBases: Set<string>,
    ancestry: ReturnType<typeof ancestryReader>,
) {
    if (!primary)
        return branches
    const result: MutableBranch[] = []
    for (const branch of branches) {
        const merged = branch.id != primary.id
            && branch.checkedOut.length == 0
            && !referencedBases.has(branch.id)
            && await ancestry.isAncestor(branch.tip, primary.tip)
        if (!merged)
            result.push(branch)
    }
    return result
}

function createVirtualBranches(worktrees: BranchGraphWorktree[]): BranchGraphVirtualBranch[] {
    return worktrees.filter(worktree => !worktree.branchRef).map(worktree => ({
        kind: "virtual",
        id: `virtual:${worktree.path}`,
        name: worktree.name,
        objectId: worktree.head,
        worktree,
        tooltip: `detached at ${shortObjectId(worktree.head)}`,
    }))
}

function ancestryReader(runner: GraphRunner) {
    const ancestors = new Map<string, boolean>()
    const mergeBases = new Map<string, string | null>()
    return {
        async isAncestor(ancestor: string, descendant: string) {
            if (ancestor == descendant)
                return true
            const key = `${ancestor}\0${descendant}`
            const cached = ancestors.get(key)
            if (cached != undefined)
                return cached
            const result = await runner.run(["merge-base", "--is-ancestor", ancestor, descendant], [0, 1])
            const value = result.exitCode == 0
            ancestors.set(key, value)
            return value
        },
        async mergeBase(left: string, right: string) {
            const key = [left, right].sort().join("\0")
            if (mergeBases.has(key))
                return mergeBases.get(key)!
            const result = await runner.run(["merge-base", left, right], [0, 1])
            const value = result.exitCode == 0 ? optionalText(result) ?? null : null
            mergeBases.set(key, value)
            return value
        },
    }
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
    validateObjectId(descriptor, request.baseTip)
    const before = optionalText(await runner.run(["rev-parse", "--verify", "--quiet", request.branchRef], [0, 1]))
    if (before != request.tip)
        throw new GitError("git.command-failed", "The branch moved before Workbench could expand its commits. Refresh the Branch Graph and try again.")
    const offset = Math.max(0, request.offset ?? 0)
    const limit = Math.min(200, Math.max(1, request.limit ?? 100))
    const output = text(
        await runner.run([
            "log",
            "--use-mailmap",
            "--topo-order",
            `--skip=${offset}`,
            `--max-count=${limit + 1}`,
            "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%s",
            `${request.baseTip}..${request.tip}`,
        ]),
    )
    const commits = parseHistory(output)
    const after = optionalText(await runner.run(["rev-parse", "--verify", "--quiet", request.branchRef], [0, 1]))
    if (after != request.tip)
        throw new GitError("git.command-failed", "The branch moved while Workbench expanded its commits. Refresh the Branch Graph and try again.")
    return {
        branchRef: request.branchRef,
        tip: request.tip,
        baseTip: request.baseTip,
        commits: commits.slice(0, limit),
        ...(commits.length > limit ? { nextOffset: offset + limit } : {}),
    }
}

function parseRefs(output: string): RefRecord[] {
    return output.split("\n").map(line => line.replace(/\0$/, "")).filter(Boolean).map(line => {
        const [ref, objectId, peeledObjectId, upstreamRef, symbolicTarget] = line.split("\0")
        return {
            ref,
            objectId,
            peeledObjectId: peeledObjectId || undefined,
            upstreamRef: upstreamRef || undefined,
            symbolicTarget: symbolicTarget || undefined,
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

function parseCommitSummary(output: string) {
    const [objectId, authoredAt, subject] = output.split("\0")
    return { objectId, authoredAt: Number(authoredAt), subject }
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
        throw new GitError("git.command-failed", `Workbench received an invalid ${descriptor.objectFormat} object ID.`)
}

function cancelledError() {
    return new GitError("git.cancelled", "Branch Graph read cancelled.")
}
