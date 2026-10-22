import type { BranchGraph, FileListView, WorktreeRecovery, WorktreeRequest } from "@laneway/shared"
import clsx from "clsx"
import { type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, useEffect, useMemo, useRef } from "react"
import { Button as AriaButton, ToggleButton, useDrop } from "react-aria-components"
import type { AppController } from "./app-controller"
import { defaultAuxiliaryColumnWidth } from "./auxiliary-columns"
import { branchDragType } from "./branch-graph"
import { type BranchWorkspace, type ColumnsSnapshot, type ColumnView, defaultColumnWidth, minimumColumnWidth, workingSummary } from "./branch-workspace"
import { ColumnBody, columnRoot, ColumnScopes } from "./column-body"
import { columnDropTarget, columnSpans } from "./column-drag"
import { ColumnFilter } from "./column-filter"
import { navigationKeyDown } from "./column-navigation"
import { Hint, IconButton } from "./controls"
import { DiffColumn, minimumDiffColumnWidth } from "./diff-column"
import { CommitDiffColumn, FileHistoryColumn } from "./file-history"
import { BranchIcon, CloseIcon, CollapseColumnIcon, CompareIcon, ExpandColumnIcon, FolderIcon, MaximizeIcon, OpenColumnIcon, RestoreIcon, SearchIcon, WarningIcon } from "./icons"
import type { AuxiliaryView, InspectionSnapshot } from "./inspection"
import { Button } from "./ui/Button"
import { Tab, TabList, Tabs } from "./ui/Tabs"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot } from "./use-snapshot"
import { workspaceGraph } from "./worktree-columns"
import { MissingWorktree, WorktreeMenu, WorktreeTitle } from "./worktree-controls"

// Polls together with window focus: a hidden or unfocused window waits.
let pollInterval = 5_000

