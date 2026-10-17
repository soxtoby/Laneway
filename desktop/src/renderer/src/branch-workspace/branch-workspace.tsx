import type { AvailableOpenRepository, BranchGraph, BranchGraphMarker, ComparisonRef, RepositoryGraphSettings, Workspace, WorkspaceColumn } from "@laneway/shared"
import type { DiffLayout, FileListView } from "@laneway/shared"
import type { RecoveryRequest, WorktreeRecovery } from "@laneway/shared"
import { css, on, ref, type RemixNode } from "remix/ui"
import { CommandLens } from "../command-lens"
import { createConflictResolution } from "../conflict-resolution"
import { errorMessage, type NoticeState } from "../feedback"
import { Icon } from "../icons"
import { comparisonColumnId, comparisonNode, renameComparisonRef } from "../inspection/comparison-columns"
import { createInspection } from "../inspection/inspection"
import { createPullLatest, type PullControl } from "../pull-latest"
import { baseName, RepositoryRail } from "../repository-rail"
import { createWorktreeActions } from "../worktrees/worktree-actions"
import { branchNodeFor, localIdentities, reconcileWorktreeColumns, recoveryColumnId, recoveryWorkspaceColumn, workspaceGraph } from "../worktrees/worktree-columns"
import { BranchColumns, columnIdentity, columnKindIcon, defaultColumnWidth, recoveryNode } from "./branch-columns"
import { graphRowHeight, type GraphRowLayout, layoutBranchGraph } from "./branch-graph-layout"
import { BranchRow, GraphError, GraphProgress, GraphRail, GraphSummary, SimpleNodeRow } from "./branch-graph-view"
import { MarkerDetails } from "./branch-marker-details"
import { canRebaseOnto, createBranchRebase, rebaseable } from "./branch-rebase"
import { GraphSettings } from "./graph-settings"
import { createLocalBranchActions } from "./local-branch-actions"

export interface RepositoryGraphState {
    graph?: BranchGraph
    lensGraph?: BranchGraph
    worktreeRecoveries: WorktreeRecovery[]
    recoveryBusy?: string
    recoveryErrors: Record<string, string>
    loading: boolean
    refreshing: boolean
    error?: string
    showAll: boolean
    selectedId?: string
    pendingGraphBranchId?: string
    openedBranchIds: string[]
    maximizedBranchId?: string
    showSettings: boolean
    patterns: string
    marker?: BranchGraphMarker
    graphCollapsed: boolean
    collapsedColumnIds: string[]
    collapsedBranchIds: string[]
    remoteRefreshed: boolean
    graphScrollTop: number
    graphViewportHeight: number
    widths: Record<string, number>
    focusedColumnId?: string
    draggingColumnId?: string
    dragOriginalIds?: string[]
    /** The Branch Node being dragged in the graph, which may rebase onto the row it is dropped on. */
    draggingBranchId?: string
    focusRestored: boolean
    diffLayouts: Record<string, DiffLayout>
    /** Open Branch Comparison Columns by column id. */
    comparisons: Record<string, { from: ComparisonRef; to: ComparisonRef }>
    contextMenu?: { branchId: string; x: number; y: number }
}

interface BranchWorkspaceOptions {
    api: Window["laneway"]
    update(): Promise<AbortSignal>
    signal: AbortSignal
    notify(notice: NoticeState): () => void
    selectRepository(id: string): Promise<void>
    closeRepository(id: string): Promise<void>
    moveRepository(id: string, targetId: string): Promise<void>
    addRepository(): void
    workspace(): Workspace
    workspaceChanged(workspace: Workspace): void
    fileListView(): FileListView
    saveFileListView(view: FileListView): void
}

export interface BranchWorkspace {
    activate(repositoryId: string): void
    deactivate(): void
    render(active: AvailableOpenRepository, workspace: Workspace, railCollapsed?: boolean, toggleRail?: () => void): RemixNode
    columnTabs(active: AvailableOpenRepository): RemixNode
    openLens(): void
    renderLens(workspace: Workspace): RemixNode
    repositoryActions(repositoryId: string, mainWorktree: string): { busy: boolean; stashes(): void; undo(): void; redo(): void; pull: PullControl }
}

let branchContextMenu = css({
    position: "fixed",
    width: "max-content",
    maxWidth: "calc(100vw - 16px)",
    borderRadius: "3px",
    margin: 0,
    padding: "4px",
    border: "1px solid var(--line-strong)",
    background: "var(--panel)",
    color: "var(--text)",
    "&::backdrop": { background: "transparent" },
    "& button": {
        display: "block",
        width: "100%",
        textAlign: "left",
        color: "inherit",
        background: "var(--control)",
        border: 0,
        padding: "4px 8px",
        font: "inherit",
        cursor: "pointer",
    },
})

interface LensNavigationResult {
    kind: "repository" | "branch"
    repositoryId: string
    nodeId: string
    label: string
    detail: string
    score: number
}

interface ColumnCommandResult extends Omit<LensNavigationResult, "kind"> {
    kind: "command"
    delta: number
}

export type LensResult = LensNavigationResult | ColumnCommandResult

let columnTabs = css({
    display: "flex",
    alignItems: "stretch",
    minWidth: "0",
    overflow: "hidden",
})

let columnTab = css({
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: "7px",
    maxWidth: "220px",
    minWidth: "0",
    padding: "0 12px",
    color: "var(--muted)",
    border: "0",
    borderRadius: "0",
    background: "transparent",
    fontSize: "12.5px",
    fontWeight: "500",
    "&:hover": { color: "var(--text)", background: "var(--hover)" },
    "&.collapsed": { color: "var(--faint)", fontStyle: "italic" },
    "&.active": { color: "var(--text)", fontWeight: "600" },
    "&.active::before": {
        content: '""',
        position: "absolute",
        left: "8px",
        right: "8px",
        bottom: "-1px",
        height: "3px",
        borderRadius: "2px 2px 0 0",
        background: "var(--accent)",
    },
    "&:focus-visible": { outlineOffset: "-2px" },
})

let columnTabName = css({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let workspaceStyle = css({
    height: "100%",
    display: "grid",
    gridTemplateColumns: "var(--rail) minmax(0, 1fr)",
})

let graphDesk = css({
    position: "relative",
    minWidth: "0",
    minHeight: "0",
    // No side padding: the branch columns scroll right up to the window edge and the repository rail.
    padding: "var(--gutter) 0",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--canvas)",
})

let graphDeskProgress = css({
    position: "absolute",
    top: "0",
    left: "0",
    zIndex: "1",
    width: "26%",
    height: "2px",
    background: "var(--accent)",
    opacity: "0.7",
    animation: "progress-sweep 1.3s ease-in-out infinite alternate",
    "@media (forced-colors: active)": {
        background: "Highlight",
    },
})

let graphToolbar = css({
    position: "relative",
    flexShrink: "0",
    flexWrap: "wrap",
    minHeight: "46px",
    padding: "0 8px 0 14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "4px 8px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel)",
})

