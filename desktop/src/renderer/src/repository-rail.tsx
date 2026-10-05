import type { Workspace } from "@laneway/shared"
import { css, type Handle, on, type RemixNode } from "remix/ui"
import { Icon } from "./icons"

// Pointer travel before a press on a repository becomes a drag.
let dragThreshold = 4
let reorderDuration = 150

type RepositoryDrag = {
    id: string
    row: HTMLElement
    pointerId: number
    startY: number
    // Measured once the drag begins; rows only move visually until the drop commits the order.
    slots?: { top: number; height: number }[]
    gap: number
    from: number
    to: number
    offset: number
    settling: boolean
    controller: AbortController
}

let repositoryRail = css({
    minWidth: "0",
    minHeight: "0",
    padding: "6px",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    gap: "6px",
    color: "var(--chrome-text)",
    borderRight: "1px solid var(--chrome-line)",
    background: "var(--chrome)",
    ".rail-collapsed &": { padding: "6px 0" },
})

let railHeading = css({
    padding: "2px 2px 6px 6px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    borderBottom: "1px solid var(--chrome-line)",
    ".rail-collapsed &": { padding: "0 0 6px", justifyContent: "center" },
})

let railEyebrow = css({
    minWidth: "0",
    flex: "1 1 auto",
    margin: "0",
    overflow: "hidden",
    color: "var(--chrome-muted)",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0",
    textOverflow: "ellipsis",
    textTransform: "none",
    whiteSpace: "nowrap",
    ".rail-collapsed &": { display: "none" },
})

let openRepositoriesNav = css({
    minWidth: "0",
    minHeight: "0",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    gap: "4px",
    overflowX: "hidden",
    overflowY: "auto",
    ".rail-collapsed &": { justifyItems: "center" },
})

let repositoryRow = css({
    position: "relative",
    ".rail-collapsed &": { width: "100%", display: "grid", justifyItems: "center" },
    "&.dragging": { zIndex: 1 },
})

let repositoryItem = css({
    "&.collapsed": { width: "36px", height: "36px", padding: "0", gridTemplateColumns: "1fr", gap: "0", justifyItems: "center" },
    position: "relative",
    minWidth: "0",
    width: "100%",
    padding: "5px 26px 5px 6px",
    display: "grid",
    gridTemplateColumns: "28px minmax(0, 1fr)",
    alignItems: "center",
    gap: "8px",
    outlineOffset: "-2px",
    textAlign: "left",
    color: "var(--chrome-text)",
    border: "1px solid transparent",
    borderRadius: "7px",
    background: "transparent",
    "&:hover:not(:disabled)": { background: "var(--chrome-2)" },
    "&.active": { background: "var(--chrome-2)", borderColor: "var(--chrome-line)" },
    "&.active > span:first-child": { color: "var(--accent-ink)", borderColor: "var(--chrome-accent)", background: "var(--chrome-accent)" },
    "&.active::before": {
        content: '""',
        position: "absolute",
        left: "-6px",
        top: "6px",
        bottom: "6px",
        width: "3px",
        borderRadius: "0 2px 2px 0",
        background: "var(--chrome-accent)",
    },
    // Collapsed, the tile alone marks the selection: a solid accent tile with a side marker of the same height.
    "&.collapsed, &.collapsed.active, &.collapsed:hover:not(:disabled)": { background: "transparent", borderColor: "transparent" },
    "&.collapsed.active::before": { left: "-8px", top: "4px", bottom: "4px", width: "3px" },
    "&.collapsed:focus-visible": { outline: "none" },
    "&.missing > span:first-child": { color: "var(--warning)" },
    // Lifted while dragging and set back down as it settles into its slot; a shadow alone disappears against the dark rail.
    transition: "scale 120ms ease",
    ".reordering:not(.settling) > .dragging > &:not(.collapsed)": {
        scale: "1.03",
        background: "var(--chrome-line)",
        boxShadow: "0 6px 16px rgb(0 0 0 / 0.6)",
    },
})

