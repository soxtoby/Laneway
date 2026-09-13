import type { BranchGraph, BranchGraphBranchNode, ChangesInventory, DiffLayout, FileDiffPage } from "@git-workbench/shared"
import { css, on, type RemixNode } from "remix/ui"
import { DiffLines } from "./diff"
import { DiffControls } from "./diff-controls"
import { FileTree } from "./file-list"

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
    alive: boolean
}

export function createBranchComparisons(options: { api: Window["workbench"]; update(): Promise<AbortSignal>; signal: AbortSignal }) {
    const states = new Set<BranchComparisonState>()
    let sequence = 0
    let activeRepositoryId: string | undefined
    const update = () => {
        if (!options.signal.aborted)
            void options.update()
    }
    const current = (state: BranchComparisonState, generation: number) => state.alive && state.generation == generation
    const fingerprint = (graph: BranchGraph, from: string, to: string) =>
        JSON.stringify([from, to].map(ref => {
            const branch = graph.branches.find(branch => branch.refs.includes(ref))
            return branch ? ref == branch.upstreamRef ? branch.upstreamTip : branch.tip : null
        }))

    function cancel(state: BranchComparisonState) {
        state.generation++
        state.loading = false
        for (const request of state.requests)
            void options.api.cancelInspection(state.repositoryId, request)
        for (const patch of state.patches.values())
            patch.loading = false
    }

    async function inventory(state: BranchComparisonState, more = false) {
        if (!state.alive || state.loading || more && state.inventory?.nextOffset == undefined)
            return
        if (!more)
            cancel(state)
        const generation = state.generation
        const requestId = `${state.requestPrefix}:inventory:${generation}`
        state.requests.add(requestId)
        state.loading = true
        state.error = undefined
        update()
        try {
            const result = await options.api.readChanges(
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
            const previous = state.inventory
            if (more && previous?.version != result.inventory.version)
                throw new Error("Comparison inputs changed. Refresh before loading more files.")
            state.inventory = { ...result.inventory, files: more ? [...previous!.files, ...result.inventory.files] : result.inventory.files }
            if (!more) {
                for (const path of state.patches.keys()) {
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
        const patch = state.patches.get(path)
        if (!patch || patch.loading)
            return
        const generation = state.generation
        const requestId = `${state.requestPrefix}:file:${generation}:${++sequence}`
        patch.requestId = requestId
        state.requests.add(requestId)
        patch.loading = true
        patch.error = undefined
        update()
        try {
            const result = await options.api.readFileDiff(state.repositoryId, requestId, {
                source: state.inventory.source,
                inventoryVersion: state.inventory.version,
                path,
                ...(more ? { offset: patch.page?.nextOffset, expectedVersion: patch.page?.version } : {}),
            })
            if (!current(state, generation) || state.patches.get(path) != patch)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            patch.page = { ...result.page, selectable: false, lines: more ? [...patch.page!.lines, ...result.page.lines] : result.page.lines }
        } catch (error) {
            if (current(state, generation) && state.patches.get(path) == patch)
                patch.error = error instanceof Error ? error.message : String(error)
        } finally {
            state.requests.delete(requestId)
            if (current(state, generation) && state.patches.get(path) == patch) {
                patch.loading = false
                update()
            }
        }
    }

    function toggle(state: BranchComparisonState, path: string) {
        if (state.patches.has(path)) {
            const requestId = state.patches.get(path)?.requestId
            state.patches.delete(path)
            if (requestId)
                void options.api.cancelInspection(state.repositoryId, requestId)
        } else {
            state.patches.set(path, { loading: false })
            void readPatch(state, path)
        }
        update()
    }

    return {
        create(repositoryId: string, from: BranchGraphBranchNode, to: BranchGraphBranchNode, graph: BranchGraph) {
            const state: BranchComparisonState = {
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
            for (const state of states) {
                if (state.repositoryId == activeRepositoryId)
                    cancel(state)
                if (state.repositoryId == repositoryId)
                    void inventory(state)
            }
            activeRepositoryId = repositoryId
        },
        refresh(repositoryId: string, graph: BranchGraph) {
            for (const state of states) {
                if (state.repositoryId != repositoryId)
                    continue
                const next = fingerprint(graph, state.fromRef, state.toRef)
                if (next != state.fingerprint) {
                    state.fingerprint = next
                    cancel(state)
                    if (repositoryId == activeRepositoryId)
                        void inventory(state)
                }
            }
        },
        renameBranch(repositoryId: string, oldRef: string, newRef: string) {
            for (const state of states) {
                if (state.repositoryId != repositoryId)
                    continue
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
                        <button type="button" aria-label="Close comparison" mix={on("click", close)}>×</button>
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
                            const patch = state.patches.get(file.path)
                            return patch
                                ? (
                                    <DiffControls
                                        layout={state.layout}
                                        showWhitespace={patch.showWhitespace ?? false}
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
                            const patch = state.patches.get(file.path)
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
}

const comparison = css({
    flex: "0 0 620px",
    minWidth: "380px",
    overflow: "auto",
    background: "var(--panel)",
    border: "1px solid var(--line-strong)",
    borderLeft: "3px solid var(--accent-edge)",
    "&:focus-visible": { outline: "2px solid var(--accent-edge)", outlineOffset: "-2px" },
    "& > header": {
        position: "sticky",
        top: 0,
        zIndex: 10,
        height: "44px",
        boxSizing: "border-box",
        display: "flex",
        gap: "6px",
        alignItems: "center",
        padding: "8px 10px",
        background: "var(--panel-deep)",
    },
    "& > header strong": { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    "& .change-file": { top: "44px" },
    "& > header button, & > p button, & .comparison-patch button:not(.diff-lines button), & > button": {
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
import type { FileHistorySource } from "@git-workbench/shared"
