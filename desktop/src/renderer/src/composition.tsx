import { draggable, dropTargetForElements, monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter"
import type { CompositionRequest, CompositionSource, CompositionTarget, LocalPreview } from "@laneway/shared"
import { createMixin, css, on, type RemixNode } from "remix/ui"
import type { NoticeState } from "./feedback"
import { Icon } from "./icons"

interface Selection {
    repositoryId: string
    source: CompositionSource
    files?: CompositionRequest["files"]
    inventoryVersion?: string
    selectedRemote?: string
    view?: CompositionRequest["view"]
    label: string
}

export const compositionStyles = css({
    // The handle is a quiet grip, always the leftmost thing in a row; the whole row drags.
    "& .composition-handle": {
        order: "-1",
        flex: "0 0 18px",
        width: "18px",
        height: "100%",
        minHeight: "22px",
        padding: "0",
        display: "grid",
        placeItems: "center",
        border: "0",
        borderRadius: "0",
        background: "transparent",
        color: "var(--line-strong)",
        cursor: "grab",
        "&:hover": { color: "var(--muted)" },
        "&:focus-visible": { outlineOffset: "-2px" },
    },
    "& :is(.change-file, .disclosure-heading, .composition-branch-target):hover .composition-handle": { color: "var(--muted)" },
    // The row, not the button inside it, owns the heading's background and edges so they run under the grip.
    "& .composition-branch-heading": {
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--line)",
        background: "var(--focus-wash)",
        "&:hover": { background: "color-mix(in srgb, var(--focus) 18%, var(--panel))" },
    },
    "& .composition-over": { outline: "2px solid var(--focus)", outlineOffset: "-2px", background: "var(--focus-wash)" },
    // Positional drops mark the edge they will insert at without moving anything around them.
    "& .composition-over-above": { boxShadow: "inset 0 3px 0 0 var(--focus)" },
    "& .composition-over-below": { boxShadow: "inset 0 -3px 0 0 var(--focus)" },
    // Seams take no space, so starting a drag never shifts the layout; they open only for keyboard focus.
    "& .composition-seam": {
        height: "0",
        overflow: "hidden",
        fontSize: "0",
        cursor: "pointer",
        "&:focus-visible": {
            height: "24px",
            margin: "2px 8px",
            display: "grid",
            placeItems: "center",
            fontSize: "11px",
            fontWeight: "600",
            color: "var(--focus)",
            border: "1px dashed var(--focus)",
            borderRadius: "var(--radius)",
            background: "var(--focus-wash)",
        },
    },
    "& .composition-review": {
        padding: "10px",
        border: "1px solid var(--accent-edge)",
        background: "var(--panel)",
        fontSize: "12px",
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
        "& p, & strong, & label": { margin: "0", flexBasis: "100%" },
        "& .composition-warning": { color: "var(--warning)", fontWeight: "600" },
        "& input:not([type=checkbox])": { width: "100%", boxSizing: "border-box" },
    },
    "& .composition-branch-target": {
        display: "flex",
        gap: "6px",
        alignItems: "center",
        minHeight: "34px",
        padding: "0 12px 0 8px",
        borderBottom: "1px solid var(--line)",
        background: "var(--focus-wash)",
        fontSize: "13px",
        fontWeight: "600",
        "& > svg": { flex: "0 0 auto", color: "var(--focus)" },
    },
})
export function createComposition(options: {
    api: Pick<Window["laneway"], "localOperation">
    signal: AbortSignal
    update(): Promise<AbortSignal>
    notify(notice: NoticeState): () => void
    changed?(repositoryId: string): Promise<void>
    busyChanged?(busy: boolean): void
    resolve?(repositoryId: string): void
}) {
    const token = `composition-${crypto.randomUUID()}`
    let active: Selection | undefined, mode: "move" | "copy" = "move"
    let pending: { selection: Selection; request: CompositionRequest; key: string; preview?: LocalPreview } | undefined
    // Outcomes and guidance use the app toast; progress and errors stay in the review panel at the destination.
    let busy = false, notice = "", generation = 0, dismissGuidance = () => {}
    type Destination = { repositoryId: string; target: CompositionTarget }
    // Staging lists take working files from the other list; the composer applies the change.
    type Staging = { repositoryId: string; worktreePath: string; view: "staged" | "unstaged"; apply(paths: string[]): void }
    type Landing = { kind: "compose"; value: Destination } | { kind: "stage"; value: Staging }
    const targets = new Map<HTMLElement, () => Landing>()
    const update = () => void options.update()
    const key = (repositoryId: string, target: CompositionTarget) => JSON.stringify([repositoryId, target])
    /** A commit dragged by its row rather than a file selection: it moves or squashes as a unit, carrying its own message. */
    const wholeCommit = (selection: Selection) => selection.source.kind == "commit" && !selection.files
    function compatible(selection: Selection | undefined, repositoryId: string, target: CompositionTarget) {
        if (!selection || selection.repositoryId != repositoryId)
            return false
        const source = selection.source
        if (source.kind == "branch")
            return target.kind == "branch"
        if (target.kind == "branch")
            return wholeCommit(selection)
        if (source.kind != "commit")
            return true
        if (target.kind == "commit")
            return target.objectId != source.objectId
        // The seams either side of a commit in its own branch would only put it back where it is.
        return target.kind != "seam" || !wholeCommit(selection) || target.branch != source.branch
            || target.parentId != source.objectId && target.parentId != source.parentId
    }
    function stageable(selection: Selection | undefined, staging: Staging) {
        return !!selection && selection.repositoryId == staging.repositoryId
            && selection.source.kind == "working" && selection.source.worktreePath == staging.worktreePath
            && !!selection.files?.length && (selection.view == "staged" || selection.view == "unstaged") && selection.view != staging.view
    }
    function accepts(selection: Selection | undefined, landing: Landing) {
        return landing.kind == "compose"
            ? compatible(selection, landing.value.repositoryId, landing.value.target)
            : stageable(selection, landing.value)
    }
    function land(selection: Selection, landing: Landing, copy: boolean) {
        if (landing.kind == "compose")
            void drop(selection, landing.value.repositoryId, landing.value.target, copy)
        else if (!busy && stageable(selection, landing.value)) {
            cancel()
            landing.value.apply(selection.files!.map(file => file.path))
        }
    }
    function choose(selection: Selection, value: "move" | "copy") {
        if (busy)
            return
        active = selection
        mode = selection.source.kind == "branch" ? "move" : value
        pending = undefined
        notice = ""
        dismissGuidance()
        dismissGuidance = options.notify({
            code: "composition.choose",
            message: `${value == "move" ? "Move" : "Copy"} ${selection.label} · Choose a destination, then Enter. Escape cancels.`,
        })
        update()
    }
    function cancel() {
        generation++
        active = undefined
        pending = undefined
        notice = ""
        dismissGuidance()
        update()
    }
    async function drop(selection: Selection, repositoryId: string, target: CompositionTarget, copy: boolean) {
        if (busy || !compatible(selection, repositoryId, target))
            return
        active = selection
        mode = copy && selection.source.kind != "branch" ? "copy" : "move"
        pending = {
            selection,
            key: key(repositoryId, target),
            request: {
                action: "compose",
                source: selection.source,
                target,
                mode,
                files: selection.files,
                inventoryVersion: selection.inventoryVersion,
                selectedRemote: selection.selectedRemote,
                view: selection.view ?? "combined",
                message: "",
                descendants: true,
                allowConflicts: false,
            },
        }
        notice = ""
        dismissGuidance()
        update()
        // Only composed file selections need a message for a new commit; a whole commit brings its own.
        if (target.kind != "seam" || wholeCommit(selection))
            await prepare()
    }
    async function prepare() {
        const current = pending
        if (!current || busy)
            return
        const version = ++generation
        busy = true
        options.busyChanged?.(true)
        notice = "Checking transfer…"
        update()
        try {
            const response = await options.api.localOperation(current.selection.repositoryId, current.request)
            if (version != generation || pending != current)
                return
            if (!response.ok)
                throw new Error(response.error.message)
            current.preview = response.result.preview
            notice = ""
        } catch (error) {
            notice = error instanceof Error ? error.message : String(error)
        } finally {
            busy = false
            options.busyChanged?.(false)
            update()
        }
        const p = current.preview?.composition
        if (pending == current && p && current.request.source.kind != "branch" && !p.conflicts.length && !p.removed.length && !p.published.length)
            await execute(false)
    }
    async function execute(resolveNow: boolean) {
        const current = pending
        if (!current?.preview || busy)
            return
        busy = true
        options.busyChanged?.(true)
        notice = "Transferring…"
        update()
        try {
            const result = await options.api.localOperation(current.selection.repositoryId, {
                ...current.request,
                allowConflicts: !!current.preview.composition?.conflicts.length,
            }, current.preview.token)
            if (!result.ok)
                throw new Error(result.error.message)
            if (result.result.status == "failed")
                throw new Error(result.result.message)
            notice = ""
            options.notify({ code: "composition.transferred", message: result.result.message ?? "Changes transferred.", transient: true })
            active = undefined
            pending = undefined
            await options.changed?.(current.selection.repositoryId)
            if (resolveNow)
                options.resolve?.(current.selection.repositoryId)
        } catch (error) {
            notice = error instanceof Error ? error.message : String(error)
            current.preview = undefined
        } finally {
            busy = false
            options.busyChanged?.(false)
            update()
        }
    }
    const keyboard = (event: KeyboardEvent) => {
        if (!active || busy || (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true]")))
            return
        if (event.key == "Escape") {
            event.preventDefault()
            cancel()
        } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            const available = [...targets].filter(([element, value]) => element.isConnected && element.getClientRects().length && accepts(active, value()))
            const index = available.findIndex(([element]) => element == document.activeElement)
            const next = available[(index + (event.key == "ArrowDown" ? 1 : -1) + available.length) % available.length]
            if (next) {
                event.preventDefault()
                next[0].focus()
            }
        } else if (event.key == "Enter" && event.target instanceof HTMLElement) {
            const landing = targets.get(event.target)?.()
            if (landing && accepts(active, landing)) {
                event.preventDefault()
                event.stopPropagation()
                land(active, landing, mode == "copy")
            }
        }
    }
    const stopMonitoring = monitorForElements({
        canMonitor: ({ source }) => !!source.data[token],
        onDrop: ({ location }) => {
            // Cancellation reports no targets, even when cancelled over a valid one.
            if (!location.current.dropTargets.length)
                cancel()
        },
    })
    document.addEventListener("keydown", keyboard, true)
    options.signal.addEventListener("abort", () => {
        document.removeEventListener("keydown", keyboard, true)
        stopMonitoring()
    }, { once: true })
    const sourceBinding = createMixin<HTMLElement, [Selection]>(handle => {
        let selection: Selection, cleanup = () => {}
        handle.addEventListener("insert", ({ node }) => {
            // The whole row is the drag surface (mouse activation waits for a click inside it); the handle stays
            // as the visible affordance and keyboard entry point.
            const row = node.closest<HTMLElement>(".change-file, .disclosure-heading, .composition-branch-target") ?? node
            cleanup = draggable({
                element: row,
                getInitialData: () => ({ [token]: selection }),
                canDrag: ({ input }) => {
                    if (busy)
                        return false
                    const target = document.elementFromPoint(input.clientX, input.clientY)
                    return !target?.closest("input, textarea, select, [contenteditable], a[href]")
                },
                onDragStart: ({ location }) => choose(selection, location.current.input.ctrlKey ? "copy" : "move"),
            })
        })
        handle.addEventListener("remove", () => cleanup())
        return (value: Selection) => {
            selection = value
            return <handle.element />
        }
    })
    /** Seams a commit row stands in for: pointer drops near its top or bottom edge land there instead of on the commit. */
    type Edges = { above?: CompositionTarget; below?: CompositionTarget }
    type Placement = { landing: Landing; edge: "above" | "on" | "below" }
    const overClasses = { above: "composition-over-above", on: "composition-over", below: "composition-over-below" }
    const targetBinding = createMixin<HTMLElement, [Landing, Edges?]>(handle => {
        let value: Landing, edges: Edges = {}, cleanup = () => {}
        handle.addEventListener("insert", ({ node: element }) => {
            targets.set(element, () => value)
            const selectionOf = (source: { data: Record<string, unknown> }) => source.data[token] as Selection | undefined
            const seam = (target: CompositionTarget | undefined, selection: Selection | undefined): Landing | undefined =>
                value.kind == "compose" && target && compatible(selection, value.value.repositoryId, target)
                    ? { kind: "compose", value: { repositoryId: value.value.repositoryId, target } }
                    : undefined
            // Edges take a quarter of the row beside a usable centre, or half of it otherwise; a lone edge takes the whole row.
            function place(selection: Selection | undefined, clientY: number): Placement | undefined {
                const on = accepts(selection, value) ? value : undefined
                const above = seam(edges.above, selection), below = seam(edges.below, selection)
                const rect = element.getBoundingClientRect(), offset = clientY - rect.top, band = rect.height / (on ? 4 : 2)
                if (above && offset < band)
                    return { landing: above, edge: "above" }
                if (below && offset > rect.height - band)
                    return { landing: below, edge: "below" }
                return on ? { landing: on, edge: "on" } : above ? { landing: above, edge: "above" } : below ? { landing: below, edge: "below" } : undefined
            }
            const clear = () => element.classList.remove(...Object.values(overClasses))
            const show = (placement: Placement | undefined) => {
                clear()
                if (placement)
                    element.classList.add(overClasses[placement.edge])
            }
            const unregister = dropTargetForElements({
                element,
                canDrop: ({ source, input }) => !busy && !!place(selectionOf(source), input.clientY),
                getDropEffect: ({ input, source }) =>
                    value.kind == "compose" && input.ctrlKey && selectionOf(source)?.source.kind != "branch" ? "copy" : "move",
                onDragEnter: ({ source, location }) => show(place(selectionOf(source), location.current.input.clientY)),
                onDrag: ({ source, location }) => show(place(selectionOf(source), location.current.input.clientY)),
                onDragLeave: clear,
                onDrop: ({ source, location, self }) => {
                    clear()
                    const placement = place(selectionOf(source), location.current.input.clientY)
                    if (placement && location.current.dropTargets[0]?.element == self.element)
                        land(selectionOf(source)!, placement.landing, location.current.input.ctrlKey)
                },
            })
            cleanup = () => {
                unregister()
                targets.delete(element)
            }
        })
        handle.addEventListener("remove", () => cleanup())
        return (next: Landing, nextEdges: Edges = {}) => {
            value = next
            edges = nextEdges
            // Targets join the tab order only while a move or copy is choosing its destination.
            return (
                <handle.element
                    tabIndex={active ? 0 : -1}
                    mix={on("click", event => {
                        if (active && event.target == event.currentTarget)
                            land(active, value, mode == "copy")
                    })}
                />
            )
        }
    })
    return {
        source(selection: Selection): RemixNode {
            return (
                <button
                    type="button"
                    class="composition-handle"
                    aria-label={`Move or copy ${selection.label}`}
                    title="Drag to move · Ctrl-drag to copy · M/C then destination and Enter"
                    disabled={busy}
                    mix={[
                        sourceBinding(selection),
                        on("click", () => choose(selection, "move")),
                        on("keydown", event => {
                            if (["m", "c"].includes(event.key.toLowerCase()) && !event.ctrlKey && !event.metaKey) {
                                event.preventDefault()
                                event.stopPropagation()
                                choose(selection, event.key.toLowerCase() == "c" ? "copy" : "move")
                            }
                        }),
                    ]}
                >
                    <Icon name="grip" size={14} />
                </button>
            )
        },
        /** Makes a staged or unstaged file list accept drops from the other list. */
        staging(value: Staging) {
            return targetBinding({ kind: "stage", value })
        },
        /** Edges name the seams a pointer reaches through this row; keyboard moves reach those seams directly. */
        target(repositoryId: string, target: CompositionTarget, edges?: Edges) {
            return targetBinding({ kind: "compose", value: { repositoryId, target } }, edges)
        },
        seam(repositoryId: string, target: Extract<CompositionTarget, { kind: "seam" }>): RemixNode {
            const branch = target.branch.replace(/^refs\/heads\//, "")
            const label = active && wholeCommit(active) ? `${mode == "copy" ? "Copy" : "Move"} commit here` : "New commit"
            return (
                <>
                    <div
                        key={key(repositoryId, target)}
                        class="composition-seam"
                        role="button"
                        aria-label={`${label} on ${branch}`}
                        mix={this.target(repositoryId, target)}
                    >
                        {label == "New commit" ? "+ New commit" : label}
                    </div>
                    {this.panel(repositoryId, target)}
                </>
            )
        },
        panel(repositoryId: string, target: CompositionTarget): RemixNode {
            if (!pending || pending.key != key(repositoryId, target))
                return null
            const current = pending, p = current.preview?.composition
            const needsMessage = target.kind == "seam" && !wholeCommit(current.selection)
            return (
                <section class="composition-review" aria-label="Review transfer">
                    <strong>{current.request.mode == "move" ? "Move" : "Copy"} {current.selection.label}</strong>
                    {needsMessage && (
                        <input
                            aria-label="New commit message"
                            placeholder="Commit message"
                            value={current.request.message}
                            disabled={busy}
                            mix={on("input", e => {
                                current.request.message = e.currentTarget.value
                                current.preview = undefined
                                update()
                            })}
                        />
                    )}
                    {current.request.source.kind == "branch" && (
                        <label>
                            <input
                                type="checkbox"
                                checked={current.request.descendants}
                                disabled={busy}
                                mix={on("change", e => {
                                    current.request.descendants = e.currentTarget.checked
                                    current.preview = undefined
                                    void prepare()
                                })}
                            />Move descendant branches too
                        </label>
                    )}
                    {!!p?.branches.length && <p>Affected: {p.branches.join(", ")}</p>}
                    {!!p?.removed.length && <p>Remove empty commits: {p.removed.map(c => c.slice(0, 8)).join(", ")}</p>}
                    {!!p?.published.length && (
                        <p class="composition-warning" role="alert">
                            Rewrites history already published on {p.published.join(", ")}. The next Publish needs force-with-lease.
                        </p>
                    )}
                    {!!p?.conflicts.length && <p>Conflicts: {p.conflicts.map(c => `${c.subject}: ${c.files.join(", ")}`).join("; ")}</p>}
                    {!!p?.skipped.length && <p>Already present: {p.skipped.join(", ")}</p>}
                    {!current.preview && (
                        <button
                            type="button"
                            disabled={busy || needsMessage && !current.request.message.trim()}
                            mix={on("click", () => prepare())}
                        >
                            Review transfer
                        </button>
                    )}
                    {current.preview && (p?.conflicts.length
                        ? (
                            <>
                                <button disabled={busy} mix={on("click", () => execute(true))}>Continue and resolve now</button>
                                <button disabled={busy} mix={on("click", () => execute(false))}>Continue and resolve later</button>
                            </>
                        )
                        : <button disabled={busy} mix={on("click", () => execute(false))}>Transfer</button>)}
                    <button type="button" disabled={busy} mix={on("click", cancel)}>
                        Cancel
                    </button>
                    {notice && <p role="status">{notice}</p>}
                </section>
            )
        },
    }
}