let repositoryInitials = css({
    width: "28px",
    height: "28px",
    display: "grid",
    placeItems: "center",
    color: "var(--chrome-text)",
    border: "1px solid var(--chrome-line)",
    borderRadius: "6px",
    background: "var(--chrome-2)",
    fontSize: "11px",
    fontWeight: "700",
    letterSpacing: "0.02em",
    ".collapsed:not(.active) > &": { color: "var(--chrome-muted)", opacity: 0.7 },
    ".collapsed:not(.active):hover > &": { opacity: 1, borderColor: "var(--chrome-accent)" },
    ".collapsed.active > &": { color: "var(--accent-ink)", borderColor: "var(--chrome-accent)", background: "var(--chrome-accent)" },
    ".collapsed:focus-visible > &": { outline: "2px solid var(--ring)", outlineOffset: "2px" },
    transition: "scale 120ms ease",
    ".reordering:not(.settling) > .dragging > .collapsed > &": { scale: "1.12", opacity: 1, boxShadow: "0 6px 16px rgb(0 0 0 / 0.6)" },
    ".reordering:not(.settling) > .dragging > .collapsed:not(.active) > &": {
        color: "var(--chrome-text)",
        borderColor: "var(--chrome-muted)",
        background: "var(--chrome-line)",
    },
})

let repositoryCopy = css({
    minWidth: "0",
    display: "grid",
    alignContent: "center",
    gap: "1px",
})

let repositoryName = css({
    overflow: "hidden",
    fontSize: "12.5px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let repositoryPath = css({
    overflow: "hidden",
    color: "var(--chrome-muted)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let repositoryClose = css({
    position: "absolute",
    top: "50%",
    right: "6px",
    width: "22px",
    height: "22px",
    padding: "0",
    display: "grid",
    translate: "0 -50%",
    placeItems: "center",
    color: "var(--chrome-muted)",
    border: "0",
    borderRadius: "5px",
    background: "transparent",
    "&:hover": { color: "var(--chrome-text)", background: "var(--chrome-line)" },
})

let railAdd = css({
    "&.collapsed": { width: "36px", height: "36px", padding: "0", gridTemplateColumns: "1fr", gap: "0", justifyItems: "center" },
    margin: "4px 0 0",
    width: "100%",
    height: "36px",
    padding: "0 6px",
    display: "grid",
    gridTemplateColumns: "28px minmax(0, 1fr)",
    alignItems: "center",
    gap: "8px",
    flex: "0 0 auto",
    outlineOffset: "-2px",
    textAlign: "left",
    color: "var(--chrome-muted)",
    border: "1px dashed var(--chrome-line)",
    borderRadius: "7px",
    background: "transparent",
    fontSize: "12px",
    lineHeight: "1",
    "&:hover:not(:disabled)": { color: "var(--chrome-text)", background: "var(--chrome-2)" },
})

let railAddIcon = css({
    width: "28px",
    height: "28px",
    display: "grid",
    placeItems: "center",
})

let railFooter = css({
    padding: "6px 2px 2px",
    display: "flex",
    justifyContent: "flex-end",
    borderTop: "1px solid var(--chrome-line)",
    ".rail-collapsed &": { justifyContent: "center", padding: "6px 0 2px" },
})

let railToggle = css({
    width: "100%",
    height: "28px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--chrome-muted)",
    border: "1px solid transparent",
    borderRadius: "6px",
    background: "transparent",
    "&.collapsed": { width: "28px" },
    "&:hover:not(:disabled)": { color: "var(--chrome-text)", background: "var(--chrome-2)" },
})

