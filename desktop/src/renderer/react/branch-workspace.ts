import type { BranchGraph, BranchGraphBranchNode, BranchGraphWorktree, ComparisonRef, DiffLayout, RecoveryRequest, Workspace, WorkspaceColumn, WorktreeRecovery } from "@laneway/shared"
import { comparisonColumnId, type ComparisonColumnNode, comparisonNode, renameComparisonRef } from "../src/inspection/comparison-columns"
import { columnWorktree, reconcileWorktreeColumns, recoveryColumnId, recoveryWorkspaceColumn, workspaceGraph } from "../src/worktrees/worktree-columns"
import type { ColumnInspection, Inspection } from "./inspection"
import { errorMessage, type Notice } from "./notice"
import { baseName } from "./repositories"
import { createStore, type Store } from "./store"

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
    /** The column last opened by an operation, which the view brings into view and focuses; `serial` tells repeats apart. */
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
    /**
     * Follows a branch rename: its column, and any comparison naming it, keep their place, width, and state
     * under the new name. The saved layout follows at once, so the next read reconciles against it.
     */
    renamed(oldRef: string, newRef: string): void
    /** Collapses or expands a column. */
    toggleCollapsed(id: string): void
    /** A worktree's column collapses instead, as it stays while the worktree does. */
    close(id: string): void
    /** Maximizes a column, or restores the row when it is already maximized. */
    toggleMaximized(id: string): void
    restore(): void
    /** Moves a column by `delta` places. */
    move(id: string, delta: number): void
    /** While a column's header is dragged, the row shows it at the target; dropping keeps that order. */
    dragOver(id: string, targetId: string): void
    drop(id: string): void
    cancelDrag(): void
    resize(id: string, width: number): void
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
    let store = createStore<ColumnsSnapshot>({ loading: false, columns: [], recoveryErrors: {}, blocked: false })
    let states = new Map<string, RepositoryColumns>()
    let activeId: string | undefined
    // A disk change that lands mid-read is replayed once that read settles.
    let changedWhileReading = false
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
                })),
                workspaceGraph(state.graph),
            )
        }
        store.publish(
            !activeId || !state
                ? { loading: false, columns: [], recoveryErrors: {}, blocked: false }
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
                    revealed: state.revealed,
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
            changedWhileReading = false
            void read(repositoryId, true)
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
            let result = await api.readBranchGraph(repositoryId, refreshRemote)
            if (result.ok) {
                if (refreshRemote)
                    state.remoteRefreshed = true
                let recoveries = result.worktreeRecoveries ?? []
                changed ||= JSON.stringify(state.graph) != JSON.stringify(result.graph) || JSON.stringify(state.recoveries) != JSON.stringify(recoveries)
                let layoutInitialized = applyGraph(repositoryId, state, result.graph, recoveries)
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
        if (removed.length > 0) {
            notify({
                code: "branch.removed",
                message: `${removed.length == 1 ? "An open branch" : `${removed.length} open branches`} no longer exists; its column was closed.`,
            })
        }
        return layoutInitialized
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
        },

        focus(id) {
            if (activeId && stateFor(activeId).focusedId != id)
                change(activeId, state => state.focusedId = id)
        },
        open(id) {
            change(activeId, state => {
                if (!state.openedIds.includes(id))
                    state.openedIds.push(id)
                state.collapsedIds = state.collapsedIds.filter(candidate => candidate != id)
                state.focusedId = id
                state.widths[id] ??= defaultColumnWidth
                state.maximizedId = undefined
                state.revealed = { id, serial: (state.revealed?.serial ?? 0) + 1 }
            })
        },
        renamed(oldRef, newRef) {
            let repositoryId = activeId
            if (!repositoryId)
                return
            let state = stateFor(repositoryId)
            let ids = new Map([[`branch:${oldRef}`, `branch:${newRef}`]])
            for (let [id, comparison] of Object.entries(state.comparisons)) {
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
