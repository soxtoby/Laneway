import type { BranchGraph, BranchGraphBranchNode, ChangesInventory, DiffLayout, FileDiffPage } from "@laneway/shared"
import { css, on, type RemixNode } from "remix/ui"
import { auxiliaryCloseButton, auxiliaryColumnFrame, auxiliaryColumnHeader } from "./auxiliary-columns"
import { DiffLines } from "./diff"
import { DiffControls } from "./diff-controls"
import { FileTree } from "./file-list"
import { Icon } from "./icons"

export interface BranchComparisonState {
    kind: "comparison"
    repositoryId: string
    fromRef: string
    toRef: string
    fromName: string
    toName: string
    fingerprint: string
    inventory?: ChangesInventory
    patches: Map<string, { page?: FileDiffPage; loading: boolean; error?: string; requestId?: string; showWhitespace?: boolean }>
    generation: number
    requestPrefix: string
    requests: Set<string>
    loading: boolean
    error?: string
    layout: DiffLayout
    showEntireFiles?: boolean
    alive: boolean
}

let comparison = css({
    ...auxiliaryColumnFrame,
    minWidth: "380px",
    "& > header": { ...auxiliaryColumnHeader, position: "sticky", top: 0, zIndex: 10 },
    "& > header strong": { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    "& > header > button": auxiliaryCloseButton,
    "& .change-file": { top: "46px" },
    "& > p button, & .comparison-patch button:not(.diff-lines button), & > button": {
        font: "inherit",
        color: "var(--text)",
        background: "var(--control)",
        border: "1px solid var(--line)",
        padding: "4px 7px",
        cursor: "pointer",
    },
    "& button:disabled": { opacity: 0.5, cursor: "default" },
    "& p": { margin: "8px 10px", fontSize: "12px" },
    "& small, & .auxiliary-source": { color: "var(--muted)" },
    "& .comparison-patch": { minWidth: 0, overflow: "hidden" },
})
import type { FileHistorySource } from "@laneway/shared"

export function createBranchComparisons(options: { api: Window["laneway"]; update(): Promise<AbortSignal>; signal: AbortSignal }) {
    let states = new Set<BranchComparisonState>()
    let sequence = 0
    let activeRepositoryId: string | undefined
    let update = () => {
        if (!options.signal.aborted)
            void options.update()
    }
    let current = (state: BranchComparisonState, generation: number) => state.alive && state.generation == generation
    let fingerprint = (graph: BranchGraph, from: string, to: string) =>
        JSON.stringify([from, to].map(ref => {
            let branch = graph.branches.find(branch => branch.refs.includes(ref))
            return branch ? ref == branch.upstreamRef ? branch.upstreamTip : branch.tip : null
        }))

    return {
        create(repositoryId: string, from: BranchGraphBranchNode, to: BranchGraphBranchNode, graph: BranchGraph) {
            let state: BranchComparisonState = {
                kind: "comparison",
                repositoryId,
                fromRef: from.preferredRef,
                toRef: to.preferredRef,
                fromName: from.name,
                toName: to.name,
                fingerprint: fingerprint(graph, from.preferredRef, to.preferredRef),
                patches: new Map(),
                generation: 0,
                requestPrefix: `comparison:${++sequence}`,
                requests: new Set(),
                loading: false,
                layout: "unified",
                alive: true,
            }
            states.add(state)
            void inventory(state)

            return state
        },
        dispose(state: BranchComparisonState) {
            state.alive = false
            cancel(state)
            states.delete(state)
        },
        activate(repositoryId?: string) {
            if (activeRepositoryId == repositoryId)
                return
            for (let state of states) {
                if (state.repositoryId == activeRepositoryId)
                    cancel(state)
                if (state.repositoryId == repositoryId)
                    void inventory(state)
            }
            activeRepositoryId = repositoryId
        },
        refresh(repositoryId: string, graph: BranchGraph) {
            for (let state of [...states].filter(state => state.repositoryId == repositoryId)) {
                let next = fingerprint(graph, state.fromRef, state.toRef)
                if (next != state.fingerprint) {
                    state.fingerprint = next
                    cancel(state)
                    if (repositoryId == activeRepositoryId)
                        void inventory(state)
                }
            }
        },
        renameBranch(repositoryId: string, oldRef: string, newRef: string) {
            for (let state of [...states].filter(state => state.repositoryId == repositoryId)) {
                if (state.fromRef == oldRef)
                    state.fromRef = newRef
                if (state.toRef == oldRef)
                    state.toRef = newRef
            }
        },
        render(
            state: BranchComparisonState,
            id: string,
            sourceId: string,
            close: () => void,
            retarget: () => void,
            history: (source: FileHistorySource, path: string) => void,
        ): RemixNode {
            return (
                <aside
                    key={id}
                    class="branch-comparison"
                    data-auxiliary-id={id}
                    data-source-column-id={sourceId}
                    tabIndex={-1}
                    aria-label={`Compare ${state.fromName} to ${state.toName}`}
                    mix={comparison}
                >
                    <header>
                        <strong
                            title={state.inventory?.source.kind == "comparison"
                                ? `${state.inventory.source.fromObjectId} → ${state.inventory.source.toObjectId}`
                                : undefined}
                        >
                            {state.fromName} → {state.toName}
                        </strong>
                        <button type="button" aria-label="Close comparison" mix={on("click", close)}>
                            <Icon name="close" size={15} />
                        </button>
                    </header>
                    {state.loading && !state.inventory && <p role="status">Reading comparison…</p>}
                    {state.error && (
                        <p role="alert">
                            {state.error}
                            {state.inventory ? " Showing the last comparison." : ""}
                            <button type="button" mix={on("click", () => inventory(state))}>Retry comparison</button>
                            <button type="button" mix={on("click", retarget)}>Compare with…</button>
                        </p>
                    )}
                    {state.inventory?.files.length == 0 && !state.error && <p>No differences between these branch tips.</p>}
                    <FileTree
                        actions={file => [{
                            label: `History in ${state.fromName}`,
                            run: () => history({ kind: "branch", ref: state.fromRef }, file.oldPath ?? file.path),
                        }, { label: `History in ${state.toName}`, run: () => history({ kind: "branch", ref: state.toRef }, file.path) }]}
                        flat
                        files={state.inventory?.files ?? []}
                        expanded={new Set(state.patches.keys())}
                        controls={file => {
                            let patch = state.patches.get(file.path)
                            return patch
                                ? (
                                    <DiffControls
                                        layout={state.layout}
                                        showWhitespace={patch.showWhitespace ?? false}
                                        showEntireFiles={state.showEntireFiles ?? false}
                                        toggleEntireFiles={() => {
                                            state.showEntireFiles = !state.showEntireFiles
                                            for (let [path, open] of state.patches) {
                                                if (open.requestId)
                                                    void options.api.cancelInspection(state.repositoryId, open.requestId)
                                                open.loading = false
                                                open.page = undefined
                                                void readPatch(state, path)
                                            }
                                            update()
                                        }}
                                        setLayout={layout => {
                                            state.layout = layout
                                            update()
                                        }}
                                        toggleWhitespace={() => {
                                            patch.showWhitespace = !patch.showWhitespace
                                            update()
                                        }}
                                    />
                                )
                                : null
                        }}
                        choose={file => toggle(state, file.path)}
                        hide={() => {}}
                        diff={file => {
                            let patch = state.patches.get(file.path)
                            return (
                                patch
                                    ? (
                                        <div class="comparison-patch">
                                            {patch.loading && !patch.page && <p role="status">Reading diff…</p>}
                                            {patch.error && (
                                                <p role="alert">
                                                    {patch.error}{" "}
                                                    <button type="button" mix={on("click", () => readPatch(state, file.path))}>
                                                        Retry diff
                                                    </button>
                                                </p>
                                            )}
                                            {patch.page && (
                                                <>
                                                    {patch.page.summary.map(text => <p>{text}</p>)}
                                                    <DiffLines
                                                        page={patch.page}
                                                        layout={state.layout}
                                                        showWhitespace={patch.showWhitespace ?? false}
                                                        selected={[]}
                                                        select={() => {}}
                                                    />
                                                    {patch.page.nextOffset != undefined && (
                                                        <button
                                                            type="button"
                                                            disabled={patch.loading || state.loading || !!state.error}
                                                            mix={on("click", () => readPatch(state, file.path, true))}
                                                        >
                                                            Load more diff
                                                        </button>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    )
                                    : null
                            )
                        }}
                    />
                    {state.inventory?.nextOffset != undefined && (
                        <button
                            type="button"
                            disabled={state.loading || !!state.error}
                            mix={on("click", () => inventory(state, true))}
                        >
                            Load more files
                        </button>
                    )}
                </aside>
            )
        },
    }

    function toggle(state: BranchComparisonState, path: string) {
        if (state.patches.has(path)) {
            let requestId = state.patches.get(path)?.requestId
            state.patches.delete(path)
            if (requestId)
                void options.api.cancelInspection(state.repositoryId, requestId)
        } else {
            state.patches.set(path, { loading: false })
            void readPatch(state, path)
        }
        update()
    }

    function cancel(state: BranchComparisonState) {
        state.generation++
        state.loading = false
        for (let request of state.requests)
            void options.api.cancelInspection(state.repositoryId, request)
        for (let patch of state.patches.values())
            patch.loading = false
    }

    async function inventory(state: BranchComparisonState, more = false) {
        if (!state.alive || state.loading || more && state.inventory?.nextOffset == undefined)
            return

        if (!more)
            cancel(state)
        let generation = state.generation
        let requestId = `${state.requestPrefix}:inventory:${generation}`
        state.requests.add(requestId)
        state.loading = true
        state.error = undefined
        update()

        try {
            let result = await options.api.readChanges(
                state.repositoryId,
                requestId,
                more
                    ? { source: state.inventory!.source, offset: state.inventory!.nextOffset }
                    : { source: { kind: "branches", fromRef: state.fromRef, toRef: state.toRef } },
            )
            if (!current(state, generation))
                return
            if (!result.ok)
                throw new Error(result.error.message)
            let previous = state.inventory
            if (more && previous?.version != result.inventory.version)
                throw new Error("Comparison inputs changed. Refresh before loading more files.")
            state.inventory = { ...result.inventory, files: more ? [...previous!.files, ...result.inventory.files] : result.inventory.files }
            if (!more) {
                for (let path of state.patches.keys()) {
                    if (!state.inventory.files.some(file => file.path == path))
                        state.patches.delete(path)
                    else
                        void readPatch(state, path)
                }
            }
        } catch (error) {
            if (current(state, generation))
                state.error = error instanceof Error ? error.message : String(error)
        } finally {
            state.requests.delete(requestId)
            if (current(state, generation)) {
                state.loading = false
                update()
            }
        }
    }

    async function readPatch(state: BranchComparisonState, path: string, more = false) {
        if (!state.inventory || !state.alive)
            return

        let patch = state.patches.get(path)
        if (!patch || patch.loading)
            return
        let generation = state.generation
        let requestId = `${state.requestPrefix}:file:${generation}:${++sequence}`
        patch.requestId = requestId
        state.requests.add(requestId)
        patch.loading = true
        patch.error = undefined
        update()

        try {
            let result = await options.api.readFileDiff(state.repositoryId, requestId, {
                source: state.inventory.source,
                inventoryVersion: state.inventory.version,
                path,
                entireFile: state.showEntireFiles,
                ...(more ? { offset: patch.page?.nextOffset, expectedVersion: patch.page?.version } : {}),
            })
            if (!current(state, generation) || state.patches.get(path) != patch || patch.requestId != requestId)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            patch.page = { ...result.page, selectable: false, lines: more ? [...patch.page!.lines, ...result.page.lines] : result.page.lines }
        } catch (error) {
            if (current(state, generation) && state.patches.get(path) == patch && patch.requestId == requestId)
                patch.error = error instanceof Error ? error.message : String(error)
        } finally {
            state.requests.delete(requestId)
            if (current(state, generation) && state.patches.get(path) == patch && patch.requestId == requestId) {
                patch.loading = false
                update()
            }
        }
    }
}
