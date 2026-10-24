import type { CompositionSource, CompositionTarget, DiffSource } from "@laneway/shared"
import { createContext, type MouseEvent, useContext, useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react"
import { Button as AriaButton } from "react-aria-components"
import type { Composition, CompositionSnapshot, Edges, Landing, TransferSelection } from "./composition"
import { Button } from "./ui/Button"
import { Checkbox } from "./ui/Checkbox"
import { GripVertical } from "./ui/icons"
import { TextField } from "./ui/TextField"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot } from "./use-snapshot"

/** What a column's grips and destinations move within: the repository, its remote, and the column's branch. */
export interface TransferScope {
    composition: Composition
    repositoryId: string
    selectedRemote?: string
    /** The column's branch, which commits taken from its lists are moved out of. */
    branch?: string
}

export let TransferScopeContext = createContext<TransferScope | undefined>(undefined)

export function useTransferScope() {
    return useContext(TransferScopeContext)
}

/** Where a list's files come from, as a transfer takes them: Working Changes, or a commit on the column's branch. */
export function transferSource(source: DiffSource, branch?: string): CompositionSource | undefined {
    if (source.kind == "working")
        return source
    if (source.kind == "commit")
        return { ...source, branch }
    return undefined
}

let idle: CompositionSnapshot = { mode: "move", busy: false }
let noChanges = () => () => {}

// The rows a grip drags by: a file or folder, a commit, or a branch heading.
let rowSelector = ".dense-row, .commit-row, .stack-heading"

/**
 * The grip that moves or copies a selection. Its row drags from the grip or anywhere but its other controls, or
 * a diff open in it, and Ctrl-dragging copies; pressing the grip,
 * or M or C anywhere in its row, chooses the selection so the arrow keys and Enter can place it. The grip
 * and its row stay marked while the selection is chosen.
 */
export function TransferGrip({ composition, selection, alone }: {
    composition: Composition
    selection: TransferSelection
    /** Drags by the grip alone, for a selection inside a row that drags its own files, such as chosen lines. */
    alone?: boolean
}) {
    let grip = useRef<HTMLButtonElement>(null)
    let { busy, active } = useSnapshot(composition)
    let current = useEffectEvent(() => selection)
    useEffect(() => {
        let row = alone ? grip.current : grip.current?.closest<HTMLElement>(rowSelector) ?? grip.current
        if (!row)
            return
        // The keys work from the row because a list's arrow keys move between rows, never onto the grip. The
        // row hears them before its list, whose type-to-find would take them.
        let keyDown = (event: KeyboardEvent) => {
            let key = event.key.toLowerCase()
            if ((key != "m" && key != "c") || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented)
                return
            if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]"))
                return
            event.preventDefault()
            event.stopPropagation()
            composition.choose(current(), key == "c" ? "copy" : "move")
        }
        row.addEventListener("keydown", keyDown)
        let unbind = composition.bindSource(row, () => current())
        return () => {
            row.removeEventListener("keydown", keyDown)
            unbind()
        }
    }, [composition, alone])
    return (
        <span className="transfer-grip">
            <TooltipTrigger>
                <AriaButton
                    ref={grip}
                    className="grip"
                    aria-label={`Move or copy ${selection.label}`}
                    data-drags-row
                    data-chosen={active != undefined && sameSelection(active, selection) || undefined}
                    isDisabled={busy}
                    onPress={() => composition.choose(selection, "move")}
                >
                    <GripVertical />
                </AriaButton>
                <Tooltip className="react-aria-Tooltip hint">Drag to move · Ctrl-drag to copy · M or C, then a destination and Enter</Tooltip>
            </TooltipTrigger>
        </span>
    )
}

/** Whether two selections take the same changes, as a grip's selection is drawn afresh on each render. */
function sameSelection(a: TransferSelection, b: TransferSelection) {
    let changes = (selection: TransferSelection) => JSON.stringify([selection.repositoryId, selection.source, selection.files, selection.view])
    return changes(a) == changes(b)
}

/**
 * Makes an element a destination for moves and copies: it takes drops, and while a selection chooses its
 * destination it joins the tab order and lands the selection when clicked. Without a landing it is inert.
 */