/** The active repository's Workspace Columns, side by side, each resizable, collapsible, and movable. */
export function WorkspaceColumns({ controller, fileListView }: { controller: AppController; fileListView: FileListView }) {
    let { columns, inspection } = controller
    let snapshot = useSnapshot(columns)
    let inspected = useSnapshot(inspection)
    let dragging = useRef<{ id: string; dropped: boolean }>(undefined)
    let graph = useMemo(() => snapshot.graph && workspaceGraph(snapshot.graph), [snapshot.graph])
    let current = inspected.repositoryId == snapshot.repositoryId ? inspected : undefined
    useRefreshes(columns)
    useUndo(controller, snapshot.repositoryId)
    useReveal(snapshot.revealed)
    useAuxiliaryFocus(current?.focused)

    // Escape restores a maximized column's neighbours.
    useEffect(() => {
        if (!snapshot.maximizedId)
            return
        let restore = (event: globalThis.KeyboardEvent) => {
            if (event.key == "Escape" && !event.defaultPrevented)
                columns.restore()
        }
        window.addEventListener("keydown", restore)
        return () => window.removeEventListener("keydown", restore)
    }, [columns, snapshot.maximizedId])

    if (snapshot.loading && !snapshot.graph)
        return <div className="columns-progress" role="progressbar" aria-label="Loading repository" />
    if (snapshot.error && !snapshot.graph) {
        return (
            <section className="columns-message" role="alert">
                <p>{snapshot.error}</p>
                <Button variant="secondary" onPress={() => void columns.refresh(false)}>Retry</Button>
            </section>
        )
    }
    if (snapshot.columns.length == 0) {
        return (
            <section className="columns-message">
                <strong>Open a branch</strong>
                <p>Select a Branch Node, then use Open or Enter.</p>
            </section>
        )
    }

    let visible = snapshot.maximizedId ? snapshot.columns.filter(column => column.id == snapshot.maximizedId) : snapshot.columns
    let header = {
        start(column: ColumnView, event: DragEvent) {
            dragging.current = { id: column.id, dropped: false }
            event.dataTransfer.effectAllowed = "move"
            event.dataTransfer.setData("text/plain", column.id)
        },
        end() {
            if (dragging.current && !dragging.current.dropped)
                columns.cancelDrag()
            dragging.current = undefined
        },
    }
    // A dragged column moves as the pointer crosses the row, and drops anywhere on it. The row takes the drag
    // before anything inside it, so drop targets within the columns, such as a header's branch drop, never see it.
    let rowDrag = (event: DragEvent<HTMLElement>) => {
        if (!dragging.current)
            return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = "move"
        let target = event.type == "dragover" && columnDropTarget(columnSpans(event.currentTarget), dragging.current.id, event.clientX)
        if (target)
            columns.dragOver(dragging.current.id, target)
    }
    let rowDrop = (event: DragEvent) => {
        if (!dragging.current)
            return
        event.preventDefault()
        event.stopPropagation()
        dragging.current.dropped = true
        columns.drop(dragging.current.id)
    }
    return (
        <section
            className={clsx("column-row", snapshot.maximizedId && "maximized")}
            onDragEnterCapture={rowDrag}
            onDragOverCapture={rowDrag}
            onDropCapture={rowDrop}
        >
            {visible.flatMap(column => {
                // A collapsed column hides its auxiliary columns, and a column without its files has none to show.
                let auxiliary = column.collapsed || column.kind == "recovery" || column.worktree?.missing ? [] : current?.auxiliary[column.id] ?? []
                let attached = auxiliary.length > 0
                // A maximized column shares the window with its auxiliary columns, split at its own width.
                let split = snapshot.maximizedId != undefined && attached
                return [
                    <ColumnFrame
                        key={column.id}
                        column={column}
                        snapshot={snapshot}
                        inspected={current}
                        graph={graph!}
                        controller={controller}
                        fileListView={fileListView}
                        header={header}
                        attached={attached}
                        split={split}
                    />,
                    !column.collapsed && (!snapshot.maximizedId || split) && (
                        <ColumnDivider
                            key={`${column.id}:divider`}
                            label="Resize branch column"
                            width={column.width}
                            minimum={minimumColumnWidth}
                            defaultWidth={defaultColumnWidth}
                            attached={attached}
                            onResize={width => columns.resize(column.id, width)}
                        />
                    ),
                    ...auxiliary.flatMap((view, index) => {
                        // The last one beside a maximized column takes the space the others leave.
                        let last = index == auxiliary.length - 1
                        return [
                            <AuxiliaryFrame
                                key={view.id}
                                view={view}
                                column={column}
                                inspected={current}
                                graph={graph!}
                                controller={controller}
                                fileListView={fileListView}
                                maximized={snapshot.maximizedId == column.id}
                            />,
                            !(snapshot.maximizedId && last) && (
                                <ColumnDivider
                                    key={`${view.id}:divider`}
                                    label="Resize auxiliary column"
                                    width={view.width}
                                    minimum={view.kind == "diff" ? minimumDiffColumnWidth : minimumColumnWidth}
                                    defaultWidth={defaultAuxiliaryColumnWidth}
                                    attached={!last}
                                    onResize={width => controller.inspection.resizeAuxiliary(view.id, width)}
                                />
                            ),
                        ]
                    }),
                ]
            })}
        </section>
    )
}

interface HeaderDrag {
    start(column: ColumnView, event: DragEvent): void
    end(): void
}

