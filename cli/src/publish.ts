import { gitText, redactGitText, type RepositoryGit } from "@laneway/git"
import { type BranchGraph, type BranchGraphReadOptions, primaryLocalRef, type PublishBranchPlan, type PublishPlan, type PublishReceipt, publishReceiptStatus, type PublishRequest, type PublishResult, type PublishUpdate } from "@laneway/shared"
import { isAncestor, readActiveStack } from "./active-stack"
import { executeConflict } from "./conflicts/conflict-operations"
import { ChangeRecorder } from "./operations/change-recorder"
import { OperationRuntimeError } from "./operations/operation-contracts"
import { latestReceipt, type MutationLock, openReceipt, readReceipt, receiptId, saveReceipt } from "./publish-receipts"
import { caughtUp, forgetPulledUpstream, readPulledUpstreams } from "./pulled-upstreams"

export type PublishProgressReporter = (message: string, completed: number, total: number) => void
export interface PublishContext {
    lock: MutationLock
    cancelled: () => boolean
    progress: PublishProgressReporter
}

type ReceiptUpdate = PublishReceipt["updates"][number]
interface LocalBranch {
    tip: string
    upstream?: { tracking: string; remote: string; remoteRef: string }
}

let unresolved = "Resolve this stack's conflicts before publishing."
let unchecked = "Nothing was restored, because Git could not check what this publish changed on the remote. Restore once the cause is fixed."

// Publish changes only remote refs, remote-tracking refs, and upstream configuration. It never enters
// Operation History; its receipt is the durable record, and restoration is another explicit publish.
export async function executePublish(
    repo: RepositoryGit,
    request: PublishRequest,
    graphOptions: BranchGraphReadOptions,
    context: PublishContext,
): Promise<PublishResult> {
    if (request.action == "plan" || request.action == "publish")
        return publishStack(repo, request, graphOptions, context)
    if (request.action == "plans")
        return planBranches(repo, request, graphOptions)

    let receipt = await readReceipt(repo, request.receipt)
    if (!receipt)
        throw new OperationRuntimeError("operation.precondition-failed", `There is no Publish Receipt ${request.receipt}.`)
    return request.action == "resume" ? resume(repo, receipt, context) : restore(repo, receipt, context)
}

async function publishStack(
    repo: RepositoryGit,
    request: Extract<PublishRequest, { action: "plan" | "publish" }>,
    graphOptions: BranchGraphReadOptions,
    context: PublishContext,
) {
    let { plan, refs } = await planStack(await readPublishing(repo, graphOptions, request.remote), request.branch)
    plan.receipt = await latestReceipt(repo, refs.map(shortName))
    if (request.action == "publish" && request.token && request.token != plan.token)
        throw new OperationRuntimeError("operation.precondition-failed", "The stack changed after it was reviewed. Review the publish again.")
    return request.action == "plan" || plan.blocked || !plan.updates.length
        ? planResult(plan)
        : publishReceipt(repo, newReceipt("publish", plan.stack, plan.updates), context)
}

// Resume pushes the receipt's own commits under its own leases, but never while those branches are unresolved.
async function resume(repo: RepositoryGit, receipt: PublishReceipt, context: PublishContext): Promise<PublishResult> {
    return await publishable(repo, receipt.updates.map(update => update.ref))
        ? publishReceipt(repo, receipt, context)
        : { type: "result", command: "publish", status: "blocked", message: unresolved, receipt }
}

// Restoration is a new, lease-guarded force publish of the earlier tips of everything the receipt published.
// An update can reach the remote without its outcome being recorded, so the remote decides what that was,
// and nothing is restored while it cannot answer.
async function restore(repo: RepositoryGit, receipt: PublishReceipt, context: PublishContext): Promise<PublishResult> {
    let unrecorded = receipt.updates.filter(update => update.status != "published")
    let verified = !unrecorded.length || await verifyRemote(repo, unrecorded)
    if (unrecorded.length)
        await saveReceipt(repo, receipt)

    let published = receipt.updates.filter(update => update.status == "published")
    let restoration = { ...newReceipt("restore", receipt.stack, published.map(restoreUpdate)), restores: receipt.id }
    return !verified
        ? { type: "result", command: "publish", status: "failed", message: unchecked, receipt }
        : published.length
        ? publishReceipt(repo, restoration, context)
        : { type: "result", command: "publish", status: "nothing", message: "Nothing from this publish reached the remote.", receipt }
}

