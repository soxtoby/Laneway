import type { BranchGraph, BranchGraphBranchNode, BranchGraphMarker, BranchGraphWorktree, ComparisonRef, DiffLayout, RecoveryRequest, RepositoryGraphSettings, Workspace, WorkspaceColumn, WorktreeRecovery } from "@laneway/shared"
import { comparisonColumnId, type ComparisonColumnNode, comparisonNode, renameComparisonRef } from "./comparison-columns"
import type { ColumnInspection, Inspection } from "./inspection"
import { errorMessage, type Notice } from "./notice"
import { baseName } from "./repositories"
import { createStore, type Store } from "./store"
import { branchNodeFor, columnWorktree, reconcileWorktreeColumns, recoveryColumnId, recoveryWorkspaceColumn, workspaceGraph } from "./worktree-columns"

type Api = Window["laneway"]
type VirtualBranch = BranchGraph["virtualBranches"][number]

export let defaultColumnWidth = 380
export let minimumColumnWidth = 310

/** What a column shows: a branch, a detached worktree, an interrupted removal, or a comparison. */
export type ColumnNode =
    | { kind: "branch"; branch: BranchGraphBranchNode }
    | { kind: "virtual"; branch: VirtualBranch }
    | { kind: "recovery"; recovery: WorktreeRecovery }
    | { kind: "comparison"; comparison: ComparisonColumnNode }

/** What a column is, which picks its icon; `description` is the icon's tooltip. */
export type ColumnIdentity = "main" | "worktree" | "branch" | "recovery" | "comparison"

export type ColumnView = ColumnNode & {
    id: string
    name: string
    description: string
    identity: ColumnIdentity
    width: number
    collapsed: boolean
    /** How the column's diffs lay out their lines. */
    diffLayout: DiffLayout
    /** The worktree backing the column, if any; it may be missing from disk. */
    worktree?: BranchGraphWorktree
}

export interface ColumnsSnapshot {
    repositoryId?: string
    graph?: BranchGraph
    /** The first read of the active repository's Branch Graph is under way. */
    loading: boolean
    error?: string
    columns: ColumnView[]
    focusedId?: string
    maximizedId?: string
    /** The recovery under way, which every recovery column waits for. */
    recoveryBusy?: string
    recoveryErrors: Record<string, string>
    /** An interrupted worktree removal waits to be resolved, so local operations wait too. */
    blocked: boolean
    /** A local operation is running, so others wait for it. */
    busy: boolean
    /** The column last opened by an operation, which the view brings into view and focuses; `serial` tells repeats apart. */
    revealed?: { id: string; serial: number }
    graphView: GraphView
}

/** How the active repository's Branch Graph shows. */
export interface GraphView {
    shown: boolean
    /** Every branch, rather than local, Involved, Primary, pattern-matched, and Base branches only. */
    showAll: boolean
    /** Graph Selection: the node the graph highlights, which never opens a column by itself. */
    selectedId?: string
    /** Branch Nodes whose stacks are folded, hiding the branches built on them. */
    foldedIds: string[]
    /** The stash marker whose details show. */
    marker?: BranchGraphMarker
    /** The node the graph scrolls to and focuses once it shows; `serial` tells repeats apart. */
    revealed?: { id: string; serial: number }
}

