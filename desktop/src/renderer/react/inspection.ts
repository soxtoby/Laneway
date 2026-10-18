import type { BranchGraph, BranchGraphBranchNode, BranchHistoryPage, ChangedFile, ChangesInventory, DiffSource } from "@laneway/shared"
import { createDiscards } from "../src/inspection/discard"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

/** One list of files a column shows: its Working Changes, a stash, or a commit. */
export interface FilesState {
    source: DiffSource
    inventory?: ChangesInventory
    loading: boolean
    error?: string
    /** Whether the list shows, for lists that fold away such as a stash's or a commit's. */
    open: boolean
}

/** A branch's commits in a column's Commit Trail, read a page at a time. */
export interface HistoryState {
    /** The branch tip, bases, and remote tips it was read for; when they move, it is read again. */
    key: string
    loading: boolean
    /** Whether its commits show; the column's own branch always shows them. */
    open: boolean
    page?: BranchHistoryPage
    error?: string
}

export interface ColumnInspection {
    worktreePath?: string
    /** Lists by group: `working`, its `working-staged` and `working-unstaged` views, and stash or commit object IDs. */
    files: Record<string, FilesState>
    /** Whole files chosen for a bulk action, as `group:path`; they all belong to one list. */
    selected: string[]
    showIgnored: boolean
    /** Histories by branch ID: the column's branch, and the bases below it that have been unfolded. */
    history: Record<string, HistoryState>
    /** The base chosen for a branch whose base is ambiguous, by branch ID. */
    bases: Record<string, string>
}

export interface InspectionSnapshot {
    repositoryId?: string
    columns: Record<string, ColumnInspection>
}

/** A column the inspection keeps lists for, as the Workspace Columns describe it. */
export interface InspectedColumn {
    id: string
    /** The worktree whose Working Changes the column shows; absent or missing means none are read. */
    worktreePath?: string
    worktreeMissing?: boolean
    /** A branch column's branch, whose history the column shows. */
    branch?: BranchGraphBranchNode
}

export interface Inspection extends Store<InspectionSnapshot> {
    /**
     * Keeps lists for these columns of the active repository, reading Working Changes for any new worktree and
     * the history of any new branch; histories whose branch moved in `graph` are read again.
     */
    retain(repositoryId: string, columns: InspectedColumn[], graph: BranchGraph): void
    /** Reads every Working Changes list again, keeping each on screen until a different one arrives. */
    refreshWorking(): void
    /** Reads a column's Working Changes again; `quiet` keeps the current list until a different one arrives. */
    readWorking(columnId: string, quiet?: boolean): Promise<void>
    /** Reads a list again after it failed. */
    retry(columnId: string, group: string): void
    /** Shows or hides a stash's files, reading them, and its untracked files, the first time. */
    toggleStash(columnId: string, objectId: string): void
    /** Reads a branch's history in the column again, or its next page. */
    readHistory(columnId: string, branchId: string, more?: boolean): void
    /** Shows or hides a base branch's history below the column's branch. */
    toggleHistory(columnId: string, branchId: string): void
    /** Shows or hides a commit's files, reading them the first time. */
    toggleCommit(columnId: string, objectId: string): void
    /** Compares a merge commit with another of its parents. */
    chooseParent(columnId: string, objectId: string, parentId: string): void
    /** Continues an ambiguous branch's history into one of its candidate bases, or none. */
    chooseBase(columnId: string, branchId: string, baseId?: string): void
    /** Drops choices that rewritten history made stale. */
    rewritten(): void
    /** Toggles whole files together: all already chosen clears them, otherwise all become chosen. */
    select(columnId: string, group: string, files: ChangedFile[]): void
    clearSelection(columnId: string): void
    setShowIgnored(columnId: string, showIgnored: boolean): void
    /** What discarding `file` from `group` would discard, and the menu label for it; nothing for lists that don't discard. */
    discardTarget(columnId: string, group: string, file: ChangedFile): { label: string; files: ChangedFile[] } | undefined
    discard(columnId: string, group: string, file: ChangedFile): Promise<void>
    /** Undoes the discards whose notice still shows; false when there are none, so Ctrl+Z can undo something else. */
    undoDiscard(): boolean
}

interface History extends HistoryState {
    generation: number
}

interface ColumnState extends ColumnInspection {
    id: string
    generations: Record<string, number>
    history: Record<string, History>
}

interface InspectionOptions {
    api: Api
    notify(notice: Notice): () => void
}

