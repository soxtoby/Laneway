import type { BranchGraph, BranchGraphBranchNode, BranchHistoryPage, ChangedFile, ChangesInventory, DiffSource, DiffView, FileDiffPage, FileImagePage } from "@laneway/shared"
import type { FileDiffLoadedChangedFiles } from "@pierre/diffs"
import { type AuxiliaryColumn, AuxiliaryColumns } from "../src/auxiliary-columns"
import { readDiffContext } from "../src/inspection/diff-context"
import { createDiscards } from "../src/inspection/discard"
import { createDiffSession, type FileDiffState } from "../src/inspection/inspection-diff-session"
import { type ImageDiffMode, readDiffImage, rememberImageMode } from "./image-files"
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

export type { FileDiffState }

/** A file's diff in one of a column's lists, by its list and path. */
export function diffKey(group: string, path: string) {
    return JSON.stringify([group, path])
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
    /** Open diffs by `diffKey`; each shows under its file's row, or in the diff column while there is one. */
    diffs: Record<string, FileDiffState>
    /** The list and file the column's diff column shows, while it has one. */
    diffColumn?: { group: string; focus?: string }
}

/** A list's whole diff, in an auxiliary column beside the Workspace Column it came from. */
export interface DiffColumnView {
    kind: "diff"
    /** The auxiliary column's ID. */
    id: string
    /** The Workspace Column whose diffs it shows. */
    sourceId: string
    width: number
    /** The list whose files it shows. */
    group: string
    /** The commit's subject, when the list is a commit's. */
    subject?: string
    /** Files folded down to their toolbar. */
    collapsed: string[]
    /** The file it scrolls to; `serial` rises each time a file is chosen, so choosing one again scrolls to it again. */
    focus?: { path: string; serial: number }
    /** Whether its diffs show their files whole rather than only around the changes. */
    entireFiles: boolean
}

/** A column opened beside a Workspace Column; it closes with that column and isn't kept across restarts. */
export type AuxiliaryView = DiffColumnView

export interface InspectionSnapshot {
    repositoryId?: string
    columns: Record<string, ColumnInspection>
    /** Each Workspace Column's auxiliary columns, in the order they show after it. */
    auxiliary: Record<string, AuxiliaryView[]>
    /** The auxiliary column that takes focus once it shows; `serial` rises each time one is to. */
    focused?: { id: string; serial: number }
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
    /** Shows or hides a file's diff under its row; with a diff column open, shows the file there instead. */
    toggleDiff(columnId: string, group: string, path: string): void
    /** Closes the diffs of files a folded folder or group hides. */
    closeDiffs(columnId: string, group: string, paths: string[]): void
    /** Shows a list's whole diff in the column's diff column, scrolled to `path` when given, and focuses it. */
    openDiffColumn(columnId: string, group: string, path?: string, subject?: string): void
    /** Opens the diff column on the Working Changes diff opened last, or else the first changed file. */
    openWorkingDiffColumn(columnId: string): void
    /** Closes an auxiliary column and the ones opened from it. */
    closeAuxiliary(id: string): void
    resizeAuxiliary(id: string, width: number): void
    /** Folds a diff column's files down to their toolbars, or unfolds them. */
    foldDiffs(id: string, paths: string[], folded: boolean): void
    /** Shows a diff column's files whole, or only around their changes, reading its diffs again. */
    toggleEntireFiles(id: string): void
    /** Reads a diff again after it failed, or its next page. */
    readDiff(columnId: string, key: string, more?: boolean): void
    /** Shows a Working Changes diff's staged or unstaged side, or a conflict's side. */
    changeView(columnId: string, key: string, view: DiffView): void
    toggleWhitespace(columnId: string, key: string): void
    /** Toggles lines together: all already chosen clears them, otherwise all become chosen. */
    selectLines(columnId: string, key: string, lineIds: number[]): void
    clearLines(columnId: string, key: string): void
    cancelDiff(columnId: string, key: string): void
    /** Discards a Working Changes diff's chosen lines, with Undo while the notice shows. */
    discardLines(columnId: string, key: string): Promise<void>
    /** Reads the whole file around a diff page, so the lines between its hunks can show. */
    readContext(page: FileDiffPage, signal: AbortSignal): Promise<FileDiffLoadedChangedFiles>
    /** Reads a changed picture's old and new versions; `fetchLfs` downloads them through Git LFS. */
    readImage(page: FileDiffPage, signal: AbortSignal, fetchLfs?: boolean): Promise<FileImagePage>
    /** Compares a picture another way; every picture opens in the last mode chosen until Laneway restarts. */
    setImageMode(columnId: string, key: string, mode: ImageDiffMode): void
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
    repositoryId: string
    generations: Record<string, number>
    history: Record<string, History>
    session: ReturnType<typeof createDiffSession>
    diffColumn?: DiffColumnState
}

