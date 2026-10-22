import { type BranchGraph, type PublishReceipt, publishReceiptStatus, type PublishUpdate, type PublishUpdateStatus } from "@laneway/shared"
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Hint } from "./controls"
import { PublishIcon } from "./icons"
import type { Publish } from "./publish"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Modal } from "./ui/Modal"
import { useSnapshot } from "./use-snapshot"

let kindLabels: Record<PublishUpdate["kind"], string> = {
    create: "New",
    update: "Update",
    force: "Force with lease",
    delete: "Delete",
}

let statusLabels: Record<PublishUpdateStatus, string> = {
    published: "Published",
    pending: "Not published",
    stale: "Changed on remote",
    failed: "Failed",
}

// What a publish that stopped short left as it was, and the way forward.
let notes = {
    stale: "Local branches are unchanged. Laneway doesn't fetch or retry on its own: Pull latest brings in what changed, then publish again.",
    partial: "Local branches are unchanged, and what was published stays on the remote. Resume publishes the rest once the cause is fixed.",
    failed: "Local branches and the remote are unchanged. Resume once the cause is fixed.",
}

/**
 * Publish for the focused column's stack. Before it is pressed it lists every destination, and it becomes Force
 * publish, naming each force-with-lease ref, when any update rewrites remote history; that visible state is the
 * only confirmation. The stack's latest receipt offers Resume and restoration, even after a restart.
 */
export function PublishControl({ publish, repositoryId, branch, graph, busy }: {
    publish: Publish
    repositoryId: string
    /** The column's local branch ref. */
    branch: string
    /** Any change to it can change what publishes. */
    graph?: BranchGraph
    /** Another operation is running, which can move the stack. */
    busy: boolean
}) {
    let { review, running } = useSnapshot(publish)
    let section = useRef<HTMLElement>(null)
    // A graph read again unchanged is a new object, which mustn't plan again.
    let version = useMemo(() => JSON.stringify(graph), [graph])
    useEffect(() => void publish.review(repositoryId, branch), [publish, repositoryId, branch, version])
    useColumnFallback(section)
    let current = review?.repositoryId == repositoryId && review.branch == branch ? review : undefined
    let plan = current?.plan
    let progress = running[repositoryId]
    // While a publish runs its controls stay, pending, so the one pressed keeps focus for the outcome to return to.
    let pending = progress != undefined
    let force = plan?.updates.some(update => update.kind == "force")
    let reason = current?.error ?? plan?.blocked
        ?? (!plan ? "Reading what this stack would publish…" : plan.updates.length == 0 ? "Everything in this stack is already published." : undefined)
    return (
        <section ref={section} className="publish-control" aria-label="Publish this stack">
            <div className="publish-row">
                {/* The hint explains a disabled button too, so it sits on a wrapper. */}
                <Hint text={pending ? undefined : reason} forControl>
                    <span className="publish-button">
                        <Button
                            variant="accent"
                            data-force={force || undefined}
                            isDisabled={!pending && (busy || reason != undefined)}
                            isPending={pending}
                            onPress={() => void publish.publish()}
                        >
                            <PublishIcon />
                            {force ? "Force publish" : "Publish"}
                        </Button>
                    </span>
                </Hint>
                {pending
                    ? <span className="publish-progress" role="status">{progress}</span>
                    : plan && plan.stack.length > 1 && <span className="publish-stack">Stack: {plan.stack.join(" › ")}</span>}
            </div>
            {plan && plan.updates.length > 0 && <Destinations label="Destinations" updates={plan.updates} />}
            {plan?.receipt && <LatestReceipt publish={publish} repositoryId={repositoryId} receipt={plan.receipt} busy={busy} pending={pending} />}
        </section>
    )
}

/**
 * Focus stays in the column when the control holding it goes or is disabled, as Publish is once everything is
 * published and restoration once it has restored. An outcome that outlives the control it returns focus to, such as a
 * Resume that went stale, still leaves focus on the page when it closes; that is rare enough to leave.
 */
function useColumnFallback(section: RefObject<HTMLElement | null>) {
    let held = useRef(false)
    useLayoutEffect(() => {
        let active = document.activeElement
        if (held.current && (active == document.body || section.current?.contains(active) && active?.matches(":disabled")))
            section.current?.closest<HTMLElement>(".column")?.focus({ preventScroll: true })
        held.current = section.current?.contains(document.activeElement) ?? false
    })
}

function Destinations({ label, updates }: { label: string; updates: PublishUpdate[] }) {
    return (
        <ul className="publish-destinations" aria-label={label}>
            {updates.map(update => <Destination key={update.ref} update={update} />)}
        </ul>
    )
}

function Destination({ update }: { update: PublishUpdate }) {
    return (
        <li data-kind={update.kind}>
            <span className="publish-kind">{kindLabels[update.kind]}</span>
            <span>
                <span className="publish-destination">{update.remote}/{update.branch}</span>
                {update.setUpstream && <small>{" "}sets upstream</small>}
            </span>
        </li>
    )
}

