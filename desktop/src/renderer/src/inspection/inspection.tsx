import type { BranchGraph, BranchGraphBranchNode, BranchGraphVirtualBranch, BranchHistoryCommit, BranchHistoryPage, ChangedFile, ChangesInventory, CompositionSource, DiffLayout, DiffSource, DiffView } from "@laneway/shared"
import { css, on, ref, type RemixNode } from "remix/ui"
import * as accordion from "remix/ui/accordion/primitives"
import { auxiliaryCloseButton, auxiliaryColumnFrame, auxiliaryColumnHeader, AuxiliaryColumns } from "../auxiliary-columns"
import { CommitComposer } from "../commit-composer"
import { compositionStyles, createComposition } from "../composition"
import { ConflictResolution } from "../conflict-resolution"
import { EditableName } from "../editable-name"
import type { NoticeState } from "../feedback"
import { Icon } from "../icons"
import { type OverflowAction, OverflowMenu } from "../overflow-menu"
import { RewordForm } from "../reword"
import { columnWorktree } from "../worktrees/worktree-columns"
import { type BranchComparisonState, createBranchComparisons } from "./branch-comparison"
import { columnItem, focusItem, isFileItem, parentItem, scrollBehavior, stepItem } from "./column-navigation"
import { CommitMessage } from "./commit-message"
import { readDiffContext } from "./diff-context"
import { DiffControls } from "./diff-controls"
import { fileLabel, FileTree } from "./file-list"
import { FileMenu } from "./file-menu"
import { createDiffSession, type FileDiffState } from "./inspection-diff-session"
import { InspectionDiffContents, inspectionMuted, inspectionProgress, selectionSummary } from "./inspection-diff-view"

type Column = BranchGraphBranchNode | BranchGraphVirtualBranch
interface Options {
    api: Window["laneway"]
    update(): Promise<AbortSignal>
    signal: AbortSignal
    notify(notice: NoticeState): () => void
    layout(repositoryId: string, columnId: string): DiffLayout
    saveLayout(repositoryId: string, columnId: string, layout: DiffLayout): void
    compareWith(repositoryId: string, fromRef: string, replaceId?: string, toRef?: string): void
    localChanged?(repositoryId: string): Promise<void>
    localBusyChanged?(busy: boolean): void
    recoveryBlocked?(repositoryId: string): boolean
    createBranchAt?(repositoryId: string, objectId: string): void
    /** Renames a local branch in place; rejects with the reason when Git declines. */
    renameBranch?(repositoryId: string, name: string, newName: string): Promise<void>
    resolveWorkingConflict?(repositoryId: string, subject: string): void
    maximized(repositoryId: string): string | undefined
    maximize(repositoryId: string, id: string): void
}
interface FileState {
    inventory?: ChangesInventory
    source: DiffSource
    loading: boolean
    /** A quiet re-read is in flight; the current inventory stays on screen until a different one arrives. */
    refreshing?: boolean
    error?: string
    open: boolean
    generation: number
    includeIgnored?: boolean
}
interface HistoryState {
    page?: BranchHistoryPage
    loading: boolean
    error?: string
    key: string
    open: boolean
    generation: number
}
/** One group's whole diff beside its source column; `focus` is the file the column last scrolled to. */
interface BreakoutState {
    kind: "diff"
    group: string
    subject?: string
    created: Set<string>
    collapsed: Set<string>
    focus?: string
    /** Keeps aiming at `focus` while diffs above it are still loading and pushing it down. */
    scrolling?: boolean
}
interface ColumnState {
    repositoryId: string
    id: string
    column: Column
    graph: BranchGraph
    worktreePath?: string
    files: Map<string, FileState>
    history: Map<string, HistoryState>
    baseSelections: Map<string, string>
    requestIds: Set<string>
    diffs: Map<string, FileDiffState>
    wholeFiles: Map<string, { source: DiffSource; path: string; version: string }>
    breakout?: BreakoutState
    showIgnored: boolean
    filter: string
    filterOpen: boolean
    conflictsOnly?: boolean
    selectingConflicts?: boolean
    filterInput?: HTMLInputElement
    filterButton?: HTMLButtonElement
    status: string
    alive: boolean
    unavailable?: boolean
    auxiliaryId?: string
    transientLayout?: DiffLayout
    showEntireFiles?: boolean
    selectionRoot?: ColumnState
    composable?: Set<string>
    compositionKey?: string
    /** The commit whose message is being edited in place. */
    reword?: string
}

let changeFileList = css({
    position: "relative",
    ".file-tree details &": {
        paddingLeft: "14px",
    },
})

// An empty staging list still needs somewhere to drop while the commit form is open.
let stagingHint = css({
    margin: "4px 10px 6px",
    padding: "8px",
    border: "1px dashed var(--line-strong)",
    borderRadius: "var(--radius)",
    color: "var(--muted)",
    fontSize: "12px",
    textAlign: "center",
    pointerEvents: "none",
})

let changeFileListP = css({
    margin: 0,
    padding: "8px 10px",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
})

let changeFileListButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    "&:hover": {
        background: "var(--control-hover)",
    },
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
})

let inspectionProgressContainer = css({
    position: "relative",
})

let diffInspector = css({
    position: "relative",
    borderBlock: "1px solid var(--line-strong)",
    background: "var(--panel)",
    minWidth: "0",
})

let diffToolbar = css({
    "& .diff-file-menu": { flex: 1, minWidth: 0 },
    // Only broken-out diffs show this toolbar, sticking under their diff column's sticky header.
    position: "sticky",
    top: "46px",
    zIndex: 5,
    background: "var(--panel-deep)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px var(--scrollbar-clearance) 4px 6px",
    borderBottom: "1px solid var(--line)",
})

let diffToolbarStrong = css({
    display: "flex",
    minWidth: "0",
    flex: "1",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    font: "12px var(--mono)",
})

let diffFileToggle = css({
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    padding: "4px 0",
    border: 0,
    background: "transparent",
    color: "var(--text)",
    textAlign: "left",
    cursor: "pointer",
    "& > svg": { flex: "0 0 auto", color: "var(--muted)" },
    "&:hover": { background: "var(--control-hover)" },
})

let renameSelection = css({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    color: "var(--muted)",
    fontSize: "11px",
    padding: "5px 8px",
})

let diffInspectorInput = css({
    '&[type="checkbox"]': {
        width: "14px",
        height: "14px",
        minHeight: "0",
        padding: "0",
        margin: "0 3px 0 0",
        flex: "0 0 14px",
    },
    width: "14px",
    height: "14px",
    minHeight: 0,
    padding: 0,
    margin: "0 3px 0 0",
    flex: "0 0 14px",
})

let columnInspection = css({
    "--filter-height": "0px",
    "&.filter-open": { "--filter-height": "52px" },
    overflow: "auto",
    flex: "1",
    minHeight: "0",
})

let inspectionFilters = css({
    position: "sticky",
    top: "6px",
    zIndex: 8,
    height: "40px",
    margin: "6px 8px",
    boxSizing: "border-box",
    background: "var(--panel)",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "4px 8px",
    border: "1px solid var(--line-strong)",
    borderRadius: "6px",
    boxShadow: "var(--shadow-popover)",
})

let filterToggleButton = css({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "0 0 auto",
    width: "26px",
    height: "26px",
    padding: "0",
    border: "0",
    borderRadius: "3px",
    background: "transparent",
    color: "var(--muted)",
    cursor: "pointer",
    "&:hover": { background: "var(--control-hover)", color: "var(--text)" },
    '&[aria-expanded="true"]': { background: "var(--accent-wash)", color: "var(--accent)" },
})

let filterChangedFilesInput = css({
    height: "28px",
    minHeight: "28px",
    boxSizing: "border-box",
    font: "inherit",
    width: "100%",
    minWidth: "40px",
    color: "var(--text)",
    background: "var(--field)",
    border: "1px solid var(--line)",
    padding: "0 7px",
    borderRadius: "3px",
})

let filterChangeStatusSelect = css({
    height: "28px",
    minHeight: "28px",
    boxSizing: "border-box",
    font: "inherit",
    color: "var(--text)",
    background: "var(--field)",
    border: "1px solid var(--line)",
    padding: "0 7px",
    borderRadius: "3px",
})

let workingChanges = css({
    background: "var(--panel)",
})

let workingChangesH3 = css({
    fontSize: "12px",
    margin: "0",
})

// Each branch in the stack is a card; its heading carries the branch tint and icon.
let stackBranch = css({
    margin: "8px 8px 0",
    overflow: "clip",
    border: "1px solid var(--focus-edge)",
    borderRadius: "var(--radius)",
    background: "var(--panel)",
    "&:last-child": { marginBottom: "8px" },
    // Rows draw their own bottom rules; the card's edge replaces the last one. A trailing -1px pulls the
    // card's bottom up over that rule, whichever row is last, and the clip hides it.
    "&::after": { content: '""', display: "block", marginTop: "-1px" },
    // Branches whose tip their remote already has take the remote teal instead of the local branch blue.
    "&.remote": { borderColor: "var(--remote-edge)" },
    "&.remote :is(.composition-branch-target, .composition-branch-heading)": { background: "var(--remote-wash)" },
    "&.remote .composition-branch-heading:hover": { background: "color-mix(in srgb, var(--remote) 18%, var(--panel))" },
    "&.remote .composition-branch-target > svg": { color: "var(--remote)" },
})

let disclosureHeading = css({
    margin: 0,
    font: "inherit",
})

// The whole sticky row owns the graph line, the node, the hover and the expanded tint, so the
// line meets the file rows below and the highlight runs under the grip too.
let commitStickyHeading = css({
    position: "sticky",
    top: "var(--filter-height, 0px)",
    zIndex: 7,
    minHeight: "34px",
    display: "flex",
    alignItems: "center",
    paddingLeft: "22px",
    background: "var(--panel)",
    borderBottom: "1px solid var(--line)",
    borderRadius: "0",
    "&::before": {
        position: "absolute",
        top: "-1px",
        bottom: "-1px",
        left: "12px",
        width: "2px",
        content: '""',
        background: "var(--line-strong)",
        pointerEvents: "none",
    },
    // Sticky rows must stay opaque, so hover and expanded tints are mixed into the panel colour.
    "&:hover": {
        backgroundColor: "color-mix(in srgb, var(--text) 5%, var(--panel))",
    },
    '&:has(> .commit-heading[aria-expanded="true"])': {
        backgroundColor: "color-mix(in srgb, var(--focus) 12%, var(--panel))",
    },
    '&:has(> .commit-heading[aria-expanded="true"]):hover': {
        backgroundColor: "color-mix(in srgb, var(--focus) 18%, var(--panel))",
    },
})

// The surrounding branch row owns the tint, edges and hover so they run under the grip too. Each css()
// class sits in its own cascade layer, so an override from the row's styles cannot reliably win here.
let stackHeading = css({
    flex: "1",
    minWidth: "0",
    border: "0",
    background: "transparent",
    color: "var(--text)",
    borderRadius: "0",
    minHeight: "34px",
    padding: "0 12px",
    font: "inherit",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    scrollMarginTop: "var(--filter-height, 0px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    textAlign: "left",
})
let conflictIndicator = css({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    minWidth: "26px",
    height: "26px",
    padding: "3px",
    color: "var(--warning)",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: "4px",
    cursor: "pointer",
    "&[aria-pressed=true]": { background: "var(--warning-wash)", borderColor: "var(--warning-edge)" },
    "&:hover": { background: "var(--warning-wash)" },
    ".inspect-commit &": { height: "100%", width: "32px", alignSelf: "stretch", borderRadius: "0", padding: "0", border: "0" },
})
// Tool buttons sit flush in the sticky commit row and stay transparent so the row's hover and
// expanded tints run under them; only the hovered button darkens.
let commitToolButton = css({
    width: "32px",
    alignSelf: "stretch",
    flex: "0 0 32px",
    display: "grid",
    placeItems: "center",
    padding: 0,
    border: "0",
    borderRadius: "0",
    background: "transparent",
    color: "var(--muted)",
    cursor: "pointer",
    "&:hover, &[aria-expanded=true]": {
        background: "color-mix(in srgb, var(--text) 8%, transparent)",
        color: "var(--text)",
    },
})