interface DiffColumnState {
    kind: "diff"
    id: string
    owner: ColumnState
    group: string
    subject?: string
    /** The diffs it opened, which close with it; diffs already open under their rows stay open. */
    created: Set<string>
    collapsed: Set<string>
    focus?: string
    serial: number
    entireFiles: boolean
}

type AuxiliaryValue = DiffColumnState

interface InspectionOptions {
    api: Api
    notify(notice: Notice): () => void
}

/** The files and commits each Workspace Column shows, read from Git as the column needs them. */
export function createInspection({ api, notify }: InspectionOptions): Inspection {
    let store = createStore<InspectionSnapshot>({ columns: {}, auxiliary: {} })
    let repositories = new Map<string, Map<string, ColumnState>>()
    let graphs = new Map<string, BranchGraph>()
    let auxiliaries = new Map<string, AuxiliaryColumns<AuxiliaryValue>>()
    let activeId: string | undefined
    let focused: InspectionSnapshot["focused"]
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
        let tree = activeId ? auxiliaryFor(activeId) : undefined
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
                    diffs: { ...state.diffs },
                    diffColumn: state.diffColumn && { group: state.diffColumn.group, focus: state.diffColumn.focus },
                }]),
            ),
            auxiliary: Object.fromEntries([...columns?.keys() ?? []].map(id => [id, tree?.descendants(id).map(auxiliaryView) ?? []])),
            focused,
        })
    }

    function auxiliaryView(node: AuxiliaryColumn<AuxiliaryValue>): AuxiliaryView {
        let column = node.value
        return {
            kind: "diff",
            id: node.id,
            sourceId: node.sourceId,
            width: node.width,
            group: column.group,
            subject: column.subject,
            collapsed: [...column.collapsed],
            focus: column.focus ? { path: column.focus, serial: column.serial } : undefined,
            entireFiles: column.entireFiles,
        }
    }

    // Each repository keeps its own auxiliary columns, rooted at its Workspace Columns.
    function auxiliaryFor(repositoryId: string) {
        let tree = auxiliaries.get(repositoryId)
        if (!tree) {
            tree = new AuxiliaryColumns()
            auxiliaries.set(repositoryId, tree)
        }
        return tree
    }

    function auxiliaryNode(id: string) {
        if (!activeId)
            return undefined
        let tree = auxiliaryFor(activeId)
        for (let rootId of repositories.get(activeId)?.keys() ?? []) {
            let node = tree.descendants(rootId).find(candidate => candidate.id == id)
            if (node)
                return { tree, node }
        }
        return undefined
    }

    function focusAuxiliary(id: string) {
        focused = { id, serial: (focused?.serial ?? 0) + 1 }
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

    function diffRequestId(state: ColumnState, diff: FileDiffState) {
        return `inspection:${state.id}:diff:${diffKey(diff.group, diff.path)}`
    }

    function createState(repositoryId: string, id: string, worktreePath?: string): ColumnState {
        let state: ColumnState = {
            id,
            repositoryId,
            worktreePath,
            files: {},
            selected: [],
            showIgnored: false,
            history: {},
            bases: {},
            diffs: {},
            generations: {},
            session: createDiffSession({
                api,
                repositoryId,
                alive: () => repositories.get(repositoryId)?.get(id) == state,
                requestId: diff => diffRequestId(state, diff),
                update: () => publishFor(repositoryId, state),
                settled: () => {},
            }),
        }
        auxiliaryFor(repositoryId).addRoot(id)
        return state
    }

    // A closed column cancels its reads and closes the auxiliary columns opened from it.
    function dispose(states: Map<string, ColumnState>, state: ColumnState) {
        states.delete(state.id)
        for (let group of Object.keys(state.files))
            void api.cancelInspection(state.repositoryId, requestId(state, group))
        auxiliaryFor(state.repositoryId).close(state.id)
    }

    // A diff reads its list's source at the version the list was read at, so it can't show newer lines than the list.
    function diffInput(state: ColumnState, group: string) {
        let files = state.files[group]
        return {
            source: files?.source,
            inventoryVersion: files?.inventory?.version,
            entireFile: state.diffColumn?.entireFiles,
            unavailable: !!files?.error,
        }
    }

    function closeDiff(state: ColumnState, diff: FileDiffState) {
        let key = diffKey(diff.group, diff.path)
        diff.generation++
        void api.cancelInspection(state.repositoryId, diffRequestId(state, diff))
        delete state.diffs[key]
        state.diffColumn?.created.delete(key)
    }

    // Reading a diff another way starts it afresh, so lines chosen in the old one no longer apply.
    function rereadDiff(state: ColumnState, diff: FileDiffState) {
        Object.assign(diff, { notice: diff.selection ? "Diff view changed. Change Selection cleared." : undefined, selection: undefined, page: undefined })
        void state.session.read(diff, diffInput(state, diff.group))
    }

    // Working Changes diffs belong to the staged and unstaged views of the `working` list.
    function closeGroup(state: ColumnState, group: string) {
        for (let diff of Object.values(state.diffs)) {
            if (diff.group == group)
                closeDiff(state, diff)
        }
        if (state.diffColumn?.group == group)
            auxiliaryFor(state.repositoryId).close(state.diffColumn.id)
    }

    /**
     * Shows one list's whole diff in the column's diff column, scrolled to `path` when given; a diff column showing
     * another list gives way to it, keeping its width. Opening it focuses it; choosing files in the column doesn't.
     */
    async function showDiffColumn(state: ColumnState, group: string, path: string | undefined, subject: string | undefined, focus: boolean) {
        let current = state.diffColumn
        if (current?.group == group) {
            if (path) {
                current.focus = path
                current.serial++
                current.collapsed.delete(path)
            }
            if (focus)
                focusAuxiliary(current.id)
            return publish()
        }
        let tree = auxiliaryFor(state.repositoryId)
        let previous = current && tree.descendants(state.id).find(node => node.value == current)
        let column: DiffColumnState = {
            kind: "diff",
            id: "",
            owner: state,
            group,
            subject: subject ?? commitSubject(state, group),
            created: new Set(),
            collapsed: new Set(),
            focus: path,
            serial: (current?.serial ?? 0) + 1,
            entireFiles: current?.entireFiles ?? false,
        }
        state.diffColumn = column
        if (previous)
            tree.close(previous.id)
        column.id = tree.open(state.id, "diff", () => ({ value: column, dispose: () => disposeDiffColumn(column) }), previous?.width).id
        if (focus)
            focusAuxiliary(column.id)
        publish()
        if (!state.files[group]?.inventory && !group.startsWith("working"))
            await read(state.repositoryId, state, group, { kind: "commit", objectId: group })
        if (state.diffColumn == column) {
            populate(state, column)
            publishFor(state.repositoryId, state)
        }
    }

    // A diff column shows every file of its list, opening the diffs that aren't open yet.
    function populate(state: ColumnState, column: DiffColumnState) {
        let files = state.files[column.group]
        if (files?.error)
            return
        for (let file of files?.inventory?.files ?? []) {
            let key = diffKey(column.group, file.path)
            if (file.ignored)
                continue
            let diff = state.diffs[key]
            if (!diff) {
                diff = state.session.create(column.group, file.path, diffInput(state, column.group))
                state.diffs[key] = diff
                column.created.add(key)
            }
            if (!diff.page && !diff.loading)
                void state.session.read(diff, diffInput(state, column.group))
        }
    }

    function disposeDiffColumn(column: DiffColumnState) {
        let state = column.owner
        let replaced = state.diffColumn != column
        if (!replaced)
            state.diffColumn = undefined
        for (let key of column.created) {
            let diff = state.diffs[key]
            if (diff)
                closeDiff(state, diff)
        }
        // The diffs left open under their rows go back to showing only the lines around their changes.
        if (column.entireFiles && !replaced && repositories.get(state.repositoryId)?.get(state.id) == state) {
            for (let diff of Object.values(state.diffs))
                rereadDiff(state, diff)
        }
    }

    function commitSubject(state: ColumnState, objectId: string) {
        for (let history of Object.values(state.history)) {
            let commit = history.page?.commits.find(candidate => candidate.objectId == objectId)
            if (commit)
                return commit.subject
        }
        return undefined
    }

    function diffFor(columnId: string, key: string) {
        let state = columnState(columnId)
        let diff = state?.diffs[key]
        return state && diff ? { state, diff } : undefined
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
        let inventory = next.inventory
        for (let diff of Object.values(state.diffs)) {
            if (diff.group != group && !(group == "working" && diff.group.startsWith("working-")))
                continue
            if (next.error || !inventory) {
                diff.selection = undefined
                diff.page = undefined
            } else if (!inventory.files.some(file => file.path == diff.path && !file.ignored))
                closeDiff(state, diff)
            else if (quiet)
                queueMicrotask(() => void state.session.read(diff, diffInput(state, diff.group), false, true))
        }
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
        let column = state.diffColumn
        if (column && (column.group == group || group == "working" && column.group.startsWith("working-")))
            populate(state, column)
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
                    dispose(states, state)
                    changed = true
                }
            }
            for (let column of columns) {
                let worktreePath = column.worktreeMissing ? undefined : column.worktreePath
                let state = states.get(column.id)
                if (!state || state.worktreePath != worktreePath) {
                    if (state)
                        dispose(states, state)
                    state = createState(repositoryId, column.id, worktreePath)
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
            if (files.open) {
                forget(state, objectId)
                closeGroup(state, objectId)
            }
            state.files[objectId] = { ...files, open: !files.open }
            publish()
        },

        chooseParent(columnId, objectId, parentId) {
            let state = columnState(columnId)
            if (!state || !activeId)
                return
            forget(state, objectId)
            closeGroup(state, objectId)
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
            for (let state of activeId ? repositories.get(activeId)?.values() ?? [] : []) {
                state.selected = []
                for (let diff of Object.values(state.diffs))
                    diff.selection = undefined
            }
            publish()
        },

        toggleDiff(columnId, group, path) {
            let state = columnState(columnId)
            if (!state)
                return
            if (state.diffColumn)
                return void showDiffColumn(state, group, path, undefined, false)
            let open = state.diffs[diffKey(group, path)]
            if (open) {
                closeDiff(state, open)
                return publish()
            }
            let diff = state.session.create(group, path, diffInput(state, group))
            state.diffs[diffKey(group, path)] = diff
            if (diff.page)
                publish()
            else
                void state.session.read(diff, diffInput(state, group))
        },

        closeDiffs(columnId, group, paths) {
            let state = columnState(columnId)
            // A diff column keeps showing its list's files whatever folds in the column.
            if (!state || state.diffColumn?.group == group)
                return
            for (let path of paths) {
                let diff = state.diffs[diffKey(group, path)]
                if (diff)
                    closeDiff(state, diff)
            }
            publish()
        },

        openDiffColumn(columnId, group, path, subject) {
            let state = columnState(columnId)
            if (state)
                void showDiffColumn(state, group, path, subject, true)
        },

        openWorkingDiffColumn(columnId) {
            let state = columnState(columnId)
            if (!state)
                return
            if (state.diffColumn?.group.startsWith("working")) {
                focusAuxiliary(state.diffColumn.id)
                return publish()
            }
            let shown = Object.values(state.diffs).findLast(diff => diff.group.startsWith("working"))
            let group = shown?.group ?? (state.files["working-staged"]?.inventory?.files.some(file => !file.ignored) ? "working-staged" : "working-unstaged")
            let path = shown?.path ?? state.files[group]?.inventory?.files.find(file => !file.ignored)?.path
            if (path)
                void showDiffColumn(state, group, path, undefined, true)
        },

        closeAuxiliary(id) {
            let found = auxiliaryNode(id)
            if (found) {
                found.tree.close(id)
                publish()
            }
        },

        resizeAuxiliary(id, width) {
            let found = auxiliaryNode(id)
            if (found) {
                found.node.width = Math.round(width)
                publish()
            }
        },

        foldDiffs(id, paths, folded) {
            let column = auxiliaryNode(id)?.node.value
            if (!column)
                return
            for (let path of paths) {
                if (folded)
                    column.collapsed.add(path)
                else
                    column.collapsed.delete(path)
            }
            publish()
        },

        toggleEntireFiles(id) {
            let column = auxiliaryNode(id)?.node.value
            if (!column)
                return
            column.entireFiles = !column.entireFiles
            for (let diff of Object.values(column.owner.diffs))
                rereadDiff(column.owner, diff)
            publish()
        },

        readDiff(columnId, key, more = false) {
            let found = diffFor(columnId, key)
            if (found)
                void found.state.session.read(found.diff, diffInput(found.state, found.diff.group), more)
        },

        changeView(columnId, key, view) {
            let found = diffFor(columnId, key)
            if (!found)
                return
            Object.assign(found.diff, { view, page: undefined, selection: undefined })
            void found.state.session.read(found.diff, diffInput(found.state, found.diff.group))
        },

        toggleWhitespace(columnId, key) {
            let found = diffFor(columnId, key)
            if (found) {
                found.diff.showWhitespace = !found.diff.showWhitespace
                publish()
            }
        },

        selectLines(columnId, key, lineIds) {
            let found = diffFor(columnId, key)
            if (found)
                found.state.session.select(found.diff, lineIds)
        },

        clearLines(columnId, key) {
            let found = diffFor(columnId, key)
            if (found) {
                found.diff.selection = undefined
                publish()
            }
        },

        cancelDiff(columnId, key) {
            let found = diffFor(columnId, key)
            if (!found)
                return
            Object.assign(found.diff, { generation: found.diff.generation + 1, loading: false, error: "Diff read cancelled." })
            void api.cancelInspection(found.state.repositoryId, diffRequestId(found.state, found.diff))
            publish()
        },

        async discardLines(columnId, key) {
            let found = diffFor(columnId, key)
            let page = found?.diff.page
            let selection = found?.diff.selection
            if (!found || !page || page.source.kind != "working" || !selection?.lineIds.length)
                return
            await discards.lines(found.state.repositoryId, page.source.worktreePath, found.diff.path, page.lines, selection.lineIds)
        },

        readContext: (page, signal) => readDiffContext(api, activeId ?? "", page, signal),

        readImage: (page, signal, fetchLfs) => readDiffImage(api, activeId ?? "", page, signal, fetchLfs),

        setImageMode(columnId, key, mode) {
            let found = diffFor(columnId, key)
            if (!found)
                return
            found.diff.imageMode = mode
            rememberImageMode(mode)
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
