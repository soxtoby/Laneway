import type { BranchGraph, BranchGraphBranchNode, BranchHistoryPage, ChangedFile, ChangesInventory, ComparisonRef, DiffLayout, DiffSource, DiffView, FileDiffPage, FileHistoryEntry, FileHistoryPage, FileHistorySource, FileImagePage, FileVersion, RemoteImageResult } from "@laneway/shared"
import type { FileDiffLoadedChangedFiles } from "@pierre/diffs"
import { type AuxiliaryColumn, AuxiliaryColumns } from "./auxiliary-columns"
import { comparisonKey } from "./comparison-columns"
import { readDiffContext } from "./diff-context"
import { createDiscards } from "./discard"
import { type BlameState, type CommitDiffState, createFileHistories, type FileHistoryState } from "./file-histories"
import { type ImageDiffMode, readDiffImage, rememberImageMode } from "./image-files"
import { createDiffSession, type FileDiffState } from "./inspection-diff-session"
import { type MarkdownVersions, type MarkdownView, readFileVersion, readMarkdownVersions, rememberMarkdownView } from "./markdown-files"
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
    /**
     * Open diffs by `diffKey`: a Workspace Column's show in its diff column, and a File History or Commit Diff
     * column's under their files' rows.
     */
    diffs: Record<string, FileDiffState>
    /** The list the column's diff column shows, while it has one, and the file at its top, whose row is marked. */
    diffColumn?: { group: string; shown?: string }
    /** The column's file filter, while it is open. */
    filter?: FileFilter
    /** The Commit Trail shows only commits with conflicts to resolve. */
    conflictsOnly?: boolean
}

/** How choosing files changes the files already chosen. */
export type FileChoice = "toggle" | "add" | "only"

/** Narrows every list in a column to the files whose path contains `text`, with the chosen status or any. */
export interface FileFilter {
    text: string
    status: string
}

