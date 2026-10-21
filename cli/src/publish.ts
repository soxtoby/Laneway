import { gitText, redactGitText, type RepositoryGit } from "@laneway/git"
import { type BranchGraphReadOptions, type PublishPlan, type PublishReceipt, publishReceiptStatus, type PublishRequest, type PublishResult, type PublishUpdate } from "@laneway/shared"
import { isAncestor, readActiveStack } from "./active-stack"
import { executeConflict } from "./conflicts/conflict-operations"
import { OperationRuntimeError } from "./operations/operation-contracts"
import { latestReceipt, readReceipt, receiptId, saveReceipt } from "./publish-receipts"

export type PublishProgressReporter = (message: string, completed: number, total: number) => void

type ReceiptUpdate = PublishReceipt["updates"][number]
interface LocalBranch {
    tip: string
    upstream?: { tracking: string; remote: string; remoteRef: string }
}

// Publish changes only remote refs, remote-tracking refs, and upstream configuration. It never enters
// Operation History; its receipt is the durable record, and restoration is another explicit publish.
export async function executePublish(
    repo: RepositoryGit,
    request: PublishRequest,
    graphOptions: BranchGraphReadOptions,
    cancelled: () => boolean,
    progress: PublishProgressReporter,
): Promise<PublishResult> {
    if (request.action == "plan" || request.action == "publish")
        return publishStack(repo, request, graphOptions, cancelled, progress)

    let receipt = await readReceipt(repo, request.receipt)
    if (!receipt)
        throw new OperationRuntimeError("operation.precondition-failed", `There is no Publish Receipt ${request.receipt}.`)
    return request.action == "resume" ? publishReceipt(repo, receipt, cancelled, progress) : restore(repo, receipt, cancelled, progress)
}

async function publishStack(
    repo: RepositoryGit,
    request: Extract<PublishRequest, { action: "plan" | "publish" }>,
    graphOptions: BranchGraphReadOptions,
    cancelled: () => boolean,
    progress: PublishProgressReporter,
) {
    let plan = await planPublish(repo, request.branch, request.remote, graphOptions)
    if (request.action == "publish" && request.token && request.token != plan.token)
        throw new OperationRuntimeError("operation.precondition-failed", "The stack changed after it was reviewed. Review the publish again.")
    return request.action == "plan" || plan.blocked || !plan.updates.length
        ? planResult(plan)
        : publishReceipt(repo, newReceipt("publish", plan.stack, plan.updates), cancelled, progress)
}

// Restoration is a new, lease-guarded force publish of the earlier tips of everything the receipt published.
async function restore(repo: RepositoryGit, receipt: PublishReceipt, cancelled: () => boolean, progress: PublishProgressReporter): Promise<PublishResult> {
    let published = receipt.updates.filter(update => update.status == "published")
    let restoration = { ...newReceipt("restore", receipt.stack, published.map(restoreUpdate)), restores: receipt.id }
    return published.length
        ? publishReceipt(repo, restoration, cancelled, progress)
        : { type: "result", command: "publish", status: "nothing", message: "Nothing from this publish reached the remote.", receipt }
}

