import type { FileHistoryEntry, FileHistoryPage, FileHistorySource } from "@laneway/shared"
import { css, on, type RemixNode } from "remix/ui"

export interface TrailCommitState {
    kind: "trail-commit"
    repositoryId: string
    entry: FileHistoryEntry
    parentId?: string
    related?: FileHistoryPage
    error?: string
    loading: boolean
    generation: number
    requests: Set<string>
    alive: boolean
}
export function createTrailCommits(options: { api: Window["laneway"]; update(): Promise<AbortSignal>; signal: AbortSignal }) {
    const states = new Set<TrailCommitState>()
    let sequence = 0
    const update = () => {
        if (!options.signal.aborted)
            void options.update()
    }
    async function read(state: TrailCommitState, more = false) {
        if (state.loading || !state.alive)
            return
        const id = `related:${++sequence}`
        const generation = state.generation
        state.requests.add(id)
        state.loading = true
        state.error = undefined
        update()
        try {
            const result = await options.api.readFileHistory(state.repositoryId, id, {
                source: { kind: "commit", objectId: state.entry.objectId },
                path: state.entry.path,
                related: {
                    objectId: state.entry.objectId,
                    path: state.entry.path,
                    parentId: state.parentId,
                    offset: more ? state.related?.nextRelatedOffset : undefined,
                },
            })
            if (!state.alive || state.generation != generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            state.related = { ...result.page, related: [...(more ? state.related?.related ?? [] : []), ...result.page.related ?? []] }
        } catch (error) {
            if (state.alive && state.generation == generation)
                state.error = String(error)
        } finally {
            state.requests.delete(id)
            if (state.alive && state.generation == generation) {
                state.loading = false
                update()
            }
        }
    }
    function cancel(state: TrailCommitState) {
        state.generation++
        state.loading = false
        for (const id of state.requests)
            void options.api.cancelInspection(state.repositoryId, id)
    }
    return {
        create(repositoryId: string, entry: FileHistoryEntry) {
            const state: TrailCommitState = {
                kind: "trail-commit",
                repositoryId,
                entry,
                parentId: entry.followedParent,
                loading: false,
                generation: 0,
                requests: new Set(),
                alive: true,
            }
            states.add(state)
            return state
        },
        suspend() {
            for (const state of states)
                cancel(state)
        },
        dispose(state: TrailCommitState) {
            state.alive = false
            cancel(state)
            states.delete(state)
        },
        render(state: TrailCommitState, id: string, sourceId: string, actions: {
            close(): void
            files(): RemixNode
            parent(parentId: string): void
            open(source: FileHistorySource, path: string): void
        }): RemixNode {
            return (
                <aside
                    key={id}
                    class="trail-commit"
                    aria-label={`Commit diff · ${state.entry.subject}`}
                    data-auxiliary-id={id}
                    data-source-column-id={sourceId}
                    tabIndex={-1}
                    mix={column}
                >
                    <header>
                        <strong>{state.entry.subject}</strong>
                        <button type="button" aria-label="Close commit diff" mix={on("click", actions.close)}>×</button>
                    </header>
                    <small>From history · {state.entry.path} · {state.entry.objectId.slice(0, 8)}</small>
                    {state.entry.parentIds.length > 1 && (
                        <label>
                            Compare with parent
                            <select
                                aria-label="Commit diff parent"
                                value={state.parentId}
                                mix={on("change", event => {
                                    cancel(state)
                                    state.parentId = event.currentTarget.value
                                    state.related = undefined
                                    actions.parent(state.parentId)
                                    update()
                                })}
                            >
                                {state.entry.parentIds.map((parent, index) => <option value={parent}>Parent {index + 1} · {parent.slice(0, 8)}</option>)}
                            </select>
                        </label>
                    )}
                    {actions.files()}
                    <section class="related-files" aria-label="Related files">
                        {!state.related && <button type="button" disabled={state.loading} mix={on("click", () => read(state))}>Find related files</button>}
                        {state.loading && !state.related && <p role="status">Reading file evidence…</p>}
                        {state.error && <p role="alert">{state.error}</p>}
                        {state.related && <p>Related files · evidence, not proven origins</p>}
                        {state.related?.notice && <p>{state.related.notice}</p>}
                        {state.related?.related?.map(file => (
                            <button
                                type="button"
                                class="related-file"
                                title={`${file.evidence} · ${file.path}`}
                                mix={on("click", () => actions.open({ kind: "commit", objectId: file.objectId }, file.path))}
                            >
                                {file.path}
                                <small>{file.evidence}{file.evidence == "shared lines" ? ` · ${file.score}` : ""}</small>
                            </button>
                        ))}
                        {state.related?.related?.length == 0 && <p>No other changed files.</p>}
                        {state.related?.nextRelatedOffset != undefined && (
                            <button
                                type="button"
                                disabled={state.loading}
                                mix={on("click", () => read(state, true))}
                            >
                                Load more related files
                            </button>
                        )}
                    </section>
                </aside>
            )
        },
    }
}
const column = css({
    flex: "0 0 620px",
    minWidth: 0,
    overflow: "auto",
    background: "var(--panel)",
    borderLeft: "3px solid var(--accent-edge)",
    "& > header": {
        position: "sticky",
        top: 0,
        zIndex: 10,
        height: "44px",
        padding: "0 10px",
        display: "flex",
        alignItems: "center",
        background: "var(--panel-deep)",
    },
    "& > header strong": { flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
    "& .change-file": { top: "44px" },
    "& > small, & > label, & p": { display: "block", margin: "6px 8px", fontSize: "12px", color: "var(--muted)" },
    "& .related-file": { display: "flex", gap: "8px", width: "100%", padding: "6px 8px", textAlign: "left" },
    "& .related-file small": { marginLeft: "auto", color: "var(--muted)" },
})
