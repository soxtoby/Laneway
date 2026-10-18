/** @jsxImportSource react */
import type { FileListView, WorktreeRecovery } from "@laneway/shared"
import clsx from "clsx"
import { type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, useEffect, useRef } from "react"
import type { AppController } from "./app-controller"
import { type BranchWorkspace, type ColumnsSnapshot, type ColumnView, defaultColumnWidth, minimumColumnWidth, workingSummary } from "./branch-workspace"
import { ColumnBody } from "./column-body"
import { IconButton } from "./controls"
import { BranchIcon, CloseIcon, CollapseColumnIcon, CompareIcon, ExpandColumnIcon, FolderIcon, MaximizeIcon, RestoreIcon, WarningIcon } from "./icons"
import type { Inspection, InspectionSnapshot } from "./inspection"
import { Button } from "./ui/Button"
import { Tab, TabList, Tabs } from "./ui/Tabs"
import { useSnapshot } from "./use-snapshot"

// Polls together with window focus, as the Remix renderer does: a hidden or unfocused window waits.
let pollInterval = 5_000

/** The active repository's Workspace Columns, side by side, each resizable, collapsible, and movable. */
export function WorkspaceColumns({ controller, fileListView }: { controller: AppController; fileListView: FileListView }) {
    let { columns, inspection } = controller
    let snapshot = useSnapshot(columns)
    let inspected = useSnapshot(inspection)
    let dragging = useRef<{ id: string; dropped: boolean }>(undefined)
    useRefreshes(columns)
    useDiscardUndo(inspection)

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
        over(column: ColumnView, event: DragEvent) {
            if (!dragging.current)
                return
            event.preventDefault()
            columns.dragOver(dragging.current.id, column.id)
        },
        drop(event: DragEvent) {
            if (!dragging.current)
                return
            event.preventDefault()
            dragging.current.dropped = true
            columns.drop(dragging.current.id)
        },
        end() {
            if (dragging.current && !dragging.current.dropped)
                columns.cancelDrag()
            dragging.current = undefined
        },
    }
    return (
        <section className={clsx("column-row", snapshot.maximizedId && "maximized")}>
            {visible.flatMap(
                column => [
                    <ColumnFrame
                        key={column.id}
                        column={column}
                        snapshot={snapshot}
                        inspected={inspected.repositoryId == snapshot.repositoryId ? inspected : undefined}
                        controller={controller}
                        fileListView={fileListView}
                        header={header}
                    />,
                    !column.collapsed && !snapshot.maximizedId && (
                        <ColumnDivider
                            key={`${column.id}:divider`}
                            column={column}
                            onResize={width => columns.resize(column.id, width)}
                        />
                    ),
                ],
            )}
        </section>
    )
}

interface HeaderDrag {
    start(column: ColumnView, event: DragEvent): void
    over(column: ColumnView, event: DragEvent): void
    drop(event: DragEvent): void
    end(): void
}

