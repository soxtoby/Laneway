import type { BranchGraph, BranchGraphBranchNode, BranchGraphWorktree } from "@laneway/shared"
import type { RecoveryRequest, WorktreeRecovery } from "@laneway/shared"
import { css, type Handle, on, type RemixNode } from "remix/ui"
import type { createConflictResolution } from "../conflict-resolution"
import { Icon } from "../icons"
import { type ComparisonColumnNode, comparisonNode } from "../inspection/comparison-columns"
import type { createInspection } from "../inspection/inspection"
import { baseName } from "../repository-rail"
import { columnWorktree, recoveryColumnId } from "../worktrees/worktree-columns"
import { WorktreeRecoveryPanel } from "../worktrees/worktree-recovery"
import { branchDragType } from "./branch-graph-view"
import type { RepositoryGraphState } from "./branch-workspace"

export let defaultColumnWidth = 380

export type ColumnNode = BranchGraph["branches"][number] | BranchGraph["virtualBranches"][number] | ComparisonColumnNode

export type RecoveryColumnNode = { kind: "recovery"; id: string; name: string; recovery: WorktreeRecovery }

let toneMain = css({ color: "var(--accent)" })

let toneWorktree = css({ color: "var(--ok)" })

let toneBranch = css({ color: "var(--focus)" })

let toneWarning = css({ color: "var(--warning)" })

let toneComparison = css({ color: "var(--muted)" })

export let columnKindIcon = css({
    flex: "0 0 auto",
    display: "grid",
    placeItems: "center",
    width: "18px",
    height: "18px",
})

let expandColumnIcon = css({
    display: "grid",
    placeItems: "center",
})

let branchColumnActions = css({
    order: "1",
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    gap: "2px",
})

let columnEmpty = css({
    minWidth: "0",
    minHeight: "0",
    display: "grid",
    placeContent: "center",
    overflow: "hidden",
    color: "var(--faint)",
    textAlign: "center",
})

let columnEmptySpan = css({
    color: "var(--muted)",
    fontSize: "14px",
})

let columnEmptyP = css({
    margin: "6px 0 0",
    fontSize: "12px",
})

let branchColumns = css({
    position: "relative",
    minWidth: "0",
    minHeight: "0",
    display: "flex",
    alignItems: "stretch",
    gap: "var(--gutter)",
    // Room for the 1px card ring, which sits outside each column's box. The side padding scrolls with the
    // columns, leaving a gap at either end while scrolled columns run to the strip's edges.
    padding: "1px var(--gutter) 1px 4px",
    // Beside the sidebar, the columns tuck under its rounded edge so scrolled columns disappear beneath its shadow.
    ".graph-layout:not(.graph-collapsed) &": {
        marginLeft: "calc(-1 * var(--radius-card))",
        paddingLeft: "calc(var(--gutter) + var(--radius-card))",
    },
    overflowX: "auto",
    overflowY: "hidden",
    // Column focus rings and dividers stay beneath the Branch Graph sidebar.
    isolation: "isolate",
    // A styled scrollbar takes up room, so it sits under the columns instead of overlaying their bottom edge.
    "&::-webkit-scrollbar": { height: "10px" },
    "&::-webkit-scrollbar-track": { background: "transparent" },
    "&::-webkit-scrollbar-thumb": {
        background: "var(--line-strong)",
        border: "2px solid var(--canvas)",
        borderRadius: "5px",
    },
    "&::-webkit-scrollbar-thumb:hover": { background: "var(--faint)" },
    "&.maximized .branch-column": {
        width: "100%",
    },
})

let collapsedColumnButton = css({
    display: "flex",
    alignItems: "center",
    gap: "12px",
    writingMode: "vertical-rl",
    padding: "12px",
    color: "var(--text)",
    background: "var(--panel)",
    border: "0",
    cursor: "pointer",
    "&:hover": { background: "var(--control-hover)" },
})

