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
interface ColumnState {
    repositoryId: string
    id: string
    column: Column
    graph: BranchGraph
    worktreePath?: string
    files: Map<string, FileState>
    history: Map<string, HistoryState>
    requestIds: Set<string>
    selected?: { group: string; path: string; view: DiffView }
    diff?: FileDiffPage
    diffLoading: boolean
    diffError?: string
    selection?: ChangeSelection
    wholeFiles: Map<string, { source: DiffSource; path: string; version: string }>
    diffGeneration: number
    notice?: string
    breakout: boolean
    focused: boolean
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
        state.selection = undefined
        state.diffGeneration++
        state.diffLoading = false
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
        if (state.selected && !state.diff)
            void readDiff(state)
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
                diffLoading: false,
                diffGeneration: 0,
                breakout: false,
                focused: false,
                showIgnored: false,
                filter: "",
                status: "all",
                wholeFiles: new Map(),
                alive: true,
            }
            columns.set(id, state)
            const created = state
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
            if (state.selected?.group == group) {
                if (!result.inventory.files.some(file => file.path == state.selected!.path && !file.ignored))
                    clearDiff(state)
                else if (refreshDiff)
                    void readDiff(state, false, true)
            }
        } catch (error) {
            if (state.alive && generation == files.generation) {
                files.error = message(error)
                if (state.selected?.group == group) {
                    state.selection = undefined
                    state.diff = undefined
                }
            }
        } finally {
            if (generation == files.generation) {
                files.loading = false
                update()
            }
        }
    }
    function clearDiff(state: ColumnState) {
        state.diffGeneration++
        cancel(state, requestId(state, "diff"))
        state.selected = undefined
        state.diff = undefined
        state.selection = undefined
        state.diffError = undefined
        state.diffLoading = false
    }
    function choose(state: ColumnState, group: string, file: ChangedFile) {
        clearDiff(state)
        state.selected = { group, path: file.path, view: "combined" }
        state.notice = undefined
        void readDiff(state)
    }
    async function readDiff(state: ColumnState, more = false, refresh = false) {
        const selected = state.selected
        const source = selected && state.files.get(selected.group)?.source
        if (!selected || !source || !state.alive || refresh && state.diffLoading)
            return
        const previous = state.diff
        const generation = ++state.diffGeneration
        state.diffLoading = true
        state.diffError = undefined
        update()
        try {
            const result = await options.api.readFileDiff(state.repositoryId, requestId(state, "diff"), {
                source,
                path: selected.path,
                view: selected.view,
                ...(more && previous ? { offset: previous.nextOffset, expectedVersion: previous.version } : {}),
            })
            if (!state.alive || generation != state.diffGeneration)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            const page = result.page
            if (previous && previous.version != page.version) {
                state.selection = undefined
                state.notice = "File changed. Change Selection cleared."
            }
            state.diff = more && previous
                ? { ...page, lines: [...previous.lines, ...page.lines] }
                : refresh && previous?.version == page.version
                ? previous
                : page
        } catch (error) {
            if (state.alive && generation == state.diffGeneration) {
                state.diffError = message(error)
                state.selection = undefined
                if (!more)
                    state.diff = undefined
            }
        } finally {
            if (generation == state.diffGeneration) {
                state.diffLoading = false
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
            if (!current.open && current.page?.commits.some(commit => commit.objectId == state.selected?.group))
                clearDiff(state)
            if (current.open && !current.page)
                void history(state, branch)
            update()
        }
    }
    function changeView(state: ColumnState, view: DiffView) {
        if (!state.selected)
            return
        state.selected.view = view
        state.diff = undefined
        state.selection = undefined
        void readDiff(state)
    }
    function selectLines(state: ColumnState, ids: number[]) {
        const page = state.diff
        if (!page?.selectable)
            return
        const selection = state.selection ?? { source: page.source, path: page.file.path, version: page.version, lineIds: [], rename: false }
        const current = new Set(selection.lineIds)
        const remove = ids.every(id => current.has(id))
        for (const id of ids) {
            if (remove)
                current.delete(id)
            else
                current.add(id)
        }
        state.selection = { ...selection, lineIds: [...current].sort((a, b) => a - b) }
        update()
    }
    function filterChanged(state: ColumnState) {
        const selected = state.selected
        const file = selected && state.files.get(selected.group)?.inventory?.files.find(file => file.path == selected.path)
        if (file && !matchesFilter(state, file))
            clearDiff(state)
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
                {files.loading && (
                    <p class="inspection-muted" role="status" mix={inspectionMuted}>
                        Reading files…
                    </p>
                )}
                {files.inventory && !all.some(file => !file.ignored) && (
                    <p class="inspection-muted" mix={inspectionMuted}>
                        {group == "working" ? "No Working Changes" : "No changes against this parent"}
                    </p>
                )}
                <FileTree
                    files={visible}
                    selected={state.selected?.group == group ? state.selected.path : undefined}
                    checked={new Set(state.wholeFiles.keys())}
                    prefix={group}
                    choose={file => choose(state, group, file)}
                    hide={() => {
                        clearDiff(state)
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
    function renderDiff(state: ColumnState): RemixNode {
        const page = state.diff
        const selected = state.selected
        if (!selected) {
            return (
                <p class="inspection-muted" mix={inspectionMuted}>
                    Choose a file to inspect its changes.
                </p>
            )
        }
        const layout = options.layout(state.repositoryId, state.id)
        return (
            <section class="diff-inspector" aria-label={`Diff for ${selected.path}`} mix={diffInspector}>
                <header class="diff-toolbar" mix={diffToolbar}>
                    <strong title={selected.path} mix={diffToolbarStrong}>
                        {selected.path}
                    </strong>
                    <div mix={diffToolbarDiv}>
                        <button
                            type="button"
                            aria-pressed={layout == "unified"}
                            mix={[diffToolbarButton, on("click", () => options.saveLayout(state.repositoryId, state.id, "unified"))]}
                        >
                            Unified
                        </button>
                        <button
                            type="button"
                            aria-pressed={layout == "split"}
                            mix={[diffToolbarButton, on("click", () => options.saveLayout(state.repositoryId, state.id, "split"))]}
                        >
                            Side by side
                        </button>
                        {!state.breakout && (
                            <button
                                type="button"
                                mix={[
                                    diffToolbarButton,
                                    on("click", () => {
                                        state.breakout = true
                                        update()
                                    }),
                                ]}
                            >
                                Break out diff
                            </button>
                        )}
                        <button
                            type="button"
                            aria-pressed={state.focused}
                            mix={[
                                diffToolbarButton,
                                on("click", () => {
                                    state.focused = !state.focused
                                    if (state.focused)
                                        state.breakout = true
                                    update()
                                }),
                            ]}
                        >
                            Focus diff
                        </button>
                    </div>
                </header>
                {page?.source.kind == "working" && (
                    <div class="diff-views" role="group" aria-label="Comparison" mix={diffViews}>
                        {([
                            "combined",
                            ...(page.file.staged ? ["staged", "unstaged"] : []),
                            ...(page.file.conflicted ? ["base", "ours", "theirs"] : []),
                        ] as DiffView[]).map(view => (
                            <button
                                type="button"
                                aria-pressed={selected.view == view}
                                mix={[diffViewsButton, on("click", () => changeView(state, view))]}
                            >
                                {view == "combined" ? "Working Changes" : view[0].toUpperCase() + view.slice(1)}
                            </button>
                        ))}
                    </div>
                )}
                {state.notice && (
                    <p class="inspection-notice" role="status" mix={inspectionNotice}>
                        {state.notice}
                    </p>
                )}
                {state.diffError && (
                    <p role="alert" mix={diffInspectorP}>
                        {state.diffError}{" "}
                        <button type="button" mix={[diffInspectorButton, on("click", () => readDiff(state))]}>
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
                                    checked={state.selection?.rename ?? false}
                                    mix={[
                                        diffInspectorInput,
                                        on("change", event => {
                                            state.selection = {
                                                source: page.source,
                                                path: page.file.path,
                                                version: page.version,
                                                lineIds: state.selection?.lineIds ?? [],
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
                        <DiffLines page={page} layout={layout} selected={state.selection?.lineIds ?? []} select={ids => selectLines(state, ids)} />
                        {state.selection && (
                            <div class="selection-summary" role="status" mix={selectionSummary}>
                                {state.selection.lineIds.length} lines selected{state.selection.rename ? " · rename selected" : ""}
                                <button
                                    type="button"
                                    mix={[
                                        selectionSummaryButton,
                                        on("click", () => {
                                            state.selection = undefined
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
                                disabled={state.diffLoading}
                                mix={[loadDiff, on("click", () => readDiff(state, true))]}
                            >
                                Load more
                            </button>
                        )}
                    </>
                )}
                {state.diffLoading && (
                    <p class="inspection-muted" role="status" mix={inspectionMuted}>
                        Reading diff…{" "}
                        <button
                            type="button"
                            mix={[
                                inspectionMutedButton,
                                on("click", () => {
                                    state.diffGeneration++
                                    state.diffLoading = false
                                    state.diffError = "Diff read cancelled."
                                    cancel(state, requestId(state, "diff"))
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
                <div class={`column-inspection ${state.focused ? "focused" : ""}`} mix={columnInspection}>
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
                    {!state.breakout && state.selected && renderDiff(state)}
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
                                                                    files.open = !files.open
                                                                    if (!files.open && state.selected?.group == commit.objectId)
                                                                        clearDiff(state)
                                                                    update()
                                                                } else {
                                                                    void readFiles(state, commit.objectId, { kind: "commit", objectId: commit.objectId })
                                                                }
                                                            }
                                                        }}
                                                    >
                                                        <div mix={accordion.root()}>
                                                            {current.loading && (
                                                                <p class="inspection-muted" mix={inspectionMuted}>
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
                                                                        <div class="inspect-commit" mix={accordion.item()}>
                                                                            <h4 class="disclosure-heading" mix={disclosureHeading}>
                                                                                <button
                                                                                    class="commit-heading"
                                                                                    type="button"
                                                                                    mix={[commitHeading, accordion.trigger()]}
                                                                                >
                                                                                    <code mix={commitHeadingCode}>
                                                                                        {commit.objectId.slice(0, 8)}
                                                                                    </code>
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
                                                                                                            clearDiff(state)
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
                <aside class={`inspection-breakout ${state.focused ? "focused" : ""}`} mix={inspectionBreakout} aria-label={`${state.column.name} diff`}>
                    <header mix={inspectionBreakoutHeader}>
                        <span>Diff · {state.column.name}</span>
                        <button
                            type="button"
                            aria-label="Close diff column"
                            mix={[
                                closeDiffColumnButton,
                                on("click", () => {
                                    state.breakout = false
                                    state.focused = false
                                    update()
                                }),
                            ]}
                        >
                            ×
                        </button>
                    </header>
                    {renderDiff(state)}
                </aside>
            )
        },
    }
}

function FileTree(
    handle: Handle<
        {
            files: ChangedFile[]
            selected?: string
            checked: Set<string>
            prefix: string
            choose(file: ChangedFile): void
            check(file: ChangedFile): void
            hide(): void
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
                <div class={`change-file ${props.selected == file.path ? "active" : ""}`} mix={changeFile}>
                    <input
                        type="checkbox"
                        aria-label={`Select file ${file.path}`}
                        checked={props.checked.has(`${props.prefix}:${file.path}`)}
                        mix={[selectFileInput, on("change", () => props.check(file))]}
                    />
                    <button
                        type="button"
                        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                        aria-pressed={props.selected == file.path}
                        mix={[changeFileButton, on("click", () => props.choose(file))]}
                    >
                        <span class={`file-status ${file.status.replaceAll(" ", "-")}`} mix={fileStatus}>
                            {file.conflicted ? "!" : file.status[0].toUpperCase()}
                        </span>
                        <span mix={changeFileSpan}>
                            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path.split("/").at(-1)}
                        </span>
                        {file.staged && (
                            <small class="staged-badge" mix={stagedBadge}>
                                staged
                            </small>
                        )}
                        {file.submodule && <small>submodule</small>}
                    </button>
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
                                    if (props.selected?.startsWith(path))
                                        props.hide()
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
        return <div class="file-tree">{renderDirectory(tree)}</div>
    }
}

function message(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

const changeFileList = css({
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

const inspectionMuted = css({
    margin: "0",
    padding: "8px 10px",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
})

const diffInspector = css({
    borderBlock: "1px solid var(--line-strong)",
    background: "var(--panel)",
    minWidth: "0",
})

const diffToolbar = css({
    padding: "8px",
    borderBottom: "1px solid var(--line)",
})

const diffToolbarStrong = css({
    display: "block",
    overflowWrap: "anywhere",
    marginBottom: "6px",
    font: "12px var(--mono)",
})

const diffToolbarDiv = css({
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    flex: "0 0 auto",
})

const diffToolbarButton = css({
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
    minWidth: "26px",
    minHeight: "26px",
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
    padding: "8px 10px",
    color: "var(--muted)",
    fontSize: "12px",
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
    "&.focused .stack-inspection": {
        display: "none",
    },
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
    borderBottom: "1px solid var(--line)",
    "&:hover": {
        background: "var(--control-hover)",
    },
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
})

const commitHeadingCode = css({
    color: "var(--muted)",
    font: "11px var(--mono)",
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
    "&.focused": {
        flexBasis: "min(1000px, 75vw)",
    },
    "& .diff-lines": {
        maxHeight: "calc(100vh - 280px)",
    },
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
    display: "flex",
    gap: "3px",
    alignItems: "center",
    padding: "1px 6px",
    minHeight: "29px",
    "&.active": {
        background: "var(--accent-wash)",
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
    '&[aria-pressed="true"]': {
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
    "&:nth-child(2)": {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
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