function ColumnFrame({ column, snapshot, inspected, graph, controller, fileListView, header, attached, split }: {
    column: ColumnView
    snapshot: ColumnsSnapshot
    /** The active repository's files, once the inspection has them. */
    inspected?: InspectionSnapshot
    /** The Branch Graph with each local branch as its own node, as the columns show them. */
    graph: BranchGraph
    controller: AppController
    fileListView: FileListView
    header: HeaderDrag
    /** Whether auxiliary columns join onto its card. */
    attached: boolean
    /** Whether it is maximized beside its auxiliary columns, keeping its own width. */
    split: boolean
}) {
    let { columns } = controller
    let worktreeBusy = useSnapshot(controller.worktrees).busy
    let busy = snapshot.busy || worktreeBusy
    let prepare = (request: WorktreeRequest) => void controller.worktrees.prepare(snapshot.repositoryId!, request, column.id)
    let files = inspected?.columns[column.id]
    let maximized = snapshot.maximizedId == column.id
    let headerRef = useRef<HTMLElement>(null)
    // A branch dragged from the Branch Graph onto a worktree column's header switches that worktree to it, unless
    // it is in a Historical Edit.
    let switchable = column.kind != "recovery" && column.kind != "comparison" && column.worktree != undefined && !column.worktree.missing
        && !column.worktree.historicalEdit
    let { dropProps, isDropTarget } = useDrop({
        ref: headerRef,
        isDisabled: !switchable,
        getDropOperation: types => types.has(branchDragType) ? "move" : "cancel",
        async onDrop(event) {
            let item = event.items.find(candidate => candidate.kind == "text" && candidate.types.has(branchDragType))
            if (item?.kind == "text" && column.worktree)
                prepare({ action: "switch", path: column.worktree.path, branch: await item.getText(branchDragType), move: true })
        },
    })
    let filterButton = useRef<HTMLButtonElement>(null)
    let filterInput = useRef<HTMLInputElement>(null)
    let filterable = column.kind != "recovery"
    // A filter that is already open takes focus again; a new one focuses its field as it shows.
    let openFilter = () => {
        controller.inspection.openFilter(column.id)
        filterInput.current?.focus()
    }
    let closeFilter = () => {
        controller.inspection.closeFilter(column.id)
        filterButton.current?.focus({ preventScroll: true })
    }
    // F2 renames a branch column's branch and Delete deletes it, from anywhere in the column but a field.
    // Ctrl+Shift+< and > move the column; it keeps focus in its new place. Ctrl+F filters its files and Escape
    // closes the filter.
    let keyDown = (event: KeyboardEvent) => {
        let editing = event.target instanceof HTMLElement && event.target.closest("input, textarea, select")
        if (filterable && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() == "f") {
            event.preventDefault()
            event.stopPropagation()
            openFilter()
            return
        }
        if (event.key == "Escape" && files?.filter && !event.defaultPrevented) {
            event.preventDefault()
            event.stopPropagation()
            closeFilter()
            return
        }
        if (column.kind == "branch" && (event.key == "F2" || event.key == "Delete") && !editing && !event.defaultPrevented) {
            event.preventDefault()
            if (event.key == "F2" && column.branch.localRefs.length > 0)
                controller.branches.rename(snapshot.repositoryId!, column.branch)
            else if (event.key == "Delete" && column.branch.localRefs.length > 0)
                void controller.branches.delete(snapshot.repositoryId!, column.branch)
            return
        }
        if (!event.ctrlKey || !event.shiftKey || (event.key != "<" && event.key != ">"))
            return
        event.preventDefault()
        columns.move(column.id, event.key == "<" ? -1 : 1)
        requestAnimationFrame(() => {
            let element = columnElement(column.id)
            element?.focus({ preventScroll: true })
            element?.scrollIntoView({ block: "nearest", inline: "nearest" })
        })
    }
    // Like a window's title bar, a double-click maximizes; the header's own controls keep theirs.
    let toggleMaximized = (event: MouseEvent) => {
        if (!(event.target instanceof Element && event.target.closest("button, input, select, textarea, a, [role=menu]")))
            columns.toggleMaximized(column.id)
    }
    return (
        <article
            className={clsx("column", column.collapsed && "collapsed", column.worktree?.missing && "missing", attached && "attached", split && "split")}
            data-column-id={column.id}
            aria-label={column.name}
            tabIndex={-1}
            style={column.collapsed || maximized && !split ? undefined : { width: column.width }}
            onFocus={() => columns.focus(column.id)}
            onKeyDown={keyDown}
            onKeyDownCapture={event => filterable && navigationKeyDown(event, files?.diffColumn != undefined)}
        >
            {column.collapsed
                ? (
                    <Hint text={column.worktree?.path ?? column.name} placement="end">
                        <button type="button" className="expand-column" aria-label={`Expand ${column.name}`} onClick={() => columns.toggleCollapsed(column.id)}>
                            <ExpandColumnIcon className="expand-column-icon" />
                            <span className="expand-column-name">{column.name}</span>
                            <span className="expand-column-summary">{workingSummary(column, files)}</span>
                        </button>
                    </Hint>
                )
                : (
                    <>
                        <Hint text="Drag to reorder · Ctrl+Shift+< / >">
                            <header
                                {...dropProps}
                                ref={headerRef}
                                className="column-header"
                                data-drop-target={isDropTarget || undefined}
                                draggable={!snapshot.maximizedId}
                                onDoubleClick={toggleMaximized}
                                onDragStart={event => header.start(column, event)}
                                onDragEnd={header.end}
                            >
                                <IconButton className="column-collapse" label={`Collapse ${column.name}`} onPress={() => columns.toggleCollapsed(column.id)}>
                                    <CollapseColumnIcon />
                                </IconButton>
                                <ColumnKind column={column} />
                                {column.worktree && column.kind != "recovery"
                                    ? <WorktreeTitle worktree={column.worktree} busy={busy} onPrepare={prepare} />
                                    : (
                                        <div className="column-title">
                                            <h2 className="column-name">{column.name}</h2>
                                        </div>
                                    )}
                                <div className="column-actions" data-controls>
                                    {column.kind == "branch" && (column.branch.unresolved || files?.conflictsOnly) && (
                                        <TooltipTrigger>
                                            <ToggleButton
                                                className="icon-button conflicts-only"
                                                aria-label="Show only conflicted commits"
                                                isSelected={files?.conflictsOnly == true}
                                                onChange={selected => controller.inspection.setConflictsOnly(column.id, selected)}
                                            >
                                                <WarningIcon />
                                            </ToggleButton>
                                            <Tooltip>Show only conflicted commits</Tooltip>
                                        </TooltipTrigger>
                                    )}
                                    {filterable && (
                                        <TooltipTrigger>
                                            <AriaButton
                                                ref={filterButton}
                                                className="icon-button"
                                                aria-label="Filter files"
                                                aria-expanded={files?.filter != undefined}
                                                onPress={openFilter}
                                            >
                                                <SearchIcon />
                                            </AriaButton>
                                            <Tooltip>Filter files (Ctrl+F)</Tooltip>
                                        </TooltipTrigger>
                                    )}
                                    {(column.kind == "branch" || column.kind == "virtual") && (
                                        <WorktreeMenu
                                            column={column}
                                            graph={graph}
                                            busy={busy}
                                            onPrepare={prepare}
                                            chooseDirectory={controller.chooseDirectory}
                                            onShowCommitAges={shown => void controller.setShowCommitAges(shown)}
                                        />
                                    )}
                                    {column.kind == "comparison" && (
                                        // Mirrors Working Changes' control: it opens the comparison's whole diff, or focuses it.
                                        <TooltipTrigger>
                                            <ToggleButton
                                                className="icon-button"
                                                aria-label="Open diff column"
                                                isSelected={files?.diffColumn != undefined}
                                                isDisabled={!files?.files.comparison?.inventory?.files.some(file => !file.ignored)}
                                                onChange={() => controller.inspection.openDiffColumn(column.id, "comparison")}
                                            >
                                                <OpenColumnIcon />
                                            </ToggleButton>
                                            <Tooltip>Open diff column</Tooltip>
                                        </TooltipTrigger>
                                    )}
                                    <IconButton
                                        label={snapshot.maximizedId ? "Restore columns" : "Maximize column"}
                                        onPress={() => columns.toggleMaximized(column.id)}
                                    >
                                        {snapshot.maximizedId ? <RestoreIcon /> : <MaximizeIcon />}
                                    </IconButton>
                                    {!column.worktree && column.kind != "recovery" && (
                                        <IconButton label="Close column" onPress={() => columns.close(column.id)}>
                                            <CloseIcon />
                                        </IconButton>
                                    )}
                                </div>
                            </header>
                        </Hint>
                        {filterable && files?.filter && (
                            <ColumnFilter
                                filter={files.filter}
                                inputRef={filterInput}
                                onChange={filter => controller.inspection.setFilter(column.id, filter)}
                                onClose={closeFilter}
                            />
                        )}
                        {column.worktree?.missing && column.kind != "recovery" && (
                            <MissingWorktree worktree={column.worktree} busy={busy} onPrepare={prepare} chooseDirectory={controller.chooseDirectory} />
                        )}
                        {column.kind == "recovery"
                            ? (
                                <RecoveryPanel
                                    recovery={column.recovery}
                                    busy={snapshot.recoveryBusy != undefined}
                                    error={snapshot.recoveryErrors[column.recovery.operationId]}
                                    onResolve={action => void columns.recover(column.recovery, action)}
                                />
                            )
                            : (
                                <ColumnBody
                                    controller={controller}
                                    repositoryId={snapshot.repositoryId!}
                                    graph={graph}
                                    column={column}
                                    inspected={files}
                                    blocked={snapshot.blocked}
                                    view={fileListView}
                                    onViewChange={view => void controller.setFileListView(view)}
                                />
                            )}
                    </>
                )}
        </article>
    )
}