function ColumnFrame({ column, snapshot, inspected, controller, fileListView, header }: {
    column: ColumnView
    snapshot: ColumnsSnapshot
    /** The active repository's files, once the inspection has them. */
    inspected?: InspectionSnapshot
    controller: AppController
    fileListView: FileListView
    header: HeaderDrag
}) {
    let { columns } = controller
    let files = inspected?.columns[column.id]
    let maximized = snapshot.maximizedId == column.id
    // Ctrl+Shift+< and > move the column; it keeps focus in its new place.
    let move = (event: KeyboardEvent) => {
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
            className={clsx("column", column.collapsed && "collapsed", column.worktree?.missing && "missing")}
            data-column-id={column.id}
            aria-label={column.name}
            tabIndex={-1}
            style={column.collapsed || maximized ? undefined : { width: column.width }}
            onFocus={() => columns.focus(column.id)}
            onKeyDown={move}
        >
            {column.collapsed
                ? (
                    <button
                        type="button"
                        className="expand-column"
                        title={column.worktree?.path ?? column.name}
                        aria-label={`Expand ${column.name}`}
                        onClick={() => columns.toggleCollapsed(column.id)}
                    >
                        <ExpandColumnIcon className="expand-column-icon" />
                        <span className="expand-column-name">{column.name}</span>
                        <span className="expand-column-summary">{workingSummary(column, files)}</span>
                    </button>
                )
                : (
                    <>
                        <header
                            className="column-header"
                            draggable={!snapshot.maximizedId}
                            title="Drag to reorder · Ctrl+Shift+< / >"
                            onDoubleClick={toggleMaximized}
                            onDragStart={event => header.start(column, event)}
                            onDragOver={event => header.over(column, event)}
                            onDrop={header.drop}
                            onDragEnd={header.end}
                        >
                            <IconButton label={`Collapse ${column.name}`} onPress={() => columns.toggleCollapsed(column.id)}>
                                <CollapseColumnIcon />
                            </IconButton>
                            <ColumnKind column={column} />
                            <div className="column-title">
                                <h2 className="column-name">{column.name}</h2>
                                {column.worktree && <span className="column-path">{column.worktree.path}</span>}
                            </div>
                            <IconButton label={snapshot.maximizedId ? "Restore columns" : "Maximize column"} onPress={() => columns.toggleMaximized(column.id)}>
                                {snapshot.maximizedId ? <RestoreIcon /> : <MaximizeIcon />}
                            </IconButton>
                            {!column.worktree && column.kind != "recovery" && (
                                <IconButton label="Close column" onPress={() => columns.close(column.id)}>
                                    <CloseIcon />
                                </IconButton>
                            )}
                        </header>
                        {column.worktree?.missing && <MissingWorktree path={column.worktree.path} />}
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
                                    column={column}
                                    contents={snapshot.contents[column.id]}
                                    inspected={files}
                                    inspection={controller.inspection}
                                    createComposer={path => controller.composer(snapshot.repositoryId!, column.id, path, snapshot.blocked)}
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
        <span className="column-kind" data-identity={column.identity} title={column.description}>
            <Icon />
        </span>
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

/** Resizes the column before it by dragging or the keyboard, and back to its default width on a double-click. */
function ColumnDivider({ column, onResize }: { column: ColumnView; onResize(width: number): void }) {
    let divider = useRef<HTMLDivElement>(null)
    // A drag sizes the column directly as it goes; the width saves once it ends.
    let size = (width: number) => {
        let clamped = Math.max(minimumColumnWidth, Math.round(width))
        let element = divider.current?.previousElementSibling
        if (element instanceof HTMLElement)
            element.style.width = `${clamped}px`
        return clamped
    }
    let keyDown = (event: KeyboardEvent) => {
        let step = event.shiftKey ? 50 : 10
        let width = event.key == "ArrowLeft" || event.key == "ArrowRight"
            ? column.width + (event.key == "ArrowLeft" ? -step : step)
            : event.key == "Home"
            ? minimumColumnWidth
            : event.key == "End"
            ? divider.current?.parentElement?.clientWidth ?? defaultColumnWidth
            : undefined
        if (width != undefined) {
            event.preventDefault()
            onResize(size(width))
        }
    }
    let pointerDown = (event: PointerEvent) => {
        event.preventDefault()
        let startX = event.clientX
        let move = (next: globalThis.PointerEvent) => size(column.width + next.clientX - startX)
        let end = (next: globalThis.PointerEvent) => {
            window.removeEventListener("pointermove", move)
            onResize(size(column.width + next.clientX - startX))
        }
        window.addEventListener("pointermove", move)
        window.addEventListener("pointerup", end, { once: true })
    }
    return (
        <div
            ref={divider}
            className="column-divider"
            role="separator"
            tabIndex={0}
            aria-label="Resize branch column"
            aria-orientation="vertical"
            aria-valuemin={minimumColumnWidth}
            aria-valuemax={2000}
            aria-valuenow={column.width}
            onKeyDown={keyDown}
            onPointerDown={pointerDown}
            onDoubleClick={() => onResize(size(defaultColumnWidth))}
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

// Repair and Remove arrive with the worktree previews (migration step 5).
function MissingWorktree({ path }: { path: string }) {
    return (
        <section className="missing-worktree" aria-label="Missing worktree">
            <h3>Worktree directory missing</h3>
            <p>{path}</p>
        </section>
    )
}

// A discard still showing its Undo notice takes Ctrl+Z; the Operation History's undo arrives in migration step 5.
function useDiscardUndo(inspection: Inspection) {
    useEffect(() => {
        let undo = (event: globalThis.KeyboardEvent) => {
            if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() != "z")
                return
            if (event.composedPath().some(node => node instanceof HTMLElement && node.matches("input, textarea, select, [contenteditable=true]")))
                return
            if (inspection.undoDiscard())
                event.preventDefault()
        }
        window.addEventListener("keydown", undo)
        return () => window.removeEventListener("keydown", undo)
    }, [inspection])
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