/** The files and commits each Workspace Column shows, read from Git as the column needs them. */
export function createInspection({ api, notify }: InspectionOptions): Inspection {
    let store = createStore<InspectionSnapshot>({ columns: {} })
    let repositories = new Map<string, Map<string, ColumnState>>()
    let graphs = new Map<string, BranchGraph>()
    let activeId: string | undefined
    let discards = createDiscards({
        api,
        notify,
        changed: (repositoryId, worktreePath) => {
            for (let state of repositories.get(repositoryId)?.values() ?? []) {
                if (state.worktreePath == worktreePath)
                    void read(repositoryId, state, "working", { kind: "working", worktreePath }, true)
            }
        },
    })

    function publish() {
        let columns = activeId ? repositories.get(activeId) : undefined
        store.publish({
            repositoryId: activeId,
            columns: Object.fromEntries(
                [...columns?.values() ?? []].map(state => [state.id, {
                    worktreePath: state.worktreePath,
                    files: { ...state.files },
                    selected: state.selected,
                    showIgnored: state.showIgnored,
                    history: { ...state.history },
                    bases: { ...state.bases },
                }]),
            ),
        })
    }

    // A column closed while its read was under way no longer shows anything.
    function publishFor(repositoryId: string, state: ColumnState) {
        if (repositoryId == activeId && repositories.get(repositoryId)?.get(state.id) == state)
            publish()
    }

    function columnState(columnId: string) {
        return activeId ? repositories.get(activeId)?.get(columnId) : undefined
    }

    function requestId(state: ColumnState, group: string) {
        return `inspection:${state.id}:files:${group}`
    }

    async function read(repositoryId: string, state: ColumnState, group: string, source: DiffSource, quiet = false) {
        let files = state.files[group] ?? { source, loading: false, open: true }
        let generation = (state.generations[group] ?? 0) + 1
        state.generations[group] = generation
        let keep = quiet && files.inventory != undefined && JSON.stringify(files.source) == JSON.stringify(source)
        state.files[group] = keep ? files : { ...files, source, loading: true, error: undefined, open: true }
        if (!keep)
            publishFor(repositoryId, state)

        let next: FilesState
        try {
            let includeIgnored = group == "working" && state.showIgnored
            let result = await api.readChanges(repositoryId, requestId(state, group), { source, includeIgnored })
            if (state.generations[group] != generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            if (keep && files.inventory?.version == result.inventory.version && !files.error)
                return
            next = { ...state.files[group]!, source: result.inventory.source, inventory: result.inventory, loading: false, error: undefined }
            // A changed list can't keep a selection made in the old one.
            if (files.inventory && files.inventory.version != result.inventory.version)
                state.selected = state.selected.filter(id => !id.startsWith(`${group}:`) && !(group == "working" && id.startsWith("working-")))
        } catch (error) {
            if (state.generations[group] != generation)
                return
            next = { ...state.files[group]!, loading: false, error: errorMessage(error) }
        }
        state.files[group] = next
        // Working Changes show as a staged list above an unstaged one, both views of the one inventory.
        if (group == "working" && next.inventory) {
            for (let view of ["staged", "unstaged"] as const) {
                state.files[`working-${view}`] = {
                    ...next,
                    inventory: {
                        ...next.inventory,
                        files: next.inventory.files.filter(file => view == "staged" ? file.staged : file.unstaged || file.untracked),
                    },
                }
            }
        }
        publishFor(repositoryId, state)
    }

    async function readHistory(repositoryId: string, state: ColumnState, branch: BranchGraphBranchNode, more = false) {
        let graph = graphs.get(repositoryId)
        if (!graph)
            return
        let key = historyKey(graph, branch)
        let current = state.history[branch.id]
        if (!current || current.key != key)
            current = { key, loading: false, open: true, generation: current?.generation ?? 0 }
        if (current.loading)
            return
        let generation = current.generation + 1
        state.history[branch.id] = { ...current, open: true, loading: true, error: undefined, generation }
        publishFor(repositoryId, state)

        let update: Partial<History>
        try {
            let result = await api.readBranchHistory(repositoryId, {
                requestId: `inspection:${state.id}:history:${branch.id}`,
                branchRef: branch.preferredRef,
                tip: branch.tip,
                baseTips: baseTips(branch),
                remoteTips: graph.remoteTips,
                limit: 50,
                ...(more ? { offset: current.page?.nextOffset } : {}),
            })
            if (state.history[branch.id]?.generation != generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            let earlier = more ? current.page?.commits ?? [] : []
            update = { page: { ...result.page, commits: [...earlier, ...result.page.commits] } }
        } catch (error) {
            if (state.history[branch.id]?.generation != generation)
                return
            update = { error: errorMessage(error) }
        }
        state.history[branch.id] = { ...state.history[branch.id]!, ...update, loading: false }
        publishFor(repositoryId, state)
    }

    function discardTarget(columnId: string, group: string, file: ChangedFile) {
        let state = columnState(columnId)
        let files = state?.files[group]
        if (!state || !files || !group.startsWith("working-") || files.source.kind != "working" || file.conflicted || file.submodule)
            return undefined
        let view = group == "working-staged" ? "staged" : "unstaged"
        let eligible = (candidate: ChangedFile) => !candidate.conflicted && !candidate.submodule
        // A right-click on one of the chosen files acts on all of them.
        let chosen = files.inventory?.files.filter(candidate => state.selected.includes(`${group}:${candidate.path}`)) ?? []
        let targets = chosen.length > 1 && chosen.some(candidate => candidate.path == file.path) ? chosen.filter(eligible) : [file]
        let label = targets.length > 1
            ? `Discard ${targets.length} selected files`
            : view == "staged"
            ? file.unstaged ? "Discard all changes" : "Discard staged changes"
            : file.untracked
            ? "Delete untracked file"
            : file.staged
            ? "Discard unstaged changes"
            : "Discard changes"
        return { label, files: targets }
    }

    function readWorkingFor(repositoryId: string, state: ColumnState, quiet: boolean) {
        if (state.worktreePath)
            return read(repositoryId, state, "working", { kind: "working", worktreePath: state.worktreePath }, quiet)
        return Promise.resolve()
    }

    function branchFor(branchId: string) {
        return activeId ? graphs.get(activeId)?.branches.find(branch => branch.id == branchId) : undefined
    }

    function forget(state: ColumnState, group: string) {
        state.selected = state.selected.filter(id => !id.startsWith(`${group}:`))
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        retain(repositoryId, columns, graph) {
            // The Workspace Columns retain on every change of theirs, so only a change here publishes.
            let changed = activeId != repositoryId
            activeId = repositoryId
            graphs.set(repositoryId, graph)
            let states = repositories.get(repositoryId) ?? new Map<string, ColumnState>()
            repositories.set(repositoryId, states)
            for (let [id, state] of states) {
                if (!columns.some(column => column.id == id)) {
                    for (let group of Object.keys(state.files))
                        void api.cancelInspection(repositoryId, requestId(state, group))
                    states.delete(id)
                    changed = true
                }
            }
            for (let column of columns) {
                let worktreePath = column.worktreeMissing ? undefined : column.worktreePath
                let state = states.get(column.id)
                if (!state || state.worktreePath != worktreePath) {
                    state = { id: column.id, worktreePath, files: {}, selected: [], showIgnored: false, history: {}, bases: {}, generations: {} }
                    states.set(column.id, state)
                    changed = true
                    void readWorkingFor(repositoryId, state, false)
                    if (column.branch)
                        void readHistory(repositoryId, state, column.branch)
                    continue
                }
                // A moved branch, base, or remote tip shows different commits.
                for (let [branchId, current] of Object.entries(state.history)) {
                    let branch = graph.branches.find(candidate => candidate.id == branchId)
                    if (!branch || current.key == historyKey(graph, branch))
                        continue
                    state.history[branchId] = { key: historyKey(graph, branch), loading: false, open: current.open, generation: current.generation + 1 }
                    changed = true
                    if (current.open)
                        void readHistory(repositoryId, state, branch)
                }
            }
            if (changed)
                publish()
        },

        refreshWorking() {
            if (!activeId)
                return
            for (let state of repositories.get(activeId)?.values() ?? [])
                void readWorkingFor(activeId, state, true)
        },

        async readWorking(columnId, quiet = false) {
            let state = columnState(columnId)
            if (state && activeId)
                await readWorkingFor(activeId, state, quiet)
        },

        retry(columnId, group) {
            let state = columnState(columnId)
            let files = state?.files[group]
            if (state && files && activeId)
                void read(activeId, state, group, files.source)
        },

        toggleStash(columnId, objectId) {
            let state = columnState(columnId)
            if (!state || !activeId)
                return
            let files = state.files[objectId]
            if (files) {
                state.files[objectId] = { ...files, open: !files.open }
                publish()
                return
            }
            // Untracked files live on the stash's third parent, so they are read alongside the tracked ones.
            let repositoryId = activeId
            void read(repositoryId, state, objectId, { kind: "commit", objectId }).then(() => {
                let untracked = state.files[objectId]?.inventory?.parents[2]
                if (untracked)
                    return read(repositoryId, state, untracked, { kind: "commit", objectId: untracked })
            })
        },

        readHistory(columnId, branchId, more = false) {
            let state = columnState(columnId)
            let branch = branchFor(branchId)
            if (state && branch && activeId)
                void readHistory(activeId, state, branch, more)
        },

        toggleHistory(columnId, branchId) {
            let state = columnState(columnId)
            let branch = branchFor(branchId)
            let graph = activeId ? graphs.get(activeId) : undefined
            if (!state || !branch || !graph || !activeId)
                return
            let current = state.history[branchId]
            if (!current || current.key != historyKey(graph, branch))
                return void readHistory(activeId, state, branch)
            if (!current.open && !current.page)
                return void readHistory(activeId, state, branch)
            state.history[branchId] = { ...current, open: !current.open }
            publish()
        },

        toggleCommit(columnId, objectId) {
            let state = columnState(columnId)
            if (!state || !activeId)
                return
            let files = state.files[objectId]
            if (!files)
                return void read(activeId, state, objectId, { kind: "commit", objectId })
            if (files.open)
                forget(state, objectId)
            state.files[objectId] = { ...files, open: !files.open }
            publish()
        },

        chooseParent(columnId, objectId, parentId) {
            let state = columnState(columnId)
            if (!state || !activeId)
                return
            forget(state, objectId)
            void read(activeId, state, objectId, { kind: "commit", objectId, parentId })
        },

        chooseBase(columnId, branchId, baseId) {
            let state = columnState(columnId)
            if (!state)
                return
            if (baseId)
                state.bases[branchId] = baseId
            else
                delete state.bases[branchId]
            publish()
        },

        rewritten() {
            for (let state of activeId ? repositories.get(activeId)?.values() ?? [] : [])
                state.selected = []
            publish()
        },

        select(columnId, group, files) {
            let state = columnState(columnId)
            if (!state)
                return
            let ids = files.map(file => `${group}:${file.path}`)
            state.selected = ids.every(id => state.selected.includes(id))
                ? state.selected.filter(id => !ids.includes(id))
                : [...state.selected.filter(id => id.startsWith(`${group}:`)), ...ids.filter(id => !state.selected.includes(id))]
            publish()
        },

        clearSelection(columnId) {
            let state = columnState(columnId)
            if (state) {
                state.selected = []
                publish()
            }
        },

        setShowIgnored(columnId, showIgnored) {
            let state = columnState(columnId)
            if (!state || !activeId)
                return
            state.showIgnored = showIgnored
            void readWorkingFor(activeId, state, false)
        },

        discardTarget,

        async discard(columnId, group, file) {
            let state = columnState(columnId)
            let target = discardTarget(columnId, group, file)
            if (!state?.worktreePath || !target || !activeId)
                return
            await discards.files(activeId, state.worktreePath, group == "working-staged" ? "staged" : "unstaged", target.files)
        },

        undoDiscard: () => discards.undo(),
    }
}

/**
 * The branches a column's Commit Trail shows: its own, then each base below it while the base is known
 * or has been chosen from the candidates.
 */
export function branchStack(graph: BranchGraph, branch: BranchGraphBranchNode, bases: Record<string, string>) {
    let stack: BranchGraphBranchNode[] = []
    let next: BranchGraphBranchNode | undefined = branch
    while (next && !stack.includes(next)) {
        let current: BranchGraphBranchNode = next
        stack.push(current)
        let chosen = bases[current.id]
        let baseId = current.base.status == "known"
            ? current.base.branchId
            : current.base.candidates.some(candidate => candidate.branchId == chosen)
            ? chosen
            : undefined
        next = graph.branches.find(candidate => candidate.id == baseId)
    }
    return stack
}

function baseTips(branch: BranchGraphBranchNode) {
    return branch.base.status == "known" ? [branch.base.tip] : branch.base.candidates.map(candidate => candidate.tip)
}

// Any remote branch can publish this branch's commits, so moving any of them reads its history again.
function historyKey(graph: BranchGraph, branch: BranchGraphBranchNode) {
    return JSON.stringify([branch.tip, baseTips(branch), graph.remoteTips, branch.unresolved])
}
