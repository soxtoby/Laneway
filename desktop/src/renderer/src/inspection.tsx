import type { BranchGraph, BranchGraphBranchNode, BranchGraphVirtualBranch, BranchHistoryPage, ChangedFile, ChangeSelection, ChangesInventory, DiffLayout, DiffSource, DiffView, FileDiffPage } from "@git-workbench/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import * as accordion from "remix/ui/accordion/primitives"
import { AuxiliaryColumns } from "./auxiliary-columns"
import { type BranchComparisonState, createBranchComparisons } from "./branch-comparison"
import { DiffLines } from "./diff"
import { DiffControls } from "./diff-controls"
import { fileLabel, FileTree } from "./file-list"
import { FileMenu } from "./file-menu"

type Column = BranchGraphBranchNode | BranchGraphVirtualBranch
interface Options {
    api: Window["workbench"]
    update(): Promise<AbortSignal>
    signal: AbortSignal
    layout(repositoryId: string, columnId: string): DiffLayout
    saveLayout(repositoryId: string, columnId: string, layout: DiffLayout): void
    compareWith(repositoryId: string, fromRef: string, replaceId?: string, toRef?: string): void
}
interface FileState {
    inventory?: ChangesInventory
    source: DiffSource
    loading: boolean
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
interface FileDiffState {
    showWhitespace: boolean
    group: string
    path: string
    view: DiffView
    page?: FileDiffPage
    loading: boolean
    error?: string
    selection?: ChangeSelection
    generation: number
    notice?: string
}
type BreakoutState =
    | { kind: "file"; diff: FileDiffState }
    | { kind: "commit"; group: string; subject: string; created: Set<string> }
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
    cachedDiffs: Map<string, FileDiffPage>
    wholeFiles: Map<string, { source: DiffSource; path: string; version: string }>
    breakout?: BreakoutState
    showIgnored: boolean
    filter: string
    filterOpen: boolean
    filterInput?: HTMLInputElement
    filterButton?: HTMLButtonElement
    status: string
    alive: boolean
    unavailable?: boolean
    auxiliaryId?: string
    transientLayout?: DiffLayout
    selectionRoot?: ColumnState
    composable?: Set<string>
    compositionKey?: string
}