/**
 * Resume when the stack's latest publish stopped short, and restoration of whatever it published. Each lists the
 * receipt's own destinations, which can differ from the current plan's: Resume publishes what the receipt left, with
 * its leases, and restoration force publishes each published ref back to its earlier tip, deleting created branches.
 */
function LatestReceipt({ publish, repositoryId, receipt, busy, pending }: {
    publish: Publish
    repositoryId: string
    receipt: PublishReceipt
    busy: boolean
    pending: boolean
}) {
    let status = publishReceiptStatus(receipt)
    let published = receipt.updates.filter(update => update.status == "published")
    let remaining = receipt.updates.filter(update => update.status != "published")
    let resumable = status == "partial" || status == "failed"
    let restorable = receipt.kind == "publish" && published.length > 0
    if (!resumable && !restorable)
        return null
    return (
        <div className="publish-receipt">
            {resumable && (
                <>
                    <span className="publish-receipt-summary">Last publish stopped. Resume publishes the rest:</span>
                    <Destinations label="Resume destinations" updates={remaining} />
                    <span className="publish-button">
                        <Button
                            variant="secondary"
                            isDisabled={!pending && busy}
                            isPending={pending}
                            onPress={() => void publish.resume(repositoryId, receipt.id)}
                        >
                            Resume
                        </Button>
                    </span>
                </>
            )}
            {restorable && (
                <>
                    <span className="publish-receipt-summary">Restore the earlier remote tips:</span>
                    <Destinations label="Restore destinations" updates={published.map(restoration)} />
                    <span className="publish-button">
                        <Button
                            variant="accent"
                            data-force
                            isDisabled={!pending && busy}
                            isPending={pending}
                            onPress={() => void publish.restore(repositoryId, receipt.id)}
                        >
                            Force publish earlier tips
                        </Button>
                    </span>
                </>
            )}
        </div>
    )
}

// What restoration does to a published update, as the Engine plans it: a created branch is deleted, and anything
// else is forced back to its earlier tip, leasing on what was published.
function restoration(update: PublishUpdate): PublishUpdate {
    return { ...update, kind: update.expected == null ? "delete" : "force", setUpstream: false }
}

/**
 * A publish that didn't simply succeed: what each update did, what stayed as it was, and the way forward. A stale
 * lease leads to Pull latest, never a retry; anything else left unpublished can Resume.
 */
export function PublishDialog({ publish, repositoryId }: { publish: Publish; repositoryId?: string }) {
    let { outcomes } = useSnapshot(publish)
    // Only the active repository's outcome shows, so Pull latest takes its open stacks; another repository's waits.
    let shown = repositoryId == undefined ? undefined : outcomes[repositoryId]
    let open = shown && repositoryId != undefined ? { repositoryId, ...shown } : undefined
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(open)
    if (open && (open.repositoryId != last?.repositoryId || open.result != last.result || open.error != last.error))
        setLast(open)
    let outcome = open ?? last
    let result = outcome?.result
    let receipt = result?.receipt
    let status = receipt && publishReceiptStatus(receipt)
    let resumable = status == "partial" || status == "failed"
    return (
        <Modal isOpen={open != undefined} isDismissable onOpenChange={isOpen => isOpen || publish.close(outcome!.repositoryId)}>
            <Dialog className="react-aria-Dialog publish-outcome" aria-label="Publish outcome">
                <Heading slot="title">{receipt?.kind == "restore" ? "Restore earlier remote tips" : "Publish"}</Heading>
                {outcome?.error && <p className="publish-error" role="alert">{outcome.error}</p>}
                {result && <p className="publish-summary">{result.message}</p>}
                {receipt && (
                    <ul className="publish-updates">
                        {receipt.updates.map(update => (
                            <li key={update.ref}>
                                <span className="publish-status" data-status={update.status}>{statusLabels[update.status]}</span>
                                <span className="publish-destination">{update.remote}/{update.branch}</span>
                                <small>{kindLabels[update.kind]}</small>
                                {update.message && <p className="publish-message">{update.message}</p>}
                            </li>
                        ))}
                    </ul>
                )}
                {status && status != "published" && <p className="publish-note">{notes[status]}</p>}
                <div className="dialog-actions">
                    {status == "stale" && <Button variant="accent" onPress={() => publish.pull(outcome!.repositoryId)} autoFocus>Pull latest</Button>}
                    {resumable && <Button variant="accent" onPress={() => void publish.resume(outcome!.repositoryId, receipt!.id)} autoFocus>Resume</Button>}
                    <Button
                        variant={status == "stale" || resumable ? "secondary" : "accent"}
                        onPress={() => publish.close(outcome!.repositoryId)}
                        autoFocus={status != "stale" && !resumable}
                    >
                        Close
                    </Button>
                </div>
            </Dialog>
        </Modal>
    )
}