/** The column's kind as an icon: a worktree's folder, a branch, a recovery, or a comparison. */
export function ColumnKind({ column }: { column: ColumnView }) {
    let Icon = column.identity == "branch"
        ? BranchIcon
        : column.identity == "recovery"
        ? WarningIcon
        : column.identity == "comparison"
        ? CompareIcon
        : FolderIcon
    return (
        <Hint text={column.description}>
            <span className="column-kind" data-identity={column.identity}>
                <Icon />
            </span>
        </Hint>
    )
}

/** The header's tabs: one per open column, the focused one selected; choosing one brings its column into view. */
export function ColumnTabs({ columns }: { columns: BranchWorkspace }) {
    let snapshot = useSnapshot(columns)
    if (snapshot.columns.length == 0 || !snapshot.focusedId)
        return null
    let show = (id: string) => {
        columns.focus(id)
        let element = columnElement(id)
        element?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })
        ;(element?.querySelector<HTMLElement>(".expand-column") ?? element)?.focus({ preventScroll: true })
    }
    // Arrow keys move between tabs; Enter or a click shows the column, which takes focus.
    return (
        <Tabs aria-label="Open columns" keyboardActivation="manual" selectedKey={snapshot.focusedId} onSelectionChange={key => show(String(key))}>
            <TabList aria-label="Open columns" className="react-aria-TabList column-tabs">
                {snapshot.columns.map(column => (
                    <Tab key={column.id} id={column.id} className={clsx("react-aria-Tab column-tab", column.collapsed && "collapsed")}>
                        <ColumnKind column={column} />
                        <span className="column-tab-name">{column.name}</span>
                    </Tab>
                ))}
            </TabList>
        </Tabs>
    )
}