// Several branches' plans share one reading of the repository, so planning every branch the desktop's columns
// show costs little more than planning one.
async function planBranches(
    repo: RepositoryGit,
    request: Extract<PublishRequest, { action: "plans" }>,
    graphOptions: BranchGraphReadOptions,
): Promise<PublishResult> {
    let reading = await readPublishing(repo, graphOptions, request.remote)
    let plans: PublishBranchPlan[] = []
    for (let branch of request.branches) {
        try {
            let { plan } = await planStack(reading, branch)
            plans.push({ branch, message: planResult(plan).message, plan })
        } catch (error) {
            plans.push({ branch, message: error instanceof Error ? error.message : String(error) })
        }
    }
    return { type: "result", command: "publish", status: "planned", message: `Planned ${list(request.branches.map(shortName))}.`, plans }
}

// What every plan for one request reads once.
interface PublishReading {
    repo: RepositoryGit
    remotes: string[]
    graph: BranchGraph
    locals: Map<string, LocalBranch>
    /** The upstream tips branches last pulled, for branches whose upstream a Laneway fetch has moved since. */
    pulled: Map<string, string | null>
    /** The remote the request named, if any. */
    remote?: string
    /** Each branch's update, by ref, shared by every stack it belongs to. */
    updates: Map<string, Promise<PublishUpdate | undefined>>
}

async function readPublishing(repo: RepositoryGit, graphOptions: BranchGraphReadOptions, remote?: string): Promise<PublishReading> {
    let remotes = (await gitText(repo, ["remote"])).split("\n").filter(Boolean)
    let graph = await repo.startReadBranchGraph({ ...graphOptions, refreshRemote: false }).result
    let [locals, pulled] = await Promise.all([readLocalBranches(repo, remotes), readPulledUpstreams(repo)])
    return { repo, remotes, graph, locals, pulled, remote, updates: new Map() }
}

async function planStack(reading: PublishReading, branch: string): Promise<{ plan: PublishPlan; refs: string[] }> {
    let { repo, remotes, graph, locals, remote } = reading
    let stack = await readActiveStack(repo, graph, branch)
    if (!stack)
        throw new OperationRuntimeError("operation.precondition-failed", `${shortName(branch)} is not a local branch.`)

    let names = stack.branches.map(item => shortName(item.ref))
    // The first member is the Base Branch, which Publish never updates. The Primary Branch has no Base, so its stack
    // is itself alone, and it publishes by itself.
    let alone = stack.branches.length == 1 && stack.branches[0]!.node.primary && branch == primaryLocalRef(graph)
    let refs = stack.branches.slice(alone ? 0 : 1).map(item => item.ref).filter(ref => ref.startsWith("refs/heads/"))
    let selected = remote ?? graph.selectedRemote
    let unplaced = refs.find(ref => !locals.get(ref)?.upstream)
    let blocked = !remotes.length
        ? "Add a remote to publish."
        : remote && !remotes.includes(remote)
        ? `There is no remote named ${remote}.`
        : stack.ambiguous
        ? `The Base of ${stack.ambiguous} is ambiguous. Choose its Base in the Branch Graph, then publish again.`
        : !refs.length
        ? `${names[0]} is the Base of this stack. Publish updates only the branches above their Base.`
        : unplaced && !selected
        ? `Choose a remote to publish ${shortName(unplaced)} to.`
        : !(await publishable(repo, refs))
        ? unresolved
        : await unpulled(reading, refs)

    let updates: PublishUpdate[] = []
    for (let ref of blocked ? [] : refs) {
        if (!reading.updates.has(ref))
            reading.updates.set(ref, planUpdate(repo, ref, locals.get(ref)!, selected!))
        let update = await reading.updates.get(ref)
        if (update)
            updates.push(update)
    }
    return { plan: { stack: names, updates, token: digest(updates), blocked }, refs }
}

async function readLocalBranches(repo: RepositoryGit, remotes: string[]) {
    let format = "%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)"
    let lines = (await gitText(repo, ["for-each-ref", `--format=${format}`, "refs/heads/"])).split("\n").filter(Boolean)
    return new Map(lines.map(line => {
        let [ref, tip, tracking, remote, remoteRef] = line.split("\0") as [string, string, string, string, string]
        // An upstream on "." is another local branch, not a destination.
        let branch: LocalBranch = { tip, upstream: remotes.includes(remote) ? { tracking, remote, remoteRef } : undefined }
        return [ref, branch]
    }))
}