export function createInspection(options: Options) {
    const columns = new Map<string, ColumnState>()
    const auxiliary = new AuxiliaryColumns<BreakoutState | BranchComparisonState | FileHistoryState | TrailCommitState>()
    const trailCommits = createTrailCommits(options)
    const comparisons = createBranchComparisons(options)
    const histories = createFileHistories({
        ...options,
        composition(history) {
            return compositionFor(historyHosts.get(history))
        },
        changed(history) {
            const host = historyHosts.get(history)
            if (!host)
                return
            host.compositionKey = JSON.stringify(compositionFor(host))
            for (const group of host.files.keys()) {
                if (group != "working" && !history.page?.entries.some(entry => entry.objectId == group)) {
                    clearGroup(host, group)
                    host.files.delete(group)
                }
            }
            host.wholeFiles.clear()
            for (const diff of host.diffs.values())
                diff.selection = undefined
        },
    })
    const historyHosts = new Map<FileHistoryState | TrailCommitState, ColumnState>()
    let activeRepositoryId: string | undefined
    const key = (repositoryId: string, id: string) => JSON.stringify([repositoryId, id])
    const update = () => {
        if (!options.signal.aborted)
            void options.update()
    }
    const refresh = () => {
        if (activeRepositoryId)
            histories.refresh(activeRepositoryId)
        for (const host of historyHosts.values()) {
            if (host.repositoryId == activeRepositoryId && host.worktreePath)
                void readFiles(host, "working", { kind: "working", worktreePath: host.worktreePath }, true)
        }
        for (const state of columns.values()) {
            if (state.repositoryId == activeRepositoryId && state.worktreePath && !state.unavailable)
                void readFiles(state, "working", { kind: "working", worktreePath: state.worktreePath }, true)
        }
    }
    const timer = window.setInterval(() => {
        if (document.visibilityState == "visible" && document.hasFocus())
            refresh()
    }, 5000)
    window.addEventListener("focus", refresh)
    const visibility = () => {
        if (document.visibilityState != "visible") {
            comparisons.activate()
            histories.suspend()
            trailCommits.suspend()
            for (const host of historyHosts.values())
                suspend(host)
            for (const state of columns.values())
                suspend(state)
        } else {
            comparisons.activate(activeRepositoryId)
            refresh()
            for (const state of columns.values()) {
                if (state.repositoryId == activeRepositoryId)
                    resume(state)
            }
        }
    }
    document.addEventListener("visibilitychange", visibility)
    options.signal.addEventListener("abort", () => {
        window.clearInterval(timer)
        window.removeEventListener("focus", refresh)
        document.removeEventListener("visibilitychange", visibility)
        for (const state of columns.values())
            dispose(state)
    }, { once: true })

    function cancel(state: ColumnState, id: string) {
        void options.api.cancelInspection(state.repositoryId, id)
    }
    function compositionFor(host?: ColumnState) {
        const root = host?.selectionRoot
        const primary = root?.graph.branches.find(branch => branch.primary)
        const branch = root?.graph.branches.find(branch => branch.id == root.column.id)
        return branch && !branch.remoteOnly && primary ? { tip: branch.tip, primaryTip: primary.tip } : undefined
    }
    function selectable(state: ColumnState, group: string) {
        return !state.auxiliaryId || group == "working"
            || state.compositionKey == JSON.stringify(compositionFor(state)) && !!state.composable?.has(group)
    }
    function openHistory(owner: ColumnState, sourceId: string, source: FileHistorySource, path: string) {
        const node = auxiliary.open(sourceId, JSON.stringify(["history", source, path]), () => {
            const value = histories.create(owner.repositoryId, source, path)
            const host: ColumnState = {
                ...owner,
                id: `history:${crypto.randomUUID()}`,
                auxiliaryId: undefined,
                breakout: undefined,
                worktreePath: source.kind == "worktree" ? source.worktreePath : undefined,
                files: new Map(),
                diffs: new Map(),
                cachedDiffs: new Map(),
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
    function openTrailCommit(owner: ColumnState, sourceId: string, entry: FileHistoryEntry) {
        const node = auxiliary.open(sourceId, JSON.stringify(["trail-commit", entry.objectId, entry.followedParent]), () => {
            const value = trailCommits.create(owner.repositoryId, entry)
            const host: ColumnState = {
                ...owner,
                id: `trail:${crypto.randomUUID()}`,
                auxiliaryId: undefined,
                breakout: undefined,
                worktreePath: undefined,
                files: new Map(),
                diffs: new Map(),
                requestIds: new Set(),
                wholeFiles: new Map(),
                cachedDiffs: new Map(),
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
    function suspend(state: ColumnState) {
        for (const diff of state.diffs.values()) {
            diff.selection = undefined
            diff.generation++
            diff.loading = false
        }
        for (const file of state.files.values()) {
            file.generation++
            file.loading = false
        }
        for (const item of state.history.values()) {
            item.generation++
            item.loading = false
        }
        for (const id of state.requestIds)
            cancel(state, id)
    }
    function dispose(state: ColumnState) {
        state.alive = false
        auxiliary.close(key(state.repositoryId, state.id))
        suspend(state)
    }
    function resume(state: ColumnState) {
        if (state.unavailable)
            return
        for (const [group, files] of state.files) {
            if (files.open && !files.inventory)
                void readFiles(state, group, files.source)
        }
        for (const [id, current] of state.history) {
            const branch = state.graph.branches.find(branch => branch.id == id)
            if (branch && current.open && !current.page)
                void history(state, branch)
        }
        for (const diff of state.diffs.values()) {
            if (!diff.page)
                void readDiff(state, diff)
        }
    }
    function requestId(state: ColumnState, suffix: string) {
        const id = `${state.id}:${suffix}`
        state.requestIds.add(id)
        return id
    }
    function stateFor(repositoryId: string, column: Column, graph: BranchGraph, worktreePath?: string) {
        const id = key(repositoryId, column.id)
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
                cachedDiffs: new Map(),
                showIgnored: false,
                filter: "",
                filterOpen: false,
                status: "all",
                wholeFiles: new Map(),
                alive: true,
                get breakout() {
                    const value = auxiliary.descendants(id).find(column =>
                        column.sourceId == id && (column.value.kind == "file" || column.value.kind == "commit")
                    )?.value
                    return value?.kind == "file" || value?.kind == "commit" ? value : undefined
                },
                set breakout(value: BreakoutState | undefined) {
                    const previous = auxiliary.descendants(id).find(column =>
                        column.sourceId == id && (column.value.kind == "file" || column.value.kind == "commit")
                    )
                    if (previous?.value == value)
                        return
                    if (previous)
                        auxiliary.close(previous.id)
                    if (value) {
                        auxiliary.open(id, value.kind == "file" ? diffKey(value.diff.group, value.diff.path) : value.group, () => ({
                            value,
                            dispose() {
                                if (value.kind == "commit") {
                                    for (const diffId of value.created) {
                                        const diff = created.diffs.get(diffId)
                                        if (diff)
                                            clearDiff(created, diff)
                                    }
                                }
                            },
                        }), previous?.width)
                    }
                },
            }
            columns.set(id, state)
            const created = state
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
        return state
    }
    async function readFiles(state: ColumnState, group: string, source: DiffSource, refreshDiff = false, open = true) {
        let files = state.files.get(group)
        if (!files) {
            files = { source, loading: false, open, generation: 0 }
            state.files.set(group, files)
        }
        if (!state.alive || files.loading && JSON.stringify(files.source) == JSON.stringify(source) && files.includeIgnored == state.showIgnored)
            return
        files.source = source
        files.includeIgnored = state.showIgnored
        files.loading = true
        files.error = undefined
        const generation = ++files.generation
        update()
        try {
            const result = await options.api.readChanges(state.repositoryId, requestId(state, `files:${group}`), { source, includeIgnored: state.showIgnored })
            if (!state.alive || generation != files.generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            const previous = files.inventory?.version
            files.inventory = result.inventory
            files.source = result.inventory.source
            if (state.breakout?.kind == "commit" && state.breakout.group == group)
                populateCommitBreakout(state, state.breakout)
            if (previous && previous != result.inventory.version) {
                for (const id of state.wholeFiles.keys()) {
                    if (id.startsWith(`${group}:`))
                        state.wholeFiles.delete(id)
                }
            }
            for (const diff of state.diffs.values()) {
                if (diff.group != group)
                    continue
                if (!result.inventory.files.some(file => file.path == diff.path && !file.ignored))
                    clearDiff(state, diff)
                else if (refreshDiff)
                    void readDiff(state, diff, false, true)
            }
        } catch (error) {
            if (state.alive && generation == files.generation) {
                files.error = message(error)
                for (const diff of state.diffs.values()) {
                    if (diff.group == group) {
                        diff.selection = undefined
                        diff.page = undefined
                    }
                }
            }
        } finally {
            if (generation == files.generation) {
                files.loading = false
                update()
            }
        }
    }
    function diffKey(group: string, path: string) {
        return JSON.stringify([group, path])
    }
    function diffRequestId(state: ColumnState, diff: FileDiffState) {
        return requestId(state, `diff:${diffKey(diff.group, diff.path)}`)
    }
    function clearDiff(state: ColumnState, diff: FileDiffState) {
        diff.generation++
        cancel(state, diffRequestId(state, diff))
        const id = diffKey(diff.group, diff.path)
        state.diffs.delete(id)
        if (state.breakout?.kind == "file" && state.breakout.diff == diff)
            state.breakout = undefined
        else if (state.breakout?.kind == "commit")
            state.breakout.created.delete(id)
    }
    function clearGroup(state: ColumnState, group: string, prefix = "") {
        for (const diff of state.diffs.values()) {
            if (diff.group == group && diff.path.startsWith(prefix))
                clearDiff(state, diff)
        }
        if (state.breakout?.kind == "commit" && state.breakout.group == group)
            state.breakout = undefined
    }
    function createDiff(state: ColumnState, group: string, path: string) {
        const files = state.files.get(group)
        const diff: FileDiffState = {
            group,
            path,
            view: "combined",
            page: files?.error ? undefined : state.cachedDiffs.get(JSON.stringify([files?.source, files?.inventory?.version, path])),
            loading: false,
            generation: 0,
            showWhitespace: false,
        }
        state.diffs.set(diffKey(group, path), diff)
        return diff
    }
    function closeCommitBreakout(state: ColumnState, keep?: FileDiffState) {
        const breakout = state.breakout
        if (breakout?.kind != "commit")
            return
        if (keep)
            breakout.created.delete(diffKey(keep.group, keep.path))
        state.breakout = undefined
    }
    function focusBreakout(state: ColumnState) {
        const column = auxiliary.descendants(key(state.repositoryId, state.id)).find(column => column.value.kind == "file" || column.value.kind == "commit")
        if (!column)
            return
        auxiliary.focusedId = column.id
        void options.update().then(signal => {
            if (!signal.aborted && auxiliary.focusedId == column.id)
                document.querySelector<HTMLElement>(`[data-auxiliary-id="${column.id}"]`)?.focus()
        })
    }
    function showFileBreakout(state: ColumnState, diff: FileDiffState) {
        closeCommitBreakout(state, diff)
        state.breakout = { kind: "file", diff }
        focusBreakout(state)
    }
    function choose(state: ColumnState, group: string, file: ChangedFile) {
        const id = diffKey(group, file.path)
        const selected = state.diffs.get(id)
        if (state.breakout) {
            if (state.breakout.kind == "file" && state.breakout.diff == selected) {
                focusBreakout(state)
                return
            }
            const diff = selected ?? createDiff(state, group, file.path)
            showFileBreakout(state, diff)
            if (!selected && !diff.page)
                void readDiff(state, diff)
            return
        }
        if (selected) {
            clearDiff(state, selected)
            update()
            return
        }
        const diff = createDiff(state, group, file.path)
        if (diff.page)
            update()
        else
            void readDiff(state, diff)
    }
    async function showCommitBreakout(state: ColumnState, commit: BranchHistoryPage["commits"][number]) {
        if (state.breakout?.kind == "commit" && state.breakout.group == commit.objectId) {
            focusBreakout(state)
            return
        }
        closeCommitBreakout(state)
        const breakout: Extract<BreakoutState, { kind: "commit" }> = {
            kind: "commit",
            group: commit.objectId,
            subject: commit.subject,
            created: new Set(),
        }
        state.breakout = breakout
        focusBreakout(state)
        let files = state.files.get(commit.objectId)
        if (!files?.inventory) {
            await readFiles(state, commit.objectId, { kind: "commit", objectId: commit.objectId }, false, false)
            files = state.files.get(commit.objectId)
        }
        if (!state.alive || state.breakout != breakout)
            return
        populateCommitBreakout(state, breakout)
        update()
    }
    function populateCommitBreakout(state: ColumnState, breakout: Extract<BreakoutState, { kind: "commit" }>) {
        if (!state.alive || state.breakout != breakout)
            return
        const files = state.files.get(breakout.group)
        for (const file of files?.inventory?.files ?? []) {
            if (file.ignored)
                continue
            const id = diffKey(breakout.group, file.path)
            let diff = state.diffs.get(id)
            if (!diff) {
                diff = createDiff(state, breakout.group, file.path)
                breakout.created.add(id)
            }
            if (!diff.page && !diff.loading)
                void readDiff(state, diff)
        }
    }
    async function readDiff(state: ColumnState, diff: FileDiffState, more = false, refresh = false) {
        const files = state.files.get(diff.group)
        const source = files?.source
        const inventoryVersion = files?.inventory?.version
        if (!source || !state.alive || refresh && diff.loading)
            return
        const previous = diff.page
        const generation = ++diff.generation
        diff.loading = true
        diff.error = undefined
        update()
        try {
            const result = await options.api.readFileDiff(state.repositoryId, diffRequestId(state, diff), {
                source,
                path: diff.path,
                view: diff.view,
                inventoryVersion,
                ...(more && previous ? { offset: previous.nextOffset, expectedVersion: previous.version } : {}),
            })
            if (!state.alive || generation != diff.generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            const page = result.page
            if (diff.view == "combined" && !more && page.lines.reduce((length, line) => length + line.text.length, 0) <= 128_000) {
                const id = JSON.stringify([source, inventoryVersion, diff.path])
                state.cachedDiffs.delete(id)
                state.cachedDiffs.set(id, page)
                if (state.cachedDiffs.size > 16)
                    state.cachedDiffs.delete(state.cachedDiffs.keys().next().value!)
            }
            if (previous && previous.version != page.version) {
                diff.selection = undefined
                diff.notice = "File changed. Change Selection cleared."
            }
            diff.page = more && previous
                ? { ...page, lines: [...previous.lines, ...page.lines] }
                : refresh && previous?.version == page.version
                ? previous
                : page
        } catch (error) {
            if (state.alive && generation == diff.generation) {
                diff.error = message(error)
                diff.selection = undefined
                if (!more)
                    diff.page = undefined
            }
        } finally {
            if (generation == diff.generation) {
                diff.loading = false
                update()
            }
        }
    }
    async function history(state: ColumnState, branch: BranchGraphBranchNode, more = false) {
        const baseTips = branch.base.status == "known" ? [branch.base.tip] : branch.base.candidates.map(candidate => candidate.tip)
        const historyKey = `${branch.tip}:${baseTips.join(":")}`
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
        const generation = ++current.generation
        try {
            const result = await options.api.readBranchHistory(state.repositoryId, {
                requestId: requestId(state, `history:${branch.id}`),
                branchRef: branch.preferredRef,
                tip: branch.tip,
                baseTips,
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
            }
        }
    }
    function toggleHistory(state: ColumnState, branch: BranchGraphBranchNode) {
        const current = state.history.get(branch.id)
        const baseTips = branch.base.status == "known" ? [branch.base.tip] : branch.base.candidates.map(candidate => candidate.tip)
        if (!current || current.key != `${branch.tip}:${baseTips.join(":")}`)
            void history(state, branch)
        else {
            current.open = !current.open
            if (!current.open) {
                for (const commit of current.page?.commits ?? [])
                    clearGroup(state, commit.objectId)
            }
            if (current.open && !current.page)
                void history(state, branch)
            update()
        }
    }
    function changeView(state: ColumnState, diff: FileDiffState, view: DiffView) {
        diff.view = view
        diff.page = undefined
        diff.selection = undefined
        void readDiff(state, diff)
    }
    function selectLines(diff: FileDiffState, ids: number[]) {
        const page = diff.page
        if (!page?.selectable)
            return
        const selection = diff.selection ?? { source: page.source, path: page.file.path, version: page.version, lineIds: [], rename: false }
        const current = new Set(selection.lineIds)
        const remove = ids.every(id => current.has(id))
        for (const id of ids) {
            if (remove)
                current.delete(id)
            else
                current.add(id)
        }
        diff.selection = { ...selection, lineIds: [...current].sort((a, b) => a - b) }
        update()
    }
    function filterChanged(state: ColumnState) {
        for (const diff of state.diffs.values()) {
            const file = state.files.get(diff.group)?.inventory?.files.find(file => file.path == diff.path)
            if (file && !matchesFilter(state, file))
                clearDiff(state, diff)
        }
        update()
    }
    function matchesFilter(state: ColumnState, file: ChangedFile) {
        return `${file.oldPath ?? ""} ${file.path}`.toLowerCase().includes(state.filter.toLowerCase()) && (state.status == "all" || file.status == state.status)
    }
    function fileList(state: ColumnState, group: string, files: FileState | undefined): RemixNode {
        if (!files)
            return null
        const all = files.inventory?.files ?? []
        const visible = all.filter(file => !file.ignored && matchesFilter(state, file))
        const expanded = state.breakout?.kind == "file" && state.breakout.diff.group == group
            ? new Set([state.breakout.diff.path])
            : state.breakout
            ? new Set<string>()
            : new Set([...state.diffs.values()].filter(diff => diff.group == group).map(diff => diff.path))
        return (
            <section class="change-file-list" aria-label={group == "working" ? "Working Changes files" : "Commit files"} mix={changeFileList}>
                {files.error && (
                    <p role="alert" mix={changeFileListP}>
                        {files.error}{" "}
                        <button type="button" mix={[changeFileListButton, on("click", () => readFiles(state, group, files.source))]}>
                            Retry
                        </button>
                    </p>
                )}
                {files.inventory && !all.some(file => !file.ignored) && (
                    <p class="inspection-muted" mix={inspectionMuted}>
                        {group == "working" ? "No Working Changes" : "No changes against this parent"}
                    </p>
                )}
                <FileTree
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
                    controls={file => {
                        const diff = state.diffs.get(diffKey(group, file.path))
                        return diff && !state.breakout ? renderDiffControls(state, diff) : null
                    }}
                    diff={file => {
                        const diff = state.diffs.get(diffKey(group, file.path))
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
                            const id = `${group}:${file.path}`
                            if (state.wholeFiles.has(id))
                                state.wholeFiles.delete(id)
                            else if (files.inventory)
                                state.wholeFiles.set(id, { source: files.inventory.source, path: file.path, version: files.inventory.version })
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
    function renderDiffControls(state: ColumnState, diff: FileDiffState): RemixNode {
        return (
            <DiffControls
                layout={state.transientLayout ?? options.layout(state.repositoryId, state.id)}
                showWhitespace={diff.showWhitespace}
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
                    ? () => showFileBreakout(state, diff)
                    : undefined}
            />
        )
    }
    function renderDiff(state: ColumnState, diff: FileDiffState): RemixNode {
        const eligible = selectable(state, diff.group)
        const page = diff.page && !eligible ? { ...diff.page, selectable: false } : diff.page
        const layout = state.transientLayout ?? options.layout(state.repositoryId, state.id)
        const brokenOut = state.breakout?.kind == "file" && state.breakout.diff == diff
            || state.breakout?.kind == "commit" && state.breakout.group == diff.group
        return (
            <section class="diff-inspector" aria-label={`Diff for ${diff.path}`} mix={diffInspector}>
                {brokenOut && (
                    <header class="diff-toolbar" mix={diffToolbar}>
                        <FileMenu
                            class="diff-file-menu"
                            actions={page
                                ? [{
                                    label: "File history",
                                    run: () => {
                                        const sourceId = auxiliary.descendants(key(state.repositoryId, state.id)).find(node => node.value == state.breakout)?.id
                                            ?? key(state.repositoryId, state.id)
                                        if (page.source.kind == "working")
                                            openHistory(state, sourceId, { kind: "worktree", worktreePath: page.source.worktreePath }, diff.path)
                                        else if (page.source.kind == "commit")
                                            openHistory(state, sourceId, { kind: "commit", objectId: page.source.objectId }, diff.path)
                                    },
                                }]
                                : []}
                        >
                            <strong title={diff.path} mix={diffToolbarStrong}>
                                {fileLabel(diff.path)}
                            </strong>
                        </FileMenu>
                        {renderDiffControls(state, diff)}
                    </header>
                )}
                {page?.source.kind == "working" && (page.file.staged || page.file.conflicted) && (
                    <div class="diff-views" role="group" aria-label="Comparison" mix={diffViews}>
                        {([
                            "combined",
                            ...(page.file.staged ? ["staged", "unstaged"] : []),
                            ...(page.file.conflicted ? ["base", "ours", "theirs"] : []),
                        ] as DiffView[]).map(view => (
                            <button
                                type="button"
                                aria-pressed={diff.view == view}
                                mix={[diffViewsButton, on("click", () => changeView(state, diff, view))]}
                            >
                                {view == "combined" ? "Working Changes" : view[0].toUpperCase() + view.slice(1)}
                            </button>
                        ))}
                    </div>
                )}
                {diff.notice && (
                    <p class="inspection-notice" role="status" mix={inspectionNotice}>
                        {diff.notice}
                    </p>
                )}
                {diff.error && (
                    <p role="alert" mix={diffInspectorP}>
                        {diff.error}{" "}
                        <button type="button" mix={[diffInspectorButton, on("click", () => readDiff(state, diff))]}>
                            Retry diff
                        </button>
                    </p>
                )}
                {page && (
                    <>
                        {page.summary.map(text => (
                            <p class="diff-summary" mix={diffSummary}>
                                {text}
                            </p>
                        ))}
                        {page.file.oldPath && page.view == "combined" && page.selectable && (
                            <label class="rename-selection" mix={renameSelection}>
                                <input
                                    type="checkbox"
                                    checked={diff.selection?.rename ?? false}
                                    mix={[
                                        diffInspectorInput,
                                        on("change", event => {
                                            diff.selection = {
                                                source: page.source,
                                                path: page.file.path,
                                                version: page.version,
                                                lineIds: diff.selection?.lineIds ?? [],
                                                rename: event.currentTarget.checked,
                                            }
                                            update()
                                        }),
                                    ]}
                                />Select rename separately
                            </label>
                        )}
                        {page.lines.length == 0 && page.summary.length == 0 && (
                            <p class="inspection-muted" mix={inspectionMuted}>
                                No net content difference in this view.
                            </p>
                        )}
                        <DiffLines
                            page={page}
                            layout={layout}
                            showWhitespace={diff.showWhitespace}
                            selected={eligible ? diff.selection?.lineIds ?? [] : []}
                            select={ids => {
                                if (eligible)
                                    selectLines(diff, ids)
                            }}
                        />
                        {eligible && diff.selection && (
                            <div class="selection-summary" role="status" mix={selectionSummary}>
                                {diff.selection.lineIds.length} lines selected{diff.selection.rename ? " · rename selected" : ""}
                                <button
                                    type="button"
                                    data-mousedown-activate
                                    mix={[
                                        selectionSummaryButton,
                                        on("click", () => {
                                            diff.selection = undefined
                                            update()
                                        }),
                                    ]}
                                >
                                    Clear selection
                                </button>
                            </div>
                        )}
                        {page.nextOffset != undefined && (
                            <button
                                type="button"
                                class="load-diff"
                                disabled={diff.loading}
                                mix={[loadDiff, on("click", () => readDiff(state, diff, true))]}
                            >
                                Load more
                            </button>
                        )}
                    </>
                )}
                {diff.loading && (
                    <p class="inspection-progress" role="status" mix={inspectionProgress}>
                        Reading diff…{" "}
                        <button
                            type="button"
                            mix={[
                                inspectionMutedButton,
                                on("click", () => {
                                    diff.generation++
                                    diff.loading = false
                                    diff.error = "Diff read cancelled."
                                    cancel(state, diffRequestId(state, diff))
                                    update()
                                }),
                            ]}
                        >
                            Cancel
                        </button>
                    </p>
                )}
            </section>
        )
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
    return {
        workingSummary(repositoryId: string, column: Column, graph: BranchGraph, worktreePath?: string) {
            if (!worktreePath)
                return "Branch"
            const files = stateFor(repositoryId, column, graph, worktreePath).files.get("working")
            if (files?.error)
                return "Working Changes unavailable"
            if (!files?.inventory)
                return "Reading Working Changes…"
            const count = files.inventory.files.filter(file => !file.ignored).length
            return count ? `${count} changed ${count == 1 ? "file" : "files"}` : "Clean"
        },
        filterKeydown(repositoryId: string, columnId: string, event: KeyboardEvent, render: Options["update"]) {
            const state = columns.get(key(repositoryId, columnId))
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
        filterControl(repositoryId: string, column: Column, graph: BranchGraph, render: Options["update"], worktreePath?: string): RemixNode {
            const state = stateFor(repositoryId, column, graph, worktreePath)
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
            for (const [id, state] of columns) {
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
                for (const host of historyHosts.values())
                    suspend(host)
                for (const state of columns.values()) {
                    if (state.repositoryId == activeRepositoryId)
                        suspend(state)
                }
                activeRepositoryId = repositoryId
                refresh()
                for (const state of columns.values()) {
                    if (state.repositoryId == activeRepositoryId)
                        resume(state)
                }
            }
        },
        retain(repositoryId: string, ids: string[], graph?: BranchGraph) {
            for (const [id, state] of columns) {
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
        body(repositoryId: string, column: Column, graph: BranchGraph, worktreePath?: string): RemixNode {
            const state = stateFor(repositoryId, column, graph, worktreePath)
            const stack: BranchGraphBranchNode[] = []
            let branch = column.kind == "branch" ? column : undefined
            while (branch && !stack.some(item => item.id == branch!.id)) {
                stack.push(branch)
                const last = stack.at(-1)!
                const selection = state.baseSelections.get(last.id)
                const nextId = last.base.status == "known"
                    ? last.base.branchId
                    : last.base.candidates.some(candidate => candidate.branchId == selection)
                    ? selection
                    : undefined
                branch = graph.branches.find(item => item.id == nextId)
            }
            return (
                <div class={`column-inspection ${state.filterOpen ? "filter-open" : ""}`} mix={columnInspection}>
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
                                ×
                            </button>
                        </div>
                    )}
                    {state.worktreePath && (
                        <section class="working-changes" mix={workingChanges}>
                            <header mix={workingChangesHeader}>
                                <h3 mix={workingChangesH3}>
                                    Working Changes
                                </h3>
                                <button
                                    type="button"
                                    aria-label="Refresh Working Changes"
                                    mix={[
                                        refreshWorkingChangesButton,
                                        on("click", () => readFiles(state, "working", { kind: "working", worktreePath: state.worktreePath! }, true)),
                                    ]}
                                >
                                    ↻
                                </button>
                            </header>
                            <label class="ignored-toggle" mix={ignoredToggle}>
                                <input
                                    type="checkbox"
                                    checked={state.showIgnored}
                                    mix={[
                                        workingChangesInput,
                                        on("change", event => {
                                            state.showIgnored = event.currentTarget.checked
                                            void readFiles(state, "working", { kind: "working", worktreePath: state.worktreePath! })
                                        }),
                                    ]}
                                />Show ignored
                            </label>
                            {fileList(state, "working", state.files.get("working"))}
                        </section>
                    )}
                    <accordion.Context
                        type="multiple"
                        value={stack.filter(branch => state.history.get(branch.id)?.open).map(branch => branch.id)}
                        onValueChange={values => {
                            for (const branch of stack) {
                                if (branch.id != column.id && values.includes(branch.id) != (state.history.get(branch.id)?.open ?? false))
                                    toggleHistory(state, branch)
                            }
                        }}
                    >
                        <div class="stack-inspection" mix={accordion.root()}>
                            {stack.map(branch => {
                                const current = state.history.get(branch.id)
                                const columnBranch = branch.id == column.id
                                return (
                                    <accordion.ItemContext key={branch.id} value={branch.id}>
                                        <section class="stack-branch" mix={[stackBranch, accordion.item()]}>
                                            {!columnBranch && (
                                                <h3 class="disclosure-heading" mix={disclosureHeading}>
                                                    <button class="stack-heading" type="button" mix={[stackHeading, accordion.trigger()]}>
                                                        <span>{current?.open ? "▾" : "▸"} {branch.name}</span>
                                                        <small mix={stackHeadingSmall}>
                                                            {branch.base.status == "known" ? "Unique commits" : "Commits"}
                                                        </small>
                                                    </button>
                                                </h3>
                                            )}
                                            <div hidden={!columnBranch && !current?.open} mix={columnBranch ? [] : accordion.content()}>
                                                {current?.open && (
                                                    <accordion.Context
                                                        type="multiple"
                                                        value={(current.page?.commits ?? []).filter(commit => state.files.get(commit.objectId)?.open).map(
                                                            commit => commit.objectId,
                                                        )}
                                                        onValueChange={values => {
                                                            for (const commit of current.page?.commits ?? []) {
                                                                const files = state.files.get(commit.objectId)
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
                                                            {current.page?.commits.map(commit => {
                                                                const files = state.files.get(commit.objectId)
                                                                return (
                                                                    <accordion.ItemContext key={commit.objectId} value={commit.objectId}>
                                                                        <div
                                                                            class="inspect-commit"
                                                                            data-expanded={files?.open ? "true" : "false"}
                                                                            mix={[inspectCommit, accordion.item()]}
                                                                        >
                                                                            <h4 class="disclosure-heading" mix={[disclosureHeading, commitStickyHeading]}>
                                                                                <button
                                                                                    class="commit-heading"
                                                                                    type="button"
                                                                                    mix={[commitHeading, accordion.trigger()]}
                                                                                >
                                                                                    <span aria-hidden="true" mix={commitNode} />
                                                                                    <span mix={commitHeadingSpan}>
                                                                                        {commit.subject}
                                                                                    </span>
                                                                                </button>
                                                                                {files?.open && (
                                                                                    <button
                                                                                        type="button"
                                                                                        aria-label={`Show full diff for commit ${commit.subject}`}
                                                                                        title="Show full commit diff"
                                                                                        mix={[
                                                                                            commitDiffButton,
                                                                                            on("click", () => void showCommitBreakout(state, commit)),
                                                                                        ]}
                                                                                    >
                                                                                        {commitDiffIcon()}
                                                                                    </button>
                                                                                )}
                                                                            </h4>
                                                                            <div hidden={!files?.open} mix={accordion.content()}>
                                                                                {files?.open && (
                                                                                    <>
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
                                                                                        {fileList(state, commit.objectId, files)}
                                                                                    </>
                                                                                )}
                                                                            </div>
                                                                        </div>
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
                                                                                const selection = event.currentTarget.value
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
            const sourceId = key(repositoryId, from.id)
            const column = auxiliary.open(sourceId, JSON.stringify(["comparison", from.preferredRef, to.preferredRef]), () => {
                const value = comparisons.create(repositoryId, from, to, graph)
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
            const state = columns.get(key(repositoryId, columnId))
            if (!state)
                return null
            return auxiliary.descendants(key(repositoryId, columnId)).map(auxiliaryColumn => {
                if (auxiliaryColumn.value.kind == "trail-commit") {
                    const commit = auxiliaryColumn.value
                    const host = historyHosts.get(commit)!
                    host.graph = state.graph
                    return trailCommits.render(commit, auxiliaryColumn.id, auxiliaryColumn.sourceId, {
                        close() {
                            auxiliary.close(auxiliaryColumn.id)
                            update()
                        },
                        files() {
                            return fileList(host, commit.entry.objectId, host.files.get(commit.entry.objectId))
                        },
                        parent(parentId) {
                            for (const child of auxiliary.descendants(auxiliaryColumn.id).filter(child => child.sourceId == auxiliaryColumn.id))
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
                    const history = auxiliaryColumn.value
                    const host = historyHosts.get(history)!
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
                            const group = entry?.objectId ?? "working"
                            if (history.expanded.has(group)) {
                                history.expanded.delete(group)
                                clearGroup(host, group)
                            } else {
                                history.expanded.add(group)
                                const source: DiffSource = entry
                                    ? { kind: "commit", objectId: entry.objectId, parentId: entry.followedParent }
                                    : { kind: "working", worktreePath: host.worktreePath! }
                                void readFiles(host, group, source).then(() => {
                                    if (!entry || !host.alive || !history.expanded.has(group))
                                        return
                                    const file = host.files.get(group)?.inventory?.files.find(file => file.path == entry.path)
                                    if (file && !host.diffs.has(diffKey(group, file.path)))
                                        choose(host, group, file)
                                })
                            }
                            update()
                        },
                        files(entry) {
                            const group = entry?.objectId ?? "working"
                            const files = host.files.get(group)
                            if (entry) {
                                const diff = host.diffs.get(diffKey(group, entry.path))
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
                            const diff = host.diffs.get(diffKey(entry.objectId, entry.path))
                            return diff ? renderDiffControls(host, diff) : null
                        },
                        selection(entry) {
                            const inventory = host.files.get(entry.objectId)?.inventory
                            if (!inventory || !selectable(host, entry.objectId))
                                return undefined
                            const id = `${entry.objectId}:${entry.path}`
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
                    const comparison = auxiliaryColumn.value
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
                const breakout = auxiliaryColumn.value
                const files = breakout.kind == "commit" ? state.files.get(breakout.group) : undefined
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
                        <header mix={inspectionBreakoutHeader}>
                            <span>
                                {breakout.kind == "commit" ? `Commit · ${breakout.subject}` : `Diff · ${state.column.name}`}
                                <small class="auxiliary-source">From {state.column.name}</small>
                            </span>
                            <button
                                type="button"
                                aria-label="Close diff column"
                                mix={[
                                    closeDiffColumnButton,
                                    on("click", () => {
                                        if (state.breakout?.kind == "commit")
                                            closeCommitBreakout(state)
                                        else
                                            state.breakout = undefined
                                        void options.update().then(signal => {
                                            if (!signal.aborted) {
                                                Array.from(document.querySelectorAll<HTMLElement>(".branch-column"))
                                                    .find(element => element.dataset.columnId == columnId)?.focus()
                                            }
                                        })
                                    }),
                                ]}
                            >
                                ×
                            </button>
                        </header>
                        {breakout.kind == "file"
                            ? renderDiff(state, breakout.diff)
                            : (
                                <div class="commit-diff">
                                    {files?.error && <p role="alert" mix={changeFileListP}>{files.error}</p>}
                                    {files?.loading && <p role="status" mix={changeFileListP}>Reading commit…</p>}
                                    {files?.inventory?.files.filter(file => !file.ignored).map(file => {
                                        const diff = state.diffs.get(diffKey(breakout.group, file.path))
                                        return diff ? <div class="commit-diff-file">{renderDiff(state, diff)}</div> : null
                                    })}
                                </div>
                            )}
                    </aside>
                )
            })
        },
    }
}

function commitDiffIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">
            <path d="M3 2h7l3 3v9H3zM10 2v3h3M5 8h6M5 11h6" />
        </svg>
    )
}

function message(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

const changeFileList = css({
    position: "relative",
    ".file-tree details &": {
        paddingLeft: "14px",
    },
})

const changeFileListP = css({
    margin: 0,
    padding: "8px 10px",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
})

const changeFileListButton = css({
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

const inspectionProgressContainer = css({
    position: "relative",
})

const inspectionProgress = css({
    position: "absolute",
    top: "0",
    right: "0",
    zIndex: 1,
    margin: "0",
    padding: "4px 8px",
    maxWidth: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--line)",
    borderRadius: "3px",
    background: "var(--panel)",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
    pointerEvents: "none",
    "& button": {
        pointerEvents: "auto",
    },
})

const inspectionMuted = css({
    margin: "0",
    padding: "8px 10px",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
})

const diffInspector = css({
    position: "relative",
    borderBlock: "1px solid var(--line-strong)",
    background: "var(--panel)",
    minWidth: "0",
})

const diffToolbar = css({
    "& .diff-file-menu": { flex: 1, minWidth: 0 },
    position: "sticky",
    top: "0",
    zIndex: 5,
    background: "var(--panel)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 6px",
    borderBottom: "1px solid var(--line)",
})

const diffToolbarStrong = css({
    display: "flex",
    minWidth: "0",
    flex: "1",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    font: "12px var(--mono)",
})

const diffViews = css({
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    padding: "6px 8px",
})

const diffViewsButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    fontSize: "11px",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

const inspectionNotice = css({
    margin: "0",
    padding: "8px 10px",
    color: "var(--warning)",
    fontSize: "12px",
    overflowWrap: "anywhere",
    background: "var(--warning-wash)",
})

const diffInspectorP = css({
    margin: 0,
    padding: "8px 10px",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
})

const diffInspectorButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

const diffSummary = css({
    margin: "0",
    padding: "4px 10px",
    color: "var(--muted)",
    fontSize: "11px",
    lineHeight: "16px",
    overflowWrap: "anywhere",
})

const renameSelection = css({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    color: "var(--muted)",
    fontSize: "11px",
    padding: "5px 8px",
})

const diffInspectorInput = css({
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

const selectionSummary = css({
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 8px",
    fontSize: "11px",
    color: "var(--accent)",
    borderTop: "1px solid var(--line)",
})

const selectionSummaryButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

const loadDiff = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    margin: "8px",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

const inspectionMutedButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

const columnInspection = css({
    "--filter-height": "0px",
    "&.filter-open": { "--filter-height": "52px" },
    overflow: "auto",
    flex: "1",
    minHeight: "0",
})

const inspectionFilters = css({
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

const filterToggleButton = css({
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

const filterChangedFilesInput = css({
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

const filterChangeStatusSelect = css({
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

const workingChanges = css({
    marginBottom: "8px",
    background: "var(--panel)",
    borderBottom: "1px solid var(--line-strong)",
})

const workingChangesHeader = css({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    background: "var(--accent-wash)",
    borderBottom: "1px solid var(--line)",
})

const workingChangesH3 = css({
    fontSize: "12px",
    margin: "0",
})

const refreshWorkingChangesButton = css({
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
    minWidth: "26px",
    minHeight: "26px",
})

const ignoredToggle = css({
    display: "flex",
    alignItems: "center",
    gap: "5px",
    color: "var(--muted)",
    fontSize: "11px",
    padding: "5px 8px",
})

const workingChangesInput = css({
    width: "14px",
    height: "14px",
    minHeight: 0,
    padding: 0,
    margin: "0 3px 0 0",
    flex: "0 0 14px",
})

const stackBranch = css({
    borderTop: "1px solid var(--line-strong)",
})

const disclosureHeading = css({
    margin: 0,
    font: "inherit",
})

const commitStickyHeading = css({
    position: "sticky",
    top: "var(--filter-height, 0px)",
    zIndex: 7,
    height: "32px",
    display: "flex",
    background: "var(--control)",
    borderRadius: "3px",
})

const stackHeading = css({
    border: "0",
    background: "var(--panel-deep)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "10px",
    font: "inherit",
    cursor: "pointer",
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    textAlign: "left",
    "&:hover": {
        background: "var(--control-hover)",
    },
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
})

const commitDiffButton = css({
    width: "32px",
    height: "32px",
    flex: "0 0 32px",
    display: "grid",
    placeItems: "center",
    padding: 0,
    border: "0",
    borderRadius: "3px",
    background: "var(--control)",
    color: "var(--muted)",
    cursor: "pointer",
    "&:hover": {
        background: "var(--control-hover)",
        color: "var(--text)",
    },
})

const stackHeadingSmall = css({
    color: "var(--muted)",
})

const stackBranchButton = css({
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

const inspectCommit = css({
    position: "relative",
    border: "1px solid transparent",
    borderRadius: "3px",
    '&[data-expanded="true"]': {
        borderColor: "var(--line)",
        background: "var(--panel)",
    },
})

const commitHeading = css({
    position: "relative",
    height: "32px",
    border: "0",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "8px 10px",
    font: "inherit",
    cursor: "pointer",
    display: "flex",
    flex: "1 1 auto",
    minWidth: 0,
    gap: "8px",
    width: "100%",
    textAlign: "left",
    "&::before": {
        position: "absolute",
        top: "-1px",
        bottom: "-1px",
        left: "14px",
        width: "2px",
        content: '""',
        background: "var(--line-strong)",
        pointerEvents: "none",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
    '&[aria-expanded="true"]': {
        backgroundColor: "var(--control)",
        backgroundImage: "linear-gradient(var(--accent-wash), var(--accent-wash))",
    },
    '&[aria-expanded="true"] > span:first-child': {
        background: "var(--accent)",
    },
})

const commitNode = css({
    position: "relative",
    zIndex: 2,
    width: "10px",
    height: "10px",
    marginBlock: "3px",
    flex: "0 0 auto",
    border: "2px solid var(--accent)",
    borderRadius: "50%",
    background: "var(--control)",
})

const commitHeadingSpan = css({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const mergeParent = css({
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
        left: "14px",
        width: "2px",
        content: '""',
        background: "var(--line-strong)",
        pointerEvents: "none",
    },
})

const parentForSelect = css({
    color: "var(--text)",
    background: "var(--field)",
    border: "1px solid var(--line)",
    padding: "5px",
    borderRadius: "3px",
})

const bodySelectionSummaryButton = css({
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

const inspectionBreakout = css({
    flex: "0 0 620px",
    minWidth: "380px",
    overflow: "auto",
    background: "var(--panel)",
    border: "1px solid var(--line-strong)",
    borderLeft: "3px solid var(--accent-edge)",
    "&:focus-visible": { outline: "2px solid var(--accent-edge)", outlineOffset: "-2px" },
    "& .auxiliary-source": { display: "block", fontSize: "10px", color: "var(--muted)" },
})

const inspectionBreakoutHeader = css({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    background: "var(--panel-deep)",
    borderBottom: "1px solid var(--line)",
})

const closeDiffColumnButton = css({
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
    minWidth: "26px",
    minHeight: "26px",
})
import type { FileHistorySource } from "@git-workbench/shared"
import type { FileHistoryEntry } from "@git-workbench/shared"
import { createFileHistories, type FileHistoryState } from "./file-history"
import { createTrailCommits, type TrailCommitState } from "./trail-commit"
