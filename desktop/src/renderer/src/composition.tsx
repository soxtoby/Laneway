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
        "& .stack-heading": { flex: "1", minWidth: "0", border: "0", background: "transparent" },
    },
    "& .composition-over": { outline: "2px solid var(--focus)", outlineOffset: "-2px", background: "var(--focus-wash)" },
    // Seams take no space until a drag or keyboard move makes them a target.
    "& .composition-seam": {
        height: "0",
        overflow: "hidden",
        fontSize: "0",
        cursor: "pointer",
        "&.available, &:focus-visible": {
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
    const targets = new Map<HTMLElement, () => Destination>()
    const update = () => void options.update()
    const key = (repositoryId: string, target: CompositionTarget) => JSON.stringify([repositoryId, target])
    function compatible(selection: Selection | undefined, repositoryId: string, target: CompositionTarget) {
        return !!selection && selection.repositoryId == repositoryId
            && (selection.source.kind != "branch" || target.kind == "branch")
            && (target.kind != "branch" || selection.source.kind == "branch" || selection.source.kind == "commit" && !selection.files)
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
        if (target.kind != "seam")
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
            const available = [...targets].filter(([element, value]) =>
                element.isConnected && element.getClientRects().length && compatible(active, value().repositoryId, value().target)
            )
            const index = available.findIndex(([element]) => element == document.activeElement)
            const next = available[(index + (event.key == "ArrowDown" ? 1 : -1) + available.length) % available.length]
            if (next) {
                event.preventDefault()
                next[0].focus()
            }
        } else if (event.key == "Enter" && event.target instanceof HTMLElement) {
            const target = targets.get(event.target)?.()
            if (target && compatible(active, target.repositoryId, target.target)) {
                event.preventDefault()
                event.stopPropagation()
                void drop(active, target.repositoryId, target.target, mode == "copy")
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
            // Anything on the row that a click would not otherwise consume is a drag surface; the handle stays
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
    const targetBinding = createMixin<HTMLElement, [Destination]>(handle => {
        let value: Destination, cleanup = () => {}
        handle.addEventListener("insert", ({ node: element }) => {
            targets.set(element, () => value)
            const unregister = dropTargetForElements({
                element,
                canDrop: ({ source }) => !busy && compatible(source.data[token] as Selection | undefined, value.repositoryId, value.target),
                getDropEffect: ({ input, source }) => input.ctrlKey && (source.data[token] as Selection)?.source.kind != "branch" ? "copy" : "move",
                onDragEnter: () => element.classList.add("composition-over"),
                onDragLeave: () => element.classList.remove("composition-over"),
                onDrop: ({ source, location, self }) => {
                    element.classList.remove("composition-over")
                    if (location.current.dropTargets[0]?.element == self.element)
                        void drop(source.data[token] as Selection, value.repositoryId, value.target, location.current.input.ctrlKey)
                },
            })
            cleanup = () => {
                unregister()
                targets.delete(element)
            }
        })
        handle.addEventListener("remove", () => cleanup())
        return (next: Destination) => {
            value = next
            return (
                <handle.element
                    tabIndex={0}
                    mix={on("click", event => {
                        if (active && event.target == event.currentTarget)
                            void drop(active, value.repositoryId, value.target, mode == "copy")
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
        target(repositoryId: string, target: CompositionTarget) {
            return targetBinding({ repositoryId, target })
        },
        seam(repositoryId: string, target: Extract<CompositionTarget, { kind: "seam" }>): RemixNode {
            return (
                <>
                    <div
                        key={key(repositoryId, target)}
                        class={`composition-seam ${active ? "available" : ""}`}
                        role="button"
                        aria-label={`New commit on ${target.branch.replace(/^refs\/heads\//, "")}`}
                        mix={this.target(repositoryId, target)}
                    >
                        + New commit
                    </div>
                    {this.panel(repositoryId, target)}
                </>
            )
        },
        panel(repositoryId: string, target: CompositionTarget): RemixNode {
            if (!pending || pending.key != key(repositoryId, target))
                return null
            const current = pending, p = current.preview?.composition
            return (
                <section class="composition-review" aria-label="Review transfer">
                    <strong>{current.request.mode == "move" ? "Move" : "Copy"} {current.selection.label}</strong>
                    {target.kind == "seam" && (
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
                    {!!p?.published.length && <p>Next Publish requires force-with-lease: {p.published.join(", ")}</p>}
                    {!!p?.conflicts.length && <p>Conflicts: {p.conflicts.map(c => `${c.subject}: ${c.files.join(", ")}`).join("; ")}</p>}
                    {!!p?.skipped.length && <p>Already present: {p.skipped.join(", ")}</p>}
                    {!current.preview && (
                        <button
                            type="button"
                            disabled={busy || target.kind == "seam" && !current.request.message.trim()}
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