// Destinations are same-named branches. A branch without one as its upstream records it, as `git push -u` does.
async function planUpdate(repo: RepositoryGit, ref: string, local: LocalBranch, selected: string): Promise<PublishUpdate | undefined> {
    let name = shortName(ref)
    let remote = local.upstream?.remote ?? selected
    let sameNamed = local.upstream?.remoteRef == ref
    let expected = await repo.resolveRef(sameNamed ? local.upstream!.tracking : `refs/remotes/${remote}/${name}`)
    // A branch behind its remote has nothing to publish; pushing it would rewind the remote.
    let kind = expected == null
        ? "create" as const
        : expected == local.tip || await isAncestor(repo, local.tip, expected)
        ? undefined
        : await isAncestor(repo, expected, local.tip)
        ? "update" as const
        : "force" as const
    return kind && { branch: name, remote, ref, expected, target: local.tip, kind, setUpstream: !sameNamed }
}

// A fetch that moved an upstream the branch hasn't pulled since brought commits the branch lacks, and a lease taken from
// that fetch would let the push discard them.
async function unpulled({ repo, locals, pulled }: PublishReading, refs: string[]) {
    for (let ref of refs) {
        let upstream = locals.get(ref)?.upstream
        if (upstream?.remoteRef != ref || !pulled.has(ref))
            continue
        if (!(await caughtUp(repo, locals.get(ref)!.tip, await repo.resolveRef(upstream.tracking), pulled.get(ref)!)))
            return `${shortName(upstream.tracking)} changed since the last pull. Pull latest, then publish again.`
    }
    return undefined
}

async function publishable(repo: RepositoryGit, refs: string[]) {
    let result = await executeConflict(repo, { action: "publish-check", branches: refs }, new ChangeRecorder(repo))
    return result.publishable != false
}

function planResult(plan: PublishPlan): PublishResult {
    let force = plan.updates.some(update => update.kind == "force")
    let remotes = [...new Set(plan.updates.map(update => update.remote))]
    return plan.blocked
        ? { type: "result", command: "publish", status: "blocked", message: plan.blocked, plan }
        : !plan.updates.length
        ? { type: "result", command: "publish", status: "nothing", message: "Everything in this stack is already published.", plan }
        : {
            type: "result",
            command: "publish",
            status: "planned",
            message: `${force ? "Force publish" : "Publish"} ${list(plan.updates.map(update => update.branch))} to ${list(remotes)}.`,
            plan,
        }
}

function newReceipt(kind: PublishReceipt["kind"], stack: string[], updates: PublishUpdate[]): PublishReceipt {
    return {
        version: 1,
        id: receiptId(),
        timestamp: new Date().toISOString(),
        kind,
        stack,
        updates: updates.map(update => ({ ...update, status: "pending" })),
    }
}

// Restoring a created branch deletes it; its upstream configuration stays for the next Publish.
function restoreUpdate(update: PublishUpdate): PublishUpdate {
    return {
        branch: update.branch,
        remote: update.remote,
        ref: update.ref,
        expected: update.target,
        target: update.expected,
        kind: update.expected == null ? "delete" : "force",
        setUpstream: false,
    }
}

// Verify every remote tip the receipt names, then push what is still pending. The receipt is saved before
// pushing and after every outcome, so after a crash Resume finds what reached the remote.
async function publishReceipt(repo: RepositoryGit, receipt: PublishReceipt, context: PublishContext) {
    await openReceipt(repo, receipt, context.lock)
    let remaining = receipt.updates.filter(update => update.status != "published").length
    context.progress(`Checking ${list([...new Set(receipt.updates.map(update => update.remote))])}…`, 0, remaining + 1)
    // Published entries are checked too, so a published branch someone has moved since stops the rest.
    await verifyRemote(repo, receipt.updates)

    // Any stale lease or unreadable remote aborts the whole attempt; Laneway never refetches or retries on its own.
    let unsettled = receipt.updates.filter(update => update.status != "published")
    if (unsettled.length && unsettled.every(update => update.status == "pending") && !context.cancelled())
        receipt.mode = await push(repo, receipt, unsettled, context)
    await saveReceipt(repo, receipt)

    let result = receiptResult(receipt)
    let problem = await recordPublished(repo, receipt)
    return problem ? { ...result, message: `${result.message} ${problem}` } : result
}