let branchColumn = css({
    "&.collapsed": { minWidth: "52px", gridTemplateRows: "minmax(0, 1fr)" },
    "&.missing:not(.collapsed)": { gridTemplateRows: "auto auto minmax(0, 1fr)" },
    position: "relative",
    width: `${defaultColumnWidth}px`,
    minWidth: "310px",
    flex: "0 0 auto",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    // A long heading truncates rather than widening the header past the column's controls.
    gridTemplateColumns: "minmax(0, 1fr)",
    overflow: "hidden",
    // The card edge is a shadow ring so the column's content box starts at its left edge.
    border: "0",
    borderRadius: "var(--radius-card)",
    background: "var(--panel)",
    boxShadow: "0 0 0 1px var(--line-strong), var(--card-shadow)",
    // The focus ring is an overlay so the header and body cannot paint over it.
    "&:focus-visible": { outline: "0" },
    "&:focus-visible::after": {
        content: '""',
        position: "absolute",
        inset: "0",
        zIndex: "10",
        border: "2px solid var(--ring)",
        borderRadius: "inherit",
        pointerEvents: "none",
    },
    // Leaves room for at least one auxiliary column beside a maximized column.
    "&.attached": { borderTopRightRadius: "0", borderBottomRightRadius: "0" },
    "&.split": { maxWidth: "calc(100% - 310px - var(--gutter))" },
    "&:has(.column-inspection.focused)": {
        width: "240px !important",
        minWidth: "240px !important",
    },
})

let branchColumnHeader = css({
    position: "relative",
    minWidth: "0",
    minHeight: "46px",
    padding: "0 6px 0 0",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel)",
    '&[draggable="true"]': {
        cursor: "grab",
    },
    '&[draggable="true"]:active': {
        cursor: "grabbing",
    },
})