let graphToolbarH1 = css({
    margin: "0",
    overflow: "hidden",
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    fontSize: "16px",
    fontWeight: "600",
    letterSpacing: "-0.01em",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let graphActions = css({
    display: "flex",
    flex: "0 0 auto",
    gap: "4px",
    "&:first-child": {
        minWidth: "0",
        display: "flex",
        alignItems: "baseline",
        gap: "8px",
        overflow: "hidden",
    },
})

let graphPanelToggleButton = css({
    width: "32px",
    height: "32px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--chrome-muted)",
    border: "1px solid transparent",
    borderRadius: "6px",
    background: "transparent",
    "&:hover": { color: "var(--chrome-text)", background: "var(--chrome-2)" },
    '&[aria-expanded="true"]': { color: "var(--chrome-accent)" },
    "&:focus-visible": { outline: "2px solid var(--ring)", outlineOffset: "1px" },
})

let graphActionsButton = css({
    height: "28px",
    padding: "0 10px",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderRadius: "var(--radius)",
    background: "var(--panel)",
    fontSize: "12px",
    fontWeight: "500",
    "&.active": {
        color: "var(--focus)",
        borderColor: "var(--focus-edge)",
        background: "var(--focus-wash)",
    },
    "&:hover:not(:disabled)": {
        background: "var(--control-hover)",
    },
})

let branchGraphSettingsButton = css({
    width: "28px",
    height: "28px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderRadius: "var(--radius)",
    background: "var(--panel)",
    "&.active": { color: "var(--focus)", borderColor: "var(--focus-edge)", background: "var(--focus-wash)" },
    "&:hover:not(:disabled)": { background: "var(--control-hover)" },
})

let graphLimit = css({
    padding: "6px 12px",
    color: "var(--warning)",
    borderBottom: "1px solid var(--line)",
    background: "var(--warning-wash)",
    fontSize: "12px",
    lineHeight: "1.4",
})

let graphLayout = css({
    "&.graph-collapsed": { gridTemplateColumns: "minmax(0, 1fr)" },
    minWidth: "0",
    minHeight: "0",
    display: "grid",
    flex: "1 1 auto",
    gridTemplateColumns: "clamp(260px, 28%, 380px) minmax(0, 1fr)",
    overflow: "hidden",
    "@media (max-width: 1080px)": {
        gridTemplateColumns: "clamp(230px, 34%, 320px) minmax(0, 1fr)",
    },
})

let graphSidebar = css({
    "&.collapsed": { display: "none" },
    position: "relative",
    zIndex: "1",
    minWidth: "0",
    minHeight: "0",
    marginLeft: "4px",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "var(--radius-card)",
    background: "var(--panel)",
    boxShadow: "var(--card-shadow), var(--edge-shadow)",
})

let graphPanel = css({
    flex: "1 1 auto",
    position: "relative",
    minWidth: "0",
    minHeight: "0",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    background: "var(--panel)",
})

let graphRows = css({
    minHeight: "0",
    padding: "0",
    overflow: "auto",
    // Virtual rows and spacers already preserve position; browser anchoring
    // otherwise compensates for their replacement and moves the viewport.
    overflowAnchor: "none",
    outline: "0",
    "&:focus-visible": {
        boxShadow: "inset 0 0 0 2px var(--focus)",
    },
})

let graphSpacer = css({
    width: "1px",
    pointerEvents: "none",
})

let unassignedMarkers = css({
    padding: "7px 10px",
    color: "var(--muted)",
    borderTop: "1px solid var(--line)",
    fontSize: "12px",
    lineHeight: "1.45",
})

let unassignedMarkersSummary = css({
    cursor: "default",
})

let unassignedMarkersButton = css({
    display: "block",
    marginTop: "6px",
    color: "var(--warning)",
    border: "0",
    background: "transparent",
    font: "inherit",
    textDecoration: "underline",
})

export function createBranchWorkspace(options: BranchWorkspaceOptions): BranchWorkspace {
    let states = new Map<string, RepositoryGraphState>()
    let activeRepositoryId: string | undefined
    let lensOpen = false
    let lensQuery = ""
    let lensInput: HTMLInputElement | undefined
    let restoreFocus: HTMLElement | null = null
    let currentWorkspace: Workspace | undefined
    let worktreeActions = createWorktreeActions({
        api: options.api,
        update: options.update,
        completed: async (repositoryId, request, columnId) => {
            let repository = options.workspace().repositories.find(item => item.id == repositoryId)
            let destination = repository?.columns.find(item => item.id == columnId)
            if (request.action == "switch" && destination && destination.kind != "comparison" && !destination.worktreePath) {
                let source = repository?.columns.find(item => item.kind != "comparison" && item.worktreePath == request.path)
                destination.worktreePath = request.path
                if (source?.kind != "comparison") {
                    destination.worktreeId = source?.worktreeId
                    if (source) {
                        source.worktreePath = undefined
                        source.worktreeId = undefined
                    }
                }
            }
            await read(repositoryId, false, false)
        },
    })
    let localMutations = 0
    let conflicts = createConflictResolution({
        api: options.api,
        update: options.update,
        changed: repositoryId => read(repositoryId, false, false),
    })
    let inspection = createInspection({
        api: options.api,
        update: options.update,
        signal: options.signal,
        notify: options.notify,
        localChanged: repositoryId => read(repositoryId, false, false),
        recoveryBlocked: repositoryId => stateFor(repositoryId).worktreeRecoveries.length > 0,
        resolveWorkingConflict: (repositoryId, subject) => conflicts.open(repositoryId, subject),
        localBusyChanged: busy => {
            localMutations += busy ? 1 : -1
        },
        createBranchAt: (repositoryId, commit) => localBranches.atCommit(repositoryId, commit),
        renameBranch: (repositoryId, name, newName) => localBranches.perform(repositoryId, { action: "branch-rename", name, newName }),
        mainWorktree: repositoryId => {
            let repository = options.workspace().repositories.find(item => item.id == repositoryId)
            return repository?.status == "available" ? repository.info.mainWorktree : undefined
        },
        openComparison,
        layout: (repositoryId, columnId) => stateFor(repositoryId).diffLayouts[columnId] ?? "unified",
        saveLayout: (repositoryId, columnId, layout) => {
            stateFor(repositoryId).diffLayouts[columnId] = layout
            void persist(repositoryId).then(() => options.update())
        },
        fileListView: options.fileListView,
        saveFileListView: options.saveFileListView,
        maximized: repositoryId => stateFor(repositoryId).maximizedBranchId,
        maximize: (repositoryId, id) => maximizeBranch(repositoryId, id),
    })
    let localBranches = createLocalBranchActions({
        api: options.api,
        update: options.update,
        completed: async (repositoryId, request) => {
            let state = stateFor(repositoryId)
            if (request.action == "branch-rename") {
                let oldId = `branch:refs/heads/${request.name}`, newId = `branch:refs/heads/${request.newName}`
                state.openedBranchIds = state.openedBranchIds.map(id => id == oldId ? newId : id)
                state.collapsedColumnIds = state.collapsedColumnIds.map(id => id == oldId ? newId : id)
                if (state.focusedColumnId == oldId)
                    state.focusedColumnId = newId
                if (state.selectedId == oldId)
                    state.selectedId = newId
                state.widths[newId] = state.widths[oldId] ?? defaultColumnWidth
                state.diffLayouts[newId] = state.diffLayouts[oldId] ?? "unified"
                let repository = options.workspace().repositories.find(item => item.id == repositoryId)
                for (let column of repository?.columns ?? []) {
                    if (column.id == oldId && column.kind == "branch") {
                        column.id = newId
                        column.ref = `refs/heads/${request.newName}`
                    }
                }
                renameComparisons(state, repository?.columns ?? [], `refs/heads/${request.name}`, `refs/heads/${request.newName}`)
                inspection.renameBranch(repositoryId, `refs/heads/${request.name}`, `refs/heads/${request.newName}`)
            }
            await read(repositoryId, false, false)
            if (request.action == "branch-create")
                openBranch(repositoryId, `branch:refs/heads/${request.name}`)
        },
    })

    let pullLatest = createPullLatest({
        api: options.api,
        update: options.update,
        signal: options.signal,
        graph: repositoryId => stateFor(repositoryId).graph,
        scope: repositoryId => {
            // Scope freezes at activation: every open column, collapsed or not, contributes its local branch.
            let state = stateFor(repositoryId)
            let branches = state.graph ? workspaceGraph(state.graph).branches : []
            return state.openedBranchIds.flatMap(id => {
                let branch = branches.find(candidate => candidate.id == id)
                return branch && branch.localRefs.includes(branch.preferredRef) ? [branch.preferredRef] : []
            })
        },
        completed: repositoryId => read(repositoryId, false, false),
        notify: options.notify,
        openBranch: (repositoryId, branchName) => openBranch(repositoryId, `branch:refs/heads/${branchName}`),
    })
    let rebase = createBranchRebase({
        api: options.api,
        update: options.update,
        notify: options.notify,
        completed: repositoryId => read(repositoryId, false, false),
        busyChanged: busy => {
            localMutations += busy ? 1 : -1
        },
        resolve: (repositoryId, names) => {
            // Lower branches show inside a dependent's column, so the lowest unresolved branch shows every conflict above it.
            let graph = stateFor(repositoryId).graph
            let branches = graph ? workspaceGraph(graph).branches : []
            let name = names.find(name => branches.some(branch => branch.name == name && branch.unresolved)) ?? names[0]
            openBranch(repositoryId, `branch:refs/heads/${name}`)
        },
    })

    // One timer polls the Branch Graph and Working Changes together so a poll costs one burst of updates.
    // A worktree operation in flight skips the poll: its Git reads run inside the directory being removed.
    let interval = window.setInterval(() => {
        if (activeRepositoryId && document.visibilityState == "visible" && document.hasFocus() && !worktreeActions.busy()) {
            void read(activeRepositoryId, false, true)
            inspection.refreshWorking()
        }
    }, 5_000)
    let onFocus = () => {
        if (activeRepositoryId)
            void read(activeRepositoryId, false, true)
    }
    // Disk changes noticed by main arrive at any time; one that lands mid-read is replayed once that read settles.
    let changedWhileReading = new Set<string>()
    let unsubscribeChanges = options.api.onRepositoryChanged(({ repositoryId }) => {
        // Laneway's own operations change the same files; their completion refreshes everything once.
        if (repositoryId != activeRepositoryId || worktreeActions.busy() || localBranches.busy() || localMutations > 0 || pullLatest.busy(repositoryId))
            return

        let state = stateFor(repositoryId)
        if (state.loading || state.refreshing) {
            changedWhileReading.add(repositoryId)
            return
        }
        void read(repositoryId, false, true)
        inspection.refreshWorking()
    })
    let onShortcut = (event: KeyboardEvent) => {
        if (event.defaultPrevented)
            return
        if (
            activeRepositoryId && event.ctrlKey && !event.altKey && (event.key.toLowerCase() == "z" || event.key.toLowerCase() == "y")
            && !event.composedPath().some(node => node instanceof HTMLElement && node.matches('input, textarea, select, [contenteditable="true"]'))
        ) {
            event.preventDefault()
            let redo = event.shiftKey || event.key.toLowerCase() == "y"
            // A discard still showing its Undo notice takes Ctrl+Z before the Operation History does.
            if (!redo && inspection.undoDiscard())
                return
            void worktreeActions.transition(activeRepositoryId, redo ? "redo" : "undo")
            return
        }
        if (event.ctrlKey && event.key.toLowerCase() == "k") {
            event.preventDefault()
            openLens()
        } else if (event.key == "Escape" && activeRepositoryId) {
            let state = stateFor(activeRepositoryId)
            if (rebase.choosing(activeRepositoryId))
                rebase.stopChoosing()
            else if (state.showSettings) {
                state.showSettings = false
                void options.update()
            } else if (state.maximizedBranchId) {
                state.maximizedBranchId = undefined
                void options.update()
            }
        }
    }
    window.addEventListener("focus", onFocus)
    window.addEventListener("keydown", onShortcut)
    options.signal.addEventListener("abort", () => {
        window.clearInterval(interval)
        unsubscribeChanges()
        window.removeEventListener("focus", onFocus)
        window.removeEventListener("keydown", onShortcut)
        for (let id of states.keys()) {
            void options.api.cancelBranchGraph(id)
            void options.api.cancelBranchHistory(id)
        }
    }, { once: true })

    return {
        openLens,
        activate(repositoryId) {
            activeRepositoryId = repositoryId
            inspection.retainRepositories(options.workspace().repositories.map(repository => repository.id))
            inspection.activate(repositoryId)
            void ensure(repositoryId, true)
        },
        deactivate() {
            activeRepositoryId = undefined
            inspection.retainRepositories(options.workspace().repositories.map(repository => repository.id))
            inspection.activate()
        },
        render(active, workspace, railCollapsed = false, toggleRail = () => {}) {
            currentWorkspace = workspace
            let state = stateFor(active.id)
            inspection.retain(active.id, state.openedBranchIds, state.graph && workspaceGraph(state.graph))
            let graph = state.graph
            // Rows show each local branch identity, so every branch sharing a tip can be opened, dragged, and dropped on.
            let identities = graph && workspaceGraph(graph)
            let visibleBranches = graph ? branchesForDisplay(graph, state.collapsedBranchIds) : []
            let rowBranches = graph ? visibleBranches.flatMap(branch => localIdentities(graph, branch)) : []
            let layout = graph ? layoutBranchGraph(graph, rowBranches) : { rows: [], width: 26 }
            let selectableIds = layout.rows.map(row => row.node.id)
            let nodeWindow = windowNodes(layout.rows, state.graphScrollTop, state.graphViewportHeight)
            if (
                state.selectedId && !selectableIds.includes(state.selectedId)
            ) {
                state.selectedId = undefined
            }

            return (
                <section class="workspace graph-workspace" mix={workspaceStyle} aria-live="polite">
                    {worktreeActions.dialog()}
                    {localBranches.render()}
                    {pullLatest.render(active.id)}
                    {rebase.render()}
                    {state.contextMenu && graph && (
                        <dialog
                            aria-label="Branch actions"
                            style={{
                                left: `${Math.max(0, Math.min(state.contextMenu.x, window.innerWidth - 180))}px`,
                                top: `${Math.max(0, Math.min(state.contextMenu.y, window.innerHeight - 180))}px`,
                            }}
                            mix={[
                                branchContextMenu,
                                ref(dialog => dialog.showModal()),
                                on("cancel", event => {
                                    event.preventDefault()
                                    state.contextMenu = undefined
                                    void options.update()
                                }),
                                on("click", event => {
                                    if (event.target == event.currentTarget) {
                                        state.contextMenu = undefined
                                        void options.update()
                                    }
                                }),
                            ]}
                        >
                            <div role="menu" aria-label="Branch actions" mix={ref(menu => menu.querySelector<HTMLElement>("[role='menuitem']")?.focus())}>
                                {(() => {
                                    let branch = workspaceGraph(graph).branches.find(branch => branch.id == state.contextMenu?.branchId)
                                    return branch && rebaseable(branch) && (
                                        <button
                                            type="button"
                                            role="menuitem"
                                            mix={on("click", () => {
                                                state.contextMenu = undefined
                                                state.graphCollapsed = false
                                                state.selectedId = branch.id
                                                rebase.choose(active.id, branch)
                                                void options.update().then(() => document.querySelector<HTMLElement>(".graph-rows")?.focus())
                                            })}
                                        >
                                            Rebase onto…
                                        </button>
                                    )
                                })()}
                                {(["branch-create", "branch-rename", "branch-delete"] as const).map(action => {
                                    let branch = workspaceGraph(graph).branches.find(branch => branch.id == state.contextMenu?.branchId)
                                    return branch && (action == "branch-create" || branch.localRefs.length > 0) && (
                                        <button
                                            role="menuitem"
                                            mix={on("click", () => {
                                                state.contextMenu = undefined
                                                localBranches.open(active.id, branch, action)
                                            })}
                                        >
                                            {action == "branch-create"
                                                ? "Create branch here…"
                                                : action == "branch-rename"
                                                ? "Rename branch…"
                                                : "Delete branch…"}
                                        </button>
                                    )
                                })}
                            </div>
                        </dialog>
                    )}
                    <RepositoryRail
                        railCollapsed={railCollapsed}
                        toggleRail={toggleRail}
                        activeId={active.id}
                        workspace={workspace}
                        busy={state.loading}
                        // Choosing the repository already shown toggles its Branch Graph instead.
                        selectRepository={id => id == active.id ? toggleGraph(active.id) : options.selectRepository(id)}
                        activeExpanded={!state.graphCollapsed}
                        closeRepository={options.closeRepository}
                        moveRepository={options.moveRepository}
                        addRepository={options.addRepository}
                        heading={
                            <button
                                type="button"
                                aria-label={state.graphCollapsed ? "Show Branch Graph" : "Hide Branch Graph"}
                                aria-expanded={!state.graphCollapsed}
                                title={state.graphCollapsed ? "Show Branch Graph" : "Hide Branch Graph"}
                                mix={[graphPanelToggleButton, on("click", () => toggleGraph(active.id))]}
                            >
                                <Icon name="graph" size={15} />
                            </button>
                        }
                    />
                    <section class="graph-desk" mix={graphDesk}>
                        {/* The sidebar shows full progress; with it hidden, a slim bar marks the first read. */}
                        {!graph && state.loading && state.graphCollapsed && (
                            <span class="graph-desk-progress" role="progressbar" aria-label="Loading repository" mix={graphDeskProgress}></span>
                        )}
                        <div class={`graph-layout ${state.graphCollapsed ? "graph-collapsed" : ""}`} mix={graphLayout}>
                            <div class={`graph-sidebar ${state.graphCollapsed ? "collapsed" : ""}`} mix={graphSidebar}>
                                <header class="graph-toolbar" mix={graphToolbar}>
                                    {/* The repository is named by the rail and its main worktree column, so the title stays generic. */}
                                    <h1 mix={graphToolbarH1}>Branch Graph</h1>
                                    <div class="graph-actions" mix={graphActions}>
                                        {/* The Engine reads the default set or every branch, so the toggle re-reads rather than filtering rows. */}
                                        <button
                                            type="button"
                                            class={state.showAll ? "active" : ""}
                                            aria-pressed={state.showAll}
                                            title={state.showAll
                                                ? "Show local, Involved, Primary, and pattern-matched remote branches"
                                                : "Show every branch, including unrelated remote branches"}
                                            mix={[graphActionsButton, on("click", () => toggleAll(active.id))]}
                                        >
                                            {state.showAll ? "Show relevant" : "Show all"}
                                        </button>
                                        <button
                                            type="button"
                                            class={state.showSettings ? "active" : ""}
                                            aria-label="Branch Graph settings"
                                            aria-expanded={state.showSettings}
                                            title="Branch Graph settings"
                                            mix={[
                                                branchGraphSettingsButton,
                                                on("click", () => {
                                                    state.showSettings = !state.showSettings
                                                    void options.update()
                                                }),
                                            ]}
                                        >
                                            <Icon name="sliders" size={15} />
                                        </button>
                                    </div>
                                    {state.showSettings && graph && (
                                        <GraphSettings
                                            graph={graph}
                                            state={state}
                                            apply={settings => applyGraphSettings(active.id, settings)}
                                            close={() => {
                                                state.showSettings = false
                                                void options.update()
                                            }}
                                        />
                                    )}
                                </header>
                                {graph?.limited.length
                                    ? (
                                        <div class="graph-limit" mix={graphLimit}>
                                            Limited evidence: {graph.limited.join(", ")}. No implicit fetch performed.
                                        </div>
                                    )
                                    : null}
                                {!graph && state.loading && <GraphProgress />}
                                {!graph && state.error && <GraphError message={state.error} retry={() => read(active.id, false, true)} />}
                                {graph && (
                                    <section class="graph-panel" aria-label="Branch Graph" mix={graphPanel}>
                                        <GraphSummary graph={graph} visibleCount={rowBranches.length} />
                                        <div
                                            class="graph-rows"
                                            role="listbox"
                                            aria-label="Branches and graph nodes"
                                            tabIndex={0}
                                            mix={[
                                                graphRows,
                                                on("keydown", event => graphKeydown(event, active.id, layout.rows)),
                                                on("scroll", event => {
                                                    state.graphScrollTop = event.currentTarget.scrollTop
                                                    state.graphViewportHeight = event.currentTarget.clientHeight
                                                    void options.update()
                                                }),
                                            ]}
                                        >
                                            {nodeWindow.before > 0 && (
                                                <div class="graph-spacer" aria-hidden="true" style={{ height: `${nodeWindow.before}px` }} mix={graphSpacer}>
                                                </div>
                                            )}
                                            {nodeWindow.nodes.map(row => {
                                                if (row.node.kind == "branch") {
                                                    let branch = row.node.branch
                                                    let choosing = identities!.branches.find(candidate => candidate.id == rebase.choosing(active.id))
                                                    let dragged = () => identities!.branches.find(candidate => candidate.id == state.draggingBranchId)
                                                    return (
                                                        <BranchRow
                                                            branch={branch}
                                                            rail={<GraphRail row={row} />}
                                                            selected={state.selectedId == branch.id}
                                                            rebase={choosing?.id == branch.id
                                                                ? "source"
                                                                : choosing && state.selectedId == branch.id && canRebaseOnto(identities!, choosing, branch)
                                                                ? "target"
                                                                : undefined}
                                                            // While a rebase chooses its destination, clicking a branch chooses it.
                                                            select={() =>
                                                                choosing && choosing.id != branch.id
                                                                    ? chooseRebaseDestination(active.id, branch.id)
                                                                    : selectNode(active.id, branch.id)}
                                                            open={() => openBranch(active.id, branch.id)}
                                                            selectMarker={marker => selectMarker(active.id, branch.id, marker)}
                                                            contextMenu={event => {
                                                                event.preventDefault()
                                                                state.contextMenu = { branchId: branch.id, x: event.clientX, y: event.clientY }
                                                                void options.update()
                                                            }}
                                                            dragStart={() => state.draggingBranchId = branch.id}
                                                            dragEnd={() => state.draggingBranchId = undefined}
                                                            accepts={() => {
                                                                let source = dragged()
                                                                return !!source && canRebaseOnto(identities!, source, branch)
                                                            }}
                                                            drop={() => {
                                                                let source = dragged()
                                                                state.draggingBranchId = undefined
                                                                if (source)
                                                                    void rebase.start(active.id, identities!, source.id, branch.id)
                                                            }}
                                                        />
                                                    )
                                                }
                                                return (
                                                    <SimpleNodeRow
                                                        id={row.node.id}
                                                        kind={row.node.kind}
                                                        name={row.node.name}
                                                        title={row.node.title}
                                                        rail={<GraphRail row={row} />}
                                                        selected={state.selectedId == row.node.id}
                                                        select={() => selectNode(active.id, row.node.id)}
                                                    />
                                                )
                                            })}
                                            {nodeWindow.after > 0 && (
                                                <div class="graph-spacer" aria-hidden="true" style={{ height: `${nodeWindow.after}px` }} mix={graphSpacer}>
                                                </div>
                                            )}
                                        </div>
                                        {graph.unassignedStashes.length > 0 && (
                                            <details class="unassigned-markers" mix={unassignedMarkers}>
                                                <summary mix={unassignedMarkersSummary}>
                                                    {graph.unassignedStashes.length} unassigned stashes
                                                </summary>
                                                {graph.unassignedStashes.map(marker => (
                                                    <button
                                                        type="button"
                                                        title={marker.tooltip}
                                                        mix={[
                                                            unassignedMarkersButton,
                                                            on("click", () => {
                                                                state.marker = marker
                                                                void options.update()
                                                            }),
                                                        ]}
                                                    >
                                                        {marker.label}
                                                    </button>
                                                ))}
                                            </details>
                                        )}
                                        {state.marker && (
                                            <MarkerDetails
                                                marker={state.marker}
                                                close={() => {
                                                    state.marker = undefined
                                                    void options.update()
                                                }}
                                            />
                                        )}
                                    </section>
                                )}
                            </div>
                            {!graph && state.error && state.graphCollapsed && <GraphError message={state.error} retry={() => read(active.id, false, true)} />}
                            {graph && (
                                <BranchColumns
                                    graph={workspaceGraph(graph)}
                                    branchAction={(branch, action) => localBranches.open(active.id, branch, action)}
                                    branchMenu={(branch, event) => {
                                        event.preventDefault()
                                        state.contextMenu = { branchId: branch.id, x: event.clientX, y: event.clientY }
                                        void options.update()
                                    }}
                                    state={state}
                                    inspection={inspection}
                                    conflicts={conflicts}
                                    repositoryId={active.id}
                                    recover={(recovery, action) => void recoverWorktree(active.id, recovery, action)}
                                    worktreePath={id => backingPath(active.id, id)}
                                    worktreeControls={column => worktreeActions.controls(active.id, column, backingPath(active.id, column.id), graph)}
                                    missingWorktreeControls={(column, worktree) => worktreeActions.missingControls(active.id, column, worktree)}
                                    dropBranch={(columnId, branchRef) => {
                                        let path = backingPath(active.id, columnId)
                                        if (path)
                                            void worktreeActions.prepare(active.id, { action: "switch", path, branch: branchRef, move: true })
                                    }}
                                    close={branchId => closeBranch(active.id, branchId)}
                                    collapse={branchId => collapseColumn(active.id, branchId)}
                                    maximize={branchId => maximizeBranch(active.id, branchId)}
                                    focus={branchId => focusColumn(active.id, branchId)}
                                    move={(branchId, delta) => moveColumn(active.id, branchId, delta)}
                                    previewMove={(branchId, targetId) => previewColumnMove(active.id, branchId, targetId)}
                                    commitMove={branchId => commitColumnMove(active.id, branchId)}
                                    resize={(branchId, width) => resizeColumn(active.id, branchId, width)}
                                />
                            )}
                        </div>
                    </section>
                </section>
            )
        },
        columnTabs(active) {
            let state = stateFor(active.id)
            let graph = state.graph && workspaceGraph(state.graph)
            if (!graph)
                return null
            let columns = state.openedBranchIds.map(id =>
                graph.branches.find(branch => branch.id == id) ?? graph.virtualBranches.find(branch => branch.id == id)
                    ?? recoveryNode(state.worktreeRecoveries.find(item => recoveryColumnId(item) == id))
                    ?? (state.comparisons[id] && comparisonNode(id, state.comparisons[id], graph))
            ).filter(column => column != undefined)
            if (columns.length == 0)
                return null

            return (
                <div class="column-tabs" role="tablist" aria-label="Open columns" mix={columnTabs}>
                    {columns.map(column => {
                        let identity = columnIdentity(column, backingPath(active.id, column.id))
                        let collapsed = state.collapsedColumnIds.includes(column.id)
                        return (
                            <button
                                type="button"
                                role="tab"
                                class={`column-tab ${column.id == state.focusedColumnId ? "active" : ""} ${collapsed ? "collapsed" : ""}`}
                                aria-selected={column.id == state.focusedColumnId}
                                title={identity.kind}
                                key={column.id}
                                mix={[
                                    columnTab,
                                    on("click", () => {
                                        let element = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(node =>
                                            node.dataset.columnId == column.id
                                        )
                                        element?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })
                                        ;(element?.querySelector<HTMLElement>(".expand-column") ?? element)?.focus(
                                            { preventScroll: true, focusVisible: true } as FocusOptions,
                                        )
                                        focusColumn(active.id, column.id)
                                        void options.update()
                                    }),
                                ]}
                            >
                                <span mix={[columnKindIcon, identity.tone]}>
                                    <Icon name={identity.icon} size={13} />
                                </span>
                                <span mix={columnTabName}>{identity.name}</span>
                            </button>
                        )
                    })}
                </div>
            )
        },
        renderLens(workspace) {
            currentWorkspace = workspace
            if (!lensOpen)
                return null
            return (
                <CommandLens
                    query={lensQuery}
                    results={lensResults(workspace, states, activeRepositoryId, lensQuery)}
                    inputRef={node => lensInput = node}
                    setQuery={value => {
                        lensQuery = value
                        void options.update()
                    }}
                    close={closeLens}
                    activate={activateLensResult}
                />
            )
        },
        repositoryActions(repositoryId, mainWorktree) {
            return {
                busy: worktreeActions.busy() || localBranches.busy() || localMutations > 0 || pullLatest.busy(repositoryId),
                stashes: () => void localBranches.stashes(repositoryId, mainWorktree),
                undo: () => void worktreeActions.transition(repositoryId, "undo"),
                redo: () => void worktreeActions.transition(repositoryId, "redo"),
                pull: pullLatest.control(repositoryId),
            }
        },
    }

    function toggleGraph(repositoryId: string) {
        let state = stateFor(repositoryId)
        state.graphCollapsed = !state.graphCollapsed
        state.showSettings = false
        void options.update()
    }

    function toggleAll(repositoryId: string) {
        let state = stateFor(repositoryId)
        state.pendingGraphBranchId = undefined
        state.showAll = !state.showAll
        // A read already in flight finishes with the previous choice; it re-reads once it notices the change.
        void read(repositoryId, false, false)
    }

    function selectMarker(repositoryId: string, branchId: string, marker: BranchGraphMarker) {
        let state = stateFor(repositoryId)
        state.pendingGraphBranchId = undefined
        state.selectedId = branchId
        state.marker = marker
        if (marker.kind == "stash") {
            let repository = options.workspace().repositories.find(item => item.id == repositoryId)
            if (repository?.status == "available")
                void localBranches.stashes(repositoryId, repository.info.mainWorktree, marker.objectId)
        }
        void options.update()
    }

    function closeBranch(repositoryId: string, branchId: string) {
        let state = stateFor(repositoryId)
        if (backingPath(repositoryId, branchId)) {
            collapseColumn(repositoryId, branchId)
            return
        }
        let index = state.openedBranchIds.indexOf(branchId)
        state.openedBranchIds = state.openedBranchIds.filter(id => id != branchId)
        delete state.comparisons[branchId]
        if (state.maximizedBranchId == branchId)
            state.maximizedBranchId = undefined
        if (state.focusedColumnId == branchId)
            state.focusedColumnId = state.openedBranchIds[index] ?? state.openedBranchIds[index - 1]
        void persist(repositoryId).then(() => options.update()).then(() => {
            let next = state.focusedColumnId
                ? [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(column => column.dataset.columnId == state.focusedColumnId)
                : document.querySelector<HTMLElement>(".graph-rows")
            next?.focus()
        })
    }

    function collapseColumn(repositoryId: string, branchId: string) {
        let state = stateFor(repositoryId)
        state.collapsedColumnIds = state.collapsedColumnIds.includes(branchId)
            ? state.collapsedColumnIds.filter(id => id != branchId)
            : [...state.collapsedColumnIds, branchId]
        state.maximizedBranchId = undefined
        void persist(repositoryId).then(() => options.update()).then(() => {
            let column = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(element => element.dataset.columnId == branchId)
            ;(column?.querySelector<HTMLElement>(".expand-column") ?? column)?.focus()
        })
    }

    function focusColumn(repositoryId: string, branchId: string) {
        let state = stateFor(repositoryId)
        if (state.focusedColumnId == branchId)
            return
        state.focusedColumnId = branchId
        void persist(repositoryId)
    }

    function previewColumnMove(repositoryId: string, branchId: string, targetId: string) {
        let state = stateFor(repositoryId)
        let from = state.openedBranchIds.indexOf(branchId)
        let to = state.openedBranchIds.indexOf(targetId)
        if (from < 0 || to < 0 || from == to)
            return
        state.openedBranchIds.splice(from, 1)
        state.openedBranchIds.splice(to, 0, branchId)
        void options.update()
    }

    function commitColumnMove(repositoryId: string, branchId: string) {
        let state = stateFor(repositoryId)
        state.focusedColumnId = branchId
        state.draggingColumnId = undefined
        state.dragOriginalIds = undefined
        void persist(repositoryId).then(() => options.update())
    }

    function resizeColumn(repositoryId: string, branchId: string, width: number) {
        stateFor(repositoryId).widths[branchId] = Math.max(310, Math.round(width))
        void persist(repositoryId).then(() => options.update())
    }

    async function recoverWorktree(repositoryId: string, recovery: WorktreeRecovery, action: RecoveryRequest["action"]) {
        let state = stateFor(repositoryId)
        if (state.recoveryBusy || localMutations || worktreeActions.busy())
            return
        state.recoveryBusy = recovery.operationId
        delete state.recoveryErrors[recovery.operationId]
        localMutations++
        await options.update()

        try {
            let result = await options.api.recoverWorktree(repositoryId, { operationId: recovery.operationId, action })
            if (!result.ok)
                state.recoveryErrors[recovery.operationId] = result.error.message
            else if (result.backupPath)
                options.notify({ code: "worktree.recovered", message: `Remaining files preserved at ${result.backupPath}` })
        } catch (error) {
            state.recoveryErrors[recovery.operationId] = errorMessage(error)
        } finally {
            state.recoveryBusy = undefined
            localMutations--
        }
        await read(repositoryId, false, false)
    }

    function maximizeBranch(repositoryId: string, branchId: string) {
        let state = stateFor(repositoryId)
        state.maximizedBranchId = state.maximizedBranchId == branchId ? undefined : branchId
        void options.update()
    }

    async function applyGraphSettings(repositoryId: string, settings: RepositoryGraphSettings) {
        let state = stateFor(repositoryId)
        try {
            await options.api.setRepositoryGraphSettings(repositoryId, settings)
            state.showSettings = false
            state.graph = undefined
            await read(repositoryId, true, false)
        } catch (error) {
            options.notify({ code: "graph.settings.failed", message: errorMessage(error) })
        }
    }

    function graphKeydown(event: KeyboardEvent, repositoryId: string, rows: GraphRowLayout[]) {
        let nodeIds = rows.map(row => row.node.id)
        let state = stateFor(repositoryId)
        let index = nodeIds.findIndex(id => id == state.selectedId)
        let selected = state.graph && workspaceGraph(state.graph).branches.find(branch => branch.id == state.selectedId)
        if (event.key == "Enter" && rebase.choosing(repositoryId) && state.selectedId) {
            event.preventDefault()
            chooseRebaseDestination(repositoryId, state.selectedId)
            return
        }
        if (event.key.toLowerCase() == "m" && !event.ctrlKey && !event.altKey && !event.metaKey) {
            if (selected && rebaseable(selected)) {
                event.preventDefault()
                rebase.choose(repositoryId, selected)
            }
            return
        }
        if (event.key == "F2" || event.key == "Delete") {
            if (selected && selected.localRefs.length > 0) {
                event.preventDefault()
                localBranches.open(repositoryId, selected, event.key == "F2" ? "branch-rename" : "branch-delete")
            }
            return
        }
        if ((event.key == "ContextMenu" || event.shiftKey && event.key == "F10") && selected) {
            event.preventDefault()
            let rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : undefined
            state.contextMenu = { branchId: selected.id, x: rect?.left ?? 0, y: rect?.top ?? 0 }
            void options.update()
        } else if (event.key == "ArrowDown" || event.key == "ArrowUp") {
            event.preventDefault()
            let delta = event.key == "ArrowDown" ? 1 : -1
            let nextIndex = index < 0 && delta < 0 ? nodeIds.length - 1 : Math.max(0, Math.min(nodeIds.length - 1, index + delta))
            if (nodeIds[nextIndex]) {
                let nextId = nodeIds[nextIndex]
                state.pendingGraphBranchId = undefined
                state.selectedId = nextId
                let nodeIndex = rows.findIndex(row => row.node.id == nextId)
                if (nodeIndex >= 0) {
                    let top = nodeIndex * graphRowHeight
                    if (top < state.graphScrollTop)
                        state.graphScrollTop = top
                    else if (top + graphRowHeight > state.graphScrollTop + state.graphViewportHeight)
                        state.graphScrollTop = Math.max(0, top + graphRowHeight - state.graphViewportHeight)
                }
                void options.update().then(() => {
                    let rows = document.querySelector<HTMLElement>(".graph-rows")
                    if (rows)
                        rows.scrollTop = state.graphScrollTop
                })
            }
        } else if (event.key == "Enter" && selected) {
            event.preventDefault()
            openBranch(repositoryId, selected.id)
        } else if ((event.key == "ArrowLeft" || event.key == "ArrowRight") && selected) {
            event.preventDefault()
            // Branches stack on a whole Branch Node, so collapsing any identity at its tip collapses them all.
            let nodeId = branchNodeFor(state.graph!, selected.id)!.id
            state.collapsedBranchIds = event.key == "ArrowLeft"
                ? [...new Set([...state.collapsedBranchIds, nodeId])]
                : state.collapsedBranchIds.filter(id => id != nodeId)
            void options.update()
        } else if (event.key == "Escape" && state.maximizedBranchId) {
            state.maximizedBranchId = undefined
            void options.update()
        }
    }

    function openBranch(repositoryId: string, branchId: string) {
        let state = stateFor(repositoryId)
        state.pendingGraphBranchId = undefined
        if (!state.openedBranchIds.includes(branchId))
            state.openedBranchIds.push(branchId)
        state.collapsedColumnIds = state.collapsedColumnIds.filter(id => id != branchId)
        state.selectedId = branchId
        state.focusedColumnId = branchId
        state.widths[branchId] ??= defaultColumnWidth
        state.maximizedBranchId = undefined
        void persist(repositoryId).then(() => options.update()).then(() =>
            [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(column => column.dataset.columnId == branchId)?.focus()
        )
    }

    function chooseRebaseDestination(repositoryId: string, targetId: string) {
        let state = stateFor(repositoryId), sourceId = rebase.choosing(repositoryId)
        let graph = state.graph && workspaceGraph(state.graph)
        let source = graph?.branches.find(branch => branch.id == sourceId), target = graph?.branches.find(branch => branch.id == targetId)
        if (!graph || !source)
            return
        if (target && canRebaseOnto(graph, source, target))
            void rebase.start(repositoryId, graph, source.id, target.id)
        else {
            options.notify({ code: "rebase.choose", message: `Choose a branch other than ${source.name} and the branches stacked on it.` })
            void options.update()
        }
    }

    async function activateLensResult(result: LensResult) {
        if (result.kind == "command") {
            moveColumn(result.repositoryId, result.nodeId, result.delta)
            closeLens()
            return
        }
        if (result.repositoryId != activeRepositoryId)
            await options.selectRepository(result.repositoryId)
        activeRepositoryId = result.repositoryId
        if (result.kind == "branch") {
            let state = stateFor(result.repositoryId)
            state.graphCollapsed = false
            state.pendingGraphBranchId = result.nodeId
            if (!state.graph || !branchNodeFor(state.graph, result.nodeId)) {
                state.showAll = true
                void read(result.repositoryId, false, false)
            }
        }
        closeLens()
        await options.update()
        document.querySelector<HTMLElement>(".graph-rows")?.focus({ preventScroll: true })
        await revealPendingGraphBranch(result.repositoryId)
    }

    async function revealPendingGraphBranch(repositoryId: string) {
        let state = stateFor(repositoryId)
        let graph = state.graph
        let branchId = state.pendingGraphBranchId
        let branch = graph && branchId && branchNodeFor(graph, branchId)
        if (!graph || !branch || !branchId || repositoryId != activeRepositoryId)
            return

        let ancestors = new Set<string>()
        while (branch?.base.status == "known" && !ancestors.has(branch.base.branchId)) {
            ancestors.add(branch.base.branchId)
            branch = branchNodeFor(graph, branch.base.branchId)
        }
        state.collapsedBranchIds = state.collapsedBranchIds.filter(id => !ancestors.has(id))
        let branches = branchesForDisplay(graph, state.collapsedBranchIds).flatMap(branch => localIdentities(graph, branch))
        let index = layoutBranchGraph(graph, branches).rows.findIndex(row => row.node.id == branchId)
        if (index >= 0) {
            state.pendingGraphBranchId = undefined
            state.selectedId = branchId
            state.marker = undefined
            state.graphScrollTop = index * graphRowHeight
            await options.update()
            if (repositoryId == activeRepositoryId && state.selectedId == branchId) {
                let rows = document.querySelector<HTMLElement>(".graph-rows")
                if (rows) {
                    rows.scrollTop = state.graphScrollTop
                    rows.focus({ preventScroll: true })
                }
            }
        }
    }

    function selectNode(repositoryId: string, nodeId: string) {
        let state = stateFor(repositoryId)
        state.pendingGraphBranchId = undefined
        state.selectedId = nodeId
        state.marker = undefined
        void options.update()
    }

    function moveColumn(repositoryId: string, branchId: string, delta: number) {
        let state = stateFor(repositoryId)
        let index = state.openedBranchIds.indexOf(branchId)
        let target = index + delta
        if (index < 0 || target < 0 || target >= state.openedBranchIds.length) {
            options.notify({ code: "column.boundary", message: target < 0 ? "Already first column." : "Already last column.", transient: true })
            return
        }
        state.openedBranchIds.splice(index, 1)
        state.openedBranchIds.splice(target, 0, branchId)
        state.focusedColumnId = branchId
        void persist(repositoryId).then(() => options.update()).then(() => {
            let column = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(candidate => candidate.dataset.columnId == branchId)
            column?.focus({ preventScroll: true })
            column?.scrollIntoView({ block: "nearest", inline: "nearest" })
        })
    }

    function closeLens() {
        lensOpen = false
        void options.update().then(() => restoreFocus?.focus())
    }

    /** Opens, or focuses, the Branch Comparison Column from `from` to `to`, placing a new one beside its source column. */
    function openComparison(repositoryId: string, sourceColumnId: string, from: ComparisonRef, to: ComparisonRef) {
        let state = stateFor(repositoryId)
        let id = comparisonColumnId(from, to)
        state.comparisons[id] = { from, to }
        if (!state.openedBranchIds.includes(id))
            state.openedBranchIds.splice(state.openedBranchIds.indexOf(sourceColumnId) + 1, 0, id)
        state.collapsedColumnIds = state.collapsedColumnIds.filter(column => column != id)
        state.focusedColumnId = id
        state.widths[id] ??= defaultColumnWidth
        state.maximizedBranchId = undefined
        void persist(repositoryId).then(() => options.update()).then(() =>
            [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(column => column.dataset.columnId == id)?.focus()
        )
    }

    function renameComparisons(state: RepositoryGraphState, columns: WorkspaceColumn[], oldRef: string, newRef: string) {
        for (let [id, comparison] of Object.entries(state.comparisons)) {
            let renamed = { from: renameComparisonRef(comparison.from, oldRef, newRef), to: renameComparisonRef(comparison.to, oldRef, newRef) }
            let newId = comparisonColumnId(renamed.from, renamed.to)
            if (newId != id) {
                delete state.comparisons[id]
                state.comparisons[newId] = renamed
                state.openedBranchIds = state.openedBranchIds.map(candidate => candidate == id ? newId : candidate)
                state.collapsedColumnIds = state.collapsedColumnIds.map(candidate => candidate == id ? newId : candidate)
                if (state.focusedColumnId == id)
                    state.focusedColumnId = newId
                state.widths[newId] = state.widths[id] ?? defaultColumnWidth
                state.diffLayouts[newId] = state.diffLayouts[id] ?? "unified"
                for (let column of columns) {
                    if (column.id == id && column.kind == "comparison")
                        Object.assign(column, { id: newId, ...renamed })
                }
            }
        }
    }

    function openLens() {
        if (lensOpen)
            return lensInput?.focus()

        restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        lensOpen = true
        lensQuery = ""
        for (let repository of currentWorkspace?.repositories ?? []) {
            if (repository.status == "available") {
                stateFor(repository.id).lensGraph = undefined
                void read(repository.id, false, true)
            }
        }
        void options.update()
    }

    async function ensure(repositoryId: string, refreshRemoteAfter = false) {
        if (!stateFor(repositoryId).graph)
            await read(repositoryId, false, false)
        let state = stateFor(repositoryId)
        if (refreshRemoteAfter && state.graph && !state.remoteRefreshed)
            await read(repositoryId, true, true)
    }

    async function read(repositoryId: string, refreshRemote: boolean, quiet: boolean) {
        let state = stateFor(repositoryId)
        if (
            state.loading || state.refreshing
            || (quiet && (worktreeActions.busy() || localBranches.busy() || localMutations > 0 || pullLatest.busy(repositoryId)))
        ) {
            return
        }
        // A quiet read shows nothing until it finds a difference; `refreshing` only guards against overlapping reads.
        let changed = !quiet || state.error != undefined
        state.error = undefined
        if (state.graph)
            state.refreshing = true
        else
            state.loading = true
        if (!quiet)
            await options.update()

        let allBranches = state.showAll
        try {
            let result = await options.api.readBranchGraph(repositoryId, refreshRemote, allBranches)
            if (result.ok) {
                let recoveries = result.worktreeRecoveries ?? []
                if (
                    !changed
                    && (refreshRemote || JSON.stringify(state.graph) != JSON.stringify(result.graph)
                        || JSON.stringify(state.worktreeRecoveries) != JSON.stringify(recoveries))
                ) {
                    changed = true
                }
                state.worktreeRecoveries = recoveries
                let columns = workspaceGraph(result.graph)
                let validColumnIds = new Set(
                    [...columns.branches, ...columns.virtualBranches].map(branch => branch.id)
                        .concat(recoveries.map(recoveryColumnId), Object.keys(state.comparisons)),
                )
                let removedColumns = state.openedBranchIds.filter(id => !validColumnIds.has(id) && !id.startsWith("recovery:"))
                let previousPatterns = state.graph?.remotePatterns.join(", ")
                state.graph = result.graph
                state.openedBranchIds.push(...inspection.refresh(repositoryId, columns))
                if (refreshRemote)
                    state.remoteRefreshed = true
                // Quiet refreshes must not wipe a draft the user is still typing into the settings panel.
                let savedPatterns = result.graph.remotePatterns.join(", ")
                if (!state.showSettings || savedPatterns != previousPatterns)
                    state.patterns = savedPatterns
                state.openedBranchIds = state.openedBranchIds.filter(id => validColumnIds.has(id))
                if (!state.focusedColumnId || !state.openedBranchIds.includes(state.focusedColumnId))
                    state.focusedColumnId = state.openedBranchIds[0]
                for (let column of [...columns.branches, ...columns.virtualBranches].filter(column => state.openedBranchIds.includes(column.id)))
                    state.widths[column.id] ??= defaultColumnWidth

                let savedRepository = options.workspace().repositories.find(repository => repository.id == repositoryId)
                if (savedRepository?.status == "available") {
                    let reconciled = reconcileWorktreeColumns(savedRepository.columns, result.graph, savedRepository.focusedColumnId, recoveries)
                    state.openedBranchIds = [
                        ...reconciled.columns.map(column => column.id),
                        ...state.openedBranchIds.filter(id => !savedRepository.columns.some(column => column.id == id)),
                    ]
                    for (let column of reconciled.columns) {
                        state.widths[column.id] = column.width
                        state.diffLayouts[column.id] = column.diffLayout ?? "unified"
                        state.collapsedColumnIds = state.collapsedColumnIds.filter(id => id != column.id)
                        if (column.collapsed)
                            state.collapsedColumnIds.push(column.id)
                    }
                    state.focusedColumnId = reconciled.focused
                    savedRepository.columns = reconciled.columns
                }

                if (savedRepository?.status == "available" && !savedRepository.layoutInitialized) {
                    let selectedPath = savedRepository.info.selectedWorktree
                    let initialColumn = columns.branches.find(branch => branch.checkedOut.some(worktree => worktree.path == selectedPath))
                        ?? result.graph.virtualBranches.find(branch => branch.worktree.path == selectedPath)
                    if (initialColumn) {
                        state.openedBranchIds.push(initialColumn.id)
                        state.focusedColumnId = initialColumn.id
                        state.widths[initialColumn.id] = defaultColumnWidth
                    }
                    savedRepository.layoutInitialized = true
                }

                for (let column of [...columns.branches.filter(branch => branch.checkedOut.length > 0), ...columns.virtualBranches]) {
                    let worktrees = column.kind == "branch" ? column.checkedOut : [column.worktree]
                    if (!state.openedBranchIds.includes(column.id) && !worktrees.some(worktree => recoveries.some(item => item.path == worktree.path)))
                        state.openedBranchIds.push(column.id)
                    state.widths[column.id] ??= defaultColumnWidth
                }

                state.openedBranchIds = [...new Set(state.openedBranchIds)]
                if (state.maximizedBranchId && !state.openedBranchIds.includes(state.maximizedBranchId))
                    state.maximizedBranchId = undefined
                if (!state.focusedColumnId || !state.openedBranchIds.includes(state.focusedColumnId))
                    state.focusedColumnId = state.openedBranchIds[0]
                // Hiding the selected node, by narrowing the graph or deleting the branch, clears Graph Selection.
                if (
                    state.selectedId
                    && !result.graph.branches.some(branch => localIdentities(result.graph, branch).some(identity => identity.id == state.selectedId))
                    && !result.graph.tags.some(tag => tag.id == state.selectedId)
                    && !result.graph.virtualBranches.some(branch => branch.id == state.selectedId)
                ) {
                    state.selectedId = undefined
                }

                if (removedColumns.length > 0) {
                    options.notify({
                        code: "branch.removed",
                        message: `${
                            removedColumns.length == 1 ? "An open branch" : `${removedColumns.length} open branches`
                        } no longer exists; its column was closed.`,
                    })
                }

                await persist(repositoryId)
                if (lensOpen && !options.signal.aborted) {
                    let search = allBranches ? result : await options.api.readBranchGraph(repositoryId, false, true)
                    if (search.ok) {
                        state.lensGraph = search.graph
                        changed = true
                    }
                }
            } else if (result.error.code != "git.cancelled") {
                changed = true
                let refreshedWorkspace = (await options.api.getState()).workspace
                if (refreshedWorkspace.repositories.some(repository => repository.id == repositoryId && repository.status == "missing"))
                    options.workspaceChanged(refreshedWorkspace)
                state.error = result.error.message
                if (state.graph)
                    options.notify({ code: result.error.code, message: `Branch Graph refresh failed: ${result.error.message}` })
            }
        } catch (error) {
            changed = true
            state.error = errorMessage(error)
        } finally {
            state.loading = false
            state.refreshing = false
            if (changedWhileReading.delete(repositoryId) && repositoryId == activeRepositoryId)
                void read(repositoryId, false, true)
            else if (state.showAll != allBranches)
                void read(repositoryId, false, false)
            if (changed || !state.focusRestored)
                await options.update()
            if (!state.focusRestored && state.focusedColumnId) {
                state.focusRestored = true
                let column = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(candidate =>
                    candidate.dataset.columnId == state.focusedColumnId
                )
                column?.focus({ preventScroll: true })
                column?.scrollIntoView({ block: "nearest", inline: "nearest" })
            }
            await revealPendingGraphBranch(repositoryId)
        }
    }

    async function persist(repositoryId: string) {
        let workspace = options.workspace()
        let repository = workspace.repositories.find(candidate => candidate.id == repositoryId)
        let state = stateFor(repositoryId)
        if (!repository || !state.graph)
            return
        repository.columns = state.openedBranchIds.flatMap((id): WorkspaceColumn[] => {
            let recovery = state.worktreeRecoveries.find(item => recoveryColumnId(item) == id)
            if (recovery) {
                return [{
                    ...recoveryWorkspaceColumn(recovery, state.widths[id] ?? defaultColumnWidth),
                    collapsed: state.collapsedColumnIds.includes(id),
                    diffLayout: state.diffLayouts[id] ?? "unified",
                }]
            }
            let branch = workspaceGraph(state.graph!).branches.find(candidate => candidate.id == id)
            if (branch) {
                return [{
                    kind: "branch" as const,
                    id,
                    ref: branch.preferredRef,
                    lastSeenObjectId: branch.tip,
                    width: state.widths[id] ?? defaultColumnWidth,
                    collapsed: state.collapsedColumnIds.includes(id),
                    diffLayout: state.diffLayouts[id] ?? "unified",
                    ...(backingPath(repositoryId, id) ? { worktreePath: backingPath(repositoryId, id) } : {}),
                    worktreeId: branch.checkedOut.find(worktree => worktree.path == backingPath(repositoryId, id))?.id,
                }]
            }
            let virtual = state.graph!.virtualBranches.find(candidate => candidate.id == id)
            if (virtual) {
                return [{
                    kind: "virtual" as const,
                    id,
                    worktreePath: virtual.worktree.path,
                    worktreeId: virtual.worktree.id,
                    lastSeenObjectId: virtual.objectId,
                    width: state.widths[id] ?? defaultColumnWidth,
                    collapsed: state.collapsedColumnIds.includes(id),
                    diffLayout: state.diffLayouts[id] ?? "unified",
                }]
            }
            let comparison = state.comparisons[id]

            return comparison
                ? [{
                    kind: "comparison" as const,
                    id,
                    ...comparison,
                    width: state.widths[id] ?? defaultColumnWidth,
                    collapsed: state.collapsedColumnIds.includes(id),
                    diffLayout: state.diffLayouts[id] ?? "unified",
                }]
                : []
        })
        repository.focusedColumnId = state.focusedColumnId

        try {
            options.workspaceChanged(await options.api.updateWorkspace(workspace))
        } catch (error) {
            options.notify({ code: "workspace.write-failed", message: errorMessage(error) })
        }
    }

    function backingPath(repositoryId: string, columnId: string) {
        let recovery = stateFor(repositoryId).worktreeRecoveries.find(item => recoveryColumnId(item) == columnId)
        if (recovery)
            return recovery.path
        let graph = stateFor(repositoryId).graph
        let virtual = graph?.virtualBranches.find(branch => branch.id == columnId)
        if (virtual)
            return virtual.worktree.path
        let branch = graph && workspaceGraph(graph).branches.find(branch => branch.id == columnId)
        let column = options.workspace().repositories.find(repository => repository.id == repositoryId)?.columns.find(column => column.id == columnId)
        let saved = column?.kind == "comparison" ? undefined : column?.worktreePath

        return branch?.checkedOut.find(worktree => worktree.path == saved)?.path ?? (branch?.checkedOut.length == 1 ? branch.checkedOut[0].path : undefined)
    }

    function stateFor(repositoryId: string) {
        let state = states.get(repositoryId)
        if (!state) {
            let saved = options.workspace().repositories.find(repository => repository.id == repositoryId)
            state = {
                worktreeRecoveries: [],
                recoveryErrors: {},
                diffLayouts: Object.fromEntries(saved?.columns.map(column => [column.id, column.diffLayout ?? "unified"]) ?? []),
                loading: false,
                refreshing: false,
                showAll: false,
                openedBranchIds: saved?.columns.map(column => column.id) ?? [],
                widths: Object.fromEntries(saved?.columns.map(column => [column.id, column.width]) ?? []),
                focusedColumnId: saved?.focusedColumnId,
                focusRestored: false,
                showSettings: false,
                patterns: "",
                graphCollapsed: true,
                collapsedColumnIds: saved?.columns.filter(column => column.collapsed).map(column => column.id) ?? [],
                comparisons: Object.fromEntries(
                    saved?.columns.flatMap(column => column.kind == "comparison" ? [[column.id, { from: column.from, to: column.to }]] : []) ?? [],
                ),
                collapsedBranchIds: [],
                remoteRefreshed: false,
                graphScrollTop: 0,
                graphViewportHeight: 600,
            }
            states.set(repositoryId, state)
        }
        return state
    }
}

function windowNodes(nodes: GraphRowLayout[], scrollTop: number, viewportHeight: number) {
    let overscan = 6
    let maximumScrollTop = Math.max(0, nodes.length * graphRowHeight - viewportHeight)
    let effectiveScrollTop = Math.min(scrollTop, maximumScrollTop)
    let start = Math.max(0, Math.floor(effectiveScrollTop / graphRowHeight) - overscan)
    let end = Math.min(nodes.length, Math.ceil((effectiveScrollTop + viewportHeight) / graphRowHeight) + overscan)

    return {
        start,
        nodes: nodes.slice(start, end),
        before: start * graphRowHeight,
        after: (nodes.length - end) * graphRowHeight,
    }
}

// The Engine already chose which branches form the graph; only collapsed Base chains hide rows here.
function branchesForDisplay(graph: BranchGraph, collapsedBranchIds: string[]) {
    let collapsed = new Set(collapsedBranchIds)

    return graph.branches.filter(branch => {
        let parent = branch.base.status == "known" ? branch.base.branchId : undefined
        let visited = new Set<string>()
        while (parent && !visited.has(parent)) {
            if (collapsed.has(parent))
                return false
            visited.add(parent)
            let parentBranch = graph.branches.find(candidate => candidate.id == parent)
            parent = parentBranch?.base.status == "known" ? parentBranch.base.branchId : undefined
        }

        return true
    })
}

function lensResults(workspace: Workspace, states: Map<string, RepositoryGraphState>, activeId: string | undefined, query: string): LensResult[] {
    let needle = query.trim().toLocaleLowerCase()
    if (!needle)
        return []
    let results: LensResult[] = []
    let focusedColumnId = activeId ? states.get(activeId)?.focusedColumnId : undefined
    if (activeId && focusedColumnId) {
        for (let command of [{ label: "Move column left", delta: -1 }, { label: "Move column right", delta: 1 }]) {
            let score = textScore(command.label, needle)
            if (score > 0) {
                results.push({
                    kind: "command",
                    repositoryId: activeId,
                    nodeId: focusedColumnId,
                    label: command.label,
                    detail: command.delta < 0 ? "Ctrl+<" : "Ctrl+>",
                    score,
                    delta: command.delta,
                })
            }
        }
    }
    for (let repository of workspace.repositories) {
        let name = repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name
        let repoScore = textScore(name, needle)
        if (repoScore > 0) {
            results.push({
                kind: "repository",
                repositoryId: repository.id,
                nodeId: repository.id,
                label: name,
                detail: repository.status == "available" ? repository.info.selectedWorktree : "Unavailable",
                score: repoScore,
            })
        }
        let state = states.get(repository.id)
        let graph = state?.lensGraph ?? state?.graph
        for (let branch of graph ? workspaceGraph(graph).branches : []) {
            let score = Math.max(...[branch.name, ...branch.aliases].map(value => textScore(value, needle)))
            if (score > 0)
                results.push({ kind: "branch", repositoryId: repository.id, nodeId: branch.id, label: branch.name, detail: name, score })
        }
    }

    return results.sort((left, right) =>
        Number(right.repositoryId == activeId) - Number(left.repositoryId == activeId) || right.score - left.score
        || left.label.localeCompare(right.label, undefined, { numeric: true })
    )
}

function textScore(value: string, query: string) {
    let text = value.toLocaleLowerCase()
    if (text == query)
        return 4
    if (text.startsWith(query))
        return 3
    if (text.split(/[\/_.-]+/).some(part => part.startsWith(query)))
        return 2

    return text.includes(query) ? 1 : 0
}