export interface BranchWorkspace extends Store<ColumnsSnapshot> {
    activate(repositoryId: string): void
    deactivate(): void
    /** Reads the active repository again; a quiet read changes nothing on screen unless something changed. */
    refresh(quiet?: boolean): Promise<void>
    /**
     * Marks a local operation as running or finished. While any run, quiet refreshes wait, as the
     * operation's own files change on disk and its completion refreshes once.
     */
    mutating(busy: boolean): void
    focus(id: string): void
    /** Opens a column, or expands it if it is collapsed, and brings it into view with focus. */
    open(id: string): void
    /** Shows or hides the active repository's Branch Graph. */
    toggleGraph(): void
    /** Shows every branch, or only the relevant ones, reading the graph again. */
    toggleAll(): void
    /** Highlights a node in the Branch Graph, or none. */
    select(nodeId?: string): void
    /** Folds a Branch Node's stack, hiding the branches built on it, or unfolds it. */
    fold(nodeId: string, folded: boolean): void
    /** Shows a stash marker's details beside the branch it belongs to, or hides them. */
    showMarker(marker?: BranchGraphMarker, branchId?: string): void
    /** Saves the active repository's remote and extra remote branches, then reads its Branch Graph with them. */
    applyGraphSettings(settings: RepositoryGraphSettings): Promise<void>
    /**
     * Shows a node in a repository's Branch Graph: reads every branch when the node is filtered out, unfolds the stack
     * it sits in, selects it, and scrolls to it. Choosing another node first, or showing relevant branches, gives it up.
     */
    reveal(repositoryId: string, nodeId: string): void
    /** Opens the Branch Comparison Column from `from` to `to` beside `sourceId`, or brings the open one into view. */
    openComparison(sourceId: string, from: ComparisonRef, to: ComparisonRef): void
    /**
     * Follows a branch rename: its column, and any comparison naming it, keep their place, width, and state
     * under the new name. The saved layout follows at once, so the next read reconciles against it.
     */
    renamed(oldRef: string, newRef: string): void
    /**
     * Follows a remote-tracking branch's checkout: its column keeps its place as the column of the local branch that
     * tracks it now, unless that branch has a column already.
     */
    tracked(remoteRef: string, localRef: string): void
    /**
     * Follows a worktree switched to the branch of the column it was asked from: the worktree leaves the column
     * that showed it and backs that one, in the saved layout the next read reconciles against.
     */
    switched(columnId: string, worktreePath: string): void
    /** Collapses or expands a column. */
    toggleCollapsed(id: string): void
    /** A worktree's column collapses instead, as it stays while the worktree does. */
    close(id: string): void
    /**
     * Maximizes a column showing a diff column: the column keeps its width and its auxiliary columns fill the rest of
     * the row's view, with the other columns beside them. Restores it when it is already maximized. Only one column
     * is maximized at a time.
     */
    toggleMaximized(id: string): void
    restore(): void
    /** Moves a column by `delta` places. */
    move(id: string, delta: number): void
    /** While a column's header is dragged, the row shows it at the target; dropping keeps that order. */
    dragOver(id: string, targetId: string): void
    drop(id: string): void
    cancelDrag(): void
    resize(id: string, width: number): void
    setDiffLayout(id: string, layout: DiffLayout): void
    recover(recovery: WorktreeRecovery, action: RecoveryRequest["action"]): Promise<void>
}

interface RepositoryColumns {
    graph?: BranchGraph
    recoveries: WorktreeRecovery[]
    recoveryBusy?: string
    recoveryErrors: Record<string, string>
    loading: boolean
    refreshing: boolean
    /** The read under way, which another read waits for. */
    reading?: Promise<void>
    error?: string
    openedIds: string[]
    widths: Record<string, number>
    collapsedIds: string[]
    maximizedId?: string
    focusedId?: string
    diffLayouts: Record<string, DiffLayout>
    comparisons: Record<string, { from: ComparisonRef; to: ComparisonRef }>
    /** The order before a header drag began, restored if it ends without a drop. */
    dragOrigin?: string[]
    /** The remote's default branch has been asked for once, after the first read. */
    remoteRefreshed: boolean
    revealed?: { id: string; serial: number }
    showAll: boolean
    graphShown: boolean
    selectedId?: string
    foldedIds: string[]
    marker?: BranchGraphMarker
    graphRevealed?: { id: string; serial: number }
    /** A node to reveal once the graph shows it. */
    pendingReveal?: string
}

interface BranchWorkspaceOptions {
    api: Api
    notify(notice: Notice): void
    /** Keeps the files of the open columns, and refreshes their Working Changes with the Branch Graph. */
    inspection: Pick<Inspection, "retain" | "refreshWorking">
    workspace(): Workspace | undefined
    /** Saves the repository's Workspace Columns. */
    saveColumns(repositoryId: string, layout: { columns: WorkspaceColumn[]; focusedColumnId?: string; layoutInitialized: boolean }): Promise<void>
    /** After a failed read, shows the repository as missing if the workspace now says it is. */
    checkMissing(repositoryId: string): Promise<void>
}