let branchColumnH2 = css({
    flex: "1 1 auto",
    minWidth: "0",
    margin: "0",
    overflow: "hidden",
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    fontSize: "15px",
    fontWeight: "600",
    letterSpacing: "-0.01em",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let branchColumnButton = css({
    width: "28px",
    height: "28px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--muted)",
    border: "1px solid transparent",
    borderRadius: "var(--radius)",
    background: "transparent",
    "&:hover": {
        color: "var(--text)",
        borderColor: "var(--line)",
        background: "var(--control-hover)",
    },
})

// The collapse control fills the header's full height at its leading edge, like a tab strip handle.
let columnCollapseButton = css({
    flex: "0 0 34px",
    alignSelf: "stretch",
    margin: "0",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--muted)",
    border: "0",
    borderRadius: "0",
    background: "transparent",
    cursor: "pointer",
    "&:hover": {
        color: "var(--text)",
        background: "var(--control-hover)",
    },
    "&:focus-visible": {
        outline: "2px solid var(--ring)",
        outlineOffset: "-2px",
    },
})

// The divider sits in the gap after its column, clear of the column's scrollbar; its negative margins cancel
// the extra flex gap it would otherwise add.
let columnDivider = css({
    position: "relative",
    zIndex: "2",
    flex: "0 0 var(--gutter)",
    alignSelf: "stretch",
    margin: "0 calc(-1 * var(--gutter))",
    cursor: "col-resize",
    "&:focus-visible": {
        outline: "2px solid var(--ring)",
        outlineOffset: "0",
    },
    // Between a column and its auxiliary columns, the divider is the seam of their shared card: it carries the card's
    // outline across the gap and still resizes the column.
    "&.attached": {
        borderInline: "1px solid var(--line)",
        background: "var(--panel-deep)",
        boxShadow: "0 -1px 0 var(--line-strong), 0 1px 0 var(--line-strong)",
    },
    "&.attached:hover, &.attached:focus-visible": { background: "var(--accent-wash-strong)" },
})

export function BranchColumns(
    handle: Handle<
        {
            graph: BranchGraph
            state: RepositoryGraphState
            inspection: ReturnType<typeof createInspection>
            conflicts: ReturnType<typeof createConflictResolution>
            repositoryId: string
            recover(recovery: WorktreeRecovery, action: RecoveryRequest["action"]): void
            branchAction(branch: BranchGraphBranchNode, action: "branch-rename" | "branch-delete"): void
            branchMenu(branch: BranchGraphBranchNode, event: MouseEvent): void
            worktreePath(id: string): string | undefined
            worktreeControls(column: BranchGraph["branches"][number] | BranchGraph["virtualBranches"][number]): RemixNode
            missingWorktreeControls(column: Exclude<ColumnNode, ComparisonColumnNode>, worktree: BranchGraphWorktree): RemixNode
            dropBranch(columnId: string, branchRef: string): void
            close(branchId: string): void
            collapse(branchId: string): void
            maximize(branchId: string): void
            focus(branchId: string): void
            move(branchId: string, delta: number): void
            previewMove(branchId: string, targetId: string): void
            commitMove(branchId: string): void
            resize(branchId: string, width: number): void
        }
    >,
) {
    return () => {
        let props = handle.props
        let columns = props.state.openedBranchIds.map(id =>
            props.graph.branches.find(branch => branch.id == id) ?? props.graph.virtualBranches.find(branch => branch.id == id)
                ?? recoveryNode(props.state.worktreeRecoveries.find(item => recoveryColumnId(item) == id))
                ?? (props.state.comparisons[id] && comparisonNode(id, props.state.comparisons[id], props.graph))
        ).filter(column => column != undefined)
        let unavailable = props.inspection.unavailableSources(props.repositoryId)
        if (columns.length == 0 && unavailable.length == 0) {
            return (
                <section class="column-empty" mix={columnEmpty}>
                    <span mix={columnEmptySpan}>
                        Open a branch
                    </span>
                    <p mix={columnEmptyP}>
                        {props.state.graphCollapsed
                            ? "Show the Branch Graph, select a Branch Node, then use Open or Enter."
                            : "Select a Branch Node, then use Open or Enter."}
                    </p>
                </section>
            )
        }
        let visible = props.state.maximizedBranchId ? columns.filter(column => column.id == props.state.maximizedBranchId) : columns

        return (
            <section class={`branch-columns ${props.state.maximizedBranchId ? "maximized" : ""}`} mix={branchColumns}>
                {visible.map(column => {
                    let worktree = column.kind == "recovery" ? undefined : columnWorktree(column, props.worktreePath(column.id))
                    let collapsed = props.state.collapsedColumnIds.includes(column.id)
                    let width = props.state.widths[column.id] ?? defaultColumnWidth
                    let auxiliary = collapsed || column.kind == "recovery" || worktree?.missing
                        ? null
                        : props.inspection.breakout(props.repositoryId, column.id)
                    // Auxiliary columns join onto their source column's card.
                    let attached = Array.isArray(auxiliary) && auxiliary.length > 0
                    // A maximized column shares the space with its auxiliary columns, split by its own resizable width.
                    let split = !!props.state.maximizedBranchId && attached

                    // A keyed run of siblings rather than a fragment: Remix appends a node added to the end of a fragment after
                    // the parent's last child, which put a newly opened diff column after every other column.

                    return [
                        <article
                            key={column.id}
                            class={`branch-column ${collapsed ? "collapsed" : ""} ${worktree?.missing ? "missing" : ""} ${attached ? "attached" : ""} ${
                                split ? "split" : ""
                            }`}
                            data-column-id={column.id}
                            style={{
                                width: props.state.maximizedBranchId && !split ? "100%" : `${collapsed ? 52 : width}px`,
                            }}
                            tabIndex={-1}
                            mix={[
                                branchColumn,
                                on("focusin", () => props.focus(column.id)),
                                // Captured so arrow keys reach the column before the commit accordion's own triggers.
                                on("keydown", event => {
                                    if (column.kind != "recovery")
                                        props.inspection.navigationKeydown(props.repositoryId, column.id, event)
                                }, true),
                                on("keydown", event => {
                                    if (
                                        column.kind == "branch" && (event.key == "F2" || event.key == "Delete")
                                        && !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select"))
                                    ) {
                                        event.preventDefault()
                                        props.branchAction(column, event.key == "F2" ? "branch-rename" : "branch-delete")
                                        return
                                    }
                                    if (column.kind != "recovery")
                                        props.inspection.filterKeydown(props.repositoryId, column.id, event, handle.update)
                                    if (event.ctrlKey && event.shiftKey && (event.key == "<" || event.key == ">")) {
                                        event.preventDefault()
                                        props.move(column.id, event.key == "<" ? -1 : 1)
                                    }
                                }),
                            ]}
                        >
                            {collapsed
                                ? (
                                    <button
                                        class="expand-column"
                                        type="button"
                                        title={props.worktreePath(column.id) ?? column.name}
                                        aria-label={`Expand ${column.name}`}
                                        mix={[collapsedColumnButton, on("click", () => props.collapse(column.id))]}
                                    >
                                        <span aria-hidden="true" mix={expandColumnIcon}>
                                            <Icon name="collapse-right" size={14} />
                                        </span>
                                        <span>{column.name}</span>
                                        <span>
                                            {column.kind == "recovery"
                                                ? "Recovery required"
                                                : props.inspection.workingSummary(props.repositoryId, column, props.graph, props.worktreePath(column.id))}
                                        </span>
                                    </button>
                                )
                                : (
                                    <>
                                        <header
                                            draggable={!props.state.maximizedBranchId}
                                            title="Drag to reorder · Ctrl+< / Ctrl+>"
                                            mix={[
                                                branchColumnHeader,
                                                on("contextmenu", event => {
                                                    if (column.kind == "branch")
                                                        props.branchMenu(column, event)
                                                }),
                                                // Like a window title bar; the header's own controls keep their double-clicks.
                                                on("dblclick", event => {
                                                    if (
                                                        !(event.target instanceof Element
                                                            && event.target.closest("button, input, select, textarea, a, [role='menu'], dialog"))
                                                    ) {
                                                        props.maximize(column.id)
                                                    }
                                                }),
                                                on("dragstart", event => {
                                                    props.state.draggingColumnId = column.id
                                                    props.state.dragOriginalIds = [...props.state.openedBranchIds]
                                                    event.dataTransfer?.setData("text/plain", column.id)
                                                }),
                                                on("dragover", event => {
                                                    event.preventDefault()
                                                    if (props.state.draggingColumnId)
                                                        props.previewMove(props.state.draggingColumnId, column.id)
                                                }),
                                                on("drop", event => {
                                                    event.preventDefault()
                                                    let source = props.state.draggingColumnId
                                                    if (source)
                                                        props.commitMove(source)
                                                    else {
                                                        let branch = event.dataTransfer?.getData(branchDragType)
                                                        if (branch && column.kind != "recovery" && column.kind != "comparison")
                                                            props.dropBranch(column.id, branch)
                                                    }
                                                }),
                                                on("dragend", () => {
                                                    if (props.state.draggingColumnId && props.state.dragOriginalIds) {
                                                        props.state.openedBranchIds = props.state.dragOriginalIds
                                                        void handle.update()
                                                    }
                                                    props.state.draggingColumnId = undefined
                                                    props.state.dragOriginalIds = undefined
                                                }),
                                            ]}
                                        >
                                            <button
                                                type="button"
                                                title="Collapse column"
                                                aria-label={`Collapse ${column.name}`}
                                                mix={[columnCollapseButton, on("click", () => props.collapse(column.id))]}
                                            >
                                                <Icon name="collapse-left" size={15} />
                                            </button>
                                            {(() => {
                                                let identity = columnIdentity(column, props.worktreePath(column.id))
                                                return (
                                                    <span class="column-kind" title={identity.kind} mix={[columnKindIcon, identity.tone]}>
                                                        <Icon name={identity.icon} size={17} />
                                                    </span>
                                                )
                                            })()}
                                            {(column.kind == "recovery" || !props.worktreePath(column.id)) && (
                                                <h2 title={column.name} mix={branchColumnH2}>
                                                    {column.name}
                                                </h2>
                                            )}
                                            {column.kind != "recovery" && column.kind != "comparison" && props.worktreeControls(column)}
                                            <div mix={branchColumnActions}>
                                                {column.kind == "comparison" && props.inspection.diffColumnControl(props.repositoryId, column, props.graph)}
                                                {column.kind != "recovery"
                                                    && props.inspection.conflictFilter(props.repositoryId, column, props.graph, props.worktreePath(column.id))}
                                                {column.kind != "recovery" && props.inspection.filterControl(
                                                    props.repositoryId,
                                                    column,
                                                    props.graph,
                                                    handle.update,
                                                    props.worktreePath(column.id),
                                                )}
                                                <button
                                                    type="button"
                                                    title={props.state.maximizedBranchId ? "Restore columns" : "Maximize column"}
                                                    aria-label={props.state.maximizedBranchId ? "Restore columns" : "Maximize column"}
                                                    mix={[branchColumnButton, on("click", () => props.maximize(column.id))]}
                                                >
                                                    <Icon name={props.state.maximizedBranchId ? "restore" : "maximize"} size={15} />
                                                </button>
                                                {!props.worktreePath(column.id) && (
                                                    <button
                                                        type="button"
                                                        title="Close column"
                                                        aria-label="Close column"
                                                        mix={[branchColumnButton, on("click", () => props.close(column.id))]}
                                                    >
                                                        <Icon name="close" size={15} />
                                                    </button>
                                                )}
                                            </div>
                                        </header>
                                        {column.kind != "recovery" && column.kind != "comparison" && worktree?.missing
                                            && props.missingWorktreeControls(column, worktree)}
                                        {column.kind == "recovery"
                                            ? (
                                                <WorktreeRecoveryPanel
                                                    recovery={column.recovery}
                                                    busy={Boolean(props.state.recoveryBusy)}
                                                    error={props.state.recoveryErrors[column.recovery.operationId]}
                                                    resolve={action => props.recover(column.recovery, action)}
                                                />
                                            )
                                            : props.inspection.body(
                                                props.repositoryId,
                                                column,
                                                props.graph,
                                                props.worktreePath(column.id),
                                                column.kind == "branch" && !worktree?.missing
                                                    ? props.conflicts.controls(props.repositoryId, column, props.worktreePath(column.id))
                                                    : undefined,
                                            )}
                                    </>
                                )}
                        </article>,
                        !collapsed && (!props.state.maximizedBranchId || split) && (
                            <ColumnDivider key={`${column.id}:divider`} branchId={column.id} width={width} attached={attached} resize={props.resize} />
                        ),
                        auxiliary,
                    ]
                })}
                {unavailable.map(id => props.inspection.breakout(props.repositoryId, id))}
            </section>
        )
    }
}

function ColumnDivider(handle: Handle<{ branchId: string; width: number; attached: boolean; resize(branchId: string, width: number): void }>) {
    // Sizes the column ahead of the resize and returns its new width. A split column is capped to keep its auxiliary
    // columns in view, so its width is read back rather than assumed.
    let applyWidth = (divider: HTMLElement, width: number) => {
        let column = divider.previousElementSibling as HTMLElement | null
        width = Math.max(310, width)
        if (column)
            column.style.width = `${width}px`

        return column?.classList.contains("split") ? column.getBoundingClientRect().width : width
    }
    return () => (
        <div
            class={`column-divider ${handle.props.attached ? "attached" : ""}`}
            role="separator"
            tabIndex={0}
            aria-label="Resize branch column"
            aria-orientation="vertical"
            aria-valuemin={310}
            aria-valuemax={2000}
            aria-valuenow={Math.round(handle.props.width)}
            mix={[
                columnDivider,
                on("keydown", event => {
                    let step = event.shiftKey ? 50 : 10
                    let width = event.key == "ArrowLeft" || event.key == "ArrowRight"
                        ? handle.props.width + (event.key == "ArrowLeft" ? -step : step)
                        : event.key == "Home"
                        ? 310
                        : event.key == "End"
                        ? document.querySelector<HTMLElement>(".graph-layout")?.clientWidth ?? 1180
                        : undefined
                    if (width != undefined) {
                        event.preventDefault()
                        handle.props.resize(handle.props.branchId, applyWidth(event.currentTarget, width))
                    }
                }),
                on("pointerdown", event => {
                    event.preventDefault()
                    let startX = event.clientX
                    let startWidth = handle.props.width
                    let divider = event.currentTarget
                    let move = (next: PointerEvent) => applyWidth(divider, startWidth + next.clientX - startX)
                    let end = (next: PointerEvent) => {
                        window.removeEventListener("pointermove", move)
                        window.removeEventListener("pointerup", end)
                        handle.props.resize(handle.props.branchId, applyWidth(divider, startWidth + next.clientX - startX))
                    }
                    window.addEventListener("pointermove", move)
                    window.addEventListener("pointerup", end, { once: true })
                }),
                on("dblclick", event => handle.props.resize(handle.props.branchId, applyWidth(event.currentTarget, defaultColumnWidth))),
            ]}
        >
        </div>
    )
}

export function recoveryNode(recovery?: WorktreeRecovery): RecoveryColumnNode | undefined {
    return recovery && { kind: "recovery", id: recoveryColumnId(recovery), name: baseName(recovery.path), recovery }
}

// What a column *is* drives its icon (and the icon's tooltip); the name is the worktree or branch.
export function columnIdentity(column: ColumnNode | RecoveryColumnNode, worktreePath: string | undefined) {
    if (column.kind == "recovery")
        return { icon: "warning" as const, kind: "Worktree recovery", name: column.name, tone: toneWarning }
    if (column.kind == "comparison")
        return { icon: "compare" as const, kind: column.description, name: column.name, tone: toneComparison }

    let worktree = columnWorktree(column, worktreePath)
    if (worktree) {
        return worktree.main
            ? { icon: "folder" as const, kind: "Main worktree", name: worktree.name, tone: toneMain }
            : { icon: "folder" as const, kind: column.kind == "virtual" ? "Virtual worktree" : "Worktree", name: worktree.name, tone: toneWorktree }
    }

    return {
        icon: "branch" as const,
        kind: column.kind == "branch" ? column.remoteOnly ? "Remote branch" : "Branch" : "Virtual branch",
        name: column.name,
        tone: toneBranch,
    }
}