export function useTransferTarget<T extends HTMLElement>(composition: Composition | undefined, landing?: Landing, edges?: Edges) {
    let target = useRef<T>(null)
    let { active, mode } = useSyncExternalStore(composition?.subscribe ?? noChanges, composition?.snapshot ?? (() => idle))
    let currentLanding = useEffectEvent(() => landing)
    let currentEdges = useEffectEvent(() => edges ?? {})
    let enabled = composition != undefined && landing != undefined
    useEffect(() => {
        if (!enabled || !composition || !target.current)
            return
        return composition.bindTarget(target.current, () => currentLanding()!, () => currentEdges())
    }, [composition, enabled])
    let accepting = composition != undefined && active != undefined && landing != undefined && composition.accepts(active, landing)
    let props = {
        tabIndex: enabled && active ? 0 : undefined,
        "data-transfer-target": accepting || undefined,
        onClick: (event: MouseEvent) => {
            if (composition && active && landing && event.target == event.currentTarget)
                composition.land(active, landing, mode == "copy")
        },
    }
    return { target, props }
}

/** The place between two commits a selection can land as a new commit. It takes no space until focused. */
export function TransferSeam({ composition, repositoryId, target }: {
    composition: Composition
    repositoryId: string
    target: Extract<CompositionTarget, { kind: "seam" }>
}) {
    let { target: seam, props } = useTransferTarget<HTMLDivElement>(composition, { kind: "compose", repositoryId, target })
    let { active, mode } = useSnapshot(composition)
    let branch = target.branch.replace(/^refs\/heads\//, "")
    let whole = active?.source.kind == "commit" && !active.files
    let label = whole ? `${mode == "copy" ? "Copy" : "Move"} commit here` : "New commit"
    return (
        <>
            <div ref={seam} {...props} className="transfer-seam" role="button" aria-label={`${label} on ${branch}`}>
                {whole ? label : "+ New commit"}
            </div>
            <TransferReview composition={composition} repositoryId={repositoryId} target={target} />
        </>
    )
}

/** A landed transfer under review at its destination: what it would do, and whether to go ahead. */
export function TransferReview({ composition, repositoryId, target }: { composition: Composition; repositoryId: string; target: CompositionTarget }) {
    let { pending, busy, notice } = useSnapshot(composition)
    if (!pending || pending.key != composition.key(repositoryId, target))
        return null
    let review = pending.preview?.composition
    let whole = pending.selection.source.kind == "commit" && !pending.selection.files
    let needsMessage = target.kind == "seam" && !whole
    return (
        <section className="transfer-review" aria-label="Review transfer">
            <strong>{pending.request.mode == "move" ? "Move" : "Copy"} {pending.selection.label}</strong>
            {needsMessage && (
                <TextField
                    aria-label="New commit message"
                    placeholder="Commit message"
                    value={pending.request.message}
                    onChange={composition.setMessage}
                    isDisabled={busy}
                    autoFocus
                />
            )}
            {pending.request.source.kind == "branch" && (
                <Checkbox isSelected={pending.request.descendants} onChange={composition.setDescendants} isDisabled={busy}>
                    Move descendant branches too
                </Checkbox>
            )}
            {!!review?.branches.length && <p>Affected: {review.branches.join(", ")}</p>}
            {!!review?.removed.length && <p>Remove empty commits: {review.removed.map(objectId => objectId.slice(0, 8)).join(", ")}</p>}
            {!!review?.published.length && (
                <p className="transfer-warning" role="alert">
                    Rewrites history already published on {review.published.join(", ")}. The next Publish needs force-with-lease.
                </p>
            )}
            {!!review?.conflicts.length && <p>Conflicts: {review.conflicts.map(conflict => `${conflict.subject}: ${conflict.files.join(", ")}`).join("; ")}</p>}
            {!!review?.skipped.length && <p>Already present: {review.skipped.join(", ")}</p>}
            {notice && <p role="status">{notice}</p>}
            <div className="commit-actions">
                <Button variant="secondary" isDisabled={busy} onPress={composition.cancel}>Cancel</Button>
                {!pending.preview && (
                    <Button
                        variant="accent"
                        isDisabled={busy || needsMessage && !pending.request.message.trim()}
                        onPress={() => void composition.prepare()}
                    >
                        Review transfer
                    </Button>
                )}
                {pending.preview && review?.conflicts.length
                    ? (
                        <>
                            {composition.resolves && (
                                <Button variant="secondary" isDisabled={busy} onPress={() => void composition.execute(true)}>Continue and resolve now</Button>
                            )}
                            <Button variant="accent" isDisabled={busy} onPress={() => void composition.execute(false)}>Continue and resolve later</Button>
                        </>
                    )
                    : pending.preview && <Button variant="accent" isDisabled={busy} onPress={() => void composition.execute(false)}>Transfer</Button>}
            </div>
        </section>
    )
}