// The ink-coloured repository rail on the left edge. Collapsed it is an icon strip of initials
// tiles; expanded it adds names and worktree paths. Both views share one markup so the
// branch workspace and the missing-repository view stay identical.
export function RepositoryRail(
    handle: Handle<{
        railCollapsed: boolean
        toggleRail(): void
        activeId: string
        workspace: Workspace
        busy?: boolean
        selectRepository(id: string): void
        // Set when choosing the active repository toggles a panel; reports whether it is shown.
        activeExpanded?: boolean
        closeRepository?(id: string): void
        moveRepository(id: string, targetId: string): void
        addRepository(): void
        heading?: RemixNode
    }>,
) {
    let drag: RepositoryDrag | undefined

    return () => {
        let props = handle.props
        let dragging = drag?.slots ? drag : undefined
        return (
            <aside class="repository-rail" mix={repositoryRail}>
                <div class="rail-heading" mix={railHeading}>
                    {props.heading}
                    <p class="eyebrow" mix={railEyebrow}>
                        Open repositories
                    </p>
                </div>
                <nav aria-label="Open repositories" class={`${dragging ? "reordering" : ""} ${dragging?.settling ? "settling" : ""}`} mix={openRepositoriesNav}>
                    {props.workspace.repositories.map((repository, index) => {
                        let name = repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name
                        let offset = !dragging ? 0 : repository.id == dragging.id ? dragging.offset : displacement(dragging, index)
                        // Rows step aside smoothly while the dragged row tracks the pointer, then it eases into its slot on release.
                        let eased = dragging && (repository.id != dragging.id || dragging.settling)

                        return (
                            <div
                                key={repository.id}
                                class={`repository-row ${repository.id == dragging?.id ? "dragging" : ""}`}
                                title="Drag to reorder · Ctrl+< / Ctrl+>"
                                // The transition is inline beside the transform so both clear together when the order commits.
                                // Remix applies that render in steps; a stylesheet transition could still catch a cleared transform.
                                style={{
                                    transform: offset ? `translateY(${offset}px)` : "",
                                    transition: eased ? `transform ${motionDuration()}ms ease` : "",
                                }}
                                mix={[
                                    repositoryRow,
                                    on("keydown", event => {
                                        if (event.ctrlKey && event.shiftKey && (event.key == "<" || event.key == ">")) {
                                            event.preventDefault()
                                            let target = props.workspace.repositories[index + (event.key == "<" ? -1 : 1)]
                                            if (target)
                                                props.moveRepository(repository.id, target.id)
                                        }
                                    }),
                                    on("pointerdown", event => {
                                        if (
                                            event.button == 0 && !props.busy && !drag
                                            && !(event.target instanceof Element && event.target.closest(".repository-close"))
                                        ) {
                                            press(event, repository.id, event.currentTarget)
                                        }
                                    }),
                                ]}
                            >
                                <button
                                    class={`repository-item ${props.railCollapsed ? "collapsed" : ""} ${
                                        repository.id == props.activeId ? "active" : ""
                                    } ${repository.status}`}
                                    type="button"
                                    disabled={props.busy}
                                    title={repository.status == "available" ? repository.info.selectedWorktree : repository.path}
                                    aria-label={name}
                                    aria-expanded={repository.id == props.activeId ? props.activeExpanded : undefined}
                                    data-click-activate
                                    mix={[
                                        repositoryItem,
                                        on("click", () => {
                                            // Releasing a drag does not choose the repository.
                                            if (!drag?.slots)
                                                props.selectRepository(repository.id)
                                        }),
                                    ]}
                                >
                                    <span mix={repositoryInitials}>
                                        {initials(repository.path)}
                                    </span>
                                    {!props.railCollapsed && (
                                        <span mix={repositoryCopy}>
                                            <strong mix={repositoryName}>{name}</strong>
                                            <small mix={repositoryPath}>
                                                {repository.status == "available" ? repository.info.selectedWorktree : "Unavailable"}
                                            </small>
                                        </span>
                                    )}
                                </button>
                                {!props.railCollapsed && props.closeRepository && (
                                    <button
                                        class="repository-close"
                                        type="button"
                                        aria-label={`Close ${name}`}
                                        title="Close repository"
                                        mix={[repositoryClose, on("click", () => props.closeRepository?.(repository.id))]}
                                    >
                                        <Icon name="close" size={12} />
                                    </button>
                                )}
                            </div>
                        )
                    })}
                    <button
                        class={`rail-add ${props.railCollapsed ? "collapsed" : ""}`}
                        type="button"
                        aria-label="Add repository"
                        title="Add repository"
                        disabled={props.busy}
                        mix={[railAdd, on("click", props.addRepository)]}
                    >
                        <span aria-hidden="true" mix={railAddIcon}>
                            <Icon name="plus" size={14} />
                        </span>
                        {!props.railCollapsed && <span class="rail-add-label">Add repository</span>}
                    </button>
                </nav>
                <div class="rail-footer" mix={railFooter}>
                    <RepositoryRailToggle collapsed={props.railCollapsed} toggle={props.toggleRail} />
                </div>
            </aside>
        )
    }

    function press(event: PointerEvent, id: string, row: HTMLElement) {
        let controller = new AbortController()
        drag = { id, row, pointerId: event.pointerId, startY: event.clientY, gap: 0, from: 0, to: 0, offset: 0, settling: false, controller }
        let signal = AbortSignal.any([controller.signal, handle.signal])
        window.addEventListener("pointermove", move, { signal })
        window.addEventListener("pointerup", release, { signal })
        window.addEventListener("pointercancel", cancel, { signal })
        window.addEventListener("keydown", event => {
            if (event.key == "Escape") {
                event.preventDefault()
                cancel()
            }
        }, { signal })
    }

    function move(event: PointerEvent) {
        if (!drag || event.pointerId != drag.pointerId)
            return

        let delta = event.clientY - drag.startY
        if (!drag.slots) {
            if (Math.abs(delta) < dragThreshold)
                return
            let rows = [...drag.row.parentElement!.querySelectorAll<HTMLElement>(":scope > .repository-row")]
            drag.slots = rows.map(row => {
                let rect = row.getBoundingClientRect()
                return { top: rect.top, height: rect.height }
            })
            drag.gap = drag.slots.length > 1 ? drag.slots[1].top - drag.slots[0].top - drag.slots[0].height : 0
            drag.from = drag.to = rows.indexOf(drag.row)
            drag.row.setPointerCapture(drag.pointerId)
        }
        let slots = drag.slots
        let own = slots[drag.from]
        let last = slots[slots.length - 1]
        // The row follows the pointer vertically but stays within the list.
        drag.offset = Math.min(Math.max(delta, slots[0].top - own.top), last.top + last.height - own.top - own.height)
        let top = own.top + drag.offset
        let bottom = top + own.height
        // A neighbour steps aside once the dragged row covers half of it.
        let from = drag.from
        drag.to = slots.filter((slot, index) => {
            let middle = slot.top + slot.height / 2
            return index < from ? top > middle : index > from && bottom >= middle
        }).length
        void handle.update()
    }

    function release(event: PointerEvent) {
        if (drag && event.pointerId == drag.pointerId)
            settle(drag.to)
    }

    function cancel() {
        if (drag)
            settle(drag.from)
    }

    // Eases the dragged row into its slot before committing, so the reordered list renders where it already appears.
    function settle(to: number) {
        let settling = drag
        if (!settling || settling.settling)
            return
        settling.controller.abort()
        if (!settling.slots) {
            drag = undefined
            return
        }
        settling.to = to
        settling.offset = landing(settling)
        settling.settling = true
        void handle.update()
        setTimeout(() => {
            drag = undefined
            let target = handle.props.workspace.repositories[to]
            if (to != settling.from && target)
                handle.props.moveRepository(settling.id, target.id)
            void handle.update()
        }, motionDuration())
    }
}