let stackHeadingName = css({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    minWidth: "0",
    "& svg": { color: "var(--faint)", flex: "0 0 auto" },
    "& svg + svg": { color: "var(--focus)" },
    ".stack-branch.remote & svg + svg": { color: "var(--remote)" },
})

let stackHeadingStatus = css({ display: "inline-flex", alignItems: "center", gap: "8px" })
let stackConflictIndicator = css({ display: "inline-flex", alignItems: "center", flexShrink: "0", color: "var(--warning)" })

let stackBranchButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    "&:hover": {
        background: "var(--control-hover)",
    },
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
})

// An expanded commit's files sit in a recessed tray under its heading.
let inspectCommit = css({
    position: "relative",
    '&[data-expanded="true"] > :not(.disclosure-heading)': {
        background: "var(--panel-deep)",
    },
})

let commitHeading = css({
    alignSelf: "stretch",
    border: "0",
    background: "transparent",
    color: "var(--text)",
    borderRadius: "0",
    padding: "0 10px 0 4px",
    font: "inherit",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    flex: "1 1 auto",
    minWidth: 0,
    gap: "8px",
    width: "100%",
    textAlign: "left",
    // Keyboard focus scrolls the heading clear of the sticky filter bar.
    scrollMarginTop: "var(--filter-height, 0px)",
    '&[aria-expanded="true"]': { paddingTop: "6px", paddingBottom: "6px" },
    '&[aria-expanded="true"] > span:first-child': {
        background: "var(--graph)",
    },
    '.inspect-commit[data-remote="true"] &[aria-expanded="true"] > span:first-child': {
        background: "var(--remote)",
    },
})

// Commits their remote already has take the remote teal, so a partly published branch changes colour along its history.
let commitNode = css({
    position: "absolute",
    zIndex: 2,
    left: "8px",
    top: "12px",
    width: "10px",
    height: "10px",
    margin: "0",
    flex: "0 0 auto",
    border: "2px solid var(--graph)",
    borderRadius: "50%",
    background: "var(--panel)",
    '.inspect-commit[data-remote="true"] &': { borderColor: "var(--remote)" },
})

let commitHeadingSpan = css({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    '.commit-heading[aria-expanded="true"] &': { whiteSpace: "normal", overflowWrap: "anywhere" },
})

let mergeParent = css({
    position: "relative",
    display: "flex",
    gap: "8px",
    alignItems: "center",
    padding: "6px 6px 6px 28px",
    fontSize: "11px",
    "&::before": {
        position: "absolute",
        top: "-1px",
        bottom: "-1px",
        left: "12px",
        width: "2px",
        content: '""',
        background: "var(--line-strong)",
        pointerEvents: "none",
    },
})

let parentForSelect = css({
    color: "var(--text)",
    background: "var(--field)",
    border: "1px solid var(--line)",
    padding: "5px",
    borderRadius: "3px",
})

let bodySelectionSummaryButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    "&:hover": {
        background: "var(--control-hover)",
    },
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
})

let inspectionBreakout = css({
    ...auxiliaryColumnFrame,
    minWidth: "380px",
    "& .auxiliary-source": { display: "block", fontSize: "10px", color: "var(--muted)" },
})

