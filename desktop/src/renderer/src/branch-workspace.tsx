import type { BranchGraph, BranchGraphBranchNode, BranchGraphMarker, RepositoryInfo, RepositoryGraphSettings, WorkbenchSession } from "@git-workbench/shared"
import { on, ref, type Handle, type RemixNode } from "remix/ui"
import { errorMessage, type NoticeState } from "./feedback"

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
}

interface BranchWorkspaceOptions {
    api: Window["workbench"]
    update(): Promise<AbortSignal>
    signal: AbortSignal
    notify(notice: NoticeState): void
    selectRepository(id: string): Promise<void>
}

export interface BranchWorkspace {
    activate(repositoryId: string): void
    deactivate(): void
    render(active: RepositoryInfo, session: WorkbenchSession): RemixNode
    renderLens(session: WorkbenchSession): RemixNode
}

export function createBranchWorkspace(options: BranchWorkspaceOptions): BranchWorkspace {
    const states = new Map<string, RepositoryGraphState>()
    let activeRepositoryId: string | undefined
    let lensOpen = false
    let lensQuery = ""
    let lensIndex = 0
    let lensInput: HTMLInputElement | undefined
    let restoreFocus: HTMLElement | null = null
    let currentSession: WorkbenchSession | undefined

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
            void ensure(repositoryId, true)
        },
        deactivate() {
            activeRepositoryId = undefined
        },
        render(active, session) {
            currentSession = session
            const state = stateFor(active.id)
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
                    <RepositoryRail active={active} session={session} busy={state.loading} selectRepository={options.selectRepository} openLens={openLens} />
                    <section class="graph-desk">
                        <header class="graph-toolbar">
                            <div><p class="eyebrow">Branch Graph</p><h1>{baseName(active.mainWorktree)}</h1></div>
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
                                <BranchColumns graph={graph} state={state} close={branchId => closeBranch(active.id, branchId)} maximize={branchId => maximizeBranch(active.id, branchId)} />
                            </div>
                        )}
                    </section>
                </section>
            )
        },
        renderLens(session) {
            currentSession = session
            if (!lensOpen)
                return null
            const results = lensResults(session, states, activeRepositoryId, lensQuery)
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
                            : <div class="lens-results">{results.map((result, index) => <button type="button" class={index == lensIndex ? "active" : ""} mix={[on("click", () => activateLensResult(result))]}><span class={`lens-kind ${result.kind}`}>{result.kind == "repository" ? "REPO" : "BR"}</span><span><strong>{result.label}</strong><small>{result.detail}</small></span><kbd>↵</kbd></button>)}</div>}
                    </section>
                </div>
            )
        },
    }

    function stateFor(repositoryId: string) {
        let state = states.get(repositoryId)
        if (!state) {
            state = { loading: false, refreshing: false, showAll: false, openedBranchIds: [], showSettings: false, patterns: "", collapsedBranchIds: [], remoteRefreshed: false, baseCandidateSelections: {}, graphScrollTop: 0, graphViewportHeight: 600 }
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
                const removedColumns = state.openedBranchIds.filter(id => !result.graph.branches.some(branch => branch.id == id))
                state.graph = result.graph
                if (refreshRemote)
                    state.remoteRefreshed = true
                state.patterns = result.graph.remotePatterns.join(", ")
                state.openedBranchIds = state.openedBranchIds.filter(id => result.graph.branches.some(branch => branch.id == id))
                state.baseCandidateSelections = Object.fromEntries(Object.entries(state.baseCandidateSelections).filter(([branchId, candidateId]) => {
                    const branch = result.graph.branches.find(candidate => candidate.id == branchId)
                    return branch?.base.status == "ambiguous" && branch.base.candidates.some(candidate => candidate.branchId == candidateId)
                }))
                if (removedColumns.length > 0)
                    options.notify({ code: "branch.removed", message: `${removedColumns.length == 1 ? "An open branch" : `${removedColumns.length} open branches`} no longer exists; its column was closed.` })
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
        state.maximizedBranchId = undefined
        void options.update().then(() => [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(column => column.dataset.columnId == branchId)?.focus())
    }

    function closeBranch(repositoryId: string, branchId: string) {
        const state = stateFor(repositoryId)
        state.openedBranchIds = state.openedBranchIds.filter(id => id != branchId)
        if (state.maximizedBranchId == branchId)
            state.maximizedBranchId = undefined
        void options.update()
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
        for (const repository of currentSession?.repositories ?? [])
            void ensure(repository.id, false)
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

const graphRowHeight = 56

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

function RepositoryRail(handle: Handle<{ active: RepositoryInfo; session: WorkbenchSession; busy: boolean; selectRepository(id: string): void; openLens(): void }>) {
    return () => {
        const props = handle.props
        return (
        <aside class="repository-rail graph-rail">
            <div class="rail-heading"><p class="eyebrow">Open repositories</p><span>{props.session.repositories.length}</span></div>
            <nav aria-label="Open repositories">{props.session.repositories.map(repository => <button class={`repository-item ${repository.id == props.active.id ? "active" : ""}`} type="button" disabled={props.busy} mix={[on("click", () => props.selectRepository(repository.id))]}><span>{initials(repository.mainWorktree)}</span><span><strong>{baseName(repository.mainWorktree)}</strong><small>{repository.selectedWorktree}</small></span></button>)}</nav>
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

function BranchColumns(handle: Handle<{ graph: BranchGraph; state: RepositoryGraphState; close(branchId: string): void; maximize(branchId: string): void }>) {
    return () => {
        const props = handle.props
        const branches = props.state.openedBranchIds.map(id => props.graph.branches.find(branch => branch.id == id)).filter((branch): branch is BranchGraphBranchNode => Boolean(branch))
        if (branches.length == 0)
            return <section class="column-empty"><span>Open a branch</span><p>Select a Branch Node, then use Open or Enter.</p></section>
        const visible = props.state.maximizedBranchId ? branches.filter(branch => branch.id == props.state.maximizedBranchId) : branches
        return <section class={`branch-columns ${props.state.maximizedBranchId ? "maximized" : ""}`}>{visible.map(branch => <article class="branch-column" data-column-id={branch.id} tabIndex={-1}><header><div><span class="column-kind">BRANCH</span><h2>{branch.name}</h2><p>{branch.preferredRef}</p></div><div><button type="button" title={props.state.maximizedBranchId ? "Restore columns" : "Maximize column"} mix={[on("click", () => props.maximize(branch.id))]}>{props.state.maximizedBranchId ? "↙" : "↗"}</button><button type="button" title="Close column" mix={[on("click", () => props.close(branch.id))]}>×</button></div></header>{branch.checkedOut.length > 0 && <div class="column-worktree">⌂ {branch.checkedOut.map(worktree => worktree.name).join(", ")}</div>}<div class="column-placeholder"><span></span><p>Branch column</p><small>Content follows in a later issue.</small></div></article>)}</section>
    }
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

interface LensResult {
    kind: "repository" | "branch"
    repositoryId: string
    nodeId: string
    label: string
    detail: string
    score: number
}

function lensResults(session: WorkbenchSession, states: Map<string, RepositoryGraphState>, activeId: string | undefined, query: string): LensResult[] {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle)
        return []
    const results: LensResult[] = []
    for (const repository of session.repositories) {
        const name = baseName(repository.mainWorktree)
        const repoScore = textScore(name, needle)
        if (repoScore > 0)
            results.push({ kind: "repository", repositoryId: repository.id, nodeId: repository.id, label: name, detail: repository.selectedWorktree, score: repoScore })
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