function motionDuration() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : reorderDuration
}

// Where the dragged row comes to rest: past every row that stepped aside for it.
function landing(drag: RepositoryDrag) {
    let passed = drag.slots!.filter((_, index) => displacement(drag, index) != 0)
    let distance = 0
    for (let slot of passed)
        distance += slot.height + drag.gap

    return drag.to > drag.from ? distance : -distance
}

// How far the row at `index` steps aside to open the dragged row's target slot.
function displacement(drag: RepositoryDrag, index: number) {
    let stride = drag.slots![drag.from].height + drag.gap
    return index > drag.from && index <= drag.to ? -stride : index < drag.from && index >= drag.to ? stride : 0
}

export function RepositoryRailToggle(handle: Handle<{ collapsed: boolean; toggle(): void }>) {
    return () => (
        <button
            class={`repository-rail-toggle ${handle.props.collapsed ? "collapsed" : ""}`}
            type="button"
            aria-label={handle.props.collapsed ? "Expand repository sidebar" : "Collapse repository sidebar"}
            title={handle.props.collapsed ? "Expand repository sidebar" : "Collapse repository sidebar"}
            aria-expanded={!handle.props.collapsed}
            mix={[railToggle, on("click", handle.props.toggle)]}
        >
            <Icon name={handle.props.collapsed ? "collapse-right" : "collapse-left"} size={14} />
        </button>
    )
}

export function initials(path: string) {
    let words = baseName(path).split(/[-_.\s]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "GW").toUpperCase()
}

export function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}
