import type { AvailableOpenRepository, BranchGraph, BranchGraphBranchNode, BranchGraphMarker, RepositoryGraphSettings, Workspace, WorkspaceColumn } from "@laneway/shared"
import type { DiffLayout } from "@laneway/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import radio from "remix/ui/radio"
import { graphLineColor, graphRowHeight, type GraphRowLayout, layoutBranchGraph } from "./branch-graph-layout"
import { CommandLens } from "./command-lens"
import { createConflictResolution } from "./conflict-resolution"
import { errorMessage, type NoticeState } from "./feedback"
import { Icon } from "./icons"
import { createInspection } from "./inspection"
import { createLocalBranchActions } from "./local-branch-actions"
import { createPullLatest, type PullControl } from "./pull-latest"
import { baseName, RepositoryRail } from "./repository-rail"
import { createWorktreeActions } from "./worktree-actions"
import { reconcileWorktreeColumns, workspaceGraph } from "./worktree-columns"

const defaultColumnWidth = 380

interface RepositoryGraphState {
    graph?: BranchGraph
    loading: boolean
    refreshing: boolean
    error?: string
    showAll: boolean
    selectedId?: string
    openedBranchIds: string[]
    maximizedBranchId?: string
    showSettings: boolean
    patterns: string
    marker?: BranchGraphMarker
    graphCollapsed: boolean
    collapsedColumnIds: string[]
    collapsedBranchIds: string[]
    remoteRefreshed: boolean
    baseCandidateSelections: Record<string, string>
    graphScrollTop: number
    graphViewportHeight: number
    widths: Record<string, number>
    focusedColumnId?: string
    draggingColumnId?: string
    dragOriginalIds?: string[]
    focusRestored: boolean
    diffLayouts: Record<string, DiffLayout>
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

export function createBranchWorkspace(options: BranchWorkspaceOptions): BranchWorkspace {
    const states = new Map<string, RepositoryGraphState>()
    let activeRepositoryId: string | undefined
    let lensOpen = false
    let lensQuery = ""
    let lensInput: HTMLInputElement | undefined
    let restoreFocus: HTMLElement | null = null
    let currentWorkspace: Workspace | undefined
    let comparisonSource: { repositoryId: string; fromRef: string; replaceId?: string; chooseFrom?: boolean; chooseFirst?: boolean } | undefined
    const worktreeActions = createWorktreeActions({
        api: options.api,
        update: options.update,
        completed: async (repositoryId, request, columnId) => {
            const repository = options.workspace().repositories.find(item => item.id == repositoryId)
            const destination = repository?.columns.find(item => item.id == columnId)
            if (request.action == "switch" && destination && !destination.worktreePath) {
                const source = repository?.columns.find(item => item.worktreePath == request.path)
                destination.worktreePath = request.path
                destination.worktreeId = source?.worktreeId
                if (source) {
                    source.worktreePath = undefined
                    source.worktreeId = undefined
                }
            }
            await read(repositoryId, false, false)
        },
    })
    let localMutations = 0
    const conflicts = createConflictResolution({
        api: options.api,
        update: options.update,
        changed: repositoryId => read(repositoryId, false, false),
    })
    const inspection = createInspection({
        api: options.api,
        update: options.update,
        signal: options.signal,
        notify: options.notify,
        localChanged: repositoryId => read(repositoryId, false, false),
        resolveWorkingConflict: (repositoryId, subject) => conflicts.open(repositoryId, subject),
        localBusyChanged: busy => {
            localMutations += busy ? 1 : -1
        },
        createBranchAt: (repositoryId, commit) => localBranches.atCommit(repositoryId, commit),
        compareWith,
        layout: (repositoryId, columnId) => stateFor(repositoryId).diffLayouts[columnId] ?? "unified",
        saveLayout: (repositoryId, columnId, layout) => {
            stateFor(repositoryId).diffLayouts[columnId] = layout
            void persist(repositoryId).then(() => options.update())
        },
        maximized: repositoryId => stateFor(repositoryId).maximizedBranchId,
        maximize: (repositoryId, id) => maximizeBranch(repositoryId, id),
    })
    const localBranches = createLocalBranchActions({
        api: options.api,
        update: options.update,
        completed: async (repositoryId, request) => {
            const state = stateFor(repositoryId)
            if (request.action == "branch-rename") {
                const oldId = `branch:refs/heads/${request.name}`, newId = `branch:refs/heads/${request.newName}`
                state.openedBranchIds = state.openedBranchIds.map(id => id == oldId ? newId : id)
                state.collapsedColumnIds = state.collapsedColumnIds.map(id => id == oldId ? newId : id)
                if (state.focusedColumnId == oldId)
                    state.focusedColumnId = newId
                if (state.selectedId == oldId)
                    state.selectedId = newId
                state.widths[newId] = state.widths[oldId] ?? defaultColumnWidth
                state.diffLayouts[newId] = state.diffLayouts[oldId] ?? "unified"
                const repository = options.workspace().repositories.find(item => item.id == repositoryId)
                for (const column of repository?.columns ?? []) {
                    if (column.id == oldId && column.kind == "branch") {
                        column.id = newId
                        column.ref = `refs/heads/${request.newName}`
                    }
                }
                inspection.renameBranch(repositoryId, `refs/heads/${request.name}`, `refs/heads/${request.newName}`)
            }
            await read(repositoryId, false, false)
            if (request.action == "branch-create")
                openBranch(repositoryId, `branch:refs/heads/${request.name}`)
        },
    })

    const pullLatest = createPullLatest({
        api: options.api,
        update: options.update,
        signal: options.signal,
        graph: repositoryId => stateFor(repositoryId).graph,
        scope: repositoryId => {
            // Scope freezes at activation: every open column, collapsed or not, contributes its local branch.
            const state = stateFor(repositoryId)
            const branches = state.graph ? workspaceGraph(state.graph).branches : []
            return state.openedBranchIds.flatMap(id => {
                const branch = branches.find(candidate => candidate.id == id)
                return branch && branch.localRefs.includes(branch.preferredRef) ? [branch.preferredRef] : []
            })
        },
        completed: repositoryId => read(repositoryId, false, false),
        notify: options.notify,
        openBranch: (repositoryId, branchName) => openBranch(repositoryId, `branch:refs/heads/${branchName}`),
    })

    const interval = window.setInterval(() => {
        if (activeRepositoryId && document.visibilityState == "visible" && document.hasFocus())
            void read(activeRepositoryId, false, true)
    }, 5_000)
    const onFocus = () => {
        if (activeRepositoryId)
            void read(activeRepositoryId, false, true)
    }
    const onShortcut = (event: KeyboardEvent) => {
        if (event.defaultPrevented)
            return
        if (
            activeRepositoryId && event.ctrlKey && !event.altKey && (event.key.toLowerCase() == "z" || event.key.toLowerCase() == "y")
            && !event.composedPath().some(node => node instanceof HTMLElement && node.matches('input, textarea, select, [contenteditable="true"]'))
        ) {
            event.preventDefault()
            void worktreeActions.transition(activeRepositoryId, event.shiftKey || event.key.toLowerCase() == "y" ? "redo" : "undo")
            return
        }
        if (event.ctrlKey && event.key.toLowerCase() == "k") {
            event.preventDefault()
            openLens()
        } else if (event.key == "Escape" && activeRepositoryId) {
            const state = stateFor(activeRepositoryId)
            if (state.showSettings) {
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
        window.removeEventListener("focus", onFocus)
        window.removeEventListener("keydown", onShortcut)
        for (const id of states.keys()) {
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
            const state = stateFor(active.id)
            inspection.retain(active.id, state.openedBranchIds, state.graph && workspaceGraph(state.graph))
            const graph = state.graph
            const visibleBranches = graph ? branchesForDisplay(graph, state.showAll, state.collapsedBranchIds) : []
            const layout = graph ? layoutBranchGraph(graph, visibleBranches) : { rows: [], width: 26 }
            const selectableIds = layout.rows.map(row => row.node.id)
            const nodeWindow = windowNodes(layout.rows, state.graphScrollTop, state.graphViewportHeight)
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
                            <div role="menu" aria-label="Branch actions">
                                <button
                                    type="button"
                                    role="menuitem"
                                    mix={[
                                        ref(button => button.focus()),
                                        on("click", () => {
                                            const branch = workspaceGraph(graph).branches.find(branch => branch.id == state.contextMenu?.branchId)
                                            state.contextMenu = undefined
                                            if (branch)
                                                compareWith(active.id, branch.preferredRef)
                                        }),
                                    ]}
                                >
                                    Compare with…
                                </button>
                                {(["branch-create", "branch-rename", "branch-delete"] as const).map(action => {
                                    const branch = workspaceGraph(graph).branches.find(branch => branch.id == state.contextMenu?.branchId)
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
                                        <button
                                            type="button"
                                            class={state.showAll ? "active" : ""}
                                            aria-pressed={state.showAll}
                                            mix={[graphActionsButton, on("click", () => toggleAll(active.id))]}
                                        >
                                            {state.showAll ? "Involved only" : "Show all"}
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
                                        <GraphSummary graph={graph} visibleCount={visibleBranches.length} />
                                        <BaseUnresolved
                                            branches={visibleBranches}
                                            selections={state.baseCandidateSelections}
                                            choose={(branchId, candidateId) => {
                                                state.baseCandidateSelections[branchId] = candidateId
                                                void options.update()
                                            }}
                                        />
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
                                            {nodeWindow.nodes.map(row =>
                                                row.node.kind == "branch"
                                                    ? (
                                                        <BranchRow
                                                            branch={row.node.branch}
                                                            rail={<GraphRail row={row} />}
                                                            selected={state.selectedId == row.node.id}
                                                            select={() => selectNode(active.id, row.node.id)}
                                                            open={() => openBranch(active.id, row.node.id)}
                                                            selectMarker={marker => selectMarker(active.id, row.node.id, marker)}
                                                            contextMenu={event => {
                                                                event.preventDefault()
                                                                state.contextMenu = { branchId: row.node.id, x: event.clientX, y: event.clientY }
                                                                void options.update()
                                                            }}
                                                        />
                                                    )
                                                    : (
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
                                            )}
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
                                    worktreePath={id => backingPath(active.id, id)}
                                    worktreeControls={column => worktreeActions.controls(active.id, column, backingPath(active.id, column.id), graph)}
                                    dropBranch={(columnId, branchRef) => {
                                        const path = backingPath(active.id, columnId)
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
            const state = stateFor(active.id)
            const graph = state.graph && workspaceGraph(state.graph)
            if (!graph)
                return null
            const columns = state.openedBranchIds.map(id =>
                graph.branches.find(branch => branch.id == id) ?? graph.virtualBranches.find(branch => branch.id == id)
            ).filter(column => column != undefined)
            if (columns.length == 0)
                return null
            return (
                <div class="column-tabs" role="tablist" aria-label="Open columns" mix={columnTabs}>
                    {columns.map(column => {
                        const identity = columnIdentity(column, backingPath(active.id, column.id))
                        const collapsed = state.collapsedColumnIds.includes(column.id)
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
                                        const element = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(node =>
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
                    prompt={comparisonSource
                        ? comparisonSource.chooseFirst
                            ? "Choose replacement source branch"
                            : `${comparisonSource.chooseFrom ? "Choose replacement source to compare to" : "Compare with"} ${
                                comparisonSource.fromRef.replace(/^refs\/(heads|remotes)\//, "")
                            }`
                        : undefined}
                    query={lensQuery}
                    results={comparisonSource
                        ? (stateFor(comparisonSource.repositoryId).graph?.branches ?? [])
                            .filter(branch => branch.preferredRef != comparisonSource!.fromRef
                                && branch.name.toLocaleLowerCase().includes(lensQuery.trim().toLocaleLowerCase())
                            )
                            .map(branch => ({
                                kind: "branch" as const,
                                repositoryId: comparisonSource!.repositoryId,
                                nodeId: branch.id,
                                label: branch.name,
                                detail: branch.preferredRef,
                                score: 1,
                            }))
                        : lensResults(workspace, states, activeRepositoryId, lensQuery)}
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

    function stateFor(repositoryId: string) {
        let state = states.get(repositoryId)
        if (!state) {
            const saved = options.workspace().repositories.find(repository => repository.id == repositoryId)
            state = {
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
                collapsedBranchIds: [],
                remoteRefreshed: false,
                baseCandidateSelections: {},
                graphScrollTop: 0,
                graphViewportHeight: 600,
            }
            states.set(repositoryId, state)
        }
        return state
    }

    async function ensure(repositoryId: string, refreshRemoteAfter = false) {
        if (!stateFor(repositoryId).graph)
            await read(repositoryId, false, false)
        const state = stateFor(repositoryId)
        if (refreshRemoteAfter && state.graph && !state.remoteRefreshed)
            await read(repositoryId, true, true)
    }

    async function read(repositoryId: string, refreshRemote: boolean, quiet: boolean) {
        const state = stateFor(repositoryId)
        if (
            state.loading || state.refreshing
            || (quiet && (worktreeActions.busy() || localBranches.busy() || localMutations > 0 || pullLatest.busy(repositoryId)))
        ) {
            return
        }
        state.error = undefined
        if (state.graph)
            state.refreshing = true
        else
            state.loading = true
        if (!quiet)
            await options.update()
        else
            void options.update()
        try {
            const result = await options.api.readBranchGraph(repositoryId, refreshRemote)
            if (result.ok) {
                const columns = workspaceGraph(result.graph)
                const validColumnIds = new Set([...columns.branches, ...columns.virtualBranches].map(branch => branch.id))
                const removedColumns = state.openedBranchIds.filter(id => !validColumnIds.has(id))
                state.graph = result.graph
                state.openedBranchIds.push(...inspection.refreshComparisons(repositoryId, columns))
                if (refreshRemote)
                    state.remoteRefreshed = true
                state.patterns = result.graph.remotePatterns.join(", ")
                state.openedBranchIds = state.openedBranchIds.filter(id => validColumnIds.has(id))
                if (!state.focusedColumnId || !state.openedBranchIds.includes(state.focusedColumnId))
                    state.focusedColumnId = state.openedBranchIds[0]
                for (const column of [...columns.branches, ...columns.virtualBranches].filter(column => state.openedBranchIds.includes(column.id)))
                    state.widths[column.id] ??= defaultColumnWidth
                const savedRepository = options.workspace().repositories.find(repository => repository.id == repositoryId)
                if (savedRepository?.status == "available") {
                    const reconciled = reconcileWorktreeColumns(savedRepository.columns, result.graph, savedRepository.focusedColumnId)
                    state.openedBranchIds = [
                        ...reconciled.columns.map(column => column.id),
                        ...state.openedBranchIds.filter(id => !savedRepository.columns.some(column => column.id == id)),
                    ]
                    for (const column of reconciled.columns) {
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
                    const selectedPath = savedRepository.info.selectedWorktree
                    const initialColumn = columns.branches.find(branch => branch.checkedOut.some(worktree => worktree.path == selectedPath))
                        ?? result.graph.virtualBranches.find(branch => branch.worktree.path == selectedPath)
                    if (initialColumn) {
                        state.openedBranchIds.push(initialColumn.id)
                        state.focusedColumnId = initialColumn.id
                        state.widths[initialColumn.id] = defaultColumnWidth
                    }
                    savedRepository.layoutInitialized = true
                }
                for (const column of [...columns.branches.filter(branch => branch.checkedOut.length > 0), ...columns.virtualBranches]) {
                    if (!state.openedBranchIds.includes(column.id))
                        state.openedBranchIds.push(column.id)
                    state.widths[column.id] ??= defaultColumnWidth
                }
                state.openedBranchIds = [...new Set(state.openedBranchIds)]
                if (!state.focusedColumnId || !state.openedBranchIds.includes(state.focusedColumnId))
                    state.focusedColumnId = state.openedBranchIds[0]
                state.baseCandidateSelections = Object.fromEntries(
                    Object.entries(state.baseCandidateSelections).filter(([branchId, candidateId]) => {
                        const branch = result.graph.branches.find(candidate => candidate.id == branchId)
                        return branch?.base.status == "ambiguous" && branch.base.candidates.some(candidate => candidate.branchId == candidateId)
                    }),
                )
                if (removedColumns.length > 0) {
                    options.notify({
                        code: "branch.removed",
                        message: `${
                            removedColumns.length == 1 ? "An open branch" : `${removedColumns.length} open branches`
                        } no longer exists; its column was closed.`,
                    })
                }
                await persist(repositoryId)
            } else if (result.error.code != "git.cancelled") {
                const refreshedWorkspace = (await options.api.getState()).workspace
                if (refreshedWorkspace.repositories.some(repository => repository.id == repositoryId && repository.status == "missing"))
                    options.workspaceChanged(refreshedWorkspace)
                state.error = result.error.message
                if (state.graph)
                    options.notify({ code: result.error.code, message: `Branch Graph refresh failed: ${result.error.message}` })
            }
        } catch (error) {
            state.error = errorMessage(error)
        } finally {
            state.loading = false
            state.refreshing = false
            await options.update()
            if (!state.focusRestored && state.focusedColumnId) {
                state.focusRestored = true
                const column = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(candidate =>
                    candidate.dataset.columnId == state.focusedColumnId
                )
                column?.focus({ preventScroll: true })
                column?.scrollIntoView({ block: "nearest", inline: "nearest" })
            }
        }
    }

    function toggleGraph(repositoryId: string) {
        const state = stateFor(repositoryId)
        state.graphCollapsed = !state.graphCollapsed
        state.showSettings = false
        void options.update()
    }

    function toggleAll(repositoryId: string) {
        const state = stateFor(repositoryId)
        state.showAll = !state.showAll
        if (
            !state.showAll && state.graph && state.selectedId
            && !branchesForDisplay(state.graph, false, state.collapsedBranchIds).some(branch => branch.id == state.selectedId)
        ) {
            state.selectedId = undefined
        }
        void options.update()
    }

    function selectNode(repositoryId: string, nodeId: string) {
        const state = stateFor(repositoryId)
        state.selectedId = nodeId
        state.marker = undefined
        void options.update()
    }

    function selectMarker(repositoryId: string, branchId: string, marker: BranchGraphMarker) {
        const state = stateFor(repositoryId)
        state.selectedId = branchId
        state.marker = marker
        if (marker.kind == "stash") {
            const repository = options.workspace().repositories.find(item => item.id == repositoryId)
            if (repository?.status == "available")
                void localBranches.stashes(repositoryId, repository.info.mainWorktree, marker.objectId)
        }
        void options.update()
    }

    function openBranch(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
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

    function collapseColumn(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
        state.collapsedColumnIds = state.collapsedColumnIds.includes(branchId)
            ? state.collapsedColumnIds.filter(id => id != branchId)
            : [...state.collapsedColumnIds, branchId]
        state.maximizedBranchId = undefined
        void persist(repositoryId).then(() => options.update()).then(() => {
            const column = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(element => element.dataset.columnId == branchId)
            ;(column?.querySelector<HTMLElement>(".expand-column") ?? column)?.focus()
        })
    }

    function closeBranch(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
        if (backingPath(repositoryId, branchId)) {
            collapseColumn(repositoryId, branchId)
            return
        }
        const index = state.openedBranchIds.indexOf(branchId)
        state.openedBranchIds = state.openedBranchIds.filter(id => id != branchId)
        if (state.maximizedBranchId == branchId)
            state.maximizedBranchId = undefined
        if (state.focusedColumnId == branchId)
            state.focusedColumnId = state.openedBranchIds[index] ?? state.openedBranchIds[index - 1]
        void persist(repositoryId).then(() => options.update()).then(() => {
            const next = state.focusedColumnId
                ? [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(column => column.dataset.columnId == state.focusedColumnId)
                : document.querySelector<HTMLElement>(".graph-rows")
            next?.focus()
        })
    }

    function focusColumn(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
        if (state.focusedColumnId == branchId)
            return
        state.focusedColumnId = branchId
        void persist(repositoryId)
    }

    function moveColumn(repositoryId: string, branchId: string, delta: number) {
        const state = stateFor(repositoryId)
        const index = state.openedBranchIds.indexOf(branchId)
        const target = index + delta
        if (index < 0 || target < 0 || target >= state.openedBranchIds.length) {
            options.notify({ code: "column.boundary", message: target < 0 ? "Already first column." : "Already last column.", transient: true })
            return
        }
        state.openedBranchIds.splice(index, 1)
        state.openedBranchIds.splice(target, 0, branchId)
        state.focusedColumnId = branchId
        void persist(repositoryId).then(() => options.update()).then(() => {
            const column = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(candidate => candidate.dataset.columnId == branchId)
            column?.focus({ preventScroll: true })
            column?.scrollIntoView({ block: "nearest", inline: "nearest" })
        })
    }

    function previewColumnMove(repositoryId: string, branchId: string, targetId: string) {
        const state = stateFor(repositoryId)
        const from = state.openedBranchIds.indexOf(branchId)
        const to = state.openedBranchIds.indexOf(targetId)
        if (from < 0 || to < 0 || from == to)
            return
        state.openedBranchIds.splice(from, 1)
        state.openedBranchIds.splice(to, 0, branchId)
        void options.update()
    }

    function commitColumnMove(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
        state.focusedColumnId = branchId
        state.draggingColumnId = undefined
        state.dragOriginalIds = undefined
        void persist(repositoryId).then(() => options.update())
    }

    function resizeColumn(repositoryId: string, branchId: string, width: number) {
        stateFor(repositoryId).widths[branchId] = Math.max(310, Math.round(width))
        void persist(repositoryId).then(() => options.update())
    }

    function backingPath(repositoryId: string, columnId: string) {
        const graph = stateFor(repositoryId).graph
        const virtual = graph?.virtualBranches.find(branch => branch.id == columnId)
        if (virtual)
            return virtual.worktree.path
        const branch = graph && workspaceGraph(graph).branches.find(branch => branch.id == columnId)
        const saved = options.workspace().repositories.find(repository => repository.id == repositoryId)?.columns.find(column => column.id == columnId)
            ?.worktreePath
        return branch?.checkedOut.find(worktree => worktree.path == saved)?.path ?? (branch?.checkedOut.length == 1 ? branch.checkedOut[0].path : undefined)
    }

    async function persist(repositoryId: string) {
        const workspace = options.workspace()
        const repository = workspace.repositories.find(candidate => candidate.id == repositoryId)
        const state = stateFor(repositoryId)
        if (!repository || !state.graph)
            return
        repository.columns = state.openedBranchIds.flatMap((id): WorkspaceColumn[] => {
            const branch = workspaceGraph(state.graph!).branches.find(candidate => candidate.id == id)
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
            const virtual = state.graph!.virtualBranches.find(candidate => candidate.id == id)
            return virtual
                ? [{
                    kind: "virtual" as const,
                    id,
                    worktreePath: virtual.worktree.path,
                    worktreeId: virtual.worktree.id,
                    lastSeenObjectId: virtual.objectId,
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

    function maximizeBranch(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
        state.maximizedBranchId = state.maximizedBranchId == branchId ? undefined : branchId
        void options.update()
    }

    async function applyGraphSettings(repositoryId: string, settings: RepositoryGraphSettings) {
        const state = stateFor(repositoryId)
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
        const nodeIds = rows.map(row => row.node.id)
        const state = stateFor(repositoryId)
        const index = nodeIds.findIndex(id => id == state.selectedId)
        if (event.key == "F2" || event.key == "Delete") {
            const branch = state.graph?.branches.find(branch => branch.id == state.selectedId && branch.localRefs.length > 0)
            if (branch) {
                event.preventDefault()
                localBranches.open(repositoryId, branch, event.key == "F2" ? "branch-rename" : "branch-delete")
            }
            return
        }
        if ((event.key == "ContextMenu" || event.shiftKey && event.key == "F10") && state.graph?.branches.some(branch => branch.id == state.selectedId)) {
            event.preventDefault()
            const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : undefined
            state.contextMenu = { branchId: state.selectedId!, x: rect?.left ?? 0, y: rect?.top ?? 0 }
            void options.update()
        } else if (event.key == "ArrowDown" || event.key == "ArrowUp") {
            event.preventDefault()
            const delta = event.key == "ArrowDown" ? 1 : -1
            const nextIndex = index < 0 && delta < 0 ? nodeIds.length - 1 : Math.max(0, Math.min(nodeIds.length - 1, index + delta))
            if (nodeIds[nextIndex]) {
                const nextId = nodeIds[nextIndex]
                state.selectedId = nextId
                const nodeIndex = rows.findIndex(row => row.node.id == nextId)
                if (nodeIndex >= 0) {
                    const top = nodeIndex * graphRowHeight
                    if (top < state.graphScrollTop)
                        state.graphScrollTop = top
                    else if (top + graphRowHeight > state.graphScrollTop + state.graphViewportHeight)
                        state.graphScrollTop = Math.max(0, top + graphRowHeight - state.graphViewportHeight)
                }
                void options.update().then(() => {
                    const rows = document.querySelector<HTMLElement>(".graph-rows")
                    if (rows)
                        rows.scrollTop = state.graphScrollTop
                })
            }
        } else if (event.key == "Enter" && state.selectedId && state.graph?.branches.some(branch => branch.id == state.selectedId)) {
            event.preventDefault()
            openBranch(repositoryId, state.selectedId)
        } else if (
            (event.key == "ArrowLeft" || event.key == "ArrowRight") && state.selectedId && state.graph?.branches.some(branch => branch.id == state.selectedId)
        ) {
            event.preventDefault()
            state.collapsedBranchIds = event.key == "ArrowLeft"
                ? [...new Set([...state.collapsedBranchIds, state.selectedId])]
                : state.collapsedBranchIds.filter(id => id != state.selectedId)
            void options.update()
        } else if (event.key == "Escape" && state.maximizedBranchId) {
            state.maximizedBranchId = undefined
            void options.update()
        }
    }

    function openLens() {
        if (lensOpen)
            return lensInput?.focus()
        restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        lensOpen = true
        lensQuery = ""
        for (const repository of currentWorkspace?.repositories ?? []) {
            if (repository.status == "available")
                void ensure(repository.id, false)
        }
        void options.update()
    }

    function closeLens() {
        lensOpen = false
        comparisonSource = undefined
        void options.update().then(() => restoreFocus?.focus())
    }

    async function activateLensResult(result: LensResult) {
        if (comparisonSource) {
            const request = comparisonSource
            const state = stateFor(request.repositoryId)
            const graph = state.graph
            if (request.chooseFirst) {
                const branch = graph?.branches.find(branch => branch.id == result.nodeId)
                if (branch) {
                    comparisonSource = { repositoryId: request.repositoryId, fromRef: branch.preferredRef, replaceId: request.replaceId }
                    lensQuery = ""
                    await options.update()
                }
                return
            }
            const fixedNode = graph?.branches.find(branch => branch.refs.includes(request.fromRef))
            const fixed = fixedNode ? { ...fixedNode, preferredRef: request.fromRef } : undefined
            const selected = graph?.branches.find(branch => branch.id == result.nodeId)
            const from = request.chooseFrom ? selected : fixed
            const to = request.chooseFrom ? fixed : selected
            if (!from || !to || !graph)
                return
            lensOpen = false
            comparisonSource = undefined
            if (!state.openedBranchIds.includes(from.id))
                state.openedBranchIds.push(from.id)
            state.collapsedColumnIds = state.collapsedColumnIds.filter(id => id != from.id)
            state.maximizedBranchId = undefined
            state.widths[from.id] ??= defaultColumnWidth
            state.focusedColumnId = from.id
            await persist(request.repositoryId)
            inspection.openComparison(request.repositoryId, from, to, graph, request.replaceId, backingPath(request.repositoryId, from.id))
            return
        }
        if (result.kind == "command") {
            moveColumn(result.repositoryId, result.nodeId, result.delta)
            closeLens()
            return
        }
        if (result.repositoryId != activeRepositoryId)
            await options.selectRepository(result.repositoryId)
        activeRepositoryId = result.repositoryId
        if (result.kind == "branch") {
            stateFor(result.repositoryId).graphCollapsed = false
            selectNode(result.repositoryId, result.nodeId)
        }
        closeLens()
        await options.update()
        document.querySelector<HTMLElement>(".graph-rows")?.focus()
    }
    function compareWith(repositoryId: string, fromRef: string, replaceId?: string, toRef?: string) {
        const chooseFrom = !!toRef && !stateFor(repositoryId).graph?.branches.some(branch => branch.refs.includes(fromRef))
        const chooseFirst = chooseFrom && !stateFor(repositoryId).graph?.branches.some(branch => branch.refs.includes(toRef!))
        comparisonSource = { repositoryId, fromRef: chooseFirst ? "" : chooseFrom ? toRef! : fromRef, replaceId, chooseFrom, chooseFirst }
        openLens()
        restoreFocus = replaceId
            ? document.querySelector<HTMLElement>(`[data-auxiliary-id="${replaceId}"]`)
            : document.querySelector<HTMLElement>(".graph-rows")
    }
}

const branchContextMenu = css({
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

function windowNodes(nodes: GraphRowLayout[], scrollTop: number, viewportHeight: number) {
    const overscan = 6
    const maximumScrollTop = Math.max(0, nodes.length * graphRowHeight - viewportHeight)
    const effectiveScrollTop = Math.min(scrollTop, maximumScrollTop)
    const start = Math.max(0, Math.floor(effectiveScrollTop / graphRowHeight) - overscan)
    const end = Math.min(nodes.length, Math.ceil((effectiveScrollTop + viewportHeight) / graphRowHeight) + overscan)
    return {
        start,
        nodes: nodes.slice(start, end),
        before: start * graphRowHeight,
        after: (nodes.length - end) * graphRowHeight,
    }
}

function branchesForDisplay(graph: BranchGraph, showAll: boolean, collapsedBranchIds: string[]) {
    let branches: BranchGraphBranchNode[]
    if (showAll)
        branches = graph.branches
    else {
        const structural = new Set(
            graph.branches.filter(branch => branch.primary || branch.checkedOut.length > 0 || branch.involvement == "involved").map(branch => branch.id),
        )
        let changed = true
        while (changed) {
            changed = false
            for (const branch of graph.branches.filter(branch => structural.has(branch.id))) {
                const baseIds = branch.base.status == "known" ? [branch.base.branchId] : branch.base.candidates.map(candidate => candidate.branchId)
                for (const id of baseIds) {
                    if (!structural.has(id)) {
                        structural.add(id)
                        changed = true
                    }
                }
            }
        }
        branches = graph.branches.filter(branch => structural.has(branch.id))
    }
    const collapsed = new Set(collapsedBranchIds)
    return branches.filter(branch => {
        let parent = branch.base.status == "known" ? branch.base.branchId : undefined
        const visited = new Set<string>()
        while (parent && !visited.has(parent)) {
            if (collapsed.has(parent))
                return false
            visited.add(parent)
            const parentBranch = graph.branches.find(candidate => candidate.id == parent)
            parent = parentBranch?.base.status == "known" ? parentBranch.base.branchId : undefined
        }
        return true
    })
}

function GraphSummary(handle: Handle<{ graph: BranchGraph; visibleCount: number }>) {
    return () => (
        <div class="graph-summary" mix={graphSummary}>
            <span mix={graphSummarySpan}>
                {handle.props.visibleCount} branches
            </span>
            <span mix={graphSummarySpan}>
                {handle.props.graph.primaryBranch.status == "known" ? `Primary · ${shortRef(handle.props.graph.primaryBranch.ref!)}` : "Primary unresolved"}
            </span>
            <span mix={graphSummarySpan}>
                {handle.props.graph.selectedRemote ? `Remote · ${handle.props.graph.selectedRemote}` : "Remote unresolved"}
            </span>
        </div>
    )
}

function BaseUnresolved(
    handle: Handle<{ branches: BranchGraphBranchNode[]; selections: Record<string, string>; choose(branchId: string, candidateId: string): void }>,
) {
    return () => {
        const unresolved = handle.props.branches.filter(branch => branch.base.status == "ambiguous")
        if (unresolved.length == 0)
            return null
        return (
            <details class="base-unresolved" mix={baseUnresolved}>
                <summary mix={baseUnresolvedSummary}>
                    Base unresolved · {unresolved.length}
                </summary>
                {unresolved.map(branch => (
                    <div mix={baseUnresolvedDiv}>
                        <strong>{branch.name}</strong>
                        <span mix={baseUnresolvedSpan}>
                            {branch.base.status == "ambiguous"
                                && branch.base.candidates.map(candidate => (
                                    <button
                                        type="button"
                                        class={handle.props.selections[branch.id] == candidate.branchId ? "active" : ""}
                                        title="Use for inspection only"
                                        mix={[baseUnresolvedButton, on("click", () => handle.props.choose(branch.id, candidate.branchId))]}
                                    >
                                        {candidate.name}
                                    </button>
                                ))}
                        </span>
                    </div>
                ))}
            </details>
        )
    }
}

function BranchRow(
    handle: Handle<
        {
            branch: BranchGraphBranchNode
            rail: RemixNode
            selected: boolean
            select(): void
            open(): void
            selectMarker(marker: BranchGraphMarker): void
            contextMenu(event: MouseEvent): void
        }
    >,
) {
    return () => {
        const props = handle.props
        const branch = props.branch
        return (
            <div
                class={`graph-row ${props.selected ? "selected" : ""}`}
                role="option"
                aria-selected={props.selected}
                data-node-id={branch.id}
                draggable={!branch.remoteOnly}
                mix={[
                    graphRow,
                    on("dragstart", event => event.dataTransfer?.setData("application/x-laneway-branch", branch.preferredRef)),
                    on("click", props.select),
                    ref((element, signal) => {
                        element.addEventListener("contextmenu", event => handle.props.contextMenu(event), { signal })
                    }),
                ]}
            >
                {props.rail}
                <span class="branch-copy" mix={branchCopy}>
                    <strong title={branch.name} mix={branchCopyStrong}>
                        {branch.name}
                    </strong>
                    <span class="branch-details" mix={branchDetails}>
                        <small mix={branchCopySmall}>
                            {branch.primary
                                ? "Primary"
                                : branch.merged
                                ? "Merged"
                                : branch.remoteOnly
                                ? "Remote only"
                                : branch.involvement == "involved"
                                ? "Involved"
                                : branch.involvement == "unknown"
                                ? "Involvement unknown"
                                : "Other branch"}
                        </small>
                        {branch.checkedOut.map(worktree => (
                            <span class="worktree-chip" title={worktree.path} mix={worktreeChip}>
                                <Icon name="folder" size={11} />
                                {worktree.name}
                            </span>
                        ))}
                        {branch.tags.map(tag => (
                            <span class="tag-chip" mix={tagChip}>
                                <Icon name="tag" size={11} />
                                {tag}
                            </span>
                        ))}
                        {branch.unresolved && (
                            <span class="conflict-marker" title={branch.unresolved.recovery ?? "This stack contains deferred conflicts"}>Unresolved</span>
                        )}
                        {branch.markers.map(marker => (
                            <button
                                class="marker-button"
                                data-mousedown-activate
                                type="button"
                                title={marker.tooltip}
                                mix={[
                                    markerButton,
                                    on("click", event => {
                                        event.stopPropagation()
                                        props.selectMarker(marker)
                                    }),
                                ]}
                            >
                                <Icon name="stash" size={12} />
                            </button>
                        ))}
                        {(branch.ahead > 0 || branch.behind > 0) && (
                            <span class="divergence" mix={divergence}>
                                ↑{branch.ahead} ↓{branch.behind}
                            </span>
                        )}
                    </span>
                </span>
                <button
                    class="open-branch"
                    data-mousedown-activate
                    type="button"
                    mix={[
                        openBranch,
                        on("click", event => {
                            event.stopPropagation()
                            props.open()
                        }),
                    ]}
                >
                    Open
                </button>
            </div>
        )
    }
}

function SimpleNodeRow(
    handle: Handle<{ id: string; kind: "tag" | "worktree"; name: string; title: string; rail: RemixNode; selected: boolean; select(): void }>,
) {
    return () => (
        <button
            class={`graph-row simple ${handle.props.selected ? "selected" : ""}`}
            data-node-id={handle.props.id}
            role="option"
            tabIndex={-1}
            aria-selected={handle.props.selected}
            type="button"
            title={handle.props.title}
            mix={[graphRow, on("click", handle.props.select)]}
        >
            {handle.props.rail}
            <span class="branch-copy" mix={branchCopy}>
                <strong mix={branchCopyStrong}>
                    {handle.props.name}
                </strong>
                <small mix={branchCopySmall}>
                    {handle.props.kind == "tag" ? "Tag" : "Detached worktree"}
                </small>
            </span>
        </button>
    )
}

function GraphRail(handle: Handle<{ row: GraphRowLayout }>) {
    return () => (
        <svg
            class="graph-rail-lines"
            aria-hidden="true"
            width={handle.props.row.width}
            height={40}
            viewBox={`0 0 ${handle.props.row.width} 40`}
            mix={graphRailLines}
        >
            {handle.props.row.paths.map(path => <path d={path.d} fill="none" stroke={graphLineColor(path.color)} stroke-width="2" />)}
            <circle cx={handle.props.row.x} cy={20} r={4} fill="var(--panel)" stroke={graphLineColor(handle.props.row.color)} stroke-width="2" />
        </svg>
    )
}

function BranchColumns(
    handle: Handle<
        {
            graph: BranchGraph
            state: RepositoryGraphState
            inspection: ReturnType<typeof createInspection>
            conflicts: ReturnType<typeof createConflictResolution>
            repositoryId: string
            branchAction(branch: BranchGraphBranchNode, action: "branch-rename" | "branch-delete"): void
            branchMenu(branch: BranchGraphBranchNode, event: MouseEvent): void
            worktreePath(id: string): string | undefined
            worktreeControls(column: BranchGraph["branches"][number] | BranchGraph["virtualBranches"][number]): RemixNode
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
        const props = handle.props
        const columns = props.state.openedBranchIds.map(id =>
            props.graph.branches.find(branch => branch.id == id) ?? props.graph.virtualBranches.find(branch => branch.id == id)
        ).filter(column => column != undefined)
        const unavailable = props.inspection.unavailableComparisonSources(props.repositoryId, props.graph)
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
        const visible = props.state.maximizedBranchId ? columns.filter(column => column.id == props.state.maximizedBranchId) : columns
        return (
            <section class={`branch-columns ${props.state.maximizedBranchId ? "maximized" : ""}`} mix={branchColumns}>
                {visible.map(column => {
                    const collapsed = props.state.collapsedColumnIds.includes(column.id)
                    const width = props.state.widths[column.id] ?? defaultColumnWidth
                    const auxiliary = collapsed ? null : props.inspection.breakout(props.repositoryId, column.id)
                    // Auxiliary columns join onto their source column's card.
                    const attached = Array.isArray(auxiliary) && auxiliary.length > 0
                    // A maximized column shares the space with its auxiliary columns, split by its own resizable width.
                    const split = !!props.state.maximizedBranchId && attached
                    // A keyed run of siblings rather than a fragment: Remix appends a node added to the end of a fragment after
                    // the parent's last child, which put a newly opened diff column after every other column.
                    return [
                        <article
                            key={column.id}
                            class={`branch-column ${collapsed ? "collapsed" : ""} ${attached ? "attached" : ""} ${split ? "split" : ""}`}
                            data-column-id={column.id}
                            style={{
                                width: props.state.maximizedBranchId && !split ? "100%" : `${collapsed ? 52 : width}px`,
                            }}
                            tabIndex={-1}
                            mix={[
                                branchColumn,
                                on("focusin", () => props.focus(column.id)),
                                on("keydown", event => {
                                    if (
                                        column.kind == "branch" && (event.key == "F2" || event.key == "Delete")
                                        && !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select"))
                                    ) {
                                        event.preventDefault()
                                        props.branchAction(column, event.key == "F2" ? "branch-rename" : "branch-delete")
                                        return
                                    }
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
                                            {props.inspection.workingSummary(props.repositoryId, column, props.graph, props.worktreePath(column.id))}
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
                                                    const source = props.state.draggingColumnId
                                                    if (source)
                                                        props.commitMove(source)
                                                    else {
                                                        const branch = event.dataTransfer?.getData("application/x-laneway-branch")
                                                        if (branch)
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
                                                const identity = columnIdentity(column, props.worktreePath(column.id))
                                                return (
                                                    <span class="column-kind" title={identity.kind} mix={[columnKindIcon, identity.tone]}>
                                                        <Icon name={identity.icon} size={17} />
                                                    </span>
                                                )
                                            })()}
                                            {!props.worktreePath(column.id) && (
                                                <h2 mix={branchColumnH2}>
                                                    {column.name}
                                                </h2>
                                            )}
                                            {props.worktreeControls(column)}
                                            <div mix={branchColumnActions}>
                                                {props.inspection.conflictFilter(props.repositoryId, column, props.graph, props.worktreePath(column.id))}
                                                {props.inspection.filterControl(
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
                                        {props.inspection.body(
                                            props.repositoryId,
                                            column,
                                            props.graph,
                                            props.worktreePath(column.id),
                                            column.kind == "branch"
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
    const applyWidth = (divider: HTMLElement, width: number) => {
        const column = divider.previousElementSibling as HTMLElement | null
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
                    const step = event.shiftKey ? 50 : 10
                    const width = event.key == "ArrowLeft" || event.key == "ArrowRight"
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
                    const startX = event.clientX
                    const startWidth = handle.props.width
                    const divider = event.currentTarget
                    const move = (next: PointerEvent) => applyWidth(divider, startWidth + next.clientX - startX)
                    const end = (next: PointerEvent) => {
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

function GraphSettings(handle: Handle<{ graph: BranchGraph; state: RepositoryGraphState; apply(settings: RepositoryGraphSettings): void; close(): void }>) {
    const applyPatterns = () =>
        handle.props.apply({ selectedRemote: handle.props.graph.selectedRemote, remotePatterns: splitPatterns(handle.props.state.patterns) })
    return () => (
        <section class="graph-settings" role="dialog" aria-labelledby={handle.id + "-title"} mix={graphSettings}>
            <header mix={graphSettingsHeader}>
                <h2 id={handle.id + "-title"} mix={graphSettingsH2}>
                    Branch Graph settings
                </h2>
                <button type="button" aria-label="Close graph settings" title="Close" mix={[closeGraphSettingsButton, on("click", handle.props.close)]}>
                    <Icon name="close" size={12} />
                </button>
            </header>
            {/* With a single remote there is nothing to choose. */}
            {handle.props.graph.availableRemotes.length > 1 && (
                <fieldset class="remote-options" mix={remoteOptions}>
                    <legend mix={graphSettingsLabel}>Remote</legend>
                    <p mix={graphSettingsHint}>The Primary Branch and remote branches come from this remote.</p>
                    {handle.props.graph.availableRemotes.map(remote => (
                        <label mix={remoteOptionsLabel}>
                            <input
                                type="radio"
                                name={handle.id + "-remote"}
                                value={remote}
                                checked={handle.props.graph.selectedRemote == remote}
                                mix={[
                                    radio(),
                                    remoteOptionsInput,
                                    on("change", event => {
                                        if (event.currentTarget.checked)
                                            void handle.props.apply({ selectedRemote: remote, remotePatterns: splitPatterns(handle.props.state.patterns) })
                                    }),
                                ]}
                            />
                            {remote}
                        </label>
                    ))}
                </fieldset>
            )}
            <div mix={graphSettingsField}>
                <label for="remote-patterns" mix={graphSettingsLabel}>
                    Additional remote branches
                </label>
                <p id="remote-patterns-hint" mix={graphSettingsHint}>
                    Also show remote-only branches matching these comma-separated globs, such as <code mix={graphSettingsCode}>origin/release/**</code>.
                </p>
                <div mix={graphSettingsRow}>
                    <input
                        id="remote-patterns"
                        aria-describedby="remote-patterns-hint"
                        value={handle.props.state.patterns}
                        placeholder="origin/release/**, upstream/topic/*"
                        mix={[
                            graphSettingsInput,
                            on("input", event => {
                                handle.props.state.patterns = event.currentTarget.value
                            }),
                            on("keydown", event => {
                                if (event.key == "Enter") {
                                    event.preventDefault()
                                    applyPatterns()
                                }
                            }),
                        ]}
                    />
                    <button class="secondary-button" type="button" mix={[secondaryButton, on("click", applyPatterns)]}>
                        Apply
                    </button>
                </div>
            </div>
        </section>
    )
}

function MarkerDetails(handle: Handle<{ marker: BranchGraphMarker; close(): void }>) {
    return () => (
        <aside class="marker-details" mix={markerDetails}>
            <div mix={markerDetailsDiv}>
                <span mix={markerDetailsSpan}>
                    STASH
                </span>
                <strong>{handle.props.marker.label}</strong>
                <small mix={markerDetailsSmall}>
                    {shortOid(handle.props.marker.objectId)}
                </small>
            </div>
            <button type="button" aria-label="Close marker details" mix={[closeMarkerDetailsButton, on("click", handle.props.close)]}>
                ×
            </button>
            <p mix={markerDetailsP}>
                {handle.props.marker.tooltip}
            </p>
        </aside>
    )
}

function GraphProgress(_handle: Handle<Record<string, never>>) {
    return () => (
        <div class="graph-loading" mix={graphLoading}>
            <span mix={graphLoadingSpan}>
            </span>
            <p mix={graphLoadingP}>
                Reading verified Branch Graph…
            </p>
            <small mix={graphLoadingSmall}>
                Local refs and worktrees first.
            </small>
        </div>
    )
}

function GraphError(handle: Handle<{ message: string; retry(): void }>) {
    return () => (
        <div class="graph-error" role="alert" mix={graphError}>
            <span mix={graphErrorSpan}>
                Graph unavailable
            </span>
            <p mix={graphErrorP}>
                {handle.props.message}
            </p>
            <button class="primary-button" type="button" mix={[primaryButton, on("click", handle.props.retry)]}>
                Retry
            </button>
        </div>
    )
}

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

function lensResults(workspace: Workspace, states: Map<string, RepositoryGraphState>, activeId: string | undefined, query: string): LensResult[] {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle)
        return []
    const results: LensResult[] = []
    const focusedColumnId = activeId ? states.get(activeId)?.focusedColumnId : undefined
    if (activeId && focusedColumnId) {
        for (const command of [{ label: "Move column left", delta: -1 }, { label: "Move column right", delta: 1 }]) {
            const score = textScore(command.label, needle)
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
    for (const repository of workspace.repositories) {
        const name = repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name
        const repoScore = textScore(name, needle)
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
        for (const branch of states.get(repository.id)?.graph?.branches ?? []) {
            const score = Math.max(...[branch.name, ...branch.aliases].map(value => textScore(value, needle)))
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
    const text = value.toLocaleLowerCase()
    if (text == query)
        return 4
    if (text.startsWith(query))
        return 3
    if (text.split(/[\/_.-]+/).some(part => part.startsWith(query)))
        return 2
    return text.includes(query) ? 1 : 0
}

function splitPatterns(value: string) {
    return value.split(",").map(pattern => pattern.trim()).filter(Boolean)
}

function shortRef(ref: string) {
    return ref.replace(/^refs\/(heads|remotes)\//, "")
}

function shortOid(objectId: string) {
    return objectId.slice(0, 8)
}

type ColumnNode = BranchGraph["branches"][number] | BranchGraph["virtualBranches"][number]

// What a column *is* drives its icon (and the icon's tooltip); the name is the worktree or branch.
function columnIdentity(column: ColumnNode, worktreePath: string | undefined) {
    const worktree = column.kind == "branch" ? column.checkedOut.find(item => item.path == worktreePath) : column.worktree
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

const toneMain = css({ color: "var(--accent)" })
const toneWorktree = css({ color: "var(--ok)" })
const toneBranch = css({ color: "var(--focus)" })

const columnKindIcon = css({
    flex: "0 0 auto",
    display: "grid",
    placeItems: "center",
    width: "18px",
    height: "18px",
})

const columnTabs = css({
    display: "flex",
    alignItems: "stretch",
    minWidth: "0",
    overflow: "hidden",
})

const columnTab = css({
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

const columnTabName = css({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const expandColumnIcon = css({
    display: "grid",
    placeItems: "center",
})

const branchColumnActions = css({
    order: "1",
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    gap: "2px",
})

const workspaceStyle = css({
    height: "100%",
    display: "grid",
    gridTemplateColumns: "var(--rail) minmax(0, 1fr)",
})

const graphDesk = css({
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

const graphDeskProgress = css({
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

const graphToolbar = css({
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

const graphToolbarH1 = css({
    margin: "0",
    overflow: "hidden",
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    fontSize: "16px",
    fontWeight: "600",
    letterSpacing: "-0.01em",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const graphActions = css({
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

const graphPanelToggleButton = css({
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

const graphActionsButton = css({
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

const branchGraphSettingsButton = css({
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

const graphLimit = css({
    padding: "6px 12px",
    color: "var(--warning)",
    borderBottom: "1px solid var(--line)",
    background: "var(--warning-wash)",
    fontSize: "12px",
    lineHeight: "1.4",
})

const graphLayout = css({
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

const graphSidebar = css({
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

const graphPanel = css({
    flex: "1 1 auto",
    position: "relative",
    minWidth: "0",
    minHeight: "0",
    display: "grid",
    gridTemplateRows: "auto auto minmax(0, 1fr) auto",
    background: "var(--panel)",
})

const graphRows = css({
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

const graphSpacer = css({
    width: "1px",
    pointerEvents: "none",
})

const unassignedMarkers = css({
    padding: "7px 10px",
    color: "var(--muted)",
    borderTop: "1px solid var(--line)",
    fontSize: "12px",
    lineHeight: "1.45",
})

const unassignedMarkersSummary = css({
    cursor: "default",
})

const unassignedMarkersButton = css({
    display: "block",
    marginTop: "6px",
    color: "var(--warning)",
    border: "0",
    background: "transparent",
    font: "inherit",
    textDecoration: "underline",
})

const graphSummary = css({
    minHeight: "28px",
    padding: "0 14px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    overflow: "hidden",
    color: "var(--muted)",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
    fontSize: "11.5px",
    whiteSpace: "nowrap",
})

const graphSummarySpan = css({
    "& + span::before": {
        marginRight: "12px",
        content: '"·"',
    },
})

const baseUnresolved = css({
    padding: "7px 10px",
    color: "var(--warning)",
    borderBottom: "1px solid var(--line)",
    background: "var(--warning-wash)",
    fontSize: "12px",
    lineHeight: "1.45",
})

const baseUnresolvedSummary = css({
    cursor: "default",
})

const baseUnresolvedDiv = css({
    marginTop: "6px",
    display: "grid",
    gridTemplateColumns: "minmax(80px, 1fr) 2fr",
    alignItems: "center",
    gap: "8px",
})

const baseUnresolvedSpan = css({
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
})

const baseUnresolvedButton = css({
    minHeight: "24px",
    padding: "0 7px",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "var(--control)",
    fontSize: "12px",
    "&.active": {
        color: "var(--warning)",
        borderColor: "var(--warning-edge)",
        background: "var(--warning-wash)",
    },
})

const graphRow = css({
    position: "relative",
    width: "100%",
    height: "40px",
    minHeight: "40px",
    padding: "3px 8px 3px 0",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    color: "var(--text)",
    textAlign: "left",
    border: "0",
    borderRadius: "0",
    background: "transparent",
    // Row separators are shadows so the 40px rail geometry stays exact.
    boxShadow: "inset 0 -1px var(--line)",
    "&.selected": {
        background: "var(--focus-wash)",
        boxShadow: "inset 3px 0 var(--focus), inset 0 -1px var(--line)",
    },
    "&.simple": {
        paddingLeft: "0",
    },
    "&:hover": {
        background: "var(--hover)",
    },
})

const graphRailLines = css({
    flexShrink: "0",
    overflow: "hidden",
    alignSelf: "center",
})

const branchCopy = css({
    minWidth: "0",
    flex: "1 1 auto",
    display: "grid",
    gap: "1px",
})

const branchCopyStrong = css({
    overflow: "hidden",
    fontSize: "13px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const branchCopySmall = css({
    color: "var(--muted)",
    fontFamily: "var(--mono)",
    fontSize: "10.5px",
    letterSpacing: "0",
    textTransform: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

const branchDetails = css({
    minWidth: "0",
    height: "18px",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    overflow: "hidden",
    "& button": { minHeight: "16px", padding: "0 3px" },
})

const worktreeChip = css({
    maxWidth: "110px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 6px",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    fontFamily: "var(--mono)",
    fontSize: "10.5px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "& svg": { flex: "0 0 auto" },
    color: "var(--ok-ink)",
    borderColor: "var(--ok-edge)",
    background: "var(--ok-wash)",
})

const tagChip = css({
    maxWidth: "110px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 6px",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    fontFamily: "var(--mono)",
    fontSize: "10.5px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "& svg": { flex: "0 0 auto" },
    color: "var(--warning)",
    borderColor: "var(--accent-edge)",
    background: "var(--accent-wash)",
})

const markerButton = css({
    width: "20px",
    height: "18px",
    padding: "0",
    display: "inline-grid",
    placeItems: "center",
    color: "var(--stash-ink)",
    border: "1px solid var(--stash-edge)",
    borderRadius: "4px",
    background: "var(--stash-wash)",
    "&:hover": { background: "var(--stash-edge)", color: "var(--panel)" },
})

const divergence = css({
    maxWidth: "110px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 6px",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    fontFamily: "var(--mono)",
    fontSize: "10.5px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "& svg": { flex: "0 0 auto" },
    color: "var(--muted)",
    background: "var(--panel-deep)",
})

const openBranch = css({
    height: "24px",
    padding: "0 10px",
    color: "var(--focus)",
    border: "1px solid var(--focus-edge)",
    borderRadius: "var(--radius)",
    background: "var(--panel)",
    fontSize: "12px",
    fontWeight: "600",
    "&:hover": {
        color: "#fff",
        borderColor: "var(--focus)",
        background: "var(--focus)",
    },
})

const columnEmpty = css({
    minWidth: "0",
    minHeight: "0",
    display: "grid",
    placeContent: "center",
    overflow: "hidden",
    color: "var(--faint)",
    textAlign: "center",
})

const columnEmptySpan = css({
    color: "var(--muted)",
    fontSize: "14px",
})

const columnEmptyP = css({
    margin: "6px 0 0",
    fontSize: "12px",
})

const branchColumns = css({
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

const collapsedColumnButton = css({
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

const branchColumn = css({
    "&.collapsed": { minWidth: "52px", gridTemplateRows: "minmax(0, 1fr)" },
    position: "relative",
    width: `${defaultColumnWidth}px`,
    minWidth: "310px",
    flex: "0 0 auto",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
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

const branchColumnHeader = css({
    position: "relative",
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

const branchColumnH2 = css({
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

const branchColumnButton = css({
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
const columnCollapseButton = css({
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
const columnDivider = css({
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

const graphSettings = css({
    position: "absolute",
    zIndex: "6",
    top: "calc(100% + 4px)",
    right: "8px",
    width: "min(360px, calc(100% - 20px))",
    padding: "10px 12px 14px",
    display: "grid",
    gap: "14px",
    border: "1px solid var(--line-strong)",
    borderRadius: "6px",
    background: "var(--raised)",
    boxShadow: "var(--shadow-popover)",
    "@media (forced-colors: active)": {
        boxShadow: "none",
    },
})

const graphSettingsHeader = css({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
})

const graphSettingsH2 = css({
    margin: "0",
    fontSize: "13px",
    fontWeight: "600",
})

// A quiet icon button, like the other close affordances, rather than a boxed control.
const closeGraphSettingsButton = css({
    width: "24px",
    height: "24px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--muted)",
    border: "0",
    borderRadius: "4px",
    background: "transparent",
    "&:hover": { color: "var(--text)", background: "var(--control-hover)" },
})

const graphSettingsField = css({
    display: "grid",
    gap: "6px",
})

const graphSettingsHint = css({
    margin: "0",
    color: "var(--muted)",
    fontSize: "11.5px",
    lineHeight: "1.45",
})

const graphSettingsCode = css({
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: "11px",
})

const graphSettingsRow = css({
    display: "flex",
    gap: "6px",
    alignItems: "stretch",
})

const graphSettingsInput = css({
    flex: "1",
    minWidth: "0",
    fontFamily: "var(--mono)",
    fontSize: "12px",
})

const remoteOptions = css({
    display: "grid",
    gap: "6px",
    margin: "0",
    padding: "0",
    border: "0",
    minWidth: "0",
})

const remoteOptionsLabel = css({
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "12.5px",
    cursor: "pointer",
})

const remoteOptionsInput = css({
    background: "var(--field)",
    border: "1px solid var(--line-strong)",
    boxShadow: "none",
    "@media (forced-colors: active)": {
        appearance: "auto",
        "&::before": {
            display: "none",
        },
    },
    "&:checked": {
        background: "var(--accent)",
        borderColor: "var(--accent)",
        boxShadow: "none",
    },
    "&:focus-visible": {
        outline: "2px solid var(--accent)",
        outlineOffset: "2px",
        boxShadow: "none",
    },
    "&::before": {
        background: "var(--accent-ink)",
        boxShadow: "none",
    },
})

const graphSettingsLabel = css({
    display: "block",
    padding: "0",
    margin: "0",
    color: "var(--text)",
    fontSize: "12px",
    fontWeight: "600",
})

const secondaryButton = css({
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    background: "var(--control)",
    "&.active": {
        color: "var(--accent)",
        borderColor: "var(--accent-edge)",
        background: "var(--accent-wash)",
    },
    minHeight: "28px",
    padding: "0 14px",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: "500",
    textTransform: "none",
    "&:hover:not(:disabled)": {
        background: "var(--control-hover)",
    },
})

const markerDetails = css({
    position: "absolute",
    right: "8px",
    bottom: "8px",
    left: "8px",
    padding: "10px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    border: "1px solid var(--warning-edge)",
    borderRadius: "6px",
    background: "var(--warning-raised)",
    boxShadow: "var(--shadow-popover)",
    "@media (forced-colors: active)": {
        boxShadow: "none",
    },
})

const markerDetailsDiv = css({
    minWidth: "0",
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    overflow: "hidden",
})

const markerDetailsSpan = css({
    color: "var(--faint)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
    letterSpacing: "0",
    textTransform: "none",
})

const markerDetailsSmall = css({
    color: "var(--faint)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
    letterSpacing: "0",
    textTransform: "none",
})

const closeMarkerDetailsButton = css({
    minHeight: "26px",
    padding: "0 7px",
    color: "var(--muted)",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "transparent",
    fontSize: "12px",
    minWidth: "26px",
    borderColor: "transparent",
    "&:hover": {
        color: "var(--text)",
        borderColor: "var(--line-strong)",
        background: "var(--control)",
    },
})

const markerDetailsP = css({
    gridColumn: "1 / -1",
    margin: "7px 0 0",
    color: "var(--muted)",
    fontSize: "12px",
})

const graphLoading = css({
    minWidth: "240px",
    margin: "auto",
    padding: "20px",
    textAlign: "center",
})

const graphLoadingSpan = css({
    width: "22px",
    height: "22px",
    margin: "0 auto 12px",
    display: "block",
    border: "2px solid var(--line-strong)",
    borderTopColor: "var(--accent)",
    borderRadius: "50%",
    animation: "graph-spin 800ms linear infinite",
})

const graphLoadingP = css({
    marginBottom: "6px",
    fontSize: "13px",
})

const graphLoadingSmall = css({
    color: "var(--faint)",
    fontSize: "11px",
    lineHeight: "1.45",
    textTransform: "none",
})

const graphError = css({
    minWidth: "240px",
    margin: "auto",
    padding: "20px",
    textAlign: "center",
})

const graphErrorSpan = css({
    color: "var(--faint)",
    fontSize: "11px",
    lineHeight: "1.45",
    textTransform: "none",
})

const graphErrorP = css({
    marginBottom: "6px",
    fontSize: "13px",
})

const primaryButton = css({
    minHeight: "28px",
    marginTop: "12px",
    padding: "0 12px",
    borderRadius: "4px",
})
