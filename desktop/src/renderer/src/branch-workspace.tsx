import type { AvailableOpenRepository, BranchGraph, BranchGraphBranchNode, BranchGraphMarker, RepositoryGraphSettings, Workspace, WorkspaceColumn } from "@git-workbench/shared"
import { on, ref, type Handle, type RemixNode } from "remix/ui"
import { errorMessage, type NoticeState } from "./feedback"
import { createInspection } from "./inspection"
import type { DiffLayout } from "@git-workbench/shared"

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
}

interface BranchWorkspaceOptions {
    api: Window["workbench"]
    update(): Promise<AbortSignal>
    signal: AbortSignal
    notify(notice: NoticeState): void
    selectRepository(id: string): Promise<void>
    closeRepository(id: string): Promise<void>
    moveRepository(id: string, targetId: string): Promise<void>
    previewRepositoryMove(id: string, targetId: string): void
    commitRepositoryOrder(): Promise<void>
    cancelRepositoryMove(): void
    addRepository(): void
    workspace(): Workspace
    workspaceChanged(workspace: Workspace): void
}

export interface BranchWorkspace {
    activate(repositoryId: string): void
    deactivate(): void
    render(active: AvailableOpenRepository, workspace: Workspace): RemixNode
    renderLens(workspace: Workspace): RemixNode
}