async function planPublish(repo: RepositoryGit, branch: string, remote: string | undefined, graphOptions: BranchGraphReadOptions): Promise<PublishPlan> {
    let remotes = (await gitText(repo, ["remote"])).split("\n").filter(Boolean)
    let graph = await repo.startReadBranchGraph({ ...graphOptions, refreshRemote: false }).result
    let stack = await readActiveStack(repo, graph, branch)
    if (!stack)
        throw new OperationRuntimeError("operation.precondition-failed", `${shortName(branch)} is not a local branch.`)

    let names = stack.branches.map(item => shortName(item.ref))
    // The first member is the Base Branch, which Publish never updates.
    let refs = stack.branches.slice(1).map(item => item.ref).filter(ref => ref.startsWith("refs/heads/"))
    let locals = await readLocalBranches(repo, remotes)
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
        ? "Resolve this stack's conflicts before publishing."
        : undefined

    let updates: PublishUpdate[] = []
    for (let ref of blocked ? [] : refs) {
        let update = await planUpdate(repo, ref, locals.get(ref)!, selected!)
        if (update)
            updates.push(update)
    }
    return { stack: names, updates, token: digest(updates), blocked, receipt: await latestReceipt(repo, refs.map(shortName)) }
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

async function publishable(repo: RepositoryGit, refs: string[]) {
    let result = await executeConflict(repo, { action: "publish-check", branches: refs }, new Map())
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

// Verify every remaining remote tip, then push what is still pending. The receipt is saved before
// pushing and after every outcome, so after a crash Resume finds what reached the remote.
async function publishReceipt(repo: RepositoryGit, receipt: PublishReceipt, cancelled: () => boolean, progress: PublishProgressReporter) {
    await saveReceipt(repo, receipt)
    let remaining = receipt.updates.filter(update => update.status != "published")
    if (remaining.length) {
        progress(`Checking ${list([...new Set(remaining.map(update => update.remote))])}…`, 0, remaining.length + 1)
        await verifyRemote(repo, remaining)
    }

    // Any stale lease or unreadable remote aborts the whole attempt; Laneway never refetches or retries on its own.
    let unsettled = remaining.filter(update => update.status != "published")
    if (unsettled.length && unsettled.every(update => update.status == "pending"))
        receipt.mode = await push(repo, receipt, unsettled, cancelled, progress)

    for (let update of receipt.updates.filter(update => update.status == "published" && update.setUpstream)) {
        await gitText(repo, ["config", `branch.${update.branch}.remote`, update.remote])
        await gitText(repo, ["config", `branch.${update.branch}.merge`, update.ref])
    }
    await saveReceipt(repo, receipt)
    return receiptResult(receipt)
}

async function verifyRemote(repo: RepositoryGit, updates: ReceiptUpdate[]) {
    for (let remote of new Set(updates.map(update => update.remote))) {
        let own = updates.filter(update => update.remote == remote)
        let result = await repo.run(repo.descriptor.mainWorktree, ["ls-remote", remote, ...own.map(update => update.ref)])
        let tips = new Map(result.stdout.toString().split("\n").filter(Boolean).map(line => line.split("\t").reverse() as [string, string]))
        for (let update of own) {
            let tip = tips.get(update.ref) ?? null
            if (result.exitCode)
                mark(update, "failed", diagnostics(result.stderr.toString(), `Git could not read ${remote}.`))
            else if (tip == update.target)
                mark(update, "published")
            else if (tip == update.expected)
                mark(update, "pending")
            else
                mark(update, "stale", changed(update))
        }
    }
}

async function push(repo: RepositoryGit, receipt: PublishReceipt, updates: ReceiptUpdate[], cancelled: () => boolean, progress: PublishProgressReporter) {
    let atomic = updates.length > 1 && new Set(updates.map(update => update.remote)).size == 1
    if (atomic)
        progress(`Publishing ${list(updates.map(update => update.branch))}…`, 1, 2)
    let result = atomic ? await pushRefs(repo, updates, true) : undefined
    // Git refuses before sending anything when the remote does not advertise atomic push.
    if (result && !/does not support --atomic/i.test(result.stderr)) {
        settle(updates, result)
        return "atomic" as const
    } else {
        // Lowest changed branch first; stop at the first failure and keep what already published.
        let stopped = false
        for (let [index, update] of updates.entries()) {
            stopped ||= cancelled()
            if (!stopped) {
                progress(`Publishing ${update.branch}…`, index + 1, updates.length + 1)
                settle([update], await pushRefs(repo, [update], false))
                await saveReceipt(repo, receipt)
                stopped = update.status != "published"
            }
        }
        return "sequential" as const
    }
}

async function pushRefs(repo: RepositoryGit, updates: ReceiptUpdate[], atomic: boolean) {
    let result = await repo.run(repo.descriptor.mainWorktree, [
        "push",
        "--porcelain",
        ...(atomic ? ["--atomic"] : []),
        ...updates.map(update => `--force-with-lease=${update.ref}:${update.expected ?? ""}`),
        updates[0]!.remote,
        ...updates.map(update => `${update.target ?? ""}:${update.ref}`),
    ])
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() }
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
    let message = status == "published"
        ? receipt.kind == "restore" ? `Restored the earlier remote tips of ${list(published)}.` : `Published ${list(published)}.`
        : status == "stale"
        ? `${outcome} ${list(stale)} changed since the last pull. Pull latest, then publish again.`
        : stopped?.status == "pending"
        ? `${outcome} Publishing stopped before ${stopped.branch}. Resume to publish the rest.`
        : `${outcome} ${stopped!.remote}/${stopped!.branch} was not published. Resume once the cause is fixed.`
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
