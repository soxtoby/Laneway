import type { FileHistoryEntry, FileHistoryPage, FileHistorySource } from "@git-workbench/shared"
import { css, on, type RemixNode } from "remix/ui"

export interface FileHistoryState {
    kind: "history"
    repositoryId: string
    source: FileHistorySource
    path: string
    page?: FileHistoryPage
    error?: string
    loading: boolean
    generation: number
    requests: Set<string>
    alive: boolean
    expanded: Set<string>
    blame?: { entry: FileHistoryEntry; page?: FileHistoryPage; error?: string; loading: boolean }
}
export function createFileHistories(
    options: { api: Window["workbench"]; update(): Promise<AbortSignal>; signal: AbortSignal; changed?(state: FileHistoryState): void },
) {
    const states = new Set<FileHistoryState>()
    let sequence = 0
    const update = () => {
        if (!options.signal.aborted)
            void options.update()
    }
    function cancel(state: FileHistoryState) {
        state.generation++
        state.loading = false
        if (state.blame)
            state.blame.loading = false
        for (const id of state.requests)
            void options.api.cancelInspection(state.repositoryId, id)
    }
    async function read(state: FileHistoryState, more = false) {
        if (!state.alive || state.loading || more && !state.page?.cursor)
            return
        const generation = state.generation
        const id = `history:${++sequence}`
        state.requests.add(id)
        state.loading = true
        state.error = undefined
        update()
        try {
            const result = await options.api.readFileHistory(state.repositoryId, id, {
                source: state.source,
                path: state.path,
                ...(more ? { cursor: state.page?.cursor } : {}),
            })
            if (!state.alive || generation != state.generation)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            if (more)
                result.page.entries = [...state.page!.entries, ...result.page.entries]
            const changed = !!state.page && state.page.tip != result.page.tip
            if (!more && state.page && state.page.tip == result.page.tip && state.page.entries.length > result.page.entries.length)
                return
            state.page = result.page
            if (changed)
                options.changed?.(state)
            for (const oid of state.expanded) {
                if (oid != "working" && !state.page.entries.some(entry => entry.objectId == oid))
                    state.expanded.delete(oid)
            }
        } catch (error) {
            if (state.alive && generation == state.generation)
                state.error = String(error)
        } finally {
            state.requests.delete(id)
            if (state.alive && generation == state.generation) {
                state.loading = false
                update()
            }
        }
    }
    async function blame(state: FileHistoryState, entry: FileHistoryEntry, more = false) {
        const view = more ? state.blame! : { entry, loading: false }
        state.blame = view
        view.loading = true
        const generation = state.generation
        const id = `blame:${++sequence}`
        state.requests.add(id)
        update()
        try {
            const result = await options.api.readFileHistory(state.repositoryId, id, {
                source: state.source,
                path: state.path,
                blame: { objectId: entry.objectId, path: entry.path, offset: more ? view.page?.nextBlameOffset : undefined },
            })
            if (!state.alive || generation != state.generation || state.blame != view)
                return
            if (!result.ok)
                throw new Error(result.error.message)
            view.page = { ...result.page, blame: [...(more ? view.page?.blame ?? [] : []), ...result.page.blame ?? []] }
        } catch (error) {
            if (state.alive && generation == state.generation)
                view.error = String(error)
        } finally {
            state.requests.delete(id)
            if (state.alive && generation == state.generation) {
                view.loading = false
                update()
            }
        }
    }
    return {
        create(repositoryId: string, source: FileHistorySource, path: string) {
            const state: FileHistoryState = {
                kind: "history",
                repositoryId,
                source,
                path,
                loading: false,
                generation: 0,
                requests: new Set(),
                alive: true,
                expanded: new Set(),
            }
            states.add(state)
            void read(state)
            return state
        },
        refresh(repositoryId: string) {
            for (const state of states) {
                if (state.repositoryId == repositoryId && state.source.kind != "commit")
                    void read(state)
            }
        },
        suspend() {
            for (const state of states)
                cancel(state)
        },
        dispose(state: FileHistoryState) {
            state.alive = false
            cancel(state)
            states.delete(state)
        },
        render(state: FileHistoryState, id: string, sourceId: string, actions: {
            close(): void
            open(source: FileHistorySource, path: string): void
            toggle(entry?: FileHistoryEntry): void
            files(entry?: FileHistoryEntry): RemixNode
        }): RemixNode {
            const source = state.source
            return (
                <aside
                    key={id}
                    class="file-history"
                    data-auxiliary-id={id}
                    data-source-column-id={sourceId}
                    aria-label={`History of ${state.path}`}
                    tabIndex={-1}
                    mix={historyColumn}
                >
                    <header>
                        <strong title={state.path}>History · {state.path}</strong>
                        <button type="button" aria-label="Close file history" mix={on("click", actions.close)}>×</button>
                    </header>
                    <small class="history-source">
                        From {source.kind == "branch" ? source.ref : source.kind == "worktree" ? source.worktreePath : source.objectId.slice(0, 8)}
                    </small>
                    {state.loading && !state.page && <p role="status">Reading history…</p>}
                    {state.error && (
                        <p role="alert">
                            {state.error} {state.page ? "Showing the last history." : ""}
                            <button type="button" mix={on("click", () => read(state))}>Retry history</button>
                        </p>
                    )}
                    {source.kind == "worktree" && (
                        <section>
                            <button
                                type="button"
                                class="history-commit"
                                aria-expanded={state.expanded.has("working")}
                                mix={on("click", () => actions.toggle())}
                            >
                                Working Changes
                            </button>
                            {state.expanded.has("working") && actions.files()}
                        </section>
                    )}
                    {state.page?.entries.map(entry => (
                        <section key={entry.objectId} class="history-entry">
                            <button
                                type="button"
                                class="history-commit"
                                aria-expanded={state.expanded.has(entry.objectId)}
                                title={`${entry.objectId} · ${entry.authorName}`}
                                mix={on("click", () => actions.toggle(entry))}
                            >
                                {entry.subject}
                            </button>
                            {entry.parentIds.length > 1 && <small>Following parent 1 · {entry.followedParent?.slice(0, 8)}</small>}
                            {entry.previousPath && <small>{entry.previousPath} → {entry.path}</small>}
                            {state.expanded.has(entry.objectId) && (
                                <div>
                                    <button type="button" mix={on("click", () => blame(state, entry))}>Blame context</button>
                                    {actions.files(entry)}
                                </div>
                            )}
                        </section>
                    ))}
                    {state.page && !state.page.entries.length && !state.page.cursor && <p>No committed history.</p>}
                    {state.page?.cursor && <button type="button" disabled={state.loading} mix={on("click", () => read(state, true))}>Load more history</button>}
                    {state.blame && (
                        <section class="blame-context" aria-label="Blame context">
                            <header>
                                Blame · {state.blame.entry.path}
                                <button
                                    type="button"
                                    aria-label="Close blame"
                                    mix={on("click", () => {
                                        state.blame = undefined
                                        update()
                                    })}
                                >
                                    ×
                                </button>
                            </header>
                            {state.blame.loading && !state.blame.page && <p role="status">Reading blame…</p>}
                            {state.blame.error && <p role="alert">{state.blame.error}</p>}
                            {state.blame.page?.notice && <p>{state.blame.page.notice}</p>}
                            {state.blame.page?.blame?.map(line => (
                                <div class="blame-line">
                                    <button
                                        type="button"
                                        title={`Open origin · ${line.author} · ${line.path}:${line.originalLine}`}
                                        mix={on("click", () => actions.open({ kind: "commit", objectId: line.objectId }, line.path))}
                                    >
                                        {line.objectId.slice(0, 8)}:{line.line}
                                    </button>
                                    <code>{line.text}</code>
                                </div>
                            ))}
                            {state.blame.page?.nextBlameOffset != undefined && (
                                <button
                                    type="button"
                                    disabled={state.blame.loading}
                                    mix={on("click", () => blame(state, state.blame!.entry, true))}
                                >
                                    Load more blame
                                </button>
                            )}
                        </section>
                    )}
                </aside>
            )
        },
    }
}
const historyColumn = css({
    flex: "0 0 620px",
    minWidth: 0,
    overflow: "auto",
    background: "var(--panel)",
    borderLeft: "3px solid var(--accent-edge)",
    "& > header": {
        position: "sticky",
        top: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        gap: "6px",
        height: "44px",
        padding: "0 10px",
        background: "var(--panel-deep)",
    },
    "& > header strong": { flex: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
    "& .history-commit": { width: "100%", textAlign: "left", padding: "8px", border: 0, borderBottom: "1px solid var(--line)" },
    "& .change-file": { top: "44px" },
    "& small": { color: "var(--muted)", display: "block", padding: "4px 8px" },
    "& button": { color: "var(--text)", background: "var(--control)", cursor: "pointer", font: "inherit" },
    "& p": { margin: "8px", fontSize: "12px" },
    "& .blame-line": { display: "flex", gap: "8px", whiteSpace: "pre", fontSize: "12px" },
    "& .blame-context": { overflow: "auto" },
})