export function createBranchWorkspace(options: BranchWorkspaceOptions): BranchWorkspace {
    const states = new Map<string, RepositoryGraphState>()
    let activeRepositoryId: string | undefined
    let lensOpen = false
    let lensQuery = ""
    let lensIndex = 0
    let lensInput: HTMLInputElement | undefined
    let restoreFocus: HTMLElement | null = null
    let currentWorkspace: Workspace | undefined
    const inspection = createInspection({
        api: options.api, update: options.update, signal: options.signal,
        layout: (repositoryId, columnId) => stateFor(repositoryId).diffLayouts[columnId] ?? "unified",
        saveLayout: (repositoryId, columnId, layout) => {
            stateFor(repositoryId).diffLayouts[columnId] = layout
            void persist(repositoryId).then(() => options.update())
        },
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
        if (event.ctrlKey && event.key.toLowerCase() == "k") {
            event.preventDefault()
            openLens()
        } else if (event.key == "Escape" && activeRepositoryId) {
            const state = stateFor(activeRepositoryId)
            if (state.maximizedBranchId) {
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
        render(active, workspace) {
            currentWorkspace = workspace
            const state = stateFor(active.id)
            inspection.retain(active.id, state.openedBranchIds)
            const graph = state.graph
            const visibleBranches = graph ? branchesForDisplay(graph, state.showAll, state.collapsedBranchIds) : []
            const displayNodes = graph ? nodesForDisplay(graph, visibleBranches) : []
            const selectableIds = displayNodes.map(node => node.id)
            const nodeWindow = windowNodes(displayNodes, state.graphScrollTop, state.graphViewportHeight)
            if (state.selectedId && !visibleBranches.some(branch => branch.id == state.selectedId)
                && !graph?.tags.some(tag => tag.id == state.selectedId)
                && !graph?.virtualBranches.some(branch => branch.id == state.selectedId))
                state.selectedId = undefined
            return (
                <section class="workspace graph-workspace" aria-live="polite">
                    <RepositoryRail active={active} workspace={workspace} busy={state.loading} selectRepository={options.selectRepository} closeRepository={options.closeRepository} moveRepository={options.moveRepository} previewRepositoryMove={options.previewRepositoryMove} commitRepositoryOrder={options.commitRepositoryOrder} cancelRepositoryMove={options.cancelRepositoryMove} addRepository={options.addRepository} openLens={openLens} />
                    <section class="graph-desk">
                        <header class="graph-toolbar">
                            <div><p class="eyebrow">Branch Graph</p><h1>{baseName(active.info.mainWorktree)}</h1></div>
                            <div class="graph-actions">
                                <button type="button" class={state.showAll ? "active" : ""} mix={[on("click", () => toggleAll(active.id))]}>{state.showAll ? "Involved only" : "Show all"}</button>
                                <button class={`refresh-button ${state.refreshing ? "refreshing" : ""}`} type="button" aria-label={state.refreshing ? "Refreshing Branch Graph" : "Refresh Branch Graph"} aria-busy={state.refreshing} title={state.refreshing ? "Refreshing Branch Graph" : "Refresh Branch Graph"} disabled={state.loading || state.refreshing} mix={[on("click", () => read(active.id, true, true))]}><span aria-hidden="true">↻</span></button>
                                <button type="button" aria-label="Branch Graph settings" title="Branch Graph settings" mix={[on("click", () => {
                                    state.showSettings = !state.showSettings
                                    void options.update()
                                })]}>⚙</button>
                            </div>
                        </header>
                        {state.showSettings && graph && <GraphSettings graph={graph} state={state} apply={settings => applyGraphSettings(active.id, settings)} close={() => {
                            state.showSettings = false
                            void options.update()
                        }} />}
                        {graph?.limited.length ? <div class="graph-limit">Limited evidence: {graph.limited.join(", ")}. No implicit fetch performed.</div> : null}
                        {!graph && state.loading && <GraphProgress />}
                        {!graph && state.error && <GraphError message={state.error} retry={() => read(active.id, false, true)} />}
                        {graph && (
                            <div class="graph-layout">
                                <section class="graph-panel" aria-label="Branch Graph">
                                    <GraphSummary graph={graph} visibleCount={visibleBranches.length} />
                                    <BaseUnresolved branches={visibleBranches} selections={state.baseCandidateSelections} choose={(branchId, candidateId) => {
                                        state.baseCandidateSelections[branchId] = candidateId
                                        void options.update()
                                    }} />
                                    <div class="graph-rows" role="listbox" aria-label="Branches and graph nodes" tabIndex={0} mix={[on("keydown", event => graphKeydown(event, active.id, selectableIds)), on("scroll", event => {
                                        state.graphScrollTop = event.currentTarget.scrollTop
                                        state.graphViewportHeight = event.currentTarget.clientHeight
                                        void options.update()
                                    })]}>
                                        {nodeWindow.before > 0 && <div class="graph-spacer" aria-hidden="true" style={`height:${nodeWindow.before}px`}></div>}
                                        {nodeWindow.nodes.map(node => node.kind == "branch"
                                            ? <BranchRow branch={node.branch} index={node.branchIndex} selected={state.selectedId == node.id} select={() => selectNode(active.id, node.id)} open={() => openBranch(active.id, node.id)} selectMarker={marker => selectMarker(active.id, node.id, marker)} />
                                            : <SimpleNodeRow id={node.id} kind={node.kind} name={node.name} title={node.title} selected={state.selectedId == node.id} select={() => selectNode(active.id, node.id)} />)}
                                        {nodeWindow.after > 0 && <div class="graph-spacer" aria-hidden="true" style={`height:${nodeWindow.after}px`}></div>}
                                    </div>
                                    {graph.unassignedStashes.length > 0 && <details class="unassigned-markers"><summary>{graph.unassignedStashes.length} unassigned stashes</summary>{graph.unassignedStashes.map(marker => <button type="button" title={marker.tooltip} mix={[on("click", () => {
                                        state.marker = marker
                                        void options.update()
                                    })]}>{marker.label}</button>)}</details>}
                                    {state.marker && <MarkerDetails marker={state.marker} close={() => {
                                        state.marker = undefined
                                        void options.update()
                                    }} />}
                                </section>
                                <BranchColumns graph={graph} state={state} inspection={inspection} repositoryId={active.id} worktreePath={id => backingPath(active.id, id)} close={branchId => closeBranch(active.id, branchId)} maximize={branchId => maximizeBranch(active.id, branchId)} focus={branchId => focusColumn(active.id, branchId)} move={(branchId, delta) => moveColumn(active.id, branchId, delta)} previewMove={(branchId, targetId) => previewColumnMove(active.id, branchId, targetId)} commitMove={branchId => commitColumnMove(active.id, branchId)} resize={(branchId, width) => resizeColumn(active.id, branchId, width)} />
                            </div>
                        )}
                    </section>
                </section>
            )
        },
        renderLens(workspace) {
            currentWorkspace = workspace
            if (!lensOpen)
                return null
            const results = lensResults(workspace, states, activeRepositoryId, lensQuery)
            if (lensIndex >= results.length)
                lensIndex = Math.max(0, results.length - 1)
            return (
                <div class="lens-backdrop" role="presentation" mix={[on("click", event => {
                    if (event.target == event.currentTarget)
                        closeLens()
                })]}>
                    <section class="command-lens" role="dialog" aria-modal="true" aria-labelledby="lens-heading">
                        <header><span>⌕</span><input aria-label="Command Lens search" id="lens-heading" placeholder="Search open repositories and branches." value={lensQuery} mix={[ref(node => {
                            lensInput = node
                            queueMicrotask(() => node.focus())
                        }), on("input", event => {
                            lensQuery = event.currentTarget.value
                            lensIndex = 0
                            void options.update()
                        }), on("keydown", event => lensKeydown(event, results))]} /></header>
                        {lensQuery.trim() == ""
                            ? <p class="lens-guidance">Search open repositories and branches.</p>
                            : <div class="lens-results">{results.map((result, index) => <button type="button" class={index == lensIndex ? "active" : ""} mix={[on("click", () => activateLensResult(result))]}><span class={`lens-kind ${result.kind}`}>{result.kind == "repository" ? "REPO" : result.kind == "command" ? "CMD" : "BR"}</span><span><strong>{result.label}</strong><small>{result.detail}</small></span><kbd>↵</kbd></button>)}</div>}
                    </section>
                </div>
            )
        },
    }

    function stateFor(repositoryId: string) {
        let state = states.get(repositoryId)
        if (!state) {
            const saved = options.workspace().repositories.find(repository => repository.id == repositoryId)
            state = { diffLayouts: Object.fromEntries(saved?.columns.map(column => [column.id, column.diffLayout ?? "unified"]) ?? []), loading: false, refreshing: false, showAll: false, openedBranchIds: saved?.columns.map(column => column.id) ?? [], widths: Object.fromEntries(saved?.columns.map(column => [column.id, column.width]) ?? []), focusedColumnId: saved?.focusedColumnId, focusRestored: false, showSettings: false, patterns: "", collapsedBranchIds: [], remoteRefreshed: false, baseCandidateSelections: {}, graphScrollTop: 0, graphViewportHeight: 600 }
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
        if (state.loading || state.refreshing)
            return
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
                const validColumnIds = new Set([...result.graph.branches, ...result.graph.virtualBranches].map(branch => branch.id))
                const removedColumns = state.openedBranchIds.filter(id => !validColumnIds.has(id))
                state.graph = result.graph
                if (refreshRemote)
                    state.remoteRefreshed = true
                state.patterns = result.graph.remotePatterns.join(", ")
                state.openedBranchIds = state.openedBranchIds.filter(id => validColumnIds.has(id))
                if (!state.focusedColumnId || !state.openedBranchIds.includes(state.focusedColumnId))
                    state.focusedColumnId = state.openedBranchIds[0]
                for (const column of [...result.graph.branches, ...result.graph.virtualBranches].filter(column => state.openedBranchIds.includes(column.id)))
                    state.widths[column.id] ??= 380
                const savedRepository = options.workspace().repositories.find(repository => repository.id == repositoryId)
                if (savedRepository?.status == "available") {
                    for (const savedColumn of savedRepository.columns.filter(column => column.kind == "branch" && column.worktreePath)) {
                        const current = result.graph.branches.find(branch => branch.checkedOut.some(worktree => worktree.path == savedColumn.worktreePath))
                            ?? result.graph.virtualBranches.find(branch => branch.worktree.path == savedColumn.worktreePath)
                        if (current && current.id != savedColumn.id && !state.openedBranchIds.includes(current.id)) {
                            const savedIndex = state.openedBranchIds.indexOf(savedColumn.id)
                            state.openedBranchIds.splice(savedIndex + 1, 0, current.id)
                            state.widths[current.id] = state.widths[savedColumn.id] ?? 380
                        }
                    }
                }
                if (savedRepository?.status == "available" && !savedRepository.layoutInitialized) {
                    const selectedPath = savedRepository.info.selectedWorktree
                    const initialColumn = result.graph.branches.find(branch => branch.checkedOut.some(worktree => worktree.path == selectedPath))
                        ?? result.graph.virtualBranches.find(branch => branch.worktree.path == selectedPath)
                    if (initialColumn) {
                        state.openedBranchIds.push(initialColumn.id)
                        state.focusedColumnId = initialColumn.id
                        state.widths[initialColumn.id] = 380
                    }
                    savedRepository.layoutInitialized = true
                }
                state.baseCandidateSelections = Object.fromEntries(Object.entries(state.baseCandidateSelections).filter(([branchId, candidateId]) => {
                    const branch = result.graph.branches.find(candidate => candidate.id == branchId)
                    return branch?.base.status == "ambiguous" && branch.base.candidates.some(candidate => candidate.branchId == candidateId)
                }))
                if (removedColumns.length > 0)
                    options.notify({ code: "branch.removed", message: `${removedColumns.length == 1 ? "An open branch" : `${removedColumns.length} open branches`} no longer exists; its column was closed.` })
                await persist(repositoryId)
            } else if (result.error.code != "git.cancelled") {
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
                const column = [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(candidate => candidate.dataset.columnId == state.focusedColumnId)
                column?.focus({ preventScroll: true })
                column?.scrollIntoView({ block: "nearest", inline: "nearest" })
            }
        }
    }

    function toggleAll(repositoryId: string) {
        const state = stateFor(repositoryId)
        state.showAll = !state.showAll
        if (!state.showAll && state.graph && state.selectedId && !branchesForDisplay(state.graph, false, state.collapsedBranchIds).some(branch => branch.id == state.selectedId))
            state.selectedId = undefined
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
        void options.update()
    }

    function openBranch(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
        if (!state.openedBranchIds.includes(branchId))
            state.openedBranchIds.push(branchId)
        state.selectedId = branchId
        state.focusedColumnId = branchId
        state.widths[branchId] ??= 380
        state.maximizedBranchId = undefined
        void persist(repositoryId).then(() => options.update()).then(() => [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(column => column.dataset.columnId == branchId)?.focus())
    }

    function closeBranch(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
        const index = state.openedBranchIds.indexOf(branchId)
        state.openedBranchIds = state.openedBranchIds.filter(id => id != branchId)
        if (state.maximizedBranchId == branchId)
            state.maximizedBranchId = undefined
        if (state.focusedColumnId == branchId) {
            state.focusedColumnId = state.openedBranchIds[index] ?? state.openedBranchIds[index - 1]
        }
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
            options.notify({ code: "column.boundary", message: target < 0 ? "Already first column." : "Already last column." })
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
        if (virtual) return virtual.worktree.path
        const branch = graph?.branches.find(branch => branch.id == columnId)
        const saved = options.workspace().repositories.find(repository => repository.id == repositoryId)?.columns.find(column => column.id == columnId)?.worktreePath
        return branch?.checkedOut.find(worktree => worktree.path == saved)?.path ?? (branch?.checkedOut.length == 1 ? branch.checkedOut[0].path : undefined)
    }

    async function persist(repositoryId: string) {
        const workspace = options.workspace()
        const repository = workspace.repositories.find(candidate => candidate.id == repositoryId)
        const state = stateFor(repositoryId)
        if (!repository || !state.graph)
            return
        repository.columns = state.openedBranchIds.flatMap((id): WorkspaceColumn[] => {
            const branch = state.graph!.branches.find(candidate => candidate.id == id)
            if (branch)
                return [{ kind: "branch" as const, id, ref: branch.preferredRef, lastSeenObjectId: branch.tip, width: state.widths[id] ?? 380, diffLayout: state.diffLayouts[id] ?? "unified", ...(backingPath(repositoryId, id) ? { worktreePath: backingPath(repositoryId, id) } : {}) }]
            const virtual = state.graph!.virtualBranches.find(candidate => candidate.id == id)
            return virtual ? [{ kind: "virtual" as const, id, worktreePath: virtual.worktree.path, lastSeenObjectId: virtual.objectId, width: state.widths[id] ?? 380, diffLayout: state.diffLayouts[id] ?? "unified" }] : []
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

    function graphKeydown(event: KeyboardEvent, repositoryId: string, nodeIds: string[]) {
        const state = stateFor(repositoryId)
        const index = nodeIds.findIndex(id => id == state.selectedId)
        if (event.key == "ArrowDown" || event.key == "ArrowUp") {
            event.preventDefault()
            const delta = event.key == "ArrowDown" ? 1 : -1
            const nextIndex = index < 0 && delta < 0 ? nodeIds.length - 1 : Math.max(0, Math.min(nodeIds.length - 1, index + delta))
            if (nodeIds[nextIndex]) {
                const nextId = nodeIds[nextIndex]
                state.selectedId = nextId
                const nodeIndex = nodeIds.indexOf(nextId)
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
        } else if ((event.key == "ArrowLeft" || event.key == "ArrowRight") && state.selectedId && state.graph?.branches.some(branch => branch.id == state.selectedId)) {
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
        lensIndex = 0
        for (const repository of currentWorkspace?.repositories ?? []) {
            if (repository.status == "available")
                void ensure(repository.id, false)
        }
        void options.update()
    }

    function closeLens() {
        lensOpen = false
        void options.update().then(() => restoreFocus?.focus())
    }

    function lensKeydown(event: KeyboardEvent, results: LensResult[]) {
        if (event.key == "Escape") {
            event.preventDefault()
            closeLens()
        } else if (event.key == "ArrowDown" || event.key == "ArrowUp") {
            event.preventDefault()
            const delta = event.key == "ArrowDown" ? 1 : -1
            lensIndex = Math.max(0, Math.min(results.length - 1, lensIndex + delta))
            void options.update()
        } else if (event.key == "Enter" && results[lensIndex]) {
            event.preventDefault()
            void activateLensResult(results[lensIndex])
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
        if (result.kind == "branch")
            selectNode(result.repositoryId, result.nodeId)
        closeLens()
        await options.update()
        document.querySelector<HTMLElement>(".graph-rows")?.focus()
    }
}

type DisplayNode =
    | { kind: "branch"; id: string; branch: BranchGraphBranchNode; branchIndex: number }
    | { kind: "tag" | "worktree"; id: string; name: string; title: string }

const graphRowHeight = 40

function nodesForDisplay(graph: BranchGraph, branches: BranchGraphBranchNode[]): DisplayNode[] {
    return [
        ...branches.flatMap((branch, branchIndex): DisplayNode[] => [
            { kind: "branch", id: branch.id, branch, branchIndex },
            ...graph.tags.filter(tag => tag.parentBranchId == branch.id).map(tag => ({ kind: "tag" as const, id: tag.id, name: tag.name, title: tag.tooltip })),
        ]),
        ...graph.tags.filter(tag => !tag.parentBranchId).map(tag => ({ kind: "tag" as const, id: tag.id, name: tag.name, title: tag.tooltip })),
        ...graph.virtualBranches.map(branch => ({ kind: "worktree" as const, id: branch.id, name: branch.name, title: branch.tooltip })),
    ]
}

function windowNodes(nodes: DisplayNode[], scrollTop: number, viewportHeight: number) {
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
    const structural = new Set(graph.branches.filter(branch => branch.primary || branch.checkedOut.length > 0).map(branch => branch.id))
    for (const branch of graph.branches.filter(branch => branch.involvement == "involved")) {
        structural.add(branch.id)
        if (branch.base.status == "known")
            structural.add(branch.base.branchId)
        else
            branch.base.candidates.forEach(candidate => structural.add(candidate.branchId))
    }
        branches = graph.branches.filter(branch => branch.involvement == "involved" || structural.has(branch.id))
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

let draggingRepositoryId: string | undefined

function RepositoryRail(handle: Handle<{ active: AvailableOpenRepository; workspace: Workspace; busy: boolean; selectRepository(id: string): void; closeRepository(id: string): void; moveRepository(id: string, targetId: string): void; previewRepositoryMove(id: string, targetId: string): void; commitRepositoryOrder(): void; cancelRepositoryMove(): void; addRepository(): void; openLens(): void }>) {
    return () => {
        const props = handle.props
        return (
        <aside class="repository-rail graph-rail">
            <div class="rail-heading"><p class="eyebrow">Open repositories</p><span>{props.workspace.repositories.length}</span><button class="rail-add" type="button" aria-label="Add repository" title="Add repository" disabled={props.busy} mix={[on("click", props.addRepository)]}>+</button></div>
            <nav aria-label="Open repositories">{props.workspace.repositories.map((repository, index) => <div class="repository-row" draggable={!props.busy} mix={[on("keydown", event => {
                if (event.ctrlKey && event.shiftKey && (event.key == "<" || event.key == ">")) {
                    event.preventDefault()
                    const target = props.workspace.repositories[index + (event.key == "<" ? -1 : 1)]
                    if (target)
                        props.moveRepository(repository.id, target.id)
                }
            }), on("dragstart", event => {
                draggingRepositoryId = repository.id
                event.dataTransfer?.setData("text/plain", repository.id)
            }), on("dragover", event => {
                event.preventDefault()
                if (draggingRepositoryId)
                    props.previewRepositoryMove(draggingRepositoryId, repository.id)
            }), on("drop", event => {
                event.preventDefault()
                props.commitRepositoryOrder()
                draggingRepositoryId = undefined
            }), on("dragend", () => {
                if (draggingRepositoryId)
                    props.cancelRepositoryMove()
                draggingRepositoryId = undefined
            })]}><button class={`repository-item ${repository.id == props.active.id ? "active" : ""} ${repository.status}`} type="button" disabled={props.busy} mix={[on("click", () => props.selectRepository(repository.id))]}><span>{initials(repository.path)}</span><span><strong>{repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name}</strong><small>{repository.status == "available" ? repository.info.selectedWorktree : "Unavailable"}</small></span></button><button class="repository-close" type="button" aria-label={`Close ${repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name}`} title="Close repository" mix={[on("click", () => props.closeRepository(repository.id))]}>×</button></div>)}</nav>
            <button class="lens-button" type="button" mix={[on("click", props.openLens)]}><span>⌕</span>Command Lens<kbd>Ctrl K</kbd></button>
        </aside>
        )
    }
}

function GraphSummary(handle: Handle<{ graph: BranchGraph; visibleCount: number }>) {
    return () => <div class="graph-summary"><span>{handle.props.visibleCount} branches</span><span>{handle.props.graph.primaryBranch.status == "known" ? `Primary · ${shortRef(handle.props.graph.primaryBranch.ref!)}` : "Primary unresolved"}</span><span>{handle.props.graph.selectedRemote ? `Remote · ${handle.props.graph.selectedRemote}` : "Remote unresolved"}</span></div>
}

function BaseUnresolved(handle: Handle<{ branches: BranchGraphBranchNode[]; selections: Record<string, string>; choose(branchId: string, candidateId: string): void }>) {
    return () => {
        const unresolved = handle.props.branches.filter(branch => branch.base.status == "ambiguous")
        if (unresolved.length == 0)
            return null
        return (
            <details class="base-unresolved">
                <summary>Base unresolved · {unresolved.length}</summary>
                {unresolved.map(branch => <div><strong>{branch.name}</strong><span>{branch.base.status == "ambiguous" && branch.base.candidates.map(candidate => <button type="button" class={handle.props.selections[branch.id] == candidate.branchId ? "active" : ""} title="Use for inspection only" mix={[on("click", () => handle.props.choose(branch.id, candidate.branchId))]}>{candidate.name}</button>)}</span></div>)}
            </details>
        )
    }
}

function BranchRow(handle: Handle<{ branch: BranchGraphBranchNode; index: number; selected: boolean; select(): void; open(): void; selectMarker(marker: BranchGraphMarker): void }>) {
    return () => {
        const props = handle.props
        const branch = props.branch
        return (
        <div class={`graph-row ${props.selected ? "selected" : ""}`} role="option" aria-selected={props.selected} data-node-id={branch.id} mix={[on("click", props.select)]}>
            <span class="lane" aria-hidden="true"><i style={`--lane:${props.index % 4}`}></i><b></b></span>
            <span class="branch-copy"><strong>{branch.name}</strong><small>{branch.primary ? "Primary" : branch.remoteOnly ? "Remote only" : branch.involvement == "involved" ? "Involved" : branch.involvement == "unknown" ? "Involvement unknown" : "Other branch"}</small></span>
            {branch.checkedOut.map(worktree => <span class="worktree-chip" title={worktree.path}>⌂ {worktree.name}</span>)}
            {branch.tags.map(tag => <span class="tag-chip">⌑ {tag}</span>)}
            {branch.markers.map(marker => <button class="marker-button" type="button" title={marker.tooltip} mix={[on("click", event => {
                event.stopPropagation()
                props.selectMarker(marker)
            })]}>◆</button>)}
            {(branch.ahead > 0 || branch.behind > 0) && <span class="divergence">↑{branch.ahead} ↓{branch.behind}</span>}
            <button class="open-branch" type="button" mix={[on("click", event => {
                event.stopPropagation()
                props.open()
            })]}>Open</button>
        </div>
        )
    }
}

function SimpleNodeRow(handle: Handle<{ id: string; kind: "tag" | "worktree"; name: string; title: string; selected: boolean; select(): void }>) {
    return () => <button class={`graph-row simple ${handle.props.selected ? "selected" : ""}`} data-node-id={handle.props.id} role="option" aria-selected={handle.props.selected} type="button" title={handle.props.title} mix={[on("click", handle.props.select)]}><span class="node-icon">{handle.props.kind == "tag" ? "⌑" : "⌂"}</span><span class="branch-copy"><strong>{handle.props.name}</strong><small>{handle.props.kind == "tag" ? "Tag" : "Detached worktree"}</small></span></button>
}

function BranchColumns(handle: Handle<{ graph: BranchGraph; state: RepositoryGraphState; inspection: ReturnType<typeof createInspection>; repositoryId: string; worktreePath(id: string): string | undefined; close(branchId: string): void; maximize(branchId: string): void; focus(branchId: string): void; move(branchId: string, delta: number): void; previewMove(branchId: string, targetId: string): void; commitMove(branchId: string): void; resize(branchId: string, width: number): void }>) {
    return () => {
        const props = handle.props
        const columns = props.state.openedBranchIds.map(id => props.graph.branches.find(branch => branch.id == id) ?? props.graph.virtualBranches.find(branch => branch.id == id)).filter(column => column != undefined)
        if (columns.length == 0)
            return <section class="column-empty"><span>Open a branch</span><p>Select a Branch Node, then use Open or Enter.</p></section>
        const visible = props.state.maximizedBranchId ? columns.filter(column => column.id == props.state.maximizedBranchId) : columns
        return <section class={`branch-columns ${props.state.maximizedBranchId ? "maximized" : ""}`}>{visible.map(column => <><article class="branch-column" data-column-id={column.id} tabIndex={-1} mix={[ref(element => { element.style.width = `${props.state.widths[column.id] ?? 380}px` }), on("focusin", () => props.focus(column.id)), on("keydown", event => {
            if (event.ctrlKey && event.shiftKey && (event.key == "<" || event.key == ">")) {
                event.preventDefault()
                props.move(column.id, event.key == "<" ? -1 : 1)
            }
        })]}><header draggable={!props.state.maximizedBranchId} title="Drag to reorder · Ctrl+< / Ctrl+>" mix={[on("dragstart", event => {
            props.state.draggingColumnId = column.id
            props.state.dragOriginalIds = [...props.state.openedBranchIds]
            event.dataTransfer?.setData("text/plain", column.id)
        }), on("dragover", event => {
            event.preventDefault()
            if (props.state.draggingColumnId)
                props.previewMove(props.state.draggingColumnId, column.id)
        }), on("drop", event => {
            event.preventDefault()
            const source = props.state.draggingColumnId
            if (source)
                props.commitMove(source)
        }), on("dragend", () => {
            if (props.state.draggingColumnId && props.state.dragOriginalIds) {
                props.state.openedBranchIds = props.state.dragOriginalIds
                void handle.update()
            }
            props.state.draggingColumnId = undefined
            props.state.dragOriginalIds = undefined
        })]}><div><span class="column-kind">{column.kind == "branch" ? "Branch" : "Virtual"}</span><h2>{column.name}</h2><p>{column.kind == "branch" ? column.preferredRef : shortOid(column.objectId)}</p></div><div><button type="button" title={props.state.maximizedBranchId ? "Restore columns" : "Maximize column"} mix={[on("click", () => props.maximize(column.id))]}>{props.state.maximizedBranchId ? "↙" : "↗"}</button><button type="button" title="Close column" mix={[on("click", () => props.close(column.id))]}>×</button></div></header>{props.worktreePath(column.id) && <div class="column-worktree">⌂ {props.worktreePath(column.id)}</div>}{props.inspection.body(props.repositoryId, column, props.graph, props.worktreePath(column.id))}{!props.state.maximizedBranchId && <ColumnDivider branchId={column.id} width={props.state.widths[column.id] ?? 380} resize={props.resize} />}</article>{props.inspection.breakout(props.repositoryId, column.id)}</>)}</section>
    }
}

function ColumnDivider(handle: Handle<{ branchId: string; width: number; resize(branchId: string, width: number): void }>) {
    return () => <div class="column-divider" role="separator" tabIndex={0} aria-label="Resize branch column" aria-orientation="vertical" aria-valuemin={310} aria-valuemax={2000} aria-valuenow={Math.round(handle.props.width)} mix={[on("keydown", event => {
        const step = event.shiftKey ? 50 : 10
        if (event.key == "ArrowLeft" || event.key == "ArrowRight") {
            event.preventDefault()
            handle.props.resize(handle.props.branchId, handle.props.width + (event.key == "ArrowLeft" ? -step : step))
        } else if (event.key == "Home") {
            event.preventDefault()
            handle.props.resize(handle.props.branchId, 310)
        } else if (event.key == "End") {
            event.preventDefault()
            handle.props.resize(handle.props.branchId, Math.max(310, document.querySelector<HTMLElement>(".graph-layout")?.clientWidth ?? 1180))
        }
    }), on("pointerdown", event => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = handle.props.width
        const column = (event.currentTarget as HTMLElement).closest<HTMLElement>(".branch-column")
        const move = (next: PointerEvent) => {
            if (column)
                column.style.width = `${Math.max(310, startWidth + next.clientX - startX)}px`
        }
        const end = (next: PointerEvent) => {
            window.removeEventListener("pointermove", move)
            window.removeEventListener("pointerup", end)
            handle.props.resize(handle.props.branchId, startWidth + next.clientX - startX)
        }
        window.addEventListener("pointermove", move)
        window.addEventListener("pointerup", end, { once: true })
    })]}></div>
}

function GraphSettings(handle: Handle<{ graph: BranchGraph; state: RepositoryGraphState; apply(settings: RepositoryGraphSettings): void; close(): void }>) {
    return () => <section class="graph-settings"><header><div><p class="eyebrow">Repository setting</p><h2>Graph sources</h2></div><button type="button" aria-label="Close graph settings" mix={[on("click", handle.props.close)]}>×</button></header><p>Select one remote when the repository has several. Patterns use Git-like globs over <code>remote/branch</code>.</p><div class="remote-options">{handle.props.graph.availableRemotes.map(remote => <button type="button" class={handle.props.graph.selectedRemote == remote ? "active" : ""} mix={[on("click", () => handle.props.apply({ selectedRemote: remote, remotePatterns: splitPatterns(handle.props.state.patterns) }))]}>{remote}</button>)}</div><label for="remote-patterns">Additional remote branches</label><input id="remote-patterns" value={handle.props.state.patterns} placeholder="origin/release/**, upstream/topic/*" mix={[on("input", event => {
        handle.props.state.patterns = event.currentTarget.value
    })]} /><button class="secondary-button" type="button" mix={[on("click", () => handle.props.apply({ selectedRemote: handle.props.graph.selectedRemote, remotePatterns: splitPatterns(handle.props.state.patterns) }))]}>Apply patterns</button></section>
}

function MarkerDetails(handle: Handle<{ marker: BranchGraphMarker; close(): void }>) {
    return () => <aside class="marker-details"><div><span>STASH</span><strong>{handle.props.marker.label}</strong><small>{shortOid(handle.props.marker.objectId)}</small></div><button type="button" aria-label="Close marker details" mix={[on("click", handle.props.close)]}>×</button><p>{handle.props.marker.tooltip}</p></aside>
}

function GraphProgress(_handle: Handle<Record<string, never>>) {
    return () => <div class="graph-loading"><span></span><p>Reading verified Branch Graph…</p><small>Local refs and worktrees first.</small></div>
}

function GraphError(handle: Handle<{ message: string; retry(): void }>) {
    return () => <div class="graph-error" role="alert"><span>Graph unavailable</span><p>{handle.props.message}</p><button class="primary-button" type="button" mix={[on("click", handle.props.retry)]}>Retry</button></div>
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

type LensResult = LensNavigationResult | ColumnCommandResult

function lensResults(workspace: Workspace, states: Map<string, RepositoryGraphState>, activeId: string | undefined, query: string): LensResult[] {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle)
        return []
    const results: LensResult[] = []
    const focusedColumnId = activeId ? states.get(activeId)?.focusedColumnId : undefined
    if (activeId && focusedColumnId) {
        for (const command of [{ label: "Move column left", delta: -1 }, { label: "Move column right", delta: 1 }]) {
            const score = textScore(command.label, needle)
            if (score > 0)
                results.push({ kind: "command", repositoryId: activeId, nodeId: focusedColumnId, label: command.label, detail: command.delta < 0 ? "Ctrl+<" : "Ctrl+>", score, delta: command.delta })
        }
    }
    for (const repository of workspace.repositories) {
        const name = repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name
        const repoScore = textScore(name, needle)
        if (repoScore > 0)
            results.push({ kind: "repository", repositoryId: repository.id, nodeId: repository.id, label: name, detail: repository.status == "available" ? repository.info.selectedWorktree : "Unavailable", score: repoScore })
        for (const branch of states.get(repository.id)?.graph?.branches ?? []) {
            const score = Math.max(...[branch.name, ...branch.aliases].map(value => textScore(value, needle)))
            if (score > 0)
                results.push({ kind: "branch", repositoryId: repository.id, nodeId: branch.id, label: branch.name, detail: name, score })
        }
    }
    return results.sort((left, right) => Number(right.repositoryId == activeId) - Number(left.repositoryId == activeId) || right.score - left.score || left.label.localeCompare(right.label, undefined, { numeric: true }))
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

function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}

function initials(path: string) {
    const words = baseName(path).split(/[-_.\s]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "GW").toUpperCase()
}
