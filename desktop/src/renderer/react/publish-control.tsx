import { publishReceiptStatus, type PublishUpdate, type PublishUpdateStatus } from "@laneway/shared"
import { type RefObject, useLayoutEffect, useRef, useState } from "react"
import { Button as AriaButton } from "react-aria-components"
import { Hint } from "./controls"
import { ForcePublishIcon, PublishIcon, PublishNewIcon } from "./icons"
import type { Publish } from "./publish"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Modal } from "./ui/Modal"
import { ProgressCircle } from "./ui/ProgressCircle"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot } from "./use-snapshot"

let kindLabels: Record<PublishUpdate["kind"], string> = {
    create: "New",
    update: "Update",
    force: "Force with lease",
    delete: "Delete",
}

// The icon shows the stack's most consequential update: a force, then a new branch, then a fast-forward.
let kindIcons = { force: ForcePublishIcon, create: PublishNewIcon, update: PublishIcon }

let statusLabels: Record<PublishUpdateStatus, string> = {
    published: "Published",
    pending: "Not published",
    stale: "Changed on remote",
    failed: "Failed",
}

// What a publish that stopped short left as it was; its summary gives the way forward.
let notes = {
    stale: "Local branches are unchanged. Laneway doesn't fetch or retry on its own: Pull latest brings in what changed, then publish again.",
    partial: "Local branches are unchanged, and what was published stays on the remote.",
    failed: "Local branches and the remote are unchanged.",
}

/**
 * Publish on a local branch's header, for the branch's Active Stack: the branch and each one below it down to their
 * Base. It shows while the branch has something to publish. Its tooltip lists every destination before it is pressed.
 * Its icon differs for a stack that creates a remote branch, and it turns red as Force publish, naming each
 * force-with-lease ref, when any update rewrites remote history; that visible state is the only confirmation.
 */
export function PublishButton({ publish, repositoryId, branch, offered, busy }: {
    publish: Publish
    repositoryId: string
    /** The branch's local ref. */
    branch: string
    /** The Branch Graph says the branch has something to publish; see `offersPublish`. */
    offered: boolean
    /** Another operation is running, which can move the stack. */
    busy: boolean
}) {
    let { review, running } = useSnapshot(publish)
    let slot = useRef<HTMLSpanElement>(null)
    useColumnFallback(slot)
    let reviewed = review?.repositoryId == repositoryId ? review.branches[branch] : undefined
    let plan = reviewed?.plan
    let run = running[repositoryId]
    // While its publish runs the button stays, pending, so it keeps focus for the outcome to return to. Its name stays
    // while its icon gives way to progress, which shows beside it.
    let progress = run?.branch == branch ? run.message : undefined
    let pending = progress != undefined
    // A branch can have its tip on another remote, so the plan has the last word on whether there's anything to publish.
    let shown = pending || offered && !(plan && !plan.blocked && !plan.updates.length)
    let kind: keyof typeof kindIcons = (["force", "create"] as const).find(candidate => plan?.updates.some(update => update.kind == candidate)) ?? "update"
    let Icon = kindIcons[kind]
    let label = `${kind == "force" ? "Force publish" : "Publish"} ${
        plan?.updates.length ? plan.updates.map(update => update.branch).join(", ") : branch.slice("refs/heads/".length)
    }`
    let reason = reviewed?.error ?? plan?.blocked ?? (!plan ? "Reading what this would publish…" : run ? "Another publish is running." : undefined)
    let disabled = !pending && (busy || reason != undefined)
    return (
        // The slot stays while the button comes and goes, so focus can fall back from it. Its hint explains a disabled
        // button too.
        <Hint text={shown && !pending ? reason : undefined} forControl>
            <span ref={slot} className="publish-slot">
                {pending && <span className="publish-progress" role="status">{progress}</span>}
                {shown && (
                    <TooltipTrigger isDisabled={disabled || pending}>
                        <AriaButton
                            className="icon-button small publish-button"
                            data-kind={kind}
                            aria-label={label}
                            isDisabled={disabled}
                            isPending={pending}
                            onPress={() => void publish.publish(repositoryId, branch)}
                        >
                            {pending ? <ProgressCircle aria-label="Publishing…" isIndeterminate /> : <Icon />}
                        </AriaButton>
                        <Tooltip className="react-aria-Tooltip publish-tooltip">
                            <span className="publish-tooltip-label">{label}</span>
                            <Destinations updates={plan?.updates ?? []} />
                        </Tooltip>
                    </TooltipTrigger>
                )}
            </span>
        </Hint>
    )
}

/**
 * Focus stays in the column when the button holding it goes or is disabled, as it goes once its branch is
 * published. An outcome that outlives the button it returns focus to still leaves focus on the page when it closes;
 * that is rare enough to leave.
 */
function useColumnFallback(slot: RefObject<HTMLElement | null>) {
    let held = useRef(false)
    useLayoutEffect(() => {
        let active = document.activeElement
        if (held.current && (active == document.body || slot.current?.contains(active) && active?.matches(":disabled")))
            slot.current?.closest<HTMLElement>(".column")?.focus({ preventScroll: true })
        held.current = slot.current?.contains(document.activeElement) ?? false
    })
}

function Destinations({ updates }: { updates: PublishUpdate[] }) {
    return (
        <ul className="publish-destinations" aria-label="Destinations">
            {updates.map(update => (
                <li key={update.ref} data-kind={update.kind}>
                    <span className="publish-kind">{kindLabels[update.kind]}</span>
                    <span>
                        <span className="publish-destination">{update.remote}/{update.branch}</span>
                        {update.setUpstream && <small>{" "}sets upstream</small>}
                    </span>
                </li>
            ))}
        </ul>
    )
}

/**
 * A publish that didn't simply succeed: what each update did, what stayed as it was, and the way forward. A stale
 * lease leads to Pull latest, never a retry; anything else left unpublished publishes again from its branch's header.
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
    return (
        <Modal isOpen={open != undefined} isDismissable onOpenChange={isOpen => isOpen || publish.close(outcome!.repositoryId)}>
            <Dialog className="react-aria-Dialog publish-outcome" aria-label="Publish outcome">
                <Heading slot="title">Publish</Heading>
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
                    <Button
                        variant={status == "stale" ? "secondary" : "accent"}
                        onPress={() => publish.close(outcome!.repositoryId)}
                        autoFocus={status != "stale"}
                    >
                        Close
                    </Button>
                </div>
            </Dialog>
        </Modal>
    )
}
