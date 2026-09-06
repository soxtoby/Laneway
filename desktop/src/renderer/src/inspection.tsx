import type { BranchGraph, BranchGraphBranchNode, BranchGraphVirtualBranch, BranchHistoryPage, ChangedFile, ChangeSelection, ChangesInventory, DiffLayout, DiffSource, DiffView, FileDiffPage } from "@git-workbench/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import * as accordion from "remix/ui/accordion/primitives"
import { DiffLines } from "./diff"

type Column = BranchGraphBranchNode | BranchGraphVirtualBranch
interface Options {
    api: Window["workbench"]
    update(): Promise<AbortSignal>
    signal: AbortSignal
    layout(repositoryId: string, columnId: string): DiffLayout
    saveLayout(repositoryId: string, columnId: string, layout: DiffLayout): void
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
interface ColumnState {
    repositoryId: string
    id: string
    column: Column
    graph: BranchGraph
    worktreePath?: string
    files: Map<string, FileState>
    history: Map<string, HistoryState>
    requestIds: Set<string>
    diffs: Map<string, FileDiffState>
    wholeFiles: Map<string, { source: DiffSource; path: string; version: string }>
    breakout?: FileDiffState
    showIgnored: boolean
    filter: string
    status: string
    alive: boolean
}

export function createInspection(options: Options) {
    const columns = new Map<string, ColumnState>()
    let activeRepositoryId: string | undefined
    const key = (repositoryId: string, id: string) => JSON.stringify([repositoryId, id])
    const update = () => {
        if (!options.signal.aborted)
            void options.update()
    }
    const refresh = () => {
        for (const state of columns.values()) {
            if (state.repositoryId == activeRepositoryId && state.worktreePath)
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
            for (const state of columns.values())
                suspend(state)
        } else {
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
        suspend(state)
    }
    function resume(state: ColumnState) {
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
            state = {
                repositoryId,
                id: column.id,
                column,
                graph,
                worktreePath,
                files: new Map(),
                history: new Map(),
                requestIds: new Set(),
                diffs: new Map(),
                showIgnored: false,
                filter: "",
                status: "all",
                wholeFiles: new Map(),
                alive: true,
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
        return state
    }
    async function readFiles(state: ColumnState, group: string, source: DiffSource, refreshDiff = false) {
        let files = state.files.get(group)
        if (!files) {
            files = { source, loading: false, open: true, generation: 0 }
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
        state.diffs.delete(diffKey(diff.group, diff.path))
        if (state.breakout == diff)
            state.breakout = undefined
    }
    function clearGroup(state: ColumnState, group: string, prefix = "") {
        for (const diff of state.diffs.values()) {
            if (diff.group == group && diff.path.startsWith(prefix))
                clearDiff(state, diff)
        }
    }
    function choose(state: ColumnState, group: string, file: ChangedFile) {
        const id = diffKey(group, file.path)
        const selected = state.diffs.get(id)
        if (selected) {
            clearDiff(state, selected)
            update()
            return
        }
        const diff: FileDiffState = { group, path: file.path, view: "combined", loading: false, generation: 0, showWhitespace: false }
        state.diffs.set(id, diff)
        void readDiff(state, diff)
    }
    async function readDiff(state: ColumnState, diff: FileDiffState, more = false, refresh = false) {
        const source = state.files.get(diff.group)?.source
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
                ...(more && previous ? { offset: previous.nextOffset, expectedVersion: previous.version } : {}),
            })
            if (!state.alive || generation != diff.generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            const page = result.page
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
        const base = branch.base.status == "known" ? branch.base.tip : undefined
        if (!base)
            return
        const historyKey = `${branch.tip}:${base}`
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
                baseTip: base,
                limit: 30,
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
        if (!current || current.key != `${branch.tip}:${branch.base.status == "known" ? branch.base.tip : ""}`)
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
                    flat={group != "working"}
                    files={visible}
                    expanded={new Set([...state.diffs.values()].filter(diff => diff.group == group).map(diff => diff.path))}
                    controls={file => {
                        const diff = state.diffs.get(diffKey(group, file.path))
                        return diff && state.breakout != diff ? renderDiffControls(state, diff) : null
                    }}
                    diff={file => {
                        const diff = state.diffs.get(diffKey(group, file.path))
                        return diff && state.breakout != diff ? renderDiff(state, diff) : null
                    }}
                    checked={new Set(state.wholeFiles.keys())}
                    prefix={group}
                    choose={file => choose(state, group, file)}
                    hide={path => {
                        clearGroup(state, group, path)
                        update()
                    }}
                    check={file => {
                        const id = `${group}:${file.path}`
                        if (state.wholeFiles.has(id))
                            state.wholeFiles.delete(id)
                        else if (files.inventory)
                            state.wholeFiles.set(id, { source: files.inventory.source, path: file.path, version: files.inventory.version })
                        update()
                    }}
                />
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
        const layout = options.layout(state.repositoryId, state.id)
        return (
            <div class="diff-controls" mix={diffToolbarDiv}>
                <button
                    type="button"
                    aria-label="Unified"
                    title="Unified"
                    aria-pressed={layout == "unified"}
                    mix={[diffToolbarButton, on("click", () => options.saveLayout(state.repositoryId, state.id, "unified"))]}
                >
                    {diffIcon("unified")}
                </button>
                <button
                    type="button"
                    aria-label="Side by side"
                    title="Side by side"
                    aria-pressed={layout == "split"}
                    mix={[diffToolbarButton, on("click", () => options.saveLayout(state.repositoryId, state.id, "split"))]}
                >
                    {diffIcon("split")}
                </button>
                <button
                    type="button"
                    aria-label="Show whitespace"
                    title="Show whitespace"
                    aria-pressed={diff.showWhitespace}
                    mix={[
                        diffToolbarButton,
                        on("click", () => {
                            diff.showWhitespace = !diff.showWhitespace
                            update()
                        }),
                    ]}
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <path d="M13 2H6a3.5 3.5 0 0 0 0 7h2M8 2v12M11 2v12" />
                    </svg>
                </button>
                {state.breakout != diff && (
                    <button
                        type="button"
                        aria-label="Break out diff"
                        title="Break out diff"
                        mix={[
                            diffToolbarButton,
                            on("click", () => {
                                state.breakout = diff
                                update()
                            }),
                        ]}
                    >
                        {diffIcon("breakout")}
                    </button>
                )}
            </div>
        )
    }
    function renderDiff(state: ColumnState, diff: FileDiffState): RemixNode {
        const page = diff.page
        const layout = options.layout(state.repositoryId, state.id)
        return (
            <section class="diff-inspector" aria-label={`Diff for ${diff.path}`} mix={diffInspector}>
                {state.breakout == diff && (
                    <header class="diff-toolbar" mix={diffToolbar}>
                        {state.breakout == diff && (
                            <strong title={diff.path} mix={diffToolbarStrong}>
                                {fileLabel(diff.path)}
                            </strong>
                        )}
                        {renderDiffControls(state, diff)}
                    </header>
                )}
                {page?.source.kind == "working" && (
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
                        {page.file.oldPath && page.view == "combined" && (
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
                            selected={diff.selection?.lineIds ?? []}
                            select={ids => selectLines(diff, ids)}
                        />
                        {diff.selection && (
                            <div class="selection-summary" role="status" mix={selectionSummary}>
                                {diff.selection.lineIds.length} lines selected{diff.selection.rename ? " · rename selected" : ""}
                                <button
                                    type="button"
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
    return {
        retainRepositories(ids: string[]) {
            for (const [id, state] of columns) {
                if (!ids.includes(state.repositoryId)) {
                    dispose(state)
                    columns.delete(id)
                }
            }
        },
        activate(repositoryId?: string) {
            if (activeRepositoryId != repositoryId) {
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
        retain(repositoryId: string, ids: string[]) {
            for (const [id, state] of columns) {
                if (state.repositoryId == repositoryId && !ids.includes(state.id)) {
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
                branch = last.base.status == "known"
                    ? graph.branches.find(item => item.id == (last.base.status == "known" ? last.base.branchId : ""))
                    : undefined
            }
            return (
                <div class="column-inspection" mix={columnInspection}>
                    <div class="inspection-filters" mix={inspectionFilters}>
                        <input
                            aria-label="Filter changed files"
                            placeholder="Filter files…"
                            value={state.filter}
                            mix={[
                                filterChangedFilesInput,
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
                    </div>
                    {state.worktreePath && (
                        <section class="working-changes">
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
                                if (values.includes(branch.id) != (state.history.get(branch.id)?.open ?? false))
                                    toggleHistory(state, branch)
                            }
                        }}
                    >
                        <div class="stack-inspection" mix={accordion.root()}>
                            {stack.map(branch => {
                                const current = state.history.get(branch.id)
                                return (
                                    <accordion.ItemContext key={branch.id} value={branch.id} disabled={branch.base.status != "known"}>
                                        <section class="stack-branch" mix={[stackBranch, accordion.item()]}>
                                            <h3 class="disclosure-heading" mix={disclosureHeading}>
                                                <button class="stack-heading" type="button" mix={[stackHeading, accordion.trigger()]}>
                                                    <span>{current?.open ? "▾" : "▸"} {branch.name}</span>
                                                    <small mix={stackHeadingSmall}>
                                                        {branch.base.status == "known" ? "Unique commits" : "Base unresolved"}
                                                    </small>
                                                </button>
                                            </h3>
                                            <div hidden={!current?.open} mix={accordion.content()}>
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
                                                                            <h4 class="disclosure-heading" mix={disclosureHeading}>
                                                                                <button
                                                                                    class="commit-heading"
                                                                                    type="button"
                                                                                    mix={[commitHeading, accordion.trigger()]}
                                                                                >
                                                                                    <span aria-hidden="true">{files?.open ? "▾" : "▸"}</span>
                                                                                    <span mix={commitHeadingSpan}>
                                                                                        {commit.subject}
                                                                                    </span>
                                                                                </button>
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
                                                                    More commits
                                                                </button>
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
        breakout(repositoryId: string, columnId: string): RemixNode {
            const state = columns.get(key(repositoryId, columnId))
            if (!state?.breakout)
                return null
            return (
                <aside class="inspection-breakout" mix={inspectionBreakout} aria-label={`${state.column.name} diff`}>
                    <header mix={inspectionBreakoutHeader}>
                        <span>Diff · {state.column.name}</span>
                        <button
                            type="button"
                            aria-label="Close diff column"
                            mix={[
                                closeDiffColumnButton,
                                on("click", () => {
                                    state.breakout = undefined
                                    update()
                                }),
                            ]}
                        >
                            ×
                        </button>
                    </header>
                    {renderDiff(state, state.breakout)}
                </aside>
            )
        },
    }
}

function FileTree(
    handle: Handle<
        {
            files: ChangedFile[]
            flat?: boolean
            expanded: Set<string>
            diff(file: ChangedFile): RemixNode
            controls(file: ChangedFile): RemixNode
            checked: Set<string>
            prefix: string
            choose(file: ChangedFile): void
            check(file: ChangedFile): void
            hide(path: string): void
        }
    >,
) {
    const collapsed = new Set<string>()
    return () => {
        const props = handle.props
        interface Directory {
            files: ChangedFile[]
            children: Map<string, Directory>
        }
        const tree: Directory = { files: [], children: new Map() }
        for (const file of props.files) {
            let directory = tree
            for (const part of file.path.split("/").slice(0, -1)) {
                let child = directory.children.get(part)
                if (!child) {
                    child = { files: [], children: new Map() }
                    directory.children.set(part, child)
                }
                directory = child
            }
            directory.files.push(file)
        }
        const rows = (files: ChangedFile[]) =>
            files.map(file => (
                <div key={file.path} class="file-inspection">
                    <div class={`change-file ${props.expanded.has(file.path) ? "active" : ""}`} mix={changeFile}>
                        <input
                            type="checkbox"
                            aria-label={`Select file ${file.path}`}
                            checked={props.checked.has(`${props.prefix}:${file.path}`)}
                            mix={[selectFileInput, on("change", () => props.check(file))]}
                        />
                        <button
                            type="button"
                            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                            aria-expanded={props.expanded.has(file.path)}
                            mix={[changeFileButton, on("click", () => props.choose(file))]}
                        >
                            <span class={`file-status ${file.status.replaceAll(" ", "-")}`} mix={fileStatus}>
                                {changeIcon(file.conflicted ? "conflicted" : file.status)}
                            </span>
                            {fileLabel(file.path, props.flat || !!file.oldPath, file.oldPath)}
                            {file.staged && (
                                <small class="staged-badge" mix={stagedBadge}>
                                    staged
                                </small>
                            )}
                            {file.submodule && <small>submodule</small>}
                        </button>
                        {props.controls(file)}
                    </div>
                    {props.diff(file)}
                </div>
            ))
        const renderDirectory = (directory: Directory, prefix = ""): RemixNode => (
            <>
                {[...directory.children].map(([name, child]) => {
                    const path = `${prefix}${name}/`
                    return (
                        <details
                            open={!collapsed.has(path)}
                            mix={[on("toggle", event => {
                                if (event.currentTarget.open)
                                    collapsed.delete(path)
                                else {
                                    collapsed.add(path)
                                    props.hide(path)
                                }
                            })]}
                        >
                            <summary mix={fileTreeSummary}>
                                {name}/
                            </summary>
                            {renderDirectory(child, path)}
                        </details>
                    )
                })}
                {rows(directory.files)}
            </>
        )
        return <div class="file-tree">{props.flat ? rows(props.files) : renderDirectory(tree)}</div>
    }
}

function changeIcon(status: string) {
    const paths: Record<string, string> = {
        added: "M8 3v10M3 8h10",
        deleted: "M3 8h10",
        modified: "m3 10 7-7 3 3-7 7H3v-3ZM9 4l3 3",
        renamed: "M2 8h11M9 4l4 4-4 4",
        copied: "M6 6h7v7H6ZM3 10H2V2h8v1",
        conflicted: "M8 2 1 14h14L8 2ZM8 6v4M8 11v1",
    }
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" role="img" aria-label={status}>
            <path d={paths[status] ?? "M8 3v10M3 8h10"} />
        </svg>
    )
}

function fileLabel(path: string, showFolder = true, oldPath?: string) {
    const separator = path.lastIndexOf("/") + 1
    const folder = `${oldPath ? `${oldPath} → ` : ""}${showFolder ? path.slice(0, separator) : ""}`
    return (
        <span mix={changeFileSpan}>
            {folder && <span class="file-folder" mix={fileFolder}>{folder}</span>}
            <span class="file-name" mix={fileName}>{path.slice(separator)}</span>
        </span>
    )
}

function diffIcon(kind: "unified" | "split" | "breakout") {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">
            {kind == "breakout"
                ? <path d="M9 2h5v5M14 2 7 9M7 3H2v11h11V9" />
                : (
                    <>
                        <rect x="2" y="2" width="12" height="12" rx="1" />
                        <path d={kind == "split" ? "M8 2v12M4 5h2M10 5h2M4 8h2M10 8h2" : "M4 5h8M4 8h8M4 11h8"} />
                    </>
                )}
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

const diffToolbarDiv = css({
    marginLeft: "auto",
    display: "flex",
    gap: "4px",
    flex: "0 0 auto",
})

const diffToolbarButton = css({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "2px",
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
    width: "22px",
    height: "22px",
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
    overflow: "auto",
    flex: "1",
    minHeight: "0",
})

const inspectionFilters = css({
    display: "flex",
    gap: "4px",
    padding: "8px",
    borderBottom: "1px solid var(--line)",
})

const filterChangedFilesInput = css({
    width: "100%",
    minWidth: "40px",
    color: "var(--text)",
    background: "var(--field)",
    border: "1px solid var(--line)",
    padding: "5px",
    borderRadius: "3px",
})

const filterChangeStatusSelect = css({
    color: "var(--text)",
    background: "var(--field)",
    border: "1px solid var(--line)",
    padding: "5px",
    borderRadius: "3px",
})

const workingChangesHeader = css({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    background: "var(--panel-deep)",
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
    border: "1px solid transparent",
    borderLeftWidth: "3px",
    marginBlock: "2px",
    borderRadius: "3px",
    '&[data-expanded="true"]': {
        borderColor: "var(--line)",
        borderLeftColor: "var(--accent-edge)",
        background: "var(--panel)",
    },
})

const commitHeading = css({
    border: "0",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "8px 10px",
    font: "inherit",
    cursor: "pointer",
    display: "flex",
    gap: "8px",
    width: "100%",
    textAlign: "left",
    "&:hover": {
        background: "var(--control-hover)",
    },
    '&[aria-expanded="true"]': {
        background: "var(--accent-wash)",
    },
})

const commitHeadingSpan = css({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const mergeParent = css({
    display: "flex",
    gap: "8px",
    alignItems: "center",
    padding: "6px",
    fontSize: "11px",
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

const changeFile = css({
    position: "sticky",
    top: "0",
    zIndex: 5,
    background: "var(--panel)",
    display: "flex",
    gap: "3px",
    alignItems: "center",
    padding: "1px 6px",
    minHeight: "29px",
    "&.active": {
        backgroundImage: "linear-gradient(var(--accent-wash), var(--accent-wash))",
    },
    ".file-tree details &": {
        paddingLeft: "14px",
    },
})

const selectFileInput = css({
    accentColor: "var(--accent)",
    flex: "0 0 14px",
    width: "14px",
    height: "14px",
    minHeight: 0,
    padding: 0,
    margin: "0 3px 0 0",
})

const changeFileButton = css({
    border: "0",
    background: "transparent",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    minWidth: "0",
    textAlign: "left",
    "&:hover": {
        background: "var(--control-hover)",
    },
    '&[aria-expanded="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
})

const fileStatus = css({
    width: "14px",
    flex: "0 0 14px",
    color: "var(--warning)",
    font: "11px var(--mono)",
    "&.added": {
        color: "var(--accent)",
    },
    "&.deleted": {
        color: "var(--danger)",
    },
    "&.conflicted": {
        color: "var(--danger)",
    },
    "&:nth-child(2)": {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
})

const changeFileSpan = css({
    display: "flex",
    minWidth: "0",
    maxWidth: "100%",
    whiteSpace: "nowrap",
})

const fileFolder = css({
    color: "var(--muted)",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

const fileName = css({
    flex: "0 0 auto",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

const stagedBadge = css({
    color: "var(--muted)",
    marginLeft: "auto",
    fontSize: "10px",
})

const fileTreeSummary = css({
    padding: "5px 8px",
    color: "var(--muted)",
    font: "11px var(--mono)",
    overflowWrap: "anywhere",
    cursor: "pointer",
})