/** The active repository's Workspace Columns: which are open and how they are laid out, read from its Branch Graph. */
export function createBranchWorkspace({ api, notify, inspection, workspace, saveColumns, checkMissing }: BranchWorkspaceOptions): BranchWorkspace {
    let store = createStore<ColumnsSnapshot>({
        loading: false,
        columns: [],
        recoveryErrors: {},
        blocked: false,
        busy: false,
        graphView: { shown: false, showAll: false, foldedIds: [] },
    })
    let states = new Map<string, RepositoryColumns>()
    let activeId: string | undefined
    // A disk change that lands mid-read is replayed once that read settles, asking the remote too if it was asked to.
    let changedWhileReading = false
    let refreshWhileReading = false
    let mutations = 0

    function stateFor(repositoryId: string) {
        let state = states.get(repositoryId)
        if (!state) {
            let saved = savedRepository(repositoryId)
            let columns = saved?.columns ?? []
            state = {
                recoveries: [],
                recoveryErrors: {},
                loading: false,
                refreshing: false,
                openedIds: columns.map(column => column.id),
                widths: Object.fromEntries(columns.map(column => [column.id, column.width])),
                collapsedIds: columns.filter(column => column.collapsed).map(column => column.id),
                focusedId: saved?.focusedColumnId,
                diffLayouts: Object.fromEntries(columns.map(column => [column.id, column.diffLayout ?? "unified"])),
                comparisons: Object.fromEntries(
                    columns.flatMap(column => column.kind == "comparison" ? [[column.id, { from: column.from, to: column.to }]] : []),
                ),
                remoteRefreshed: false,
                showAll: false,
                graphShown: false,
                foldedIds: [],
            }
            states.set(repositoryId, state)
        }
        return state
    }

    function savedRepository(repositoryId: string) {
        let repository = workspace()?.repositories.find(candidate => candidate.id == repositoryId)
        return repository?.status == "available" ? repository : undefined
    }

    function publish() {
        let state = activeId ? stateFor(activeId) : undefined
        let columns = activeId && state ? columnViews(activeId, state) : []
        // The inspection keeps files and commits for exactly the columns on screen.
        if (activeId && state?.graph) {
            inspection.retain(
                activeId,
                columns.map(view => ({
                    id: view.id,
                    worktreePath: view.worktree?.path,
                    worktreeMissing: view.worktree?.missing,
                    branch: view.kind == "branch" ? view.branch : undefined,
                    comparison: view.kind == "comparison" ? { from: view.comparison.from, to: view.comparison.to } : undefined,
                })),
                workspaceGraph(state.graph),
            )
        }
        store.publish(
            !activeId || !state
                ? {
                    loading: false,
                    columns: [],
                    recoveryErrors: {},
                    blocked: false,
                    busy: mutations > 0,
                    graphView: { shown: false, showAll: false, foldedIds: [] },
                }
                : {
                    repositoryId: activeId,
                    graph: state.graph,
                    loading: state.loading,
                    error: state.error,
                    columns,
                    focusedId: state.focusedId,
                    maximizedId: state.maximizedId,
                    recoveryBusy: state.recoveryBusy,
                    recoveryErrors: state.recoveryErrors,
                    blocked: state.recoveries.length > 0,
                    busy: mutations > 0,
                    revealed: state.revealed,
                    graphView: {
                        shown: state.graphShown,
                        showAll: state.showAll,
                        selectedId: state.selectedId,
                        foldedIds: state.foldedIds,
                        marker: state.marker,
                        revealed: state.graphRevealed,
                    },
                },
        )
    }

    function columnViews(repositoryId: string, state: RepositoryColumns): ColumnView[] {
        if (!state.graph)
            return []
        let graph = workspaceGraph(state.graph)
        return state.openedIds.flatMap((id): ColumnView[] => {
            let node = columnNode(graph, state, id)
            if (!node)
                return []
            let worktree = node.kind == "recovery" || node.kind == "comparison" ? undefined : columnWorktree(node.branch, backingPath(repositoryId, state, id))
            return [{
                ...node,
                ...identity(node, worktree),
                id,
                width: state.widths[id] ?? defaultColumnWidth,
                collapsed: state.collapsedIds.includes(id),
                diffLayout: state.diffLayouts[id] ?? "unified",
                worktree,
            }]
        })
    }

    // Which worktree backs a column: a recovery's directory, a detached worktree's, or the branch's worktree
    // the column was saved with, falling back to its only one.
    function backingPath(repositoryId: string, state: RepositoryColumns, columnId: string) {
        let recovery = state.recoveries.find(item => recoveryColumnId(item) == columnId)
        if (recovery)
            return recovery.path
        let virtual = state.graph?.virtualBranches.find(branch => branch.id == columnId)
        if (virtual)
            return virtual.worktree.path
        let branch = state.graph && workspaceGraph(state.graph).branches.find(candidate => candidate.id == columnId)
        let column = savedRepository(repositoryId)?.columns.find(candidate => candidate.id == columnId)
        let saved = column?.kind == "comparison" ? undefined : column?.worktreePath
        return branch?.checkedOut.find(worktree => worktree.path == saved)?.path ?? (branch?.checkedOut.length == 1 ? branch.checkedOut[0]!.path : undefined)
    }

    // A branch's column, and with `comparisons` any comparison naming it, keep their place, width, and state under its new ref.
    function follow(repositoryId: string, oldRef: string, newRef: string, comparisons: boolean) {
        let state = stateFor(repositoryId)
        let ids = new Map([[`branch:${oldRef}`, `branch:${newRef}`]])
        for (let [id, comparison] of comparisons ? Object.entries(state.comparisons) : []) {
            let renamed = { from: renameComparisonRef(comparison.from, oldRef, newRef), to: renameComparisonRef(comparison.to, oldRef, newRef) }
            let newId = comparisonColumnId(renamed.from, renamed.to)
            if (newId != id) {
                delete state.comparisons[id]
                state.comparisons[newId] = renamed
                ids.set(id, newId)
            }
        }
        let rename = (id: string) => ids.get(id) ?? id
        state.openedIds = state.openedIds.map(rename)
        state.collapsedIds = state.collapsedIds.map(rename)
        state.focusedId = state.focusedId && rename(state.focusedId)
        state.maximizedId = state.maximizedId && rename(state.maximizedId)
        for (let [oldId, newId] of ids) {
            state.widths[newId] = state.widths[oldId] ?? defaultColumnWidth
            state.diffLayouts[newId] = state.diffLayouts[oldId] ?? "unified"
        }
        // Nothing shows until the next read brings the renamed branch; the saved layout must already name it.
        let saved = savedRepository(repositoryId)
        if (saved) {
            let columns = saved.columns.map((column): WorkspaceColumn => {
                let id = rename(column.id)
                if (id == column.id)
                    return column
                if (column.kind == "branch")
                    return { ...column, id, ref: newRef }
                return column.kind == "comparison" ? { ...column, id, ...state.comparisons[id] } : column
            })
            let focusedColumnId = saved.focusedColumnId && rename(saved.focusedColumnId)
            void saveColumns(repositoryId, { columns, focusedColumnId, layoutInitialized: saved.layoutInitialized })
        }
    }

    async function persist(repositoryId: string, layoutInitialized = true) {
        let state = stateFor(repositoryId)
        if (!state.graph)
            return
        let graph = workspaceGraph(state.graph)
        let common = (id: string) => ({
            width: state.widths[id] ?? defaultColumnWidth,
            collapsed: state.collapsedIds.includes(id),
            diffLayout: state.diffLayouts[id] ?? "unified",
        })
        let columns = state.openedIds.flatMap((id): WorkspaceColumn[] => {
            let recovery = state.recoveries.find(item => recoveryColumnId(item) == id)
            if (recovery)
                return [{ ...recoveryWorkspaceColumn(recovery, state.widths[id] ?? defaultColumnWidth), ...common(id) }]
            let branch = graph.branches.find(candidate => candidate.id == id)
            if (branch) {
                let path = backingPath(repositoryId, state, id)
                return [{
                    kind: "branch",
                    id,
                    ref: branch.preferredRef,
                    lastSeenObjectId: branch.tip,
                    ...common(id),
                    ...path ? { worktreePath: path } : {},
                    worktreeId: branch.checkedOut.find(worktree => worktree.path == path)?.id,
                }]
            }
            let virtual = state.graph!.virtualBranches.find(candidate => candidate.id == id)
            if (virtual) {
                return [{
                    kind: "virtual",
                    id,
                    worktreePath: virtual.worktree.path,
                    worktreeId: virtual.worktree.id,
                    lastSeenObjectId: virtual.objectId,
                    ...common(id),
                }]
            }
            let comparison = state.comparisons[id]
            return comparison ? [{ kind: "comparison", id, ...comparison, ...common(id) }] : []
        })
        await saveColumns(repositoryId, { columns, focusedColumnId: state.focusedId, layoutInitialized })
    }

    // A quiet read asked for mid-read is replayed once that read settles. Any other waits for it and then reads,
    // so an operation's own refresh always sees what the operation did.
    async function read(repositoryId: string, quiet: boolean, refreshRemote = false): Promise<void> {
        let state = stateFor(repositoryId)
        if (state.reading) {
            if (quiet) {
                changedWhileReading = true
                refreshWhileReading ||= refreshRemote
                return
            }
            await state.reading
            return read(repositoryId, quiet, refreshRemote)
        }
        state.reading = readNow(repositoryId, state, quiet, refreshRemote)
        try {
            await state.reading
        } finally {
            state.reading = undefined
        }
        if (changedWhileReading && repositoryId == activeId) {
            let refresh = refreshWhileReading
            changedWhileReading = false
            refreshWhileReading = false
            void read(repositoryId, true, refresh)
        }
    }

    async function readNow(repositoryId: string, state: RepositoryColumns, quiet: boolean, refreshRemote: boolean) {
        let changed = !quiet || state.error != undefined
        state.error = undefined
        if (state.graph)
            state.refreshing = true
        else
            state.loading = true
        if (!quiet)
            publish()

        try {
            let result = await api.readBranchGraph(repositoryId, refreshRemote, state.showAll)
            if (result.ok) {
                if (refreshRemote)
                    state.remoteRefreshed = true
                let recoveries = result.worktreeRecoveries ?? []
                changed ||= JSON.stringify(state.graph) != JSON.stringify(result.graph) || JSON.stringify(state.recoveries) != JSON.stringify(recoveries)
                let layoutInitialized = applyGraph(repositoryId, state, result.graph, recoveries)
                revealPending(state)
                await persist(repositoryId, layoutInitialized)
            } else if (result.error.code != "git.cancelled") {
                changed = true
                await checkMissing(repositoryId)
                if (state.graph)
                    notify({ code: result.error.code, message: `Branch Graph refresh failed: ${result.error.message}` })
                state.error = result.error.message
            }
        } catch (error) {
            changed = true
            state.error = errorMessage(error)
        } finally {
            state.loading = false
            state.refreshing = false
            if (changed && repositoryId == activeId)
                publish()
        }
    }

    /** Takes a new Branch Graph: keeps the saved columns that still exist, opens every worktree, and closes the rest. */
    function applyGraph(repositoryId: string, state: RepositoryColumns, graph: BranchGraph, recoveries: WorktreeRecovery[]) {
        let shown = state.openedIds
        state.recoveries = recoveries
        let identities = workspaceGraph(graph)
        let nodes = [...identities.branches, ...identities.virtualBranches]
        let valid = new Set([...nodes.map(node => node.id), ...recoveries.map(recoveryColumnId), ...Object.keys(state.comparisons)])
        let removed = state.openedIds.filter(id => !valid.has(id) && !id.startsWith("recovery:"))
        state.graph = graph
        state.openedIds = state.openedIds.filter(id => valid.has(id))

        let saved = savedRepository(repositoryId)
        let layoutInitialized = saved?.layoutInitialized ?? true
        if (saved) {
            let reconciled = reconcileWorktreeColumns(saved.columns, graph, saved.focusedColumnId, recoveries)
            state.openedIds = [...reconciled.columns.map(column => column.id), ...state.openedIds.filter(id => !saved.columns.some(column => column.id == id))]
            for (let column of reconciled.columns) {
                state.widths[column.id] = column.width
                state.diffLayouts[column.id] = column.diffLayout ?? "unified"
                state.collapsedIds = state.collapsedIds.filter(id => id != column.id)
                if (column.collapsed)
                    state.collapsedIds.push(column.id)
            }
            state.focusedId = reconciled.focused
            // A repository opened for the first time starts with the worktree it was opened from.
            if (!saved.layoutInitialized) {
                let selected = saved.info.selectedWorktree
                let initial = identities.branches.find(branch => branch.checkedOut.some(worktree => worktree.path == selected))
                    ?? graph.virtualBranches.find(branch => branch.worktree.path == selected)
                if (initial) {
                    state.openedIds.push(initial.id)
                    state.focusedId = initial.id
                }
                layoutInitialized = true
            }
        }

        // Every worktree has a column, except one whose interrupted removal shows as a recovery column instead.
        for (let node of [...identities.branches.filter(branch => branch.checkedOut.length > 0), ...identities.virtualBranches]) {
            let worktrees = node.kind == "branch" ? node.checkedOut : [node.worktree]
            if (!state.openedIds.includes(node.id) && !worktrees.some(worktree => recoveries.some(item => item.path == worktree.path)))
                state.openedIds.push(node.id)
        }
        state.openedIds = [...new Set(state.openedIds)]
        // A header drag under way keeps the order it shows; its drop saves that order.
        if (state.dragOrigin)
            state.openedIds = [...shown.filter(id => state.openedIds.includes(id)), ...state.openedIds.filter(id => !shown.includes(id))]
        for (let id of state.openedIds)
            state.widths[id] ??= defaultColumnWidth
        if (state.maximizedId && !state.openedIds.includes(state.maximizedId))
            state.maximizedId = undefined
        if (!state.focusedId || !state.openedIds.includes(state.focusedId))
            state.focusedId = state.openedIds[0]
        // Hiding the selected node, by narrowing the graph or deleting its branch, clears Graph Selection.
        let shownIds = [...identities.branches, ...graph.tags, ...graph.virtualBranches].map(node => node.id)
        if (state.selectedId && !shownIds.includes(state.selectedId))
            state.selectedId = undefined
        if (removed.length > 0) {
            let names = new Intl.ListFormat("en", { type: "conjunction" }).format(removed.map(removedColumnName))
            notify({
                code: "branch.removed",
                message: removed.length == 1
                    ? `${names} no longer exists; its column was closed.`
                    : `${names} no longer exist; their columns were closed.`,
            })
        }
        return layoutInitialized
    }

    function revealPending(state: RepositoryColumns) {
        let graph = state.graph
        let nodeId = state.pendingReveal
        let identities = graph && workspaceGraph(graph)
        let shown = identities && [...identities.branches, ...graph!.tags, ...graph!.virtualBranches].some(node => node.id == nodeId)
        if (!graph || !nodeId || !shown)
            return
        // A branch hides under any folded Branch Node below it in its stack.
        let below = new Set<string>()
        for (let branch = branchNodeFor(graph, nodeId); branch?.base.status == "known" && !below.has(branch.base.branchId);) {
            below.add(branch.base.branchId)
            branch = branchNodeFor(graph, branch.base.branchId)
        }
        state.foldedIds = state.foldedIds.filter(id => !below.has(id))
        state.pendingReveal = undefined
        state.selectedId = nodeId
        state.marker = undefined
        state.graphRevealed = { id: nodeId, serial: (state.graphRevealed?.serial ?? 0) + 1 }
    }

    // The first read shows the local Branch Graph at once; the remote's default branch follows quietly.
    async function ensure(repositoryId: string) {
        let state = stateFor(repositoryId)
        await read(repositoryId, state.graph != undefined)
        if (state.graph && !state.remoteRefreshed)
            await read(repositoryId, true, true)
    }

    function toggleCollapsed(id: string) {
        change(activeId, state => {
            state.collapsedIds = state.collapsedIds.includes(id) ? state.collapsedIds.filter(candidate => candidate != id) : [...state.collapsedIds, id]
            if (state.maximizedId == id)
                state.maximizedId = undefined
        })
    }

    function change(repositoryId: string | undefined, update: (state: RepositoryColumns) => void, save = true) {
        if (!repositoryId)
            return
        let state = stateFor(repositoryId)
        update(state)
        publish()
        if (save)
            void persist(repositoryId)
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        activate(repositoryId) {
            if (activeId == repositoryId)
                return
            activeId = repositoryId
            publish()
            void ensure(repositoryId)
        },

        deactivate() {
            activeId = undefined
            publish()
        },

        refresh: async (quiet = true) => {
            if (!activeId || quiet && mutations > 0)
                return
            await read(activeId, quiet)
            if (quiet)
                inspection.refreshWorking()
        },
        mutating(busy) {
            mutations += busy ? 1 : -1
            publish()
        },

        focus(id) {
            if (activeId && stateFor(activeId).focusedId != id)
                change(activeId, state => state.focusedId = id)
        },
        open(id) {
            change(activeId, state => {
                if (!state.openedIds.includes(id))
                    state.openedIds.push(id)
                state.selectedId = id
                state.collapsedIds = state.collapsedIds.filter(candidate => candidate != id)
                state.focusedId = id
                state.widths[id] ??= defaultColumnWidth
                state.revealed = { id, serial: (state.revealed?.serial ?? 0) + 1 }
            })
        },
        toggleGraph() {
            change(activeId, state => state.graphShown = !state.graphShown, false)
        },
        toggleAll() {
            if (!activeId)
                return
            change(activeId, state => {
                state.showAll = !state.showAll
                state.pendingReveal = undefined
            }, false)
            void read(activeId, false)
        },
        select(nodeId) {
            change(activeId, state => {
                state.selectedId = nodeId
                state.marker = undefined
                state.pendingReveal = undefined
            }, false)
        },
        reveal(repositoryId, nodeId) {
            let state = stateFor(repositoryId)
            state.graphShown = true
            state.pendingReveal = nodeId
            revealPending(state)
            // A node the relevant branches leave out shows once every branch is read.
            if (state.pendingReveal) {
                state.showAll = true
                void read(repositoryId, false)
            }
            if (repositoryId == activeId)
                publish()
        },
        fold(nodeId, folded) {
            change(activeId, state => {
                state.foldedIds = folded ? [...new Set([...state.foldedIds, nodeId])] : state.foldedIds.filter(id => id != nodeId)
            }, false)
        },
        showMarker(marker, branchId) {
            change(activeId, state => {
                state.marker = marker
                if (branchId)
                    state.selectedId = branchId
            }, false)
        },
        async applyGraphSettings(settings) {
            let repositoryId = activeId
            if (!repositoryId)
                return
            try {
                await api.setRepositoryGraphSettings(repositoryId, settings)
            } catch (error) {
                return notify({ code: "graph.settings.failed", message: errorMessage(error) })
            }
            await read(repositoryId, false)
        },
        openComparison(sourceId, from, to) {
            let id = comparisonColumnId(from, to)
            change(activeId, state => {
                state.comparisons[id] = { from, to }
                if (!state.openedIds.includes(id))
                    state.openedIds.splice(state.openedIds.indexOf(sourceId) + 1, 0, id)
                state.collapsedIds = state.collapsedIds.filter(candidate => candidate != id)
                state.focusedId = id
                state.widths[id] ??= defaultColumnWidth
                state.revealed = { id, serial: (state.revealed?.serial ?? 0) + 1 }
            })
        },
        switched(columnId, worktreePath) {
            let saved = activeId ? savedRepository(activeId) : undefined
            let destination = saved?.columns.find(column => column.id == columnId)
            if (!activeId || !saved || destination?.kind != "branch" || destination.worktreePath)
                return
            let source = saved.columns.find(column => column.kind != "comparison" && column.worktreePath == worktreePath)
            let worktreeId = source && source.kind != "comparison" ? source.worktreeId : undefined
            let columns = saved.columns.map((column): WorkspaceColumn => {
                if (column.kind != "branch")
                    return column
                if (column.id == columnId)
                    return { ...column, worktreePath, worktreeId }
                // A detached worktree's column goes once its worktree has a branch, so only a branch column gives one up.
                if (column == source)
                    return { ...column, worktreePath: undefined, worktreeId: undefined }
                return column
            })
            void saveColumns(activeId, { columns, focusedColumnId: saved.focusedColumnId, layoutInitialized: saved.layoutInitialized })
        },
        renamed(oldRef, newRef) {
            if (activeId)
                follow(activeId, oldRef, newRef, true)
        },
        tracked(remoteRef, localRef) {
            if (activeId && !stateFor(activeId).openedIds.includes(`branch:${localRef}`))
                follow(activeId, remoteRef, localRef, false)
        },

        toggleCollapsed,

        close(id) {
            let state = activeId && stateFor(activeId)
            if (!state)
                return
            if (backingPath(activeId!, state, id)) {
                toggleCollapsed(id)
                return
            }
            change(activeId, state => {
                let index = state.openedIds.indexOf(id)
                state.openedIds = state.openedIds.filter(candidate => candidate != id)
                delete state.comparisons[id]
                if (state.maximizedId == id)
                    state.maximizedId = undefined
                if (state.focusedId == id)
                    state.focusedId = state.openedIds[index] ?? state.openedIds[index - 1]
            })
        },

        toggleMaximized(id) {
            change(activeId, state => state.maximizedId = state.maximizedId == id ? undefined : id, false)
        },

        restore() {
            change(activeId, state => state.maximizedId = undefined, false)
        },

        move(id, delta) {
            let state = activeId && stateFor(activeId)
            if (!state)
                return
            let index = state.openedIds.indexOf(id)
            let target = index + delta
            if (index < 0 || target < 0 || target >= state.openedIds.length) {
                notify({ code: "column.boundary", message: target < 0 ? "Already first column." : "Already last column.", transient: true })
                return
            }
            change(activeId, state => {
                state.openedIds.splice(index, 1)
                state.openedIds.splice(target, 0, id)
                state.focusedId = id
            })
        },

        dragOver(id, targetId) {
            change(activeId, state => {
                let from = state.openedIds.indexOf(id)
                let to = state.openedIds.indexOf(targetId)
                if (from < 0 || to < 0 || from == to)
                    return
                state.dragOrigin ??= [...state.openedIds]
                state.openedIds.splice(from, 1)
                state.openedIds.splice(to, 0, id)
            }, false)
        },

        drop(id) {
            change(activeId, state => {
                state.dragOrigin = undefined
                state.focusedId = id
            })
        },

        cancelDrag() {
            change(activeId, state => {
                if (state.dragOrigin)
                    state.openedIds = state.dragOrigin
                state.dragOrigin = undefined
            })
        },

        setDiffLayout(id, layout) {
            change(activeId, state => state.diffLayouts[id] = layout)
        },
        resize(id, width) {
            change(activeId, state => state.widths[id] = Math.max(minimumColumnWidth, Math.round(width)))
        },

        async recover(recovery, action) {
            let repositoryId = activeId
            if (!repositoryId)
                return
            let state = stateFor(repositoryId)
            if (state.recoveryBusy || mutations > 0)
                return
            mutations++
            change(repositoryId, state => {
                state.recoveryBusy = recovery.operationId
                delete state.recoveryErrors[recovery.operationId]
            }, false)
            try {
                let result = await api.recoverWorktree(repositoryId, { operationId: recovery.operationId, action })
                if (!result.ok)
                    state.recoveryErrors[recovery.operationId] = result.error.message
                else if (result.backupPath)
                    notify({ code: "worktree.recovered", message: `Remaining files preserved at ${result.backupPath}` })
            } catch (error) {
                state.recoveryErrors[recovery.operationId] = errorMessage(error)
            } finally {
                state.recoveryBusy = undefined
                mutations--
            }
            await read(repositoryId, false)
        },
    }
}