// An update that reached the remote without its outcome being recorded is recognized here, not pushed again.
// The receipt is verified whole: an unreadable remote fails every pending update, on every remote, with its
// diagnostic, so nothing is pushed. Returns whether every remote could be read.
async function verifyRemote(repo: RepositoryGit, updates: ReceiptUpdate[]) {
    let problem: string | undefined
    for (let remote of new Set(updates.map(update => update.remote))) {
        let own = updates.filter(update => update.remote == remote)
        let read = await readRemoteTips(repo, remote, own.map(update => update.ref))
        if ("problem" in read) {
            problem ??= read.problem
            for (let update of own.filter(update => update.status != "published"))
                mark(update, "failed", read.problem)
        } else {
            for (let update of own)
                observe(update, read.tips.get(update.ref) ?? null)
        }
    }
    for (let update of problem ? updates.filter(update => update.status == "pending") : [])
        mark(update, "failed", problem)
    return !problem
}

// Publication changes the push URL's repository, which can differ from the fetch URL, so leases are checked
// there. Git reads the same configuration again when pushing to the remote by name moments later.
async function readRemoteTips(repo: RepositoryGit, remote: string, refs: string[]) {
    let main = repo.descriptor.mainWorktree
    let urls = await repo.run(main, ["remote", "get-url", "--push", "--all", remote])
    let [url, ...others] = urls.stdout.toString().split("\n").filter(Boolean)
    let result = url && !others.length ? await repo.run(main, ["ls-remote", url, ...refs]) : undefined
    return urls.exitCode || !url
        ? { problem: diagnostics(urls.stderr.toString(), `Git could not find ${remote}.`) }
        : !result
        ? { problem: `${remote} has several push URLs. Publish updates one repository, so keep a single push URL.` }
        : result.exitCode
        ? { problem: diagnostics(result.stderr.toString(), `Git could not read ${remote}.`) }
        : { tips: new Map(result.stdout.toString().split("\n").filter(Boolean).map(line => line.split("\t").reverse() as [string, string])) }
}

function observe(update: ReceiptUpdate, tip: string | null) {
    if (tip == update.target)
        mark(update, "published")
    else if (update.status == "published")
        mark(update, "stale", `${update.remote}/${update.branch} changed after it was published.`)
    else if (tip == update.expected)
        mark(update, "pending")
    else
        mark(update, "stale", changed(update))
}

async function push(repo: RepositoryGit, receipt: PublishReceipt, updates: ReceiptUpdate[], context: PublishContext) {
    let atomic = updates.length > 1 && new Set(updates.map(update => update.remote)).size == 1
    if (atomic)
        context.progress(`Publishing ${list(updates.map(update => update.branch))}…`, 1, 2)
    let result = atomic ? await pushRefs(repo, updates, true) : undefined
    // Git refuses before sending anything when the remote does not advertise atomic push.
    if (result && !/does not support --atomic/i.test(result.stderr)) {
        settle(updates, result)
        return "atomic" as const
    } else {
        // Lowest changed branch first; stop at the first failure and keep what already published.
        let stopped = false
        for (let [index, update] of updates.entries()) {
            stopped ||= context.cancelled()
            if (!stopped) {
                context.progress(`Publishing ${update.branch}…`, index + 1, updates.length + 1)
                settle([update], await pushRefs(repo, [update], false))
                await saveReceipt(repo, receipt)
                stopped = update.status != "published"
            }
        }
        return "sequential" as const
    }
}

