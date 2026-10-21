import { type BranchGraph, type PublishReceipt, publishReceiptStatus, type PublishUpdate, type PublishUpdateStatus } from "@laneway/shared"
import { useEffect, useMemo, useState } from "react"
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
    // A graph read again unchanged is a new object, which mustn't plan again.
    let version = useMemo(() => JSON.stringify(graph), [graph])
    useEffect(() => void publish.review(repositoryId, branch), [publish, repositoryId, branch, version])
    let current = review?.repositoryId == repositoryId && review.branch == branch ? review : undefined
    let plan = current?.plan
    let progress = running[repositoryId]
    let force = plan?.updates.some(update => update.kind == "force")
    let reason = current?.error ?? plan?.blocked
        ?? (!plan ? "Reading what this stack would publish…" : plan.updates.length == 0 ? "Everything in this stack is already published." : undefined)
    return (
        <section className="publish-control" aria-label="Publish this stack">
            <div className="publish-row">
                {progress != undefined
                    ? <span className="publish-progress" role="status">{progress}</span>
                    : (
                        // The hint explains a disabled button too, so it sits on a wrapper.
                        <Hint text={reason} forControl>
                            <span className="publish-button">
                                <Button
                                    variant="accent"
                                    data-force={force || undefined}
                                    isDisabled={busy || reason != undefined}
                                    onPress={() => void publish.publish()}
                                >
                                    <PublishIcon />
                                    {force ? "Force publish" : "Publish"}
                                </Button>
                            </span>
                        </Hint>
                    )}
                {plan && plan.stack.length > 1 && <span className="publish-stack">Stack: {plan.stack.join(" › ")}</span>}
            </div>
            {plan && plan.updates.length > 0 && (
                <ul className="publish-destinations" aria-label="Destinations">
                    {plan.updates.map(update => <Destination key={update.ref} update={update} />)}
                </ul>
            )}
            {plan?.receipt && progress == undefined && <LatestReceipt publish={publish} repositoryId={repositoryId} receipt={plan.receipt} busy={busy} />}
        </section>
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

/** Resume when the stack's latest publish stopped short, and restoration of whatever it published. */
function LatestReceipt({ publish, repositoryId, receipt, busy }: { publish: Publish; repositoryId: string; receipt: PublishReceipt; busy: boolean }) {
    let status = publishReceiptStatus(receipt)
    let published = receipt.updates.filter(update => update.status == "published")
    let remaining = receipt.updates.filter(update => update.status != "published")
    let resumable = status == "partial" || status == "failed"
    let restorable = receipt.kind == "publish" && published.length > 0
    if (!resumable && !restorable)
        return null
    let refs = published.map(update => `${update.remote}/${update.branch}`).join(", ")
    return (
        <div className="publish-receipt">
            <span className="publish-receipt-summary">
                {resumable
                    ? `Last publish stopped: ${names(remaining)} not published.`
                    : `Last ${receipt.kind == "restore" ? "restored" : "published"} ${names(published)}.`}
            </span>
            {resumable && <Button variant="secondary" isDisabled={busy} onPress={() => void publish.resume(repositoryId, receipt.id)}>Resume</Button>}
            {restorable && (
                <Hint text={`Force publish ${refs} back to the tips they had before, if nobody has changed them since`} forControl>
                    <span className="publish-restore">
                        <Button variant="quiet" isDisabled={busy} onPress={() => void publish.restore(repositoryId, receipt.id)}>
                            Restore earlier remote tips
                        </Button>
                    </span>
                </Hint>
            )}
        </div>
    )
}

/**
 * A publish that didn't simply succeed: what each update did, what stayed as it was, and the way forward. A stale
 * lease leads to Pull latest, never a retry; anything else left unpublished can Resume.
 */
export function PublishDialog({ publish }: { publish: Publish }) {
    let { outcome: open } = useSnapshot(publish)
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(open)
    if (open && open != last)
        setLast(open)
    let outcome = open ?? last
    let result = outcome?.result
    let receipt = result?.receipt
    let status = receipt && publishReceiptStatus(receipt)
    let resumable = status == "partial" || status == "failed"
    return (
        <Modal isOpen={open != undefined} isDismissable onOpenChange={isOpen => isOpen || publish.close()}>
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
                    {status == "stale" && <Button variant="accent" onPress={publish.pull} autoFocus>Pull latest</Button>}
                    {resumable && <Button variant="accent" onPress={() => void publish.resume(outcome!.repositoryId, receipt!.id)} autoFocus>Resume</Button>}
                    <Button
                        variant={status == "stale" || resumable ? "secondary" : "accent"}
                        onPress={publish.close}
                        autoFocus={status != "stale" && !resumable}
                    >
                        Close
                    </Button>
                </div>
            </Dialog>
        </Modal>
    )
}

function names(updates: PublishUpdate[]) {
    return updates.map(update => update.branch).join(", ")
}