function columnNode(graph: BranchGraph, state: RepositoryColumns, id: string): ColumnNode | undefined {
    let branch = graph.branches.find(candidate => candidate.id == id)
    if (branch)
        return { kind: "branch", branch }
    let virtual = graph.virtualBranches.find(candidate => candidate.id == id)
    if (virtual)
        return { kind: "virtual", branch: virtual }
    let recovery = state.recoveries.find(item => recoveryColumnId(item) == id)
    if (recovery)
        return { kind: "recovery", recovery }
    let comparison = state.comparisons[id]
    return comparison && { kind: "comparison", comparison: comparisonNode(id, comparison, graph) }
}

/** Names a column whose branch or virtual worktree is gone, from its id alone. */
function removedColumnName(id: string) {
    if (id.startsWith("virtual:"))
        return baseName(id.slice("virtual:".length))
    return id.replace(/^branch:/, "").replace(/^refs\/(heads|remotes)\//, "")
}

// A worktree column is named for its worktree; a branch or comparison without one, for itself.
function identity(node: ColumnNode, worktree?: BranchGraphWorktree): { name: string; description: string; identity: ColumnIdentity } {
    if (node.kind == "recovery")
        return { name: baseName(node.recovery.path), description: "Worktree recovery", identity: "recovery" }
    if (node.kind == "comparison")
        return { name: node.comparison.name, description: node.comparison.description, identity: "comparison" }
    if (worktree) {
        return worktree.main
            ? { name: worktree.name, description: "Main worktree", identity: "main" }
            : { name: worktree.name, description: node.kind == "virtual" ? "Virtual worktree" : "Worktree", identity: "worktree" }
    }
    let description = node.kind == "branch" ? node.branch.remoteOnly ? "Remote branch" : "Branch" : "Virtual branch"
    return { name: node.branch.name, description, identity: "branch" }
}

/** What a collapsed column says about its Working Changes. */
export function workingSummary(column: ColumnView, inspected?: ColumnInspection) {
    if (column.kind == "recovery")
        return "Recovery required"
    if (column.kind == "comparison")
        return "Comparison"
    if (!column.worktree)
        return "Branch"
    if (column.worktree.missing)
        return "Missing"
    let working = inspected?.files.working
    if (working?.error)
        return "Working Changes unavailable"
    if (!working?.inventory)
        return "Reading Working Changes…"
    let count = working.inventory.files.filter(file => !file.ignored).length
    return count ? `${count} changed ${count == 1 ? "file" : "files"}` : "Clean"
}