/** An auxiliary column beside the Workspace Column it descends from, sharing that column's scopes. */
function AuxiliaryFrame({ view, column, inspected, graph, controller, fileListView, maximized }: {
    view: AuxiliaryView
    column: ColumnView
    inspected?: InspectionSnapshot
    graph: BranchGraph
    controller: AppController
    fileListView: FileListView
    maximized: boolean
}) {
    let stacked = column.worktree != undefined && column.kind != "recovery"
    let root = columnRoot(column)
    let { inspection } = controller
    // Closing it returns focus to the column it was opened from.
    let returnFocus = () =>
        requestAnimationFrame(() => {
            let source = document.querySelector<HTMLElement>(`[data-auxiliary-id="${view.sourceId}"]`) ?? columnElement(view.sourceId)
            source?.focus({ preventScroll: true })
        })
    return (
        <ColumnScopes controller={controller} repositoryId={inspected?.repositoryId ?? ""} graph={graph} column={column}>
            {view.kind == "diff"
                ? (
                    <DiffColumn
                        view={view}
                        sourceName={column.name}
                        stacked={stacked}
                        inspected={inspected?.columns[column.id]}
                        listView={fileListView}
                        inspection={inspection}
                        root={root}
                        maximized={maximized}
                        onMaximize={() => controller.columns.toggleMaximized(column.id)}
                        onClose={returnFocus}
                    />
                )
                : view.kind == "history"
                ? (
                    <FileHistoryColumn
                        history={view}
                        inspection={inspection}
                        view={fileListView}
                        root={view.source.kind == "worktree" ? view.source.worktreePath : root}
                        stacked={stacked}
                        onClose={returnFocus}
                    />
                )
                : <CommitDiffColumn commit={view} inspection={inspection} view={fileListView} root={root} stacked={stacked} onClose={returnFocus} />}
        </ColumnScopes>
    )
}

/** Resizes the column before it by dragging or the keyboard, and back to its default width on a double-click. */
function ColumnDivider({ label, width, minimum, defaultWidth, attached, onResize }: {
    label: string
    width: number
    minimum: number
    defaultWidth: number
    /** Whether it is the seam between a column and an auxiliary column joined onto its card. */
    attached: boolean
    onResize(width: number): void
}) {
    let divider = useRef<HTMLDivElement>(null)
    // A drag sizes the column directly as it goes; the width saves once it ends.
    let size = (next: number) => {
        let clamped = Math.max(minimum, Math.round(next))
        let element = divider.current?.previousElementSibling
        if (element instanceof HTMLElement)
            element.style.width = `${clamped}px`
        return clamped
    }
    let keyDown = (event: KeyboardEvent) => {
        let step = event.shiftKey ? 50 : 10
        let next = event.key == "ArrowLeft" || event.key == "ArrowRight"
            ? width + (event.key == "ArrowLeft" ? -step : step)
            : event.key == "Home"
            ? minimum
            : event.key == "End"
            ? divider.current?.parentElement?.clientWidth ?? defaultWidth
            : undefined
        if (next != undefined) {
            event.preventDefault()
            onResize(size(next))
        }
    }
    let pointerDown = (event: PointerEvent) => {
        event.preventDefault()
        let startX = event.clientX
        let move = (next: globalThis.PointerEvent) => size(width + next.clientX - startX)
        let end = (next: globalThis.PointerEvent) => {
            window.removeEventListener("pointermove", move)
            onResize(size(width + next.clientX - startX))
        }
        window.addEventListener("pointermove", move)
        window.addEventListener("pointerup", end, { once: true })
    }
    return (
        <div
            ref={divider}
            className={clsx("column-divider", attached && "attached")}
            role="separator"
            tabIndex={0}
            aria-label={label}
            aria-orientation="vertical"
            aria-valuemin={minimum}
            aria-valuemax={2000}
            aria-valuenow={width}
            onKeyDown={keyDown}
            onPointerDown={pointerDown}
            onDoubleClick={() => onResize(size(defaultWidth))}
        />
    )
}