// Explicit refspecs already bypass push.default and remote.<name>.push; following tags and recursing into
// submodules are the remaining configuration that would push refs the receipt does not name.
async function pushRefs(repo: RepositoryGit, updates: ReceiptUpdate[], atomic: boolean) {
    let result = await repo.run(repo.descriptor.mainWorktree, [
        "push",
        "--porcelain",
        "--no-follow-tags",
        "--recurse-submodules=no",
        ...(atomic ? ["--atomic"] : []),
        ...updates.map(update => `--force-with-lease=${update.ref}:${update.expected ?? ""}`),
        updates[0]!.remote,
        ...updates.map(update => `${update.target ?? ""}:${update.ref}`),
    ])
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

// Git moves remote-tracking refs only once the remote answers, so after a crash a recognized update leaves
// its tracking ref behind. Each moves from the receipt's lease to its target only if nothing has moved it since.
// Upstreams are recorded after the receipt is saved, so a configuration error never hides what was published.
async function recordPublished(repo: RepositoryGit, receipt: PublishReceipt) {
    let main = repo.descriptor.mainWorktree
    let published = receipt.updates.filter(update => update.status == "published")
    for (let update of published) {
        let tracking = `refs/remotes/${update.remote}/${update.branch}`
        await repo.run(main, update.target ? ["update-ref", tracking, update.target, update.expected ?? ""] : ["update-ref", "-d", tracking, update.expected!])
        // The upstream is now the branch's own tip, so what it last pulled no longer matters.
        if (update.target && update.target == await repo.resolveRef(`refs/heads/${update.branch}`))
            await forgetPulledUpstream(repo, `refs/heads/${update.branch}`)
    }

    let recording = published.filter(update => update.setUpstream)
    try {
        for (let update of recording) {
            await gitText(repo, ["config", `branch.${update.branch}.remote`, update.remote])
            await gitText(repo, ["config", `branch.${update.branch}.merge`, update.ref])
        }
        return undefined
    } catch (error) {
        return `Git could not record the upstreams of ${list(recording.map(update => update.branch))}: ${error instanceof Error ? error.message : error}`
    }
}

// Porcelain lines are "<flag>\t<source>:<destination>\t<summary>"; "!" marks a refused ref. A failing
// pre-push hook or credential prompt reports no lines at all.
function settle(updates: ReceiptUpdate[], result: { stdout: string; stderr: string }) {
    let lines = new Map(
        result.stdout.split("\n").map(line => line.split("\t")).filter(parts => parts.length == 3).map((
            [flag, refs, summary],
        ) => [refs!.slice(refs!.lastIndexOf(":") + 1), { refused: flag == "!", summary: summary! }]),
    )
    // The remote's own explanation, such as a pre-receive hook's output.
    let remoteLines = result.stderr.split("\n").filter(line => line.startsWith("remote: ")).map(line => line.slice(8).trim()).filter(Boolean)
    for (let update of updates) {
        let line = lines.get(update.ref)
        if (line && !line.refused)
            mark(update, "published")
        else if (line && /stale info/.test(line.summary))
            mark(update, "stale", changed(update))
        else
            mark(update, "failed", line ? redactGitText([line.summary, ...remoteLines].join("\n")) : diagnostics(result.stderr, "Git could not publish."))
    }
}

function mark(update: ReceiptUpdate, status: ReceiptUpdate["status"], message?: string) {
    update.status = status
    update.message = message
}

function changed(update: PublishUpdate) {
    return `${update.remote}/${update.branch} changed since the last pull.`
}

function receiptResult(receipt: PublishReceipt): PublishResult {
    let status = publishReceiptStatus(receipt)
    let published = receipt.updates.filter(update => update.status == "published").map(update => update.branch)
    let stale = receipt.updates.filter(update => update.status == "stale").map(update => `${update.remote}/${update.branch}`)
    let stopped = receipt.updates.find(update => update.status != "published")
    let outcome = published.length ? `${receipt.kind == "restore" ? "Restored" : "Published"} ${list(published)}.` : "Nothing was published."
    // Publishing again plans what a publish left; a restoration has no plan, so only resuming its receipt finishes it.
    let retry = receipt.kind == "restore" ? "Resume" : "Publish again"
    let message = status == "published"
        ? receipt.kind == "restore" ? `Restored the earlier remote tips of ${list(published)}.` : `Published ${list(published)}.`
        : status == "stale"
        ? `${outcome} ${list(stale)} changed since the last pull. Pull latest, then publish again.`
        : stopped?.status == "pending"
        ? `${outcome} Publishing stopped before ${stopped.branch}. ${retry} to publish the rest.`
        : `${outcome} ${stopped!.remote}/${stopped!.branch} was not published. ${retry} once the cause is fixed.`
    return { type: "result", command: "publish", status, message, receipt }
}

function diagnostics(stderr: string, fallback: string) {
    return redactGitText(stderr).trim() || fallback
}

function digest(updates: PublishUpdate[]) {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(updates)).digest("hex").slice(0, 16)
}

function list(items: string[]) {
    return items.join(", ")
}

function shortName(ref: string) {
    return ref.replace(/^refs\/(heads|remotes)\//, "")
}