let inspectionBreakoutHeader = css({
    ...auxiliaryColumnHeader,
    position: "sticky",
    top: 0,
    zIndex: 10,
    "& > span": { flex: "1 1 auto", minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
})

let closeDiffColumnButton = css(auxiliaryCloseButton)
import type { FileHistorySource } from "@laneway/shared"
import type { FileHistoryEntry } from "@laneway/shared"
import { createTrailCommits, type TrailCommitState } from "../trail-commit"
import { createFileHistories, type FileHistoryState } from "./file-history"

export function createInspection(options: Options) {
    let diffSessions = new WeakMap<ColumnState, ReturnType<typeof createDiffSession>>()
    let navigationHighlight: Animation | undefined
    let columns = new Map<string, ColumnState>()
    let auxiliary = new AuxiliaryColumns<BreakoutState | BranchComparisonState | FileHistoryState | TrailCommitState>()
    let trailCommits = createTrailCommits(options)
    let comparisons = createBranchComparisons(options)
    let histories = createFileHistories({
        ...options,
        composition(history) {
            return compositionFor(historyHosts.get(history))
        },
        changed(history) {
            let host = historyHosts.get(history)
            if (!host)
                return
            host.compositionKey = JSON.stringify(compositionFor(host))
            for (let group of host.files.keys()) {
                if (group != "working" && !history.page?.entries.some(entry => entry.objectId == group)) {
                    clearGroup(host, group)
                    host.files.delete(group)
                }
            }
            host.wholeFiles.clear()
            for (let diff of host.diffs.values())
                diff.selection = undefined
        },
    })
    let historyHosts = new Map<FileHistoryState | TrailCommitState, ColumnState>()
    let activeRepositoryId: string | undefined
    let key = (repositoryId: string, id: string) => JSON.stringify([repositoryId, id])
    let update = () => {
        if (!options.signal.aborted)
            void options.update()
    }
    let composition = createComposition({
        ...options,
        busyChanged: options.localBusyChanged,
        changed: mutated,
        async resolve(repositoryId) {
            let result = await options.api.conflictOperation(repositoryId, { action: "list" })
            let first = result.ok ? result.result.conflicts.find(c => !c.suspended) : undefined
            if (first?.kind == "working") {
                options.resolveWorkingConflict?.(repositoryId, first.id)
                return
            }
            let state = [...columns.values()].find(s => s.repositoryId == repositoryId && s.column.kind == "branch" && s.column.unresolved)
            if (state) {
                state.conflictsOnly = true
                if (state.column.kind == "branch") {
                    let branch = state.graph.branches.find(b => first && b.unresolved?.subjects.includes(first.id)) ?? state.column
                    await history(state, branch)
                    let commit = [...state.history.values()].flatMap(h => h.page?.commits ?? []).find(c => first ? c.conflictId == first.id : c.conflictId)
                    if (commit)
                        await readFiles(state, commit.objectId, { kind: "commit", objectId: commit.objectId })
                }
                update()
            }
        },
    })
    let refresh = () => {
        if (activeRepositoryId)
            histories.refresh(activeRepositoryId)
        for (let host of historyHosts.values()) {
            if (host.repositoryId == activeRepositoryId && host.worktreePath)
                void readFiles(host, "working", { kind: "working", worktreePath: host.worktreePath }, true)
        }
        for (let state of columns.values()) {
            if (state.repositoryId == activeRepositoryId && state.worktreePath && !state.unavailable)
                void readFiles(state, "working", { kind: "working", worktreePath: state.worktreePath }, true)
        }
    }
    // The Branch Graph owner polls on one timer and calls `refreshWorking` alongside its own read, so a poll costs one burst of updates.
    window.addEventListener("focus", refresh)
    let visibility = () => {
        if (document.visibilityState != "visible") {
            comparisons.activate()
            histories.suspend()
            trailCommits.suspend()
            for (let host of historyHosts.values())
                suspend(host)
            for (let state of columns.values())
                suspend(state)
        } else {
            comparisons.activate(activeRepositoryId)
            refresh()
            for (let state of columns.values()) {
                if (state.repositoryId == activeRepositoryId)
                    resume(state)
            }
        }
    }
    document.addEventListener("visibilitychange", visibility)
    options.signal.addEventListener("abort", () => {
        navigationHighlight?.cancel()
        window.removeEventListener("focus", refresh)
        document.removeEventListener("visibilitychange", visibility)
        for (let state of columns.values())
            dispose(state)
    }, { once: true })
    return {
        /** Re-reads every open worktree's Working Changes, for repository changes noticed outside Laneway. */
        refreshWorking() {
            refresh()
        },
        renameBranch(repositoryId: string, oldRef: string, newRef: string) {
            comparisons.renameBranch(repositoryId, oldRef, newRef)
            histories.renameBranch(repositoryId, oldRef, newRef)
        },
        workingSummary(repositoryId: string, column: Column, graph: BranchGraph, worktreePath?: string) {
            if (!worktreePath)
                return "Branch"

            let state = stateFor(repositoryId, column, graph, worktreePath)
            if (columnWorktree(column, worktreePath)?.missing)
                return "Missing"
            let files = state.files.get("working")
            if (files?.error)
                return "Working Changes unavailable"
            if (!files?.inventory)
                return "Reading Working Changes…"
            let count = files.inventory.files.filter(file => !file.ignored).length

            return count ? `${count} changed ${count == 1 ? "file" : "files"}` : "Clean"
        },
        filterKeydown(repositoryId: string, columnId: string, event: KeyboardEvent, render: Options["update"]) {
            let state = columns.get(key(repositoryId, columnId))
            if (!state)
                return
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() == "f") {
                event.preventDefault()
                event.stopPropagation()
                void openFilter(state, render)
            } else if (event.key == "Escape" && state.filterOpen) {
                event.preventDefault()
                event.stopPropagation()
                closeFilter(state)
            }
        },
        /**
         * Up and Down move between the column's branches, commits, and files; Right expands and Left collapses.
         * With the diff column open, moving onto a file shows it there. Captured on the column, so it wins over
         * the commit accordion's own arrow keys.
         */
        navigationKeydown(repositoryId: string, columnId: string, event: KeyboardEvent) {
            let state = columns.get(key(repositoryId, columnId))
            let column = event.currentTarget
            let target = event.target
            if (
                !state || !(column instanceof HTMLElement) || !(target instanceof HTMLElement) || event.defaultPrevented
                || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
                || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
                || target.closest("input, textarea, select, [contenteditable=true], [role='menu'], [role='listbox'], dialog, .diff-inspector")
            ) {
                return
            }
            if (event.key == "ArrowUp" || event.key == "ArrowDown") {
                event.preventDefault()
                event.stopPropagation()
                let next = stepItem(column, target, event.key == "ArrowDown" ? 1 : -1)
                if (!next)
                    return
                focusItem(next)
                if (state.breakout && isFileItem(next))
                    next.click()
                return
            }
            let item = columnItem(target)
            if (!item)
                return
            event.preventDefault()
            event.stopPropagation()
            let expanded = item.getAttribute("aria-expanded") == "true"
            if (event.key == "ArrowRight") {
                if (!expanded)
                    item.click()
                return
            }
            // A file shown in the diff column has nothing of its own to collapse, so Left moves up to its commit.
            if (expanded && !(state.breakout && isFileItem(item)))
                item.click()
            else {
                let parent = parentItem(item)
                if (parent)
                    focusItem(parent)
            }
        },
        conflictFilter(repositoryId: string, column: Column, graph: BranchGraph, worktreePath?: string): RemixNode {
            let state = stateFor(repositoryId, column, graph, worktreePath)
            if (column.kind != "branch" || !column.unresolved && !state.conflictsOnly)
                return null
            return (
                <button
                    type="button"
                    aria-label="Show only conflicted commits"
                    title="Show only conflicted commits"
                    aria-pressed={Boolean(state.conflictsOnly)}
                    mix={[
                        conflictIndicator,
                        on("click", () => {
                            state.conflictsOnly = !state.conflictsOnly
                            if (state.conflictsOnly) {
                                let branch: BranchGraphBranchNode | undefined = column
                                let seen = new Set<string>()
                                while (branch && !seen.has(branch.id)) {
                                    seen.add(branch.id)
                                    if (branch.unresolved) {
                                        let current = state.history.get(branch.id)
                                        if (current)
                                            current.open = true
                                        if (!current?.page || current.page.nextOffset != undefined)
                                            void history(state, branch, Boolean(current?.page))
                                    }
                                    let nextId: string | undefined = branch.base.status == "known"
                                        ? branch.base.branchId
                                        : state.baseSelections.get(branch.id)
                                    branch = graph.branches.find(b => b.id == nextId)
                                }
                            }
                            update()
                        }),
                    ]}
                >
                    {conflictIcon()}
                </button>
            )
        },
        filterControl(repositoryId: string, column: Column, graph: BranchGraph, render: Options["update"], worktreePath?: string): RemixNode {
            let state = stateFor(repositoryId, column, graph, worktreePath)
            return (
                <button
                    type="button"
                    aria-label="Filter files"
                    title="Filter files (Ctrl+F)"
                    aria-expanded={state.filterOpen}
                    mix={[
                        filterToggleButton,
                        ref(element => {
                            state.filterButton = element
                        }),
                        on("click", () => openFilter(state, render)),
                    ]}
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <circle cx="6.5" cy="6.5" r="4.5" />
                        <path d="m10 10 4 4" />
                    </svg>
                </button>
            )
        },
        retainRepositories(ids: string[]) {
            for (let [id, state] of columns) {
                if (!ids.includes(state.repositoryId)) {
                    dispose(state)
                    columns.delete(id)
                }
            }
        },
        activate(repositoryId?: string) {
            comparisons.activate(repositoryId)
            if (activeRepositoryId != repositoryId) {
                histories.suspend()
                trailCommits.suspend()
                for (let host of historyHosts.values())
                    suspend(host)
                for (let state of columns.values()) {
                    if (state.repositoryId == activeRepositoryId)
                        suspend(state)
                }
                activeRepositoryId = repositoryId
                refresh()
                for (let state of columns.values()) {
                    if (state.repositoryId == activeRepositoryId)
                        resume(state)
                }
            }
        },
        retain(repositoryId: string, ids: string[], graph?: BranchGraph) {
            for (let [id, state] of columns) {
                if (state.repositoryId == repositoryId && !ids.includes(state.id)) {
                    if (
                        graph && ![...graph.branches, ...graph.virtualBranches].some(branch => branch.id == state.id)
                        && auxiliary.descendants(id).some(column => column.value.kind == "comparison" || column.value.kind == "history")
                    ) {
                        if (!state.unavailable) {
                            state.unavailable = true
                            state.breakout = undefined
                            suspend(state)
                        }
                        continue
                    }
                    dispose(state)
                    columns.delete(id)
                }
            }
        },
        body(repositoryId: string, column: Column, graph: BranchGraph, worktreePath?: string, conflictControls?: RemixNode): RemixNode {
            let state = stateFor(repositoryId, column, graph, worktreePath)
            let stack: BranchGraphBranchNode[] = []
            let branch = column.kind == "branch" ? column : undefined
            while (branch && !stack.some(item => item.id == branch!.id)) {
                stack.push(branch)
                let last = stack.at(-1)!
                let selection = state.baseSelections.get(last.id)
                let nextId = last.base.status == "known"
                    ? last.base.branchId
                    : last.base.candidates.some(candidate => candidate.branchId == selection)
                    ? selection
                    : undefined
                branch = graph.branches.find(item => item.id == nextId)
            }

            return (
                <div class={`column-inspection ${state.filterOpen ? "filter-open" : ""}`} mix={[columnInspection, compositionStyles]}>
                    {conflictControls}
                    {state.filterOpen && (
                        <div class="inspection-filters" mix={inspectionFilters}>
                            <input
                                aria-label="Filter changed files"
                                placeholder="Filter files…"
                                value={state.filter}
                                mix={[
                                    filterChangedFilesInput,
                                    ref(element => {
                                        state.filterInput = element
                                    }),
                                    on("input", event => {
                                        state.filter = event.currentTarget.value
                                        filterChanged(state)
                                    }),
                                ]}
                            />
                            <select
                                aria-label="Filter change status"
                                value={state.status}
                                mix={[
                                    filterChangeStatusSelect,
                                    on("change", event => {
                                        state.status = event.currentTarget.value
                                        filterChanged(state)
                                    }),
                                ]}
                            >
                                {["all", "added", "modified", "deleted", "renamed", "copied", "type changed", "conflicted"].map(status => (
                                    <option value={status}>{status}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                aria-label="Close file filter"
                                title="Close and clear filter (Escape)"
                                mix={[filterToggleButton, on("click", () => closeFilter(state))]}
                            >
                                <Icon name="close" size={13} />
                            </button>
                        </div>
                    )}
                    {state.worktreePath && (
                        <section
                            class="working-changes"
                            mix={[workingChanges, composition.target(repositoryId, { kind: "working", worktreePath: state.worktreePath })]}
                        >
                            {composition.panel(repositoryId, { kind: "working", worktreePath: state.worktreePath })}
                            <CommitComposer
                                key={`${state.worktreePath}:${Boolean(options.recoveryBlocked?.(repositoryId))}`}
                                api={options.api}
                                repositoryId={state.repositoryId}
                                path={state.worktreePath}
                                blocked={options.recoveryBlocked?.(repositoryId)}
                                virtual={column.kind != "branch"}
                                unborn={column.kind == "virtual" && /^0+$/.test(column.objectId)}
                                busyChanged={options.localBusyChanged}
                                inventory={state.files.get("working")?.inventory}
                                openDiffColumn={() => showWorkingBreakout(state)}
                                stashes={column.kind == "branch" ? column.markers : []}
                                stashOpen={stash => state.files.get(stash.objectId)?.open ?? false}
                                toggleStash={stash => {
                                    let files = state.files.get(stash.objectId)
                                    if (files) {
                                        files.open = !files.open
                                        return void options.update()
                                    }
                                    // Untracked files live on the stash's third parent, so read them alongside tracked ones.
                                    void readFiles(state, stash.objectId, { kind: "commit", objectId: stash.objectId }).then(() => {
                                        let untracked = state.files.get(stash.objectId)?.inventory?.parents[2]
                                        if (untracked)
                                            return readFiles(state, untracked, { kind: "commit", objectId: untracked })
                                    })
                                }}
                                renderStash={stash => {
                                    let files = state.files.get(stash.objectId)
                                    let untracked = files?.inventory?.parents[2]
                                    let untrackedFiles = untracked ? state.files.get(untracked) : undefined
                                    let tracked = files?.inventory?.files.length

                                    return (
                                        <>
                                            {(tracked || !untrackedFiles?.inventory?.files.length) && fileList(state, stash.objectId, files)}
                                            {untrackedFiles && fileList(state, untracked!, untrackedFiles)}
                                        </>
                                    )
                                }}
                                showIgnored={state.showIgnored}
                                toggleIgnored={value => {
                                    state.showIgnored = value
                                    void readFiles(state, "working", { kind: "working", worktreePath: state.worktreePath! })
                                }}
                                renderFiles={(view, stage) => fileList(state, `working-${view}`, state.files.get(`working-${view}`), stage)}
                                changed={async (refreshGraph = true) => {
                                    await readFiles(state, "working", { kind: "working", worktreePath: state.worktreePath! }, true)
                                    if (refreshGraph)
                                        await options.localChanged?.(state.repositoryId)
                                }}
                            />
                            {state.files.get("working")?.error && <p role="alert">{state.files.get("working")?.error}</p>}
                            {state.showIgnored && (
                                <details>
                                    <summary>Ignored files · {state.files.get("working")?.inventory?.files.filter(file => file.ignored).length ?? 0}</summary>
                                    {state.files.get("working")?.inventory?.files.filter(file => file.ignored).map(file => (
                                        <div class="inspection-muted">{file.path}</div>
                                    ))}
                                </details>
                            )}
                        </section>
                    )}
                    {!state.worktreePath && column.kind == "branch" && column.markers.length > 0 && (
                        <section aria-label="Stashed Working Changes" mix={workingChanges}>
                            <h3 mix={workingChangesH3}>Stashed Working Changes</h3>
                            {column.markers.map(marker => {
                                let files = state.files.get(marker.objectId)
                                let untracked = files?.inventory?.parents[2]
                                return (
                                    <div>
                                        <button
                                            type="button"
                                            title={marker.tooltip}
                                            mix={on("click", () => readFiles(state, marker.objectId, { kind: "commit", objectId: marker.objectId }))}
                                        >
                                            {marker.label} · Show stashed files
                                        </button>
                                        {files && fileList(state, marker.objectId, files)}
                                        {untracked && (
                                            <>
                                                <button
                                                    type="button"
                                                    mix={on("click", () => readFiles(state, untracked, { kind: "commit", objectId: untracked }))}
                                                >
                                                    Show stashed untracked files
                                                </button>
                                                {state.files.has(untracked) && fileList(state, untracked, state.files.get(untracked))}
                                            </>
                                        )}
                                    </div>
                                )
                            })}
                        </section>
                    )}
                    <accordion.Context
                        type="multiple"
                        value={stack.filter(branch => state.history.get(branch.id)?.open).map(branch => branch.id)}
                        onValueChange={values => {
                            for (let branch of stack) {
                                if (branch.id != column.id && values.includes(branch.id) != (state.history.get(branch.id)?.open ?? false))
                                    toggleHistory(state, branch)
                            }
                        }}
                    >
                        <div class="stack-inspection" mix={accordion.root()}>
                            {stack.map((branch, branchIndex) => {
                                let current = state.history.get(branch.id)
                                let columnBranch = branch.id == column.id
                                return (
                                    <accordion.ItemContext key={branch.id} value={branch.id}>
                                        <section class={branch.published ? "stack-branch remote" : "stack-branch"} mix={[stackBranch, accordion.item()]}>
                                            {branchIndex > 0 && !stack[branchIndex - 1].remoteOnly
                                                && composition.seam(repositoryId, {
                                                    kind: "seam",
                                                    branch: stack[branchIndex - 1].preferredRef,
                                                    parentId: branch.tip,
                                                })}
                                            {columnBranch && !branch.remoteOnly && (
                                                <div
                                                    class="composition-branch-target"
                                                    mix={composition.target(repositoryId, { kind: "branch", branch: branch.preferredRef, tip: branch.tip })}
                                                >
                                                    {!branch.primary && composition.source({
                                                        repositoryId,
                                                        selectedRemote: graph.selectedRemote,
                                                        source: { kind: "branch", branch: branch.preferredRef, tip: branch.tip },
                                                        label: branch.name,
                                                    })}
                                                    <Icon name="branch" size={14} />
                                                    {options.renameBranch && branch.localRefs.length > 0
                                                        ? (
                                                            <EditableName
                                                                name={branch.name}
                                                                label={`branch ${branch.name}`}
                                                                commit={name => options.renameBranch!(repositoryId, branch.name, name)}
                                                            />
                                                        )
                                                        : branch.name}
                                                </div>
                                            )}
                                            {/* Remote-only branches can't receive transfers, but still get a heading. */}
                                            {columnBranch && branch.remoteOnly && (
                                                <div class="composition-branch-target">
                                                    <Icon name="branch" size={14} />
                                                    {branch.name}
                                                </div>
                                            )}
                                            {composition.panel(repositoryId, { kind: "branch", branch: branch.preferredRef, tip: branch.tip })}
                                            {!columnBranch && (
                                                <h3
                                                    class="disclosure-heading composition-branch-heading"
                                                    mix={[
                                                        disclosureHeading,
                                                        composition.target(repositoryId, { kind: "branch", branch: branch.preferredRef, tip: branch.tip }),
                                                    ]}
                                                >
                                                    {!branch.remoteOnly && !branch.primary
                                                        && composition.source({
                                                            repositoryId,
                                                            selectedRemote: graph.selectedRemote,
                                                            source: { kind: "branch", branch: branch.preferredRef, tip: branch.tip },
                                                            label: branch.name,
                                                        })}
                                                    <button class="stack-heading" type="button" mix={[stackHeading, accordion.trigger()]}>
                                                        <span mix={stackHeadingName}>
                                                            <Icon name={current?.open ? "chevron-down" : "chevron-right"} size={12} />
                                                            <Icon name="branch" size={14} />
                                                            {branch.name}
                                                        </span>
                                                        <span mix={stackHeadingStatus}>
                                                            {branch.unresolved && (
                                                                <span
                                                                    class="stack-conflict-indicator"
                                                                    role="img"
                                                                    aria-label={`${branch.name} has unresolved conflicts`}
                                                                    title={branch.unresolved.recovery ?? "This branch is part of an unresolved stack"}
                                                                    mix={stackConflictIndicator}
                                                                >
                                                                    {conflictIcon()}
                                                                </span>
                                                            )}
                                                        </span>
                                                    </button>
                                                </h3>
                                            )}
                                            {!branch.remoteOnly
                                                && composition.seam(repositoryId, { kind: "seam", branch: branch.preferredRef, parentId: branch.tip })}
                                            <div hidden={!columnBranch && !current?.open} mix={columnBranch ? [] : accordion.content()}>
                                                {current?.open && (
                                                    <accordion.Context
                                                        type="multiple"
                                                        value={(current.page?.commits ?? []).filter(commit => state.files.get(commit.objectId)?.open).map(
                                                            commit => commit.objectId,
                                                        )}
                                                        onValueChange={values => {
                                                            for (let commit of current.page?.commits ?? []) {
                                                                let files = state.files.get(commit.objectId)
                                                                if (values.includes(commit.objectId) == (files?.open ?? false))
                                                                    continue
                                                                if (files) {
                                                                    files.open = values.includes(commit.objectId)
                                                                    if (!files.open)
                                                                        clearGroup(state, commit.objectId)
                                                                } else {
                                                                    void readFiles(state, commit.objectId, { kind: "commit", objectId: commit.objectId })
                                                                }
                                                            }
                                                            update()
                                                        }}
                                                    >
                                                        <div mix={[accordion.root(), inspectionProgressContainer]}>
                                                            {current.loading && (
                                                                <p class="inspection-progress" role="status" mix={inspectionProgress}>
                                                                    Reading commits…
                                                                </p>
                                                            )}
                                                            {current.error && (
                                                                <p role="alert">
                                                                    {current.error}
                                                                    <button type="button" mix={[stackBranchButton, on("click", () => history(state, branch))]}>
                                                                        Retry
                                                                    </button>
                                                                </p>
                                                            )}
                                                            {current.page?.commits.filter(commit => !state.conflictsOnly || commit.conflictId).map(commit => {
                                                                let files = state.files.get(commit.objectId)
                                                                let actions = commitActions(state, branch, commit)
                                                                return (
                                                                    <accordion.ItemContext key={commit.objectId} value={commit.objectId}>
                                                                        <div
                                                                            class="inspect-commit"
                                                                            data-expanded={files?.open ? "true" : "false"}
                                                                            data-remote={commit.remote ? "true" : "false"}
                                                                            mix={[inspectCommit, accordion.item()]}
                                                                        >
                                                                            <h4
                                                                                class="disclosure-heading"
                                                                                mix={[
                                                                                    disclosureHeading,
                                                                                    commitStickyHeading,
                                                                                    ref((element, signal) => {
                                                                                        let resize = new ResizeObserver(() => {
                                                                                            element.parentElement?.style.setProperty(
                                                                                                "--commit-heading-height",
                                                                                                `${element.getBoundingClientRect().height}px`,
                                                                                            )
                                                                                        })
                                                                                        resize.observe(element)
                                                                                        signal.addEventListener("abort", () => resize.disconnect())
                                                                                    }),
                                                                                    // Dropping near the row's top or bottom inserts beside the commit.
                                                                                    composition.target(repositoryId, {
                                                                                        kind: "commit",
                                                                                        objectId: commit.objectId,
                                                                                        branch: branch.preferredRef,
                                                                                    }, {
                                                                                        // Published history stays insertable; the engine reports the rewrite for confirmation.
                                                                                        above: !branch.remoteOnly
                                                                                            ? {
                                                                                                kind: "seam",
                                                                                                parentId: commit.objectId,
                                                                                                branch: branch.preferredRef,
                                                                                            }
                                                                                            : undefined,
                                                                                        below: !branch.remoteOnly && commit.parentIds[0]
                                                                                            ? {
                                                                                                kind: "seam",
                                                                                                parentId: commit.parentIds[0],
                                                                                                branch: branch.preferredRef,
                                                                                            }
                                                                                            : undefined,
                                                                                    }),
                                                                                ]}
                                                                            >
                                                                                {composition.source({
                                                                                    repositoryId,
                                                                                    selectedRemote: graph.selectedRemote,
                                                                                    // A single parent also tells composition which seams sit beside this commit.
                                                                                    source: {
                                                                                        kind: "commit",
                                                                                        objectId: commit.objectId,
                                                                                        branch: branch.preferredRef,
                                                                                        ...(files?.source.kind == "commit" && files.source.parentId
                                                                                            ? { parentId: files.source.parentId }
                                                                                            : commit.parentIds.length == 1
                                                                                            ? { parentId: commit.parentIds[0] }
                                                                                            : {}),
                                                                                    },
                                                                                    label: commit.subject,
                                                                                })}
                                                                                <button
                                                                                    class="commit-heading"
                                                                                    type="button"
                                                                                    title={commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject}
                                                                                    mix={[commitHeading, accordion.trigger()]}
                                                                                >
                                                                                    <span aria-hidden="true" mix={commitNode} />
                                                                                    <span class="commit-subject" mix={commitHeadingSpan}>
                                                                                        {commit.subject}
                                                                                    </span>
                                                                                    {commit.body && !files?.open && (
                                                                                        <span
                                                                                            class="commit-message-indicator"
                                                                                            role="img"
                                                                                            aria-label="Has message body"
                                                                                            mix={css({
                                                                                                display: "inline-flex",
                                                                                                flexShrink: 0,
                                                                                                color: "var(--faint)",
                                                                                                opacity: 0.65,
                                                                                            })}
                                                                                        >
                                                                                            <Icon name="more" size={10} />
                                                                                        </span>
                                                                                    )}
                                                                                </button>
                                                                                {commit.conflictId && (
                                                                                    <button
                                                                                        type="button"
                                                                                        title="Commit has conflicts · Resolve"
                                                                                        aria-label={`Resolve conflicts in ${commit.subject}`}
                                                                                        mix={[
                                                                                            conflictIndicator,
                                                                                            on("click", () => {
                                                                                                if (files)
                                                                                                    files.open = true
                                                                                                else {
                                                                                                    void readFiles(state, commit.objectId, {
                                                                                                        kind: "commit",
                                                                                                        objectId: commit.objectId,
                                                                                                    })
                                                                                                }
                                                                                                update()
                                                                                            }),
                                                                                        ]}
                                                                                    >
                                                                                        {conflictIcon()}
                                                                                    </button>
                                                                                )}
                                                                                {files?.open && (
                                                                                    <button
                                                                                        type="button"
                                                                                        aria-label={`Show full diff for commit ${commit.subject}`}
                                                                                        title="Show full commit diff"
                                                                                        mix={[
                                                                                            commitToolButton,
                                                                                            on("click", () =>
                                                                                                void showBreakout(
                                                                                                    state,
                                                                                                    commit.objectId,
                                                                                                    undefined,
                                                                                                    commit.subject,
                                                                                                )),
                                                                                        ]}
                                                                                    >
                                                                                        <Icon name="diff" size={14} />
                                                                                    </button>
                                                                                )}
                                                                                {files?.open && actions.length > 0 && (
                                                                                    <OverflowMenu
                                                                                        label={`More actions for commit ${commit.subject}`}
                                                                                        title="More actions"
                                                                                        trigger={commitToolButton}
                                                                                        actions={actions}
                                                                                    />
                                                                                )}
                                                                            </h4>
                                                                            {state.reword == commit.objectId && (
                                                                                <RewordForm
                                                                                    key={commit.objectId}
                                                                                    api={options.api}
                                                                                    repositoryId={repositoryId}
                                                                                    branch={branch.preferredRef}
                                                                                    commit={commit}
                                                                                    selectedRemote={graph.selectedRemote}
                                                                                    notify={options.notify}
                                                                                    busyChanged={options.localBusyChanged}
                                                                                    changed={() => mutated(repositoryId)}
                                                                                    close={() => {
                                                                                        state.reword = undefined
                                                                                        update()
                                                                                    }}
                                                                                />
                                                                            )}
                                                                            {composition.panel(repositoryId, {
                                                                                kind: "commit",
                                                                                objectId: commit.objectId,
                                                                                branch: branch.preferredRef,
                                                                            })}
                                                                            <div hidden={!files?.open} mix={accordion.content()}>
                                                                                {files?.open && (
                                                                                    <>
                                                                                        {commit.body && <CommitMessage body={commit.body} />}
                                                                                        {commit.parentIds.length > 1 && (
                                                                                            <label class="merge-parent" mix={mergeParent}>
                                                                                                Compare parent<select
                                                                                                    aria-label={`Parent for ${commit.subject}`}
                                                                                                    value={files.inventory?.source.kind == "commit"
                                                                                                        ? files.inventory.source.parentId
                                                                                                        : commit.parentIds[0]}
                                                                                                    mix={[
                                                                                                        parentForSelect,
                                                                                                        on("change", event => {
                                                                                                            clearGroup(state, commit.objectId)
                                                                                                            void readFiles(state, commit.objectId, {
                                                                                                                kind: "commit",
                                                                                                                objectId: commit.objectId,
                                                                                                                parentId: event.currentTarget.value,
                                                                                                            })
                                                                                                        }),
                                                                                                    ]}
                                                                                                >
                                                                                                    {commit.parentIds.map((parent, index) => (
                                                                                                        <option value={parent}>
                                                                                                            Parent {index + 1} · {parent.slice(0, 8)}
                                                                                                        </option>
                                                                                                    ))}
                                                                                                </select>
                                                                                            </label>
                                                                                        )}
                                                                                        {commit.conflictId
                                                                                            ? (
                                                                                                <ConflictResolution
                                                                                                    key={commit.conflictId}
                                                                                                    api={options.api}
                                                                                                    repository={state.repositoryId}
                                                                                                    subject={commit.conflictId}
                                                                                                    path={state.worktreePath}
                                                                                                    changed={async () => {
                                                                                                        await options.localChanged?.(state.repositoryId)
                                                                                                    }}
                                                                                                    renderFiles={(conflicts, renderFile) =>
                                                                                                        fileList(
                                                                                                            state,
                                                                                                            commit.objectId,
                                                                                                            files,
                                                                                                            undefined,
                                                                                                            { files: conflicts, renderFile },
                                                                                                        )}
                                                                                                />
                                                                                            )
                                                                                            : fileList(state, commit.objectId, files)}
                                                                                    </>
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                        {!branch.remoteOnly && commit.parentIds[0]
                                                                            && !(branch.base.status == "known" && branch.base.tip == commit.parentIds[0]
                                                                                && branchIndex + 1 < stack.length)
                                                                            && composition.seam(repositoryId, {
                                                                                kind: "seam",
                                                                                parentId: commit.parentIds[0],
                                                                                branch: branch.preferredRef,
                                                                            })}
                                                                    </accordion.ItemContext>
                                                                )
                                                            })}
                                                            {current.page?.nextOffset != undefined && (
                                                                <button
                                                                    type="button"
                                                                    disabled={current.loading}
                                                                    mix={[stackBranchButton, on("click", () => history(state, branch, true))]}
                                                                >
                                                                    Load more
                                                                </button>
                                                            )}
                                                            {current.page && current.page.nextOffset == undefined && branch.base.status == "ambiguous" && (
                                                                <label class="base-continuation" mix={mergeParent}>
                                                                    Continue with<select
                                                                        aria-label={`Branch after ${branch.name}`}
                                                                        value={state.baseSelections.get(branch.id) ?? ""}
                                                                        mix={[
                                                                            parentForSelect,
                                                                            on("change", event => {
                                                                                let selection = event.currentTarget.value
                                                                                if (selection)
                                                                                    state.baseSelections.set(branch.id, selection)
                                                                                else
                                                                                    state.baseSelections.delete(branch.id)
                                                                                update()
                                                                            }),
                                                                        ]}
                                                                    >
                                                                        <option value="">Choose branch…</option>
                                                                        {branch.base.candidates.map(candidate => (
                                                                            <option value={candidate.branchId}>{candidate.name}</option>
                                                                        ))}
                                                                    </select>
                                                                </label>
                                                            )}
                                                        </div>
                                                    </accordion.Context>
                                                )}
                                            </div>
                                        </section>
                                    </accordion.ItemContext>
                                )
                            })}
                        </div>
                    </accordion.Context>
                    {state.wholeFiles.size > 0 && (
                        <div class="selection-summary" mix={selectionSummary}>
                            {state.wholeFiles.size} files selected<button
                                type="button"
                                mix={[
                                    bodySelectionSummaryButton,
                                    on("click", () => {
                                        state.wholeFiles.clear()
                                        update()
                                    }),
                                ]}
                            >
                                Clear files
                            </button>
                        </div>
                    )}
                </div>
            )
        },
        refreshComparisons(repositoryId: string, graph: BranchGraph) {
            comparisons.refresh(repositoryId, graph)
            histories.refresh(repositoryId)
            return [...columns.values()].filter(state =>
                state.repositoryId == repositoryId && state.unavailable
                && graph.branches.some(branch => branch.id == state.id)
            ).map(state => state.id)
        },
        unavailableComparisonSources(repositoryId: string, graph: BranchGraph) {
            return [...columns.values()].filter(state =>
                state.repositoryId == repositoryId
                && ![...graph.branches, ...graph.virtualBranches].some(branch => branch.id == state.id)
                && auxiliary.descendants(key(repositoryId, state.id)).some(column => column.value.kind == "comparison" || column.value.kind == "history")
            ).map(state => state.id)
        },
        openComparison(
            repositoryId: string,
            from: BranchGraphBranchNode,
            to: BranchGraphBranchNode,
            graph: BranchGraph,
            replaceId?: string,
            worktreePath?: string,
        ) {
            stateFor(repositoryId, from, graph, worktreePath)
            let sourceId = key(repositoryId, from.id)
            let column = auxiliary.open(sourceId, JSON.stringify(["comparison", from.preferredRef, to.preferredRef]), () => {
                let value = comparisons.create(repositoryId, from, to, graph)
                return { value, dispose: () => comparisons.dispose(value) }
            })
            if (replaceId && replaceId != column.id)
                auxiliary.close(replaceId)
            auxiliary.focusedId = column.id
            void options.update().then(signal => {
                if (!signal.aborted)
                    document.querySelector<HTMLElement>(`[data-auxiliary-id="${column.id}"]`)?.focus()
            })
        },
        breakout(repositoryId: string, columnId: string): RemixNode {
            let state = columns.get(key(repositoryId, columnId))
            if (!state)
                return null
            return auxiliary.descendants(key(repositoryId, columnId)).map(auxiliaryColumn => {
                if (auxiliaryColumn.value.kind == "trail-commit") {
                    let commit = auxiliaryColumn.value
                    let host = historyHosts.get(commit)!
                    host.graph = state.graph
                    return trailCommits.render(commit, auxiliaryColumn.id, auxiliaryColumn.sourceId, {
                        close() {
                            auxiliary.close(auxiliaryColumn.id)
                            update()
                        },
                        files() {
                            return fileList(host, commit.entry.objectId, host.files.get(commit.entry.objectId), undefined, undefined, true)
                        },
                        parent(parentId) {
                            for (let child of auxiliary.descendants(auxiliaryColumn.id).filter(child => child.sourceId == auxiliaryColumn.id))
                                auxiliary.close(child.id)
                            clearGroup(host, commit.entry.objectId)
                            host.wholeFiles.clear()
                            void readFiles(host, commit.entry.objectId, { kind: "commit", objectId: commit.entry.objectId, parentId })
                        },
                        open(source, path) {
                            openHistory(host, auxiliaryColumn.id, source, path)
                        },
                    })
                }
                if (auxiliaryColumn.value.kind == "history") {
                    let history = auxiliaryColumn.value
                    let host = historyHosts.get(history)!
                    host.composable = new Set(history.error ? [] : history.page?.entries.filter(entry => entry.composable).map(entry => entry.objectId))
                    host.graph = state.graph
                    return histories.render(history, auxiliaryColumn.id, auxiliaryColumn.sourceId, {
                        commit(entry) {
                            openTrailCommit(host, auxiliaryColumn.id, entry)
                        },
                        close() {
                            auxiliary.close(auxiliaryColumn.id)
                            update()
                        },
                        open(source, path) {
                            openHistory(host, auxiliaryColumn.id, source, path)
                        },
                        toggle(entry) {
                            let group = entry?.objectId ?? "working"
                            if (history.expanded.has(group)) {
                                history.expanded.delete(group)
                                clearGroup(host, group)
                            } else {
                                history.expanded.add(group)
                                let source: DiffSource = entry
                                    ? { kind: "commit", objectId: entry.objectId, parentId: entry.followedParent }
                                    : { kind: "working", worktreePath: host.worktreePath! }
                                void readFiles(host, group, source).then(() => {
                                    if (!entry || !host.alive || !history.expanded.has(group))
                                        return
                                    let file = host.files.get(group)?.inventory?.files.find(file => file.path == entry.path)
                                    if (file && !host.diffs.has(diffKey(group, file.path)))
                                        choose(host, group, file)
                                })
                            }
                            update()
                        },
                        files(entry) {
                            let group = entry?.objectId ?? "working"
                            let files = host.files.get(group)
                            if (entry) {
                                let diff = host.diffs.get(diffKey(group, entry.path))
                                return diff ? renderDiff(host, diff) : files?.error
                                    ? <p role="alert">{files.error}</p>
                                    : files?.loading
                                    ? <p role="status">Reading diff…</p>
                                    : null
                            }

                            return fileList(
                                host,
                                group,
                                files?.inventory
                                    ? {
                                        ...files,
                                        inventory: {
                                            ...files.inventory,
                                            files: files.inventory.files.filter(file => file.path == history.path),
                                        },
                                    }
                                    : files,
                            )
                        },
                        controls(entry) {
                            let diff = host.diffs.get(diffKey(entry.objectId, entry.path))
                            return diff ? renderDiffControls(host, diff) : null
                        },
                        selection(entry) {
                            let inventory = host.files.get(entry.objectId)?.inventory
                            if (!inventory || !selectable(host, entry.objectId))
                                return undefined
                            let id = `${entry.objectId}:${entry.path}`

                            return {
                                checked: host.wholeFiles.has(id),
                                check() {
                                    if (host.wholeFiles.has(id))
                                        host.wholeFiles.delete(id)
                                    else
                                        host.wholeFiles.set(id, { source: inventory.source, path: entry.path, version: inventory.version })
                                    update()
                                },
                            }
                        },
                    })
                }
                if (auxiliaryColumn.value.kind == "comparison") {
                    let comparison = auxiliaryColumn.value
                    return comparisons.render(
                        comparison,
                        auxiliaryColumn.id,
                        columnId,
                        () => {
                            auxiliary.close(auxiliaryColumn.id)
                            void options.update().then(signal => {
                                if (!signal.aborted) {
                                    ;(Array.from(document.querySelectorAll<HTMLElement>(".branch-column"))
                                        .find(element => element.dataset.columnId == columnId) ?? document.querySelector<HTMLElement>(".graph-rows"))?.focus()
                                }
                            })
                        },
                        () => options.compareWith(repositoryId, comparison.fromRef, auxiliaryColumn.id, comparison.toRef),
                        (source, path) => openHistory(state, auxiliaryColumn.id, source, path),
                    )
                }
                let breakout = auxiliaryColumn.value
                let files = state.files.get(breakout.group)
                // Maximizing a diff column maximizes its source column, which keeps the diff column beside it.
                let maximized = options.maximized(repositoryId) == columnId

                return (
                    <aside
                        key={auxiliaryColumn.id}
                        class="inspection-breakout"
                        data-auxiliary-id={auxiliaryColumn.id}
                        data-source-column-id={columnId}
                        tabIndex={-1}
                        mix={inspectionBreakout}
                        aria-label={`${state.column.name} diff`}
                    >
                        <header
                            mix={[
                                inspectionBreakoutHeader,
                                // Like a branch column header; the header's own controls keep their double-clicks.
                                on("dblclick", event => {
                                    if (!(event.target instanceof Element && event.target.closest("button")))
                                        options.maximize(repositoryId, columnId)
                                }),
                            ]}
                        >
                            <span title={breakoutTitle(state, breakout)}>
                                {breakoutTitle(state, breakout)}
                                <small class="auxiliary-source">From {state.column.name}</small>
                            </span>
                            <button
                                type="button"
                                title="Expand all"
                                aria-label="Expand all"
                                mix={[
                                    closeDiffColumnButton,
                                    on("click", () => {
                                        breakout.collapsed.clear()
                                        update()
                                    }),
                                ]}
                            >
                                <Icon name="expand-all" size={15} />
                            </button>
                            <button
                                type="button"
                                title="Collapse all"
                                aria-label="Collapse all"
                                mix={[
                                    closeDiffColumnButton,
                                    on("click", () => {
                                        breakout.collapsed = new Set(files?.inventory?.files.filter(file => !file.ignored).map(file => file.path))
                                        breakout.scrolling = false
                                        update()
                                    }),
                                ]}
                            >
                                <Icon name="collapse-all" size={15} />
                            </button>
                            <button
                                type="button"
                                title={maximized ? "Restore columns" : "Maximize column"}
                                aria-label={maximized ? "Restore columns" : "Maximize column"}
                                mix={[closeDiffColumnButton, on("click", () => options.maximize(repositoryId, columnId))]}
                            >
                                <Icon name={maximized ? "restore" : "maximize"} size={15} />
                            </button>
                            <button
                                type="button"
                                aria-label="Close diff column"
                                mix={[
                                    closeDiffColumnButton,
                                    on("click", () => {
                                        closeBreakout(state)
                                        void options.update().then(signal => {
                                            if (!signal.aborted) {
                                                Array.from(document.querySelectorAll<HTMLElement>(".branch-column"))
                                                    .find(element => element.dataset.columnId == columnId)?.focus()
                                            }
                                        })
                                    }),
                                ]}
                            >
                                <Icon name="close" size={15} />
                            </button>
                        </header>
                        <div class="commit-diff">
                            {files?.error && <p role="alert" mix={changeFileListP}>{files.error}</p>}
                            {files?.loading && !files.inventory && <p role="status" mix={changeFileListP}>Reading changes…</p>}
                            {files?.inventory?.files.filter(file => !file.ignored).map(file => {
                                let diff = state.diffs.get(diffKey(breakout.group, file.path))
                                return diff
                                    ? (
                                        <div class="commit-diff-file" data-diff-path={file.path}>
                                            {renderDiff(state, diff)}
                                        </div>
                                    )
                                    : null
                            })}
                        </div>
                    </aside>
                )
            })
        },
    }

    function openTrailCommit(owner: ColumnState, sourceId: string, entry: FileHistoryEntry) {
        let node = auxiliary.open(sourceId, JSON.stringify(["trail-commit", entry.objectId, entry.followedParent]), () => {
            let value = trailCommits.create(owner.repositoryId, entry)
            let host: ColumnState = {
                ...owner,
                id: `trail:${crypto.randomUUID()}`,
                auxiliaryId: undefined,
                breakout: undefined,
                worktreePath: undefined,
                files: new Map(),
                diffs: new Map(),
                requestIds: new Set(),
                wholeFiles: new Map(),
                history: new Map(),
                transientLayout: "unified",
                filter: "",
                filterOpen: false,
                selectionRoot: owner.selectionRoot ?? owner,
                composable: new Set(entry.composable ? [entry.objectId] : []),
            }
            historyHosts.set(value, host)
            host.compositionKey = JSON.stringify(compositionFor(host))
            void readFiles(host, entry.objectId, { kind: "commit", objectId: entry.objectId, parentId: entry.followedParent })

            return {
                value,
                dispose() {
                    trailCommits.dispose(value)
                    host.alive = false
                    suspend(host)
                    historyHosts.delete(value)
                },
            }
        })
        if (node.value.kind == "trail-commit")
            historyHosts.get(node.value)!.auxiliaryId = node.id
        void options.update().then(signal => {
            if (!signal.aborted)
                document.querySelector<HTMLElement>(`[data-auxiliary-id="${node.id}"]`)?.focus()
        })
    }

    function resume(state: ColumnState) {
        if (state.unavailable)
            return

        for (let [group, files] of state.files) {
            if (files.open && !files.inventory)
                void readFiles(state, group, files.source)
        }
        for (let [id, current] of state.history) {
            let branch = state.graph.branches.find(branch => branch.id == id)
            if (branch && current.open && !current.page)
                void history(state, branch)
        }
        for (let diff of state.diffs.values()) {
            if (!diff.page)
                void readDiff(state, diff)
        }
    }

    function stateFor(repositoryId: string, column: Column, graph: BranchGraph, worktreePath?: string) {
        if (columnWorktree(column, worktreePath)?.missing)
            worktreePath = undefined
        let id = key(repositoryId, column.id)
        let state = columns.get(id)
        if (!state || state.worktreePath != worktreePath) {
            if (state)
                dispose(state)
            auxiliary.addRoot(id)
            state = {
                repositoryId,
                id: column.id,
                column,
                graph,
                worktreePath,
                files: new Map(),
                history: new Map(),
                baseSelections: new Map(),
                requestIds: new Set(),
                diffs: new Map(),
                showIgnored: false,
                filter: "",
                filterOpen: false,
                status: "all",
                wholeFiles: new Map(),
                alive: true,
                get breakout() {
                    let value = auxiliary.descendants(id).find(column => column.sourceId == id && column.value.kind == "diff")?.value
                    return value?.kind == "diff" ? value : undefined
                },
                set breakout(value: BreakoutState | undefined) {
                    let previous = auxiliary.descendants(id).find(column => column.sourceId == id && column.value.kind == "diff")
                    if (previous?.value == value)
                        return
                    if (previous)
                        auxiliary.close(previous.id)
                    if (value) {
                        auxiliary.open(id, value.group, () => ({
                            value,
                            dispose() {
                                for (let diffId of value.created) {
                                    let diff = created.diffs.get(diffId)
                                    if (diff)
                                        clearDiff(created, diff)
                                }
                            },
                        }), previous?.width)
                    }
                },
            }
            columns.set(id, state)
            let created = state
            if (column.kind == "branch") {
                queueMicrotask(() => {
                    if (created.alive)
                        void history(created, column)
                })
            }
            if (worktreePath) {
                queueMicrotask(() => {
                    if (created.alive)
                        void readFiles(created, "working", { kind: "working", worktreePath })
                })
            }
        }
        state.column = column
        state.graph = graph
        state.unavailable = false
        for (let [id, current] of state.history) {
            let branch = graph.branches.find(branch => branch.id == id)
            if (!branch || current.key == branchHistoryKey(state, branch))
                continue
            current.generation++
            current.key = branchHistoryKey(state, branch)
            current.page = undefined
            current.error = undefined
            current.loading = false
            let owner = state
            if (current.open) {
                queueMicrotask(() => {
                    if (owner.alive && owner.history.get(id) == current && current.key == branchHistoryKey(owner, branch))
                        void history(owner, branch)
                })
            }
        }

        return state
    }

    function toggleHistory(state: ColumnState, branch: BranchGraphBranchNode) {
        let current = state.history.get(branch.id)
        if (!current || current.key != branchHistoryKey(state, branch))
            void history(state, branch)
        else {
            current.open = !current.open
            if (!current.open) {
                for (let commit of current.page?.commits ?? [])
                    clearGroup(state, commit.objectId)
            }
            if (current.open && !current.page)
                void history(state, branch)
            update()
        }
    }

    function fileList(
        state: ColumnState,
        group: string,
        files: FileState | undefined,
        stage?: (paths: string[], unstage: boolean) => void,
        resolution?: { files: ChangedFile[]; renderFile(file: ChangedFile): RemixNode },
        diffColumn = false,
    ): RemixNode {
        if (!files)
            return null

        let inventory = files.inventory?.files ?? []
        let replacements = new Map(resolution?.files.map(file => [file.path, file]))
        let all = [
            ...inventory.map(file => replacements.has(file.path) ? { ...file, ...replacements.get(file.path) } : file),
            ...(resolution?.files.filter(file => !inventory.some(existing => existing.path == file.path)) ?? []),
        ]
        let visible = all.filter(file => !file.ignored && matchesFilter(state, file))
        let expanded = state.breakout
            ? new Set(state.breakout.group == group && state.breakout.focus ? [state.breakout.focus] : [])
            : new Set([...state.diffs.values()].filter(diff => diff.group == group).map(diff => diff.path))
        // Renamed files stage as their old and new paths together.
        let withOldPaths = (paths: string[]) =>
            paths.flatMap(path => {
                let file = all.find(candidate => candidate.path == path)
                return file?.oldPath ? [file.oldPath, path] : [path]
            })
        let staging = stage && files.source.kind == "working"
            ? composition.staging({
                repositoryId: state.repositoryId,
                worktreePath: files.source.worktreePath,
                view: group == "working-staged" ? "staged" : "unstaged",
                apply: paths => stage(withOldPaths(paths), group != "working-staged"),
            })
            : undefined

        return (
            <section
                class="change-file-list"
                aria-label={group == "working-staged" ? "Staged files" : group.startsWith("working") ? "Working Changes files" : "Commit files"}
                mix={[changeFileList, staging]}
            >
                {staging && group == "working-staged" && !visible.length && (
                    <p class="staging-hint" mix={stagingHint}>
                        Drop files here to stage them
                    </p>
                )}
                {!!resolution?.files.length && (
                    <button
                        type="button"
                        mix={[
                            changeFileListButton,
                            on("click", () => {
                                state.selectingConflicts = !state.selectingConflicts
                                update()
                            }),
                        ]}
                    >
                        {state.selectingConflicts ? "Back to conflict resolution" : "Select changes outside conflicted lines"}
                    </button>
                )}
                {files.error && (
                    <p role="alert" mix={changeFileListP}>
                        {files.error}{" "}
                        <button type="button" mix={[changeFileListButton, on("click", () => readFiles(state, group, files.source))]}>
                            Retry
                        </button>
                    </p>
                )}
                {files.inventory && !group.startsWith("working-") && !all.some(file => !file.ignored) && (
                    <p class="inspection-muted" mix={inspectionMuted}>
                        {group == "working" ? "No Working Changes" : "No changes against this parent"}
                    </p>
                )}
                <FileTree
                    renderFile={state.selectingConflicts ? undefined : resolution?.renderFile}
                    hideStagedBadge={group.startsWith("working-")}
                    actions={file => [{
                        label: "File history",
                        run: () =>
                            openHistory(
                                state,
                                state.auxiliaryId ?? key(state.repositoryId, state.id),
                                files.source.kind == "working"
                                    ? { kind: "worktree", worktreePath: files.source.worktreePath }
                                    : files.source.kind == "commit"
                                    ? { kind: "commit", objectId: files.source.objectId }
                                    : { kind: "branch", ref: state.column.kind == "branch" ? state.column.preferredRef : "" },
                                file.path,
                            ),
                    }]}
                    flat
                    filter={state.filter}
                    files={visible}
                    expanded={expanded}
                    leading={file => fileTransfer(state, group, file)}
                    controls={file => {
                        let diff = state.diffs.get(diffKey(group, file.path))
                        return diff && !state.breakout ? renderDiffControls(state, diff, diffColumn) : null
                    }}
                    diff={file => {
                        let diff = state.diffs.get(diffKey(group, file.path))
                        return diff && !state.breakout ? renderDiff(state, diff) : null
                    }}
                    checked={new Set(state.wholeFiles.keys())}
                    prefix={group}
                    choose={file => choose(state, group, file)}
                    hide={path => {
                        clearGroup(state, group, path)
                        update()
                    }}
                    check={selectable(state, group)
                        ? file => {
                            let id = `${group}:${file.path}`
                            if (state.wholeFiles.has(id))
                                state.wholeFiles.delete(id)
                            else if (files.inventory) {
                                for (let id of state.wholeFiles.keys()) {
                                    if (!id.startsWith(group + ":"))
                                        state.wholeFiles.delete(id)
                                }
                                state.wholeFiles.set(id, { source: files.inventory.source, path: file.path, version: files.inventory.version })
                            }
                            update()
                        }
                        : undefined}
                />
                {state.auxiliaryId && state.wholeFiles.size > 0 && (
                    <p role="status">
                        {state.wholeFiles.size} files selected
                        <button
                            type="button"
                            mix={on("click", () => {
                                state.wholeFiles.clear()
                                update()
                            })}
                        >
                            Clear files
                        </button>
                    </p>
                )}
                {group == "working" && state.showIgnored && (
                    <details>
                        <summary>Ignored files · {all.filter(file => file.ignored).length}</summary>
                        {all.filter(file => file.ignored).map(file => (
                            <div class="inspection-muted" mix={inspectionMuted}>
                                {file.path}
                            </div>
                        ))}
                    </details>
                )}
            </section>
        )
    }

    function fileTransfer(state: ColumnState, group: string, file: ChangedFile) {
        let inventory = state.files.get(group)?.inventory
        let source = inventory && transferSource(state, inventory.source)
        if (!source || !inventory)
            return null
        let chosen = state.wholeFiles.has(`${group}:${file.path}`)
            ? [...state.wholeFiles].filter(([id]) => id.startsWith(group + ":")).map(([, f]) => ({ path: f.path }))
            : [{ path: file.path }]

        return composition.source({
            repositoryId: state.repositoryId,
            selectedRemote: state.graph.selectedRemote,
            source,
            files: chosen,
            inventoryVersion: inventory.version,
            view: group == "working-staged" ? "staged" : group == "working-unstaged" ? "unstaged" : "combined",
            label: chosen.length > 1 ? `${chosen.length} files` : file.path,
        })
    }

    function clearGroup(state: ColumnState, group: string, prefix = "") {
        for (let diff of state.diffs.values()) {
            if (diff.group == group && diff.path.startsWith(prefix))
                clearDiff(state, diff)
        }
        if (state.breakout?.group == group)
            state.breakout = undefined
    }

    function choose(state: ColumnState, group: string, file: ChangedFile) {
        // With a diff column open, choosing a file shows its group there and scrolls to it, keeping focus in this column.
        if (state.breakout) {
            void showBreakout(state, group, file.path, undefined, false)
            return
        }
        let selected = state.diffs.get(diffKey(group, file.path))
        if (selected) {
            clearDiff(state, selected)
            update()
            return
        }
        let diff = createDiff(state, group, file.path)
        if (diff.page)
            update()
        else
            void readDiff(state, diff)
    }

    function renderDiff(state: ColumnState, diff: FileDiffState): RemixNode {
        let page = diff.page
        let breakout = state.breakout?.group == diff.group ? state.breakout : undefined
        let collapsed = breakout?.collapsed.has(diff.path) ?? false

        return (
            <section class="diff-inspector" aria-label={`Diff for ${diff.path}`} mix={diffInspector}>
                {breakout && (
                    <header class="diff-toolbar" mix={diffToolbar}>
                        <FileMenu
                            class="diff-file-menu"
                            actions={page
                                ? [{
                                    label: "File history",
                                    run: () => {
                                        let sourceId = auxiliary.descendants(key(state.repositoryId, state.id)).find(node => node.value == state.breakout)?.id
                                            ?? key(state.repositoryId, state.id)
                                        if (page.source.kind == "working")
                                            openHistory(state, sourceId, { kind: "worktree", worktreePath: page.source.worktreePath }, diff.path)
                                        else if (page.source.kind == "commit")
                                            openHistory(state, sourceId, { kind: "commit", objectId: page.source.objectId }, diff.path)
                                    },
                                }]
                                : []}
                        >
                            <button
                                type="button"
                                title={diff.path}
                                aria-label={`${collapsed ? "Expand" : "Collapse"} ${diff.path}`}
                                aria-expanded={!collapsed}
                                mix={[
                                    diffFileToggle,
                                    on("click", () => {
                                        if (collapsed)
                                            breakout.collapsed.delete(diff.path)
                                        else
                                            breakout.collapsed.add(diff.path)
                                        breakout.scrolling = false
                                        update()
                                    }),
                                ]}
                            >
                                <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
                                <strong mix={diffToolbarStrong}>{fileLabel(diff.path)}</strong>
                            </button>
                        </FileMenu>
                        {renderDiffControls(state, diff, true)}
                    </header>
                )}
                {!collapsed && renderDiffContents(state, diff)}
            </section>
        )
    }

    function openHistory(owner: ColumnState, sourceId: string, source: FileHistorySource, path: string) {
        let node = auxiliary.open(sourceId, JSON.stringify(["history", source, path]), () => {
            let value = histories.create(owner.repositoryId, source, path)
            let host: ColumnState = {
                ...owner,
                id: `history:${crypto.randomUUID()}`,
                auxiliaryId: undefined,
                breakout: undefined,
                worktreePath: source.kind == "worktree" ? source.worktreePath : undefined,
                files: new Map(),
                diffs: new Map(),
                requestIds: new Set(),
                wholeFiles: new Map(),
                history: new Map(),
                filter: "",
                filterOpen: false,
                transientLayout: "unified",
                selectionRoot: owner.selectionRoot ?? owner,
                composable: new Set(),
            }
            historyHosts.set(value, host)
            host.compositionKey = JSON.stringify(compositionFor(host))

            return {
                value,
                dispose() {
                    histories.dispose(value)
                    host.alive = false
                    suspend(host)
                    historyHosts.delete(value)
                },
            }
        })
        if (node.value.kind == "history")
            historyHosts.get(node.value)!.auxiliaryId = node.id
        void options.update().then(signal => {
            if (!signal.aborted)
                document.querySelector<HTMLElement>(`[data-auxiliary-id="${node.id}"]`)?.focus()
        })
    }

    function dispose(state: ColumnState) {
        state.alive = false
        auxiliary.close(key(state.repositoryId, state.id))
        suspend(state)
    }

    function suspend(state: ColumnState) {
        for (let diff of state.diffs.values()) {
            diff.selection = undefined
            diff.generation++
            diff.loading = false
            diff.refreshing = false
        }
        for (let file of state.files.values()) {
            file.generation++
            file.loading = false
            file.refreshing = false
        }
        for (let item of state.history.values()) {
            item.generation++
            item.loading = false
        }
        for (let id of state.requestIds)
            cancel(state, id)
    }

    function renderDiffControls(state: ColumnState, diff: FileDiffState, diffColumn = false): RemixNode {
        return (
            <DiffControls
                layout={state.transientLayout ?? options.layout(state.repositoryId, state.id)}
                showWhitespace={diff.showWhitespace}
                showEntireFiles={state.showEntireFiles ?? false}
                toggleEntireFiles={diffColumn
                    ? () => {
                        state.showEntireFiles = !state.showEntireFiles
                        for (let open of state.diffs.values()) {
                            open.notice = open.selection ? "Diff view changed. Change Selection cleared." : undefined
                            open.selection = undefined
                            open.page = undefined
                            void readDiff(state, open)
                        }
                        update()
                    }
                    : undefined}
                setLayout={layout => {
                    if (state.auxiliaryId) {
                        state.transientLayout = layout
                        update()
                    } else {
                        options.saveLayout(state.repositoryId, state.id, layout)
                    }
                }}
                toggleWhitespace={() => {
                    diff.showWhitespace = !diff.showWhitespace
                    update()
                }}
                breakout={!state.breakout && !state.auxiliaryId
                    ? () => void showBreakout(state, diff.group, diff.path)
                    : undefined}
            />
        )
    }

    /**
     * Shows one group's whole diff in the column's diff column, scrolled to `path` when given.
     * Opening it moves focus there; choosing files from the source column leaves focus where it is.
     */
    async function showBreakout(state: ColumnState, group: string, path?: string, subject?: string, focus = true) {
        let current = state.breakout
        if (current?.group == group) {
            current.focus = path
            if (path)
                current.collapsed.delete(path)
            if (focus)
                focusBreakout(state)
            scrollBreakout(state, current)
            return
        }
        closeBreakout(state)
        let breakout: BreakoutState = {
            kind: "diff",
            group,
            subject: subject ?? commitSubject(state, group),
            created: new Set(),
            collapsed: new Set(),
            focus: path,
        }
        state.breakout = breakout
        if (focus)
            focusBreakout(state)
        if (!state.files.get(group)?.inventory && !group.startsWith("working"))
            await readFiles(state, group, { kind: "commit", objectId: group }, false, false)
        if (!state.alive || state.breakout != breakout)
            return
        populateBreakout(state, breakout)
        update()
        scrollBreakout(state, breakout)
    }

    function showWorkingBreakout(state: ColumnState) {
        if (state.breakout?.group.startsWith("working")) {
            focusBreakout(state)
            return
        }
        let selected = [...state.diffs.values()].findLast(diff => diff.group.startsWith("working"))
        let group = selected?.group ?? (state.files.get("working-staged")?.inventory?.files.some(file => !file.ignored) ? "working-staged" : "working-unstaged")
        let path = selected?.path ?? state.files.get(group)?.inventory?.files.find(file => !file.ignored)?.path
        if (path)
            void showBreakout(state, group, path)
    }

    /**
     * Reads a group's changed files. With `refreshDiff`, an inventory already on screen is re-read quietly: nothing
     * renders unless the result differs, and only then are the group's open diffs re-read, quietly too.
     */
    async function readFiles(state: ColumnState, group: string, source: DiffSource, refreshDiff = false, open = true) {
        let files = state.files.get(group)
        if (!files) {
            files = { source, loading: false, open, generation: 0 }
            state.files.set(group, files)
        }

        let sameRequest = JSON.stringify(files.source) == JSON.stringify(source) && files.includeIgnored == state.showIgnored
        if (!state.alive || (files.loading || files.refreshing) && sameRequest)
            return

        let quiet = refreshDiff && sameRequest && !!files.inventory
        let changed = !quiet
        files.source = source
        files.includeIgnored = state.showIgnored
        if (quiet)
            files.refreshing = true
        else {
            files.loading = true
            files.error = undefined
            update()
        }
        let generation = ++files.generation

        try {
            let result = await options.api.readChanges(state.repositoryId, requestId(state, `files:${group}`), { source, includeIgnored: state.showIgnored })

            if (!state.alive || generation != files.generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)

            let previous = files.inventory?.version
            if (quiet && previous == result.inventory.version && !files.error)
                return

            changed = true
            files.error = undefined
            files.inventory = result.inventory
            files.source = result.inventory.source
            if (group == "working") {
                for (let view of ["staged", "unstaged"] as const) {
                    state.files.set(`working-${view}`, {
                        ...files,
                        inventory: {
                            ...result.inventory,
                            files: result.inventory.files.filter(file => view == "staged" ? file.staged : file.unstaged || file.untracked),
                        },
                    })
                }
            }
            if (state.breakout && (state.breakout.group == group || group == "working" && state.breakout.group.startsWith("working-")))
                populateBreakout(state, state.breakout)

            if (previous && previous != result.inventory.version) {
                for (let id of state.wholeFiles.keys()) {
                    if (id.startsWith(`${group}:`))
                        state.wholeFiles.delete(id)
                }
            }

            for (let diff of state.diffs.values()) {
                if (diff.group != group && !(group == "working" && diff.group.startsWith("working-")))
                    continue
                if (!result.inventory.files.some(file => file.path == diff.path && !file.ignored))
                    clearDiff(state, diff)
                else if (refreshDiff)
                    void readDiff(state, diff, false, true)
            }
        } catch (error) {
            if (state.alive && generation == files.generation) {
                changed = true
                files.error = message(error)
                for (let diff of state.diffs.values()) {
                    if (diff.group == group) {
                        diff.selection = undefined
                        diff.page = undefined
                    }
                }
            }
        } finally {
            if (generation == files.generation) {
                files.loading = false
                files.refreshing = false
                if (changed)
                    update()
            }
        }
    }

    function closeBreakout(state: ColumnState) {
        state.breakout = undefined
    }

    function focusBreakout(state: ColumnState) {
        let column = state.breakout && breakoutColumn(state, state.breakout)
        if (!column)
            return
        auxiliary.focusedId = column.id
        void options.update().then(signal => {
            if (signal.aborted || auxiliary.focusedId != column.id)
                return

            let element = document.querySelector<HTMLElement>(`[data-auxiliary-id="${column.id}"]`)
            element?.focus({ preventScroll: true })
            element?.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" })
        })
    }

    function commitSubject(state: ColumnState, objectId: string) {
        for (let history of state.history.values()) {
            let commit = history.page?.commits.find(commit => commit.objectId == objectId)
            if (commit)
                return commit.subject
        }
        return undefined
    }

    function populateBreakout(state: ColumnState, breakout: BreakoutState) {
        if (!state.alive || state.breakout != breakout)
            return
        let files = state.files.get(breakout.group)
        for (let file of files?.inventory?.files ?? []) {
            if (file.ignored)
                continue
            let id = diffKey(breakout.group, file.path)
            let diff = state.diffs.get(id)
            if (!diff) {
                diff = createDiff(state, breakout.group, file.path)
                breakout.created.add(id)
            }
            if (!diff.page && !diff.loading)
                void readDiff(state, diff)
        }
    }

    function createDiff(state: ColumnState, group: string, path: string) {
        let files = state.files.get(group)
        let diff = diffSession(state).create(group, path, {
            source: files?.source,
            inventoryVersion: files?.inventory?.version,
            entireFile: state.showEntireFiles,
            unavailable: !!files?.error,
        })
        state.diffs.set(diffKey(group, path), diff)

        return diff
    }

    async function history(state: ColumnState, branch: BranchGraphBranchNode, more = false) {
        let baseTips = branch.base.status == "known" ? [branch.base.tip] : branch.base.candidates.map(candidate => candidate.tip)
        let historyKey = branchHistoryKey(state, branch)
        let current = state.history.get(branch.id)
        if (!current || current.key != historyKey) {
            current = { key: historyKey, loading: false, open: true, generation: 0 }
            state.history.set(branch.id, current)
        }
        if (current.loading)
            return
        current.loading = true
        current.error = undefined
        update()
        let generation = ++current.generation

        try {
            let result = await options.api.readBranchHistory(state.repositoryId, {
                requestId: requestId(state, `history:${branch.id}`),
                branchRef: branch.preferredRef,
                tip: branch.tip,
                baseTips,
                remoteTips: state.graph.remoteTips,
                limit: 50,
                ...(more ? { offset: current.page?.nextOffset } : {}),
            })
            if (!state.alive || state.history.get(branch.id) != current || current.generation != generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            current.page = more && current.page ? { ...result.page, commits: [...current.page.commits, ...result.page.commits] } : result.page
        } catch (error) {
            if (generation == current.generation)
                current.error = message(error)
        } finally {
            if (generation == current.generation) {
                current.loading = false
                update()
                if (state.alive && state.conflictsOnly && !current.error && current.page?.nextOffset != undefined)
                    void history(state, branch, true)
            }
        }
    }

    /** Drops selections that a history rewrite made stale, then re-reads the graph and every open worktree. */
    async function mutated(repositoryId: string) {
        for (let state of [...columns.values(), ...historyHosts.values()]) {
            if (state.repositoryId == repositoryId) {
                state.wholeFiles.clear()
                for (let diff of state.diffs.values())
                    diff.selection = undefined
            }
        }
        await options.localChanged?.(repositoryId)
        refresh()
    }

    /** A commit's overflow actions. Only a local branch's history can be reworded, and merge commits are not editable. */
    function commitActions(state: ColumnState, branch: BranchGraphBranchNode, commit: BranchHistoryCommit): OverflowAction[] {
        let actions: OverflowAction[] = []
        if (!branch.remoteOnly && commit.parentIds.length == 1) {
            actions.push({
                icon: "pencil",
                label: "Reword commit…",
                run: () => {
                    state.reword = commit.objectId
                    update()
                },
            })
        }
        if (options.createBranchAt)
            actions.push({ icon: "branch", label: "Create branch here…", run: () => options.createBranchAt?.(state.repositoryId, commit.objectId) })
        return actions
    }

    // Any remote branch can publish this branch's commits, so moving any of them refreshes its history.
    function branchHistoryKey(state: ColumnState, branch: BranchGraphBranchNode) {
        let baseTips = branch.base.status == "known" ? [branch.base.tip] : branch.base.candidates.map(candidate => candidate.tip)
        return JSON.stringify([branch.tip, baseTips, state.graph.remoteTips, branch.unresolved])
    }

    function renderDiffContents(state: ColumnState, diff: FileDiffState): RemixNode {
        let page = diff.page

        return (
            <InspectionDiffContents
                diff={diff}
                eligible={selectable(state, diff.group)}
                layout={state.transientLayout ?? options.layout(state.repositoryId, state.id)}
                selectionControl={page && diff.selection && transferSource(state, page.source) && composition.source({
                    repositoryId: state.repositoryId,
                    selectedRemote: state.graph.selectedRemote,
                    source: transferSource(state, page.source)!,
                    files: [{ path: diff.path, version: page.version, entireFile: page.entireFile, lineIds: diff.selection.lineIds }],
                    view: diff.view == "staged" || diff.view == "unstaged" ? diff.view : "combined",
                    label: `${diff.selection.lineIds.length} lines in ${diff.path}`,
                })}
                changeView={view => changeView(state, diff, view)}
                read={more => readDiff(state, diff, more)}
                readContext={(page, signal) => readDiffContext(options.api, state.repositoryId, page, signal)}
                select={ids => diffSession(state).select(diff, ids)}
                clearSelection={() => {
                    diff.selection = undefined
                    update()
                }}
                cancel={() => {
                    diff.generation++
                    diff.loading = false
                    diff.error = "Diff read cancelled."
                    cancel(state, diffRequestId(state, diff))
                    update()
                }}
            />
        )
    }

    function transferSource(state: ColumnState, source: DiffSource): CompositionSource | undefined {
        if (source.kind == "working")
            return source
        if (source.kind == "commit")
            return { ...source, branch: state.column.kind == "branch" ? state.column.preferredRef : undefined }
    }

    function changeView(state: ColumnState, diff: FileDiffState, view: DiffView) {
        diff.view = view
        diff.page = undefined
        diff.selection = undefined
        void readDiff(state, diff)
    }

    /** Reads a file's diff. With `refresh`, a page already on screen stays put until a different version arrives. */
    async function readDiff(state: ColumnState, diff: FileDiffState, more = false, refresh = false) {
        let files = state.files.get(diff.group)
        await diffSession(state).read(
            diff,
            {
                source: files?.source,
                inventoryVersion: files?.inventory?.version,
                entireFile: state.showEntireFiles,
            },
            more,
            refresh,
        )
    }

    function diffSession(state: ColumnState) {
        let session = diffSessions.get(state)
        if (!session) {
            session = createDiffSession({
                api: options.api,
                repositoryId: state.repositoryId,
                alive: () => state.alive,
                requestId: diff => diffRequestId(state, diff),
                update,
                settled(diff) {
                    if (state.breakout?.scrolling && state.breakout.group == diff.group)
                        scrollBreakout(state, state.breakout)
                },
            })
            diffSessions.set(state, session)
        }

        return session
    }

    /** Scrolls the diff column so its focused file's toolbar sits under the column header. */
    function scrollBreakout(state: ColumnState, breakout: BreakoutState) {
        if (!breakout.focus)
            return
        breakout.scrolling = true
        void options.update().then(signal => {
            if (signal.aborted || state.breakout != breakout || !breakout.scrolling || !breakout.focus)
                return

            let column = breakoutColumn(state, breakout)
            let aside = column && document.querySelector<HTMLElement>(`[data-auxiliary-id="${column.id}"]`)
            let columnHeader = aside?.querySelector("header")
            let target = aside
                && Array.from(aside.querySelectorAll<HTMLElement>("[data-diff-path]")).find(element => element.dataset.diffPath == breakout.focus)
            if (!aside || !columnHeader || !target)
                return
            aside.scrollTo({
                top: aside.scrollTop + target.getBoundingClientRect().top - columnHeader.getBoundingClientRect().bottom,
                behavior: scrollBehavior(),
            })
            let header = target.querySelector<HTMLElement>(".diff-toolbar")
            navigationHighlight?.cancel()
            navigationHighlight = header?.animate?.([
                { backgroundColor: "color-mix(in srgb, var(--accent) 28%, var(--panel-deep))", boxShadow: "inset 3px 0 var(--accent)", offset: 0 },
                { backgroundColor: "color-mix(in srgb, var(--accent) 28%, var(--panel-deep))", boxShadow: "inset 3px 0 var(--accent)", offset: 0.6 },
                { backgroundColor: "var(--panel-deep)", boxShadow: "inset 3px 0 transparent", offset: 1 },
            ], { duration: 1500, easing: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "steps(1, end)" : "ease-out" })
            // Diffs above the target push it down as they arrive, so keep aiming until they have all loaded.
            let files = state.files.get(breakout.group)?.inventory?.files ?? []
            let above = files.slice(0, files.findIndex(file => file.path == breakout.focus) + 1)
            if (above.every(file => !state.diffs.get(diffKey(breakout.group, file.path))?.loading))
                breakout.scrolling = false
        })
    }

    function breakoutColumn(state: ColumnState, breakout: BreakoutState) {
        return auxiliary.descendants(key(state.repositoryId, state.id)).find(column => column.value == breakout)
    }

    function selectable(state: ColumnState, group: string) {
        return !state.auxiliaryId || group == "working"
            || state.compositionKey == JSON.stringify(compositionFor(state)) && !!state.composable?.has(group)
    }

    function compositionFor(host?: ColumnState) {
        let root = host?.selectionRoot
        let primary = root?.graph.branches.find(branch => branch.primary)
        let branch = root?.graph.branches.find(branch => branch.id == root.column.id)

        return branch && !branch.remoteOnly && primary ? { tip: branch.tip, primaryTip: primary.tip } : undefined
    }

    async function openFilter(state: ColumnState, render: Options["update"]) {
        state.filterOpen = true
        await render()
        if (state.alive && state.filterOpen)
            state.filterInput?.focus({ preventScroll: true })
    }

    function closeFilter(state: ColumnState) {
        state.filterOpen = false
        state.filter = ""
        state.status = "all"
        filterChanged(state)
        state.filterButton?.focus({ preventScroll: true })
    }

    function filterChanged(state: ColumnState) {
        for (let diff of state.diffs.values()) {
            let file = state.files.get(diff.group)?.inventory?.files.find(file => file.path == diff.path)
            if (file && !matchesFilter(state, file))
                clearDiff(state, diff)
        }
        update()
    }

    function clearDiff(state: ColumnState, diff: FileDiffState) {
        diff.generation++
        cancel(state, diffRequestId(state, diff))
        let id = diffKey(diff.group, diff.path)
        state.diffs.delete(id)
        if (state.breakout?.group == diff.group)
            state.breakout.created.delete(id)
    }

    function cancel(state: ColumnState, id: string) {
        void options.api.cancelInspection(state.repositoryId, id)
    }

    function diffRequestId(state: ColumnState, diff: FileDiffState) {
        return requestId(state, `diff:${diffKey(diff.group, diff.path)}`)
    }

    function requestId(state: ColumnState, suffix: string) {
        let id = `${state.id}:${suffix}`
        state.requestIds.add(id)
        return id
    }

    function diffKey(group: string, path: string) {
        return JSON.stringify([group, path])
    }

    function matchesFilter(state: ColumnState, file: ChangedFile) {
        return `${file.oldPath ?? ""} ${file.path}`.toLowerCase().includes(state.filter.toLowerCase()) && (state.status == "all" || file.status == state.status)
    }
}

// The staged and unstaged lists each show their own side of a file, so only conflict views remain
// selectable there; the combined Working Changes view keeps its staged and unstaged toggles.

function message(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function breakoutTitle(state: ColumnState, breakout: BreakoutState) {
    switch (breakout.group) {
        case "working":
            return `Working Changes · ${state.column.name}`
        case "working-staged":
            return `Staged · ${state.column.name}`
        case "working-unstaged":
            return `Unstaged · ${state.column.name}`
        default:
            return breakout.subject ? `Commit · ${breakout.subject}` : `Diff · ${state.column.name}`
    }
}

function conflictIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M8 2 15 14H1Z" />
            <path d="M8 6v4m0 1.5v1" />
        </svg>
    )
}