export function matchesFilter(filter: FileFilter, file: ChangedFile) {
    let path = `${file.oldPath ?? ""} ${file.path}`.toLowerCase()
    let status = filter.status == "all" || file.status == filter.status || filter.status == "conflicted" && file.conflicted
    return status && path.includes(filter.text.toLowerCase())
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

/** What a File History or Commit Diff column shows its files with: a column state of its own. */
interface HostedView {
    /** The auxiliary column's ID. */
    id: string
    /** The column it was opened from: a Workspace Column or another auxiliary column. */
    sourceId: string
    width: number
    /** The column state its files and diffs live in, which inspection calls take as their column. */
    hostId: string
    host: ColumnInspection
    /** Its diffs' layout, which isn't saved. */
    layout: DiffLayout
    /** Lists whose files and lines can be chosen to move: Working Changes, and commits its Workspace Column's branch can compose while that branch stays where it was read. */
    eligible: string[]
}

/** One file's history beside the column it was opened from; each entry unfolds to the file's diff in that commit. */
export interface FileHistoryView extends HostedView {
    kind: "history"
    source: FileHistorySource
    path: string
    page?: FileHistoryPage
    error?: string
    loading: boolean
    /** Entries showing their diff, by object ID, and `working` for a worktree's Working Changes. */
    expanded: string[]
    blame?: BlameState
}

/** A history entry's whole commit, with the files related to the history's file found on request. */
export interface CommitDiffView extends HostedView {
    kind: "commit"
    entry: FileHistoryEntry
    parentId?: string
    related?: FileHistoryPage
    error?: string
    loading: boolean
}

/** A column opened beside a Workspace Column; it closes with that column and isn't kept across restarts. */
export type AuxiliaryView = DiffColumnView | FileHistoryView | CommitDiffView

export interface InspectionSnapshot {
    repositoryId?: string
    columns: Record<string, ColumnInspection>
    /** Each Workspace Column's auxiliary columns, in the order they show after it. */
    auxiliary: Record<string, AuxiliaryView[]>
    /** The auxiliary column that takes focus once it shows; `serial` rises each time one is to. */
    focused?: { id: string; serial: number }
    /** Whether every diff wraps its long lines rather than scrolling them sideways. */
    wrapLines: boolean
}

/** A column the inspection keeps lists for, as the Workspace Columns describe it. */
export interface InspectedColumn {
    id: string
    /** The worktree whose Working Changes the column shows; absent or missing means none are read. */
    worktreePath?: string
    worktreeMissing?: boolean
    /** A branch column's branch, whose history the column shows. */
    branch?: BranchGraphBranchNode
    /** A Branch Comparison Column's ends, whose differences it lists. */
    comparison?: { from: ComparisonRef; to: ComparisonRef }
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
    /** Shows or hides a file's diff under its row, in a File History or Commit Diff column. */
    toggleDiff(columnId: string, group: string, path: string): void
    /** Closes the diffs of files a folded folder or group hides. */
    closeDiffs(columnId: string, group: string, paths: string[]): void
    /** Shows a list's whole diff in the column's diff column, scrolled to `path` when given, and focuses it. */
    openDiffColumn(columnId: string, group: string, path?: string, subject?: string): void
    /**
     * Scrolls the column's diff column to a file without taking focus, moving it to the file's list when it shows
     * another. With no diff column, `open` opens one there; otherwise nothing happens.
     */
    showInDiffColumn(columnId: string, group: string, path: string, open?: boolean): void
    /** Opens the diff column on the Working Changes, staged first. */
    openWorkingDiffColumn(columnId: string): void
    /** Closes an auxiliary column and the ones opened from it. */
    closeAuxiliary(id: string): void
    resizeAuxiliary(id: string, width: number): void
    /** Folds a diff column's files down to their toolbars, or unfolds them. */
    foldDiffs(id: string, paths: string[], folded: boolean): void
    /** Marks the file a diff column has scrolled to the top of its files in its source column's list. */
    scrolledTo(id: string, path: string): void
    /** Shows a diff column's files whole, or only around their changes, reading its diffs again. */
    toggleEntireFiles(id: string): void
    /**
     * Opens a file's history beside `fromId`: a Workspace Column, the column state of a File History or Commit Diff
     * column, or a diff column. A history already open there for the same file takes focus instead.
     */
    openHistory(fromId: string, source: FileHistorySource, path: string): void
    /** Unfolds a history entry to its file's diff, or its worktree's Working Changes without `objectId`, or folds it. */
    toggleHistoryEntry(id: string, objectId?: string): void
    /** Reads a history again after it failed, or its next page. */
    readFileHistory(id: string, more?: boolean): void
    /** Follows a copy origin for an entry Git couldn't follow, or none, reading the history again. */
    chooseOrigin(id: string, objectId: string, previousPath?: string): void
    /** Shows who last changed each line of an entry's file, or the next page of lines. */
    blame(id: string, objectId: string, more?: boolean): void
    closeBlame(id: string): void
    /** Opens an entry's whole commit beside its history. */
    openCommitDiff(id: string, objectId: string): void
    /** Compares a merge commit's diff with another of its parents. */
    chooseCommitParent(id: string, parentId: string): void
    /** Finds files related to the history's file in a commit diff, or the next page of them. */
    findRelated(id: string, more?: boolean): void
    /** Lays out an auxiliary column's diffs, for the session only. */
    setLayout(columnId: string, layout: DiffLayout): void
    /** Opens the column's file filter, empty, unless it is already open. */
    openFilter(columnId: string): void
    /** Narrows the column's lists, closing the diffs of files the filter hides. */
    setFilter(columnId: string, filter: FileFilter): void
    /** Closes the column's file filter, showing every file again. */
    closeFilter(columnId: string): void
    /** Shows only the commits with conflicts in a column's Commit Trail, reading its unresolved branches' whole histories. */
    setConflictsOnly(columnId: string, conflictsOnly: boolean): void
    /** Opens the conflicted commit `conflictId` in the column whose stack holds it, showing only conflicted commits. */
    resolveConflict(conflictId: string): void
    /** Follows a renamed branch in the histories read from it. */
    renamed(oldRef: string, newRef: string): void
    /** Reads a diff again after it failed, or its next page. */
    readDiff(columnId: string, key: string, more?: boolean): void
    /** Shows a Working Changes diff's staged or unstaged side, or a conflict's side. */
    changeView(columnId: string, key: string, view: DiffView): void
    toggleWhitespace(columnId: string, key: string): void
    /** Wraps every diff's long lines, or scrolls them sideways again, until Laneway restarts. */
    toggleWrapLines(): void
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
    /** Shows a Markdown file's source lines or rendered documents; every Markdown diff opens the last way chosen until Laneway restarts. */
    setMarkdownView(columnId: string, key: string, view: MarkdownView): void
    /** Reads a Markdown document's old and new text for its rendered diff. */
    readMarkdown(page: FileDiffPage, signal: AbortSignal): Promise<MarkdownVersions>
    /** Reads a picture a rendered Markdown document shows from the repository, as one side of its diff has it. */
    readMarkdownPicture(page: FileDiffPage, side: "old" | "new", path: string): Promise<FileVersion>
    /** Downloads a picture from the web that a rendered Markdown document shows. */
    readRemoteImage(url: string): Promise<RemoteImageResult>
    /** Opens a rendered Markdown document's web or email link outside Laneway. */
    openLink(url: string): void
    /**
     * Chooses whole files together. `toggle` clears them when all are already chosen and otherwise chooses them all,
     * `add` only chooses them, and `only` chooses them in place of every other file.
     */
    select(columnId: string, group: string, files: ChangedFile[], how?: FileChoice): void
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
    /** A branch column's branch. */
    branchId?: string
    /** The compared tips a comparison was read at; when a compared branch moves, it is read again. */
    comparisonKey?: string
    /** A conflicted commit to open once its history shows it. */
    openConflict?: string
    /** For an auxiliary column's state, the Workspace Column it descends from, and its own auxiliary column. */
    root?: ColumnState
    auxiliaryId?: string
    layout?: DiffLayout
    /** The composition tips its lists were read against; files and lines can only be chosen while they hold. */
    compositionKey?: string
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
    /** The file at the top of its files: the one chosen, until the user scrolls it to another. */
    shown?: string
    entireFiles: boolean
}

interface HistoryColumnState {
    kind: "history"
    history: FileHistoryState
    host: ColumnState
}

interface CommitColumnState {
    kind: "commit"
    commit: CommitDiffState
    host: ColumnState
}

type AuxiliaryValue = DiffColumnState | HistoryColumnState | CommitColumnState

interface InspectionOptions {
    api: Api
    notify(notice: Notice): () => void
    /** Puts a list's files in the order its rows show them, the order a diff column reads their diffs in. */
    displayOrder(files: ChangedFile[]): ChangedFile[]
}

/** The files and commits each Workspace Column shows, read from Git as the column needs them. */
export function createInspection({ api, notify, displayOrder }: InspectionOptions): Inspection {
    let store = createStore<InspectionSnapshot>({ columns: {}, auxiliary: {}, wrapLines: false })
    let repositories = new Map<string, Map<string, ColumnState>>()
    let graphs = new Map<string, BranchGraph>()
    let auxiliaries = new Map<string, AuxiliaryColumns<AuxiliaryValue>>()
    // Auxiliary columns' own column states, by repository.
    let hosts = new Map<string, Map<string, ColumnState>>()
    let hostSerial = 0
    let historyHosts = new Map<FileHistoryState, ColumnState>()
    let activeId: string | undefined
    let focused: InspectionSnapshot["focused"]
    let wrapLines = false
    let diffViews = new WeakMap<FileDiffState, FileDiffState>()
    let discards = createDiscards({
        api,
        notify,
        changed: (repositoryId, worktreePath) => {
            for (let state of allStates(repositoryId)) {
                if (state.worktreePath == worktreePath)
                    void read(repositoryId, state, "working", { kind: "working", worktreePath }, true)
            }
        },
    })
    let histories = createFileHistories({
        api,
        update: () => publish(),
        composition: history => compositionTips(historyHosts.get(history)?.root),
        // A moved history drops the commits it no longer shows, and anything chosen in them.
        changed(history) {
            let host = historyHosts.get(history)
            if (!host)
                return
            host.compositionKey = JSON.stringify(compositionTips(host.root))
            for (let group of Object.keys(host.files)) {
                if (!group.startsWith("working") && !history.page?.entries.some(entry => entry.objectId == group)) {
                    closeGroup(host, group)
                    delete host.files[group]
                }
            }
            host.selected = []
            for (let diff of Object.values(host.diffs))
                diff.selection = undefined
        },
    })

    function publish() {
        let columns = activeId ? repositories.get(activeId) : undefined
        let tree = activeId ? auxiliaryFor(activeId) : undefined
        store.publish({
            repositoryId: activeId,
            columns: Object.fromEntries([...columns?.values() ?? []].map(state => [state.id, inspected(state)])),
            auxiliary: Object.fromEntries([...columns?.keys() ?? []].map(id => [id, tree?.descendants(id).map(auxiliaryView) ?? []])),
            focused,
            wrapLines,
        })
    }

    function inspected(state: ColumnState): ColumnInspection {
        return {
            worktreePath: state.worktreePath,
            files: { ...state.files },
            selected: state.selected,
            showIgnored: state.showIgnored,
            history: { ...state.history },
            bases: { ...state.bases },
            diffs: Object.fromEntries(Object.entries(state.diffs).map(([key, diff]) => [key, diffView(diff)])),
            diffColumn: state.diffColumn && { group: state.diffColumn.group, shown: state.diffColumn.shown },
            filter: state.filter,
            conflictsOnly: state.conflictsOnly,
        }
    }

    // A diff's reads and choices change it in place, so the snapshot shows a copy, kept until the diff changes again:
    // a view can then skip the diffs that didn't change, which in a large diff column is nearly all of them.
    function diffView(diff: FileDiffState) {
        let view = diffViews.get(diff)
        if (!view || !sameFields(view, diff)) {
            view = { ...diff }
            diffViews.set(diff, view)
        }
        return view
    }

    function auxiliaryView(node: AuxiliaryColumn<AuxiliaryValue>): AuxiliaryView {
        let value = node.value
        let placed = { id: node.id, sourceId: node.sourceId, width: node.width }
        if (value.kind == "diff") {
            return {
                kind: "diff",
                ...placed,
                group: value.group,
                subject: value.subject,
                collapsed: [...value.collapsed],
                focus: value.focus ? { path: value.focus, serial: value.serial } : undefined,
                entireFiles: value.entireFiles,
            }
        }
        let { host } = value
        let composable = value.kind == "history"
            ? value.history.error ? [] : value.history.page?.entries.filter(entry => entry.composable).map(entry => entry.objectId) ?? []
            : value.commit.entry.composable
            ? [value.commit.entry.objectId]
            : []
        let fresh = host.compositionKey == JSON.stringify(compositionTips(host.root))
        let hosted = { ...placed, hostId: host.id, host: inspected(host), layout: host.layout ?? "unified", eligible: ["working", ...fresh ? composable : []] }
        if (value.kind == "history") {
            let { history } = value
            return {
                kind: "history",
                ...hosted,
                source: history.source,
                path: history.path,
                page: history.page,
                error: history.error,
                loading: history.loading,
                expanded: [...history.expanded],
                blame: history.blame && { ...history.blame },
            }
        }
        let { commit } = value
        return {
            kind: "commit",
            ...hosted,
            entry: commit.entry,
            parentId: commit.parentId,
            related: commit.related,
            error: commit.error,
            loading: commit.loading,
        }
    }

    function hostsFor(repositoryId: string) {
        let states = hosts.get(repositoryId)
        if (!states) {
            states = new Map()
            hosts.set(repositoryId, states)
        }
        return states
    }

    function allStates(repositoryId: string) {
        return [...repositories.get(repositoryId)?.values() ?? [], ...hostsFor(repositoryId).values()]
    }

    function alive(state: ColumnState) {
        return (state.root ? hostsFor(state.repositoryId) : repositories.get(state.repositoryId))?.get(state.id) == state
    }

    // A history's commits can move onto its Workspace Column's branch while that branch and the primary branch stay put.
    function compositionTips(root?: ColumnState) {
        let graph = root && graphs.get(root.repositoryId)
        let primary = graph?.branches.find(branch => branch.primary)
        let branch = graph?.branches.find(candidate => candidate.id == root?.branchId)
        return branch && !branch.remoteOnly && primary ? { tip: branch.tip, primaryTip: primary.tip } : undefined
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
        if (repositoryId == activeId && alive(state))
            publish()
    }

    function columnState(columnId: string) {
        return activeId ? repositories.get(activeId)?.get(columnId) ?? hostsFor(activeId).get(columnId) : undefined
    }

    function requestId(state: ColumnState, group: string) {
        return `inspection:${state.id}:files:${group}`
    }

    function diffRequestId(state: ColumnState, diff: FileDiffState) {
        return `inspection:${state.id}:diff:${diffKey(diff.group, diff.path)}`
    }

    function createState(repositoryId: string, id: string, worktreePath?: string, root?: ColumnState): ColumnState {
        let state: ColumnState = {
            id,
            repositoryId,
            worktreePath,
            root,
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
                alive: () => alive(state),
                requestId: diff => diffRequestId(state, diff),
                update: () => publishFor(repositoryId, state),
                settled: () => {},
            }),
        }
        if (!root)
            auxiliaryFor(repositoryId).addRoot(id)
        return state
    }

    // An auxiliary column's state shows its files with the Workspace Column's scopes, its diffs unified to start.
    function createHost(root: ColumnState, worktreePath?: string) {
        let host = createState(root.repositoryId, `auxiliary-host:${++hostSerial}`, worktreePath, root)
        host.layout = "unified"
        host.compositionKey = JSON.stringify(compositionTips(root))
        hostsFor(root.repositoryId).set(host.id, host)
        return host
    }

    // A closed column cancels its reads and closes the auxiliary columns opened from it.
    function dispose(states: Map<string, ColumnState>, state: ColumnState) {
        states.delete(state.id)
        for (let group of Object.keys(state.files))
            void api.cancelInspection(state.repositoryId, requestId(state, group))
        for (let diff of Object.values(state.diffs))
            closeDiff(state, diff)
        if (!state.root)
            auxiliaryFor(state.repositoryId).close(state.id)
    }

    /** Where a column opened from `fromId` attaches, and the state whose files it came from. */
    function attachment(fromId: string) {
        let state = columnState(fromId)
        if (state)
            return { owner: state, sourceId: state.auxiliaryId ?? state.id }
        let value = auxiliaryNode(fromId)?.node.value
        return value?.kind == "diff" ? { owner: value.owner, sourceId: fromId } : undefined
    }

    function historyColumn(id: string) {
        let value = auxiliaryNode(id)?.node.value
        return value?.kind == "history" ? value : undefined
    }

    function commitColumn(id: string) {
        let found = auxiliaryNode(id)
        return found?.node.value.kind == "commit" ? { ...found, value: found.node.value } : undefined
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
                current.shown = path
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
            shown: path,
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
    // It starts their reads in the list's order, so the files at its top tend to arrive first; they still run at once
    // and may finish in any order. Reads started before the list's view changes keep the order they started in.
    function populate(state: ColumnState, column: DiffColumnState) {
        let files = state.files[column.group]
        if (files?.error)
            return
        for (let file of displayOrder(files?.inventory?.files ?? [])) {
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
        if (state.diffColumn == column)
            state.diffColumn = undefined
        for (let key of column.created) {
            let diff = state.diffs[key]
            if (diff)
                closeDiff(state, diff)
        }
    }

    function toggleDiffIn(state: ColumnState, group: string, path: string) {
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
        openConflictCommit(repositoryId, state)
        publishFor(repositoryId, state)
        // Showing only conflicted commits reads the whole history, so none is missed.
        if (state.conflictsOnly && !update.error && update.page?.nextOffset != undefined && alive(state))
            void readHistory(repositoryId, state, branch, true)
    }

    // Each unresolved branch in the column's stack shows, read to its end.
    function readConflictHistories(repositoryId: string, state: ColumnState) {
        let graph = graphs.get(repositoryId)
        let branch = graph?.branches.find(candidate => candidate.id == state.branchId)
        if (!graph || !branch)
            return
        for (let item of branchStack(graph, branch, state.bases)) {
            if (!item.unresolved)
                continue
            let current = state.history[item.id]
            if (!current || current.key != historyKey(graph, item) || !current.page)
                void readHistory(repositoryId, state, item)
            else {
                state.history[item.id] = { ...current, open: true }
                if (current.page.nextOffset != undefined)
                    void readHistory(repositoryId, state, item, true)
            }
        }
    }

    function openConflictCommit(repositoryId: string, state: ColumnState) {
        let conflictId = state.openConflict
        let commit = conflictId
            && Object.values(state.history).flatMap(history => history.page?.commits ?? []).find(candidate => candidate.conflictId == conflictId)
        if (!commit)
            return
        state.openConflict = undefined
        let files = state.files[commit.objectId]
        if (!files)
            void read(repositoryId, state, commit.objectId, { kind: "commit", objectId: commit.objectId })
        else if (!files.open)
            state.files[commit.objectId] = { ...files, open: true }
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
                    state.branchId = column.branch?.id
                    states.set(column.id, state)
                    changed = true
                    void readWorkingFor(repositoryId, state, false)
                    if (column.branch)
                        void readHistory(repositoryId, state, column.branch)
                    if (column.comparison) {
                        state.comparisonKey = comparisonKey(graph, column.comparison.from, column.comparison.to)
                        void read(repositoryId, state, "comparison", { kind: "refs", ...column.comparison })
                    }
                    continue
                }
                state.branchId = column.branch?.id
                // A moved branch at either end changes the comparison; its list and open diffs read again quietly.
                if (column.comparison && state.comparisonKey != comparisonKey(graph, column.comparison.from, column.comparison.to)) {
                    state.comparisonKey = comparisonKey(graph, column.comparison.from, column.comparison.to)
                    void read(repositoryId, state, "comparison", { kind: "refs", ...column.comparison }, true)
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
            for (let state of allStates(activeId))
                void readWorkingFor(activeId, state, true)
            histories.refresh(activeId)
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
            for (let state of activeId ? allStates(activeId) : []) {
                state.selected = []
                for (let diff of Object.values(state.diffs))
                    diff.selection = undefined
            }
            publish()
        },

        toggleDiff(columnId, group, path) {
            let state = columnState(columnId)
            if (state)
                toggleDiffIn(state, group, path)
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

        showInDiffColumn(columnId, group, path, open = false) {
            let state = columnState(columnId)
            if (state && (state.diffColumn || open))
                void showDiffColumn(state, group, path, undefined, false)
        },

        openWorkingDiffColumn(columnId) {
            let state = columnState(columnId)
            if (!state)
                return
            if (state.diffColumn?.group.startsWith("working")) {
                focusAuxiliary(state.diffColumn.id)
                return publish()
            }
            let listed = (group: string) => state.files[group]?.inventory?.files.some(file => !file.ignored) == true
            let group = listed("working-staged") ? "working-staged" : "working-unstaged"
            // It starts at the top, which the file list's view may give to any of its files.
            if (listed(group))
                void showDiffColumn(state, group, undefined, undefined, true)
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
            if (column?.kind != "diff")
                return
            for (let path of paths) {
                if (folded)
                    column.collapsed.add(path)
                else
                    column.collapsed.delete(path)
            }
            publish()
        },

        scrolledTo(id, path) {
            let column = auxiliaryNode(id)?.node.value
            if (column?.kind != "diff" || column.shown == path)
                return
            column.shown = path
            publish()
        },

        toggleEntireFiles(id) {
            let column = auxiliaryNode(id)?.node.value
            if (column?.kind != "diff")
                return
            column.entireFiles = !column.entireFiles
            for (let diff of Object.values(column.owner.diffs))
                rereadDiff(column.owner, diff)
            publish()
        },

        openHistory(fromId, source, path) {
            let attached = attachment(fromId)
            if (!attached)
                return
            let root = attached.owner.root ?? attached.owner
            let node = auxiliaryFor(root.repositoryId).open(attached.sourceId, JSON.stringify(["history", source, path]), () => {
                let history = histories.history(root.repositoryId, source, path)
                let host = createHost(root, source.kind == "worktree" ? source.worktreePath : undefined)
                historyHosts.set(history, host)
                queueMicrotask(() => void histories.read(history))
                return {
                    value: { kind: "history", history, host },
                    dispose() {
                        histories.dispose(history)
                        historyHosts.delete(history)
                        dispose(hostsFor(root.repositoryId), host)
                    },
                }
            })
            if (node.value.kind == "history")
                node.value.host.auxiliaryId = node.id
            focusAuxiliary(node.id)
            publish()
        },

        toggleHistoryEntry(id, objectId) {
            let column = historyColumn(id)
            if (!column)
                return
            let { history, host } = column
            let group = objectId ?? "working"
            if (history.expanded.delete(group)) {
                closeGroup(host, group)
                return publish()
            }
            let entry = history.page?.entries.find(candidate => candidate.objectId == objectId)
            let source: DiffSource | undefined = entry
                ? { kind: "commit", objectId: entry.objectId, parentId: entry.followedParent }
                : !objectId && host.worktreePath
                ? { kind: "working", worktreePath: host.worktreePath }
                : undefined
            if (!source)
                return
            history.expanded.add(group)
            // An entry shows its file's diff in that commit straight away.
            void read(host.repositoryId, host, group, source).then(() => {
                let file = entry && host.files[group]?.inventory?.files.find(candidate => candidate.path == entry.path)
                if (file && alive(host) && history.expanded.has(group) && !host.diffs[diffKey(group, file.path)])
                    toggleDiffIn(host, group, file.path)
            })
        },

        readFileHistory(id, more = false) {
            let column = historyColumn(id)
            if (column)
                void histories.read(column.history, more)
        },

        chooseOrigin(id, objectId, previousPath) {
            let column = historyColumn(id)
            let entry = column?.history.page?.entries.find(candidate => candidate.objectId == objectId)
            if (column && entry)
                histories.chooseOrigin(column.history, entry, previousPath)
        },

        blame(id, objectId, more = false) {
            let column = historyColumn(id)
            let entry = more ? column?.history.blame?.entry : column?.history.page?.entries.find(candidate => candidate.objectId == objectId)
            if (column && entry)
                void histories.blame(column.history, entry, more)
        },

        closeBlame(id) {
            let column = historyColumn(id)
            if (column) {
                column.history.blame = undefined
                publish()
            }
        },

        openCommitDiff(id, objectId) {
            let found = auxiliaryNode(id)
            let column = found?.node.value
            let entry = column?.kind == "history" ? column.history.page?.entries.find(candidate => candidate.objectId == objectId) : undefined
            if (!found || column?.kind != "history" || !entry)
                return
            let root = column.host.root!
            let node = found.tree.open(id, JSON.stringify(["commit", entry.objectId, entry.followedParent]), () => {
                let commit = histories.commit(root.repositoryId, entry)
                let host = createHost(root)
                void read(root.repositoryId, host, entry.objectId, { kind: "commit", objectId: entry.objectId, parentId: entry.followedParent })
                return {
                    value: { kind: "commit", commit, host },
                    dispose() {
                        histories.dispose(commit)
                        dispose(hostsFor(root.repositoryId), host)
                    },
                }
            })
            if (node.value.kind == "commit")
                node.value.host.auxiliaryId = node.id
            focusAuxiliary(node.id)
            publish()
        },

        chooseCommitParent(id, parentId) {
            let found = commitColumn(id)
            if (!found)
                return
            let { commit, host } = found.value
            // Columns opened from its related files belong to the old comparison.
            for (let child of found.tree.descendants(id).filter(candidate => candidate.sourceId == id))
                found.tree.close(child.id)
            histories.cancel(commit)
            commit.parentId = parentId
            commit.related = undefined
            commit.error = undefined
            closeGroup(host, commit.entry.objectId)
            host.selected = []
            void read(host.repositoryId, host, commit.entry.objectId, { kind: "commit", objectId: commit.entry.objectId, parentId })
        },

        findRelated(id, more = false) {
            let found = commitColumn(id)
            if (found)
                void histories.related(found.value.commit, more)
        },

        openFilter(columnId) {
            let state = columnState(columnId)
            if (state && !state.filter) {
                state.filter = { text: "", status: "all" }
                publish()
            }
        },

        setFilter(columnId, filter) {
            let state = columnState(columnId)
            if (!state)
                return
            state.filter = filter
            // The diff column keeps its own list's diffs, which it filters as it shows them.
            for (let diff of Object.values(state.diffs)) {
                let file = state.files[diff.group]?.inventory?.files.find(candidate => candidate.path == diff.path)
                if (file && diff.group != state.diffColumn?.group && !matchesFilter(filter, file))
                    closeDiff(state, diff)
            }
            publish()
        },

        closeFilter(columnId) {
            let state = columnState(columnId)
            if (state?.filter) {
                state.filter = undefined
                publish()
            }
        },

        setConflictsOnly(columnId, conflictsOnly) {
            let state = columnState(columnId)
            if (!state || !activeId)
                return
            state.conflictsOnly = conflictsOnly
            if (conflictsOnly)
                readConflictHistories(activeId, state)
            publish()
        },

        resolveConflict(conflictId) {
            let graph = activeId ? graphs.get(activeId) : undefined
            for (let state of activeId ? repositories.get(activeId)?.values() ?? [] : []) {
                let branch = graph?.branches.find(candidate => candidate.id == state.branchId)
                if (!graph || !branch || !branchStack(graph, branch, state.bases).some(item => item.unresolved?.subjects.includes(conflictId)))
                    continue
                state.openConflict = conflictId
                state.conflictsOnly = true
                readConflictHistories(activeId!, state)
                openConflictCommit(activeId!, state)
                return publish()
            }
        },

        setLayout(columnId, layout) {
            let state = columnState(columnId)
            if (state?.root) {
                state.layout = layout
                publish()
            }
        },

        renamed(oldRef, newRef) {
            if (activeId)
                histories.renamed(activeId, oldRef, newRef)
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

        toggleWrapLines() {
            wrapLines = !wrapLines
            publish()
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

        setMarkdownView(columnId, key, view) {
            let found = diffFor(columnId, key)
            if (!found)
                return
            found.diff.markdownView = view
            rememberMarkdownView(view)
            publish()
        },

        readMarkdown: (page, signal) => readMarkdownVersions(api, activeId ?? "", page, signal),

        readMarkdownPicture: (page, side, path) => readFileVersion(api, activeId ?? "", { source: page.source, view: page.view, side, path, fetchLfs: true }),

        readRemoteImage: url => api.readRemoteImage(url),

        openLink: url => void api.openLink(url),

        select(columnId, group, files, how = "toggle") {
            let state = columnState(columnId)
            if (!state)
                return
            let ids = files.map(file => `${group}:${file.path}`)
            state.selected = how == "only"
                ? ids
                : how == "toggle" && ids.every(id => state.selected.includes(id))
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

function sameFields<T extends object>(a: T, b: T) {
    let keys = Object.keys(a) as (keyof T)[]
    return keys.length == Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key])
}