function RecoveryPanel({ recovery, busy, error, onResolve }: {
    recovery: WorktreeRecovery
    busy: boolean
    error?: string
    onResolve(action: "restore" | "remove"): void
}) {
    return (
        <section className="worktree-recovery" aria-label="Worktree recovery">
            <h3>Worktree removal interrupted</h3>
            <p>{recovery.message}</p>
            <p className="recovery-path">{recovery.path}</p>
            <div className="recovery-actions">
                <Button variant="accent" isDisabled={busy} onPress={() => onResolve("restore")}>Recover</Button>
                <Button variant="secondary" isDisabled={busy} onPress={() => onResolve("remove")}>Remove</Button>
            </div>
            <p className="recovery-help">Recover restores the saved worktree and backs up leftover files.</p>
            <p className="recovery-help">Remove deletes leftover files and keeps only the saved Git state for Undo.</p>
            {busy && <p role="status">Resolving worktree removal…</p>}
            {error && <p className="recovery-error" role="alert">{error}</p>}
            <details>
                <summary>Details</summary>
                <p>Operation: {recovery.operationId}</p>
                {recovery.backupPath && <p>Files preserved at: {recovery.backupPath}</p>}
            </details>
        </section>
    )
}

// A column an operation opened, such as a newly created branch's, comes into view with focus once it shows,
// after any dialog that opened it has returned focus.
function useReveal(revealed?: { id: string; serial: number }) {
    useEffect(() => {
        if (!revealed)
            return
        let frame = requestAnimationFrame(() => {
            let element = columnElement(revealed.id)
            element?.focus({ preventScroll: true })
            element?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })
        })
        return () => cancelAnimationFrame(frame)
    }, [revealed])
}

// An auxiliary column that opens, or is asked for again, takes focus once it shows, after any menu that opened it
// has returned focus to its trigger.
function useAuxiliaryFocus(focused?: { id: string; serial: number }) {
    useEffect(() => {
        if (!focused)
            return
        let frame = requestAnimationFrame(() => {
            let element = document.querySelector<HTMLElement>(`[data-auxiliary-id="${focused.id}"]`)
            element?.focus({ preventScroll: true })
            element?.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" })
        })
        return () => cancelAnimationFrame(frame)
    }, [focused])
}

// Ctrl+Z undoes and Ctrl+Y or Ctrl+Shift+Z redoes the latest operation; a discard still showing its Undo notice
// takes Ctrl+Z first. Fields keep the keys for their own text.
function useUndo(controller: AppController, repositoryId?: string) {
    useEffect(() => {
        let undo = (event: globalThis.KeyboardEvent) => {
            let key = event.key.toLowerCase()
            if (!repositoryId || event.defaultPrevented || !event.ctrlKey || event.altKey || (key != "z" && key != "y"))
                return
            if (event.composedPath().some(node => node instanceof HTMLElement && node.matches("input, textarea, select, [contenteditable=true]")))
                return
            event.preventDefault()
            let redo = event.shiftKey || key == "y"
            if (!redo && controller.inspection.undoDiscard())
                return
            void controller.worktrees.transition(repositoryId, redo ? "redo" : "undo")
        }
        window.addEventListener("keydown", undo)
        return () => window.removeEventListener("keydown", undo)
    }, [controller, repositoryId])
}

function useRefreshes(columns: BranchWorkspace) {
    useEffect(() => {
        let refresh = () => void columns.refresh()
        let poll = window.setInterval(() => {
            if (document.visibilityState == "visible" && document.hasFocus())
                refresh()
        }, pollInterval)
        window.addEventListener("focus", refresh)
        return () => {
            window.clearInterval(poll)
            window.removeEventListener("focus", refresh)
        }
    }, [columns])
}

function columnElement(id: string) {
    return [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(element => element.dataset.columnId == id)
}
