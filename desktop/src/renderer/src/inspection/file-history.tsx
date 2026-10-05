import type { FileHistoryEntry, FileHistoryPage, FileHistorySource } from "@laneway/shared"
import { css, on, type RemixNode } from "remix/ui"
import { auxiliaryCloseButton, auxiliaryColumnFrame, auxiliaryColumnHeader } from "../auxiliary-columns"
import { Icon } from "../icons"
import { InspectionItem } from "./file-list"

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
    choices: Array<{ objectId: string; path: string; previousPath: string }>
    readKey?: string
    blame?: { entry: FileHistoryEntry; page?: FileHistoryPage; error?: string; loading: boolean }
}
let historyColumn = css({
    ...auxiliaryColumnFrame,
    minWidth: 0,
    "& > header": { ...auxiliaryColumnHeader, position: "sticky", top: 0, zIndex: 10 },
    "& > header strong": { flex: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" },
    "& > header > button": auxiliaryCloseButton,
    "& .history-commit": { width: "100%", textAlign: "left", padding: "8px", border: 0, borderBottom: "1px solid var(--line)" },
    "& .change-file": { top: "46px" },
    "& .history-subject": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
    "& small": { color: "var(--muted)", display: "block", padding: "4px 8px" },
    "& button": { color: "var(--text)", background: "var(--control)", cursor: "pointer", font: "inherit" },
    "& p": { margin: "8px", fontSize: "12px" },
    "& .blame-line": { display: "flex", gap: "8px", whiteSpace: "pre", fontSize: "12px" },
    "& .blame-context": { overflow: "auto" },
})
export function createFileHistories(
    options: {
        api: Window["laneway"]
        update(): Promise<AbortSignal>
        signal: AbortSignal
        changed?(state: FileHistoryState): void
        composition?(state: FileHistoryState): { tip: string; primaryTip: string } | undefined
    },
) {
    let states = new Set<FileHistoryState>()
    let sequence = 0
    let update = () => {
        if (!options.signal.aborted)
            void options.update()
    }
    return {
        create(repositoryId: string, source: FileHistorySource, path: string) {
            let state: FileHistoryState = {
                kind: "history",
                repositoryId,
                source,
                path,
                loading: false,
                generation: 0,
                requests: new Set(),
                alive: true,
                expanded: new Set(),
                choices: [],
            }
            states.add(state)
            void Promise.resolve().then(() => read(state))

            return state
        },
        refresh(repositoryId: string) {
            for (let state of states) {
                if (
                    state.repositoryId == repositoryId
                    && (state.source.kind != "commit" || state.readKey != JSON.stringify([options.composition?.(state), state.choices]))
                ) {
                    void read(state)
                }
            }
        },
        renameBranch(repositoryId: string, oldRef: string, newRef: string) {
            for (let state of states) {
                if (state.repositoryId == repositoryId && state.source.kind == "branch" && state.source.ref == oldRef)
                    state.source.ref = newRef
            }
        },
        suspend() {
            for (let state of states)
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
            controls(entry: FileHistoryEntry): RemixNode
            selection(entry: FileHistoryEntry): { checked: boolean; check(): void } | undefined
            commit(entry: FileHistoryEntry): void
        }): RemixNode {
            let source = state.source
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
                        <button type="button" aria-label="Close file history" mix={on("click", actions.close)}>
                            <Icon name="close" size={15} />
                        </button>
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
                        <InspectionItem
                            key={entry.objectId}
                            class="history-entry"
                            title={`${entry.subject}\n${entry.objectId} · ${entry.authorName}\n${
                                entry.previousPath ? `${entry.previousPath} → ` : ""
                            }${entry.path}`}
                            label={<span class="history-subject">{entry.subject}</span>}
                            expanded={state.expanded.has(entry.objectId)}
                            choose={() => actions.toggle(entry)}
                            controls={actions.controls(entry)}
                            {...actions.selection(entry)}
                            checkLabel={`Select file ${entry.path}`}
                            actions={[{ label: "Blame context", run: () => blame(state, entry) }, {
                                label: "Complete commit diff",
                                run: () => actions.commit(entry),
                            }]}
                        >
                            {state.expanded.has(entry.objectId) && entry.candidates && (
                                <label>
                                    Follow copy origin
                                    <select
                                        aria-label="Follow copy origin"
                                        value={entry.previousPath ?? ""}
                                        mix={on("change", event => {
                                            let previousPath = event.currentTarget.value
                                            state.choices = state.choices.filter(choice => choice.objectId != entry.objectId || choice.path != entry.path)
                                            if (previousPath)
                                                state.choices.push({ objectId: entry.objectId, path: entry.path, previousPath })
                                            cancel(state)
                                            void read(state)
                                        })}
                                    >
                                        <option value="">Choose an origin…</option>
                                        {entry.candidates.map(path => <option value={path}>{path}</option>)}
                                    </select>
                                </label>
                            )}
                            {state.expanded.has(entry.objectId) && (
                                actions.files(entry)
                            )}
                        </InspectionItem>
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

    function cancel(state: FileHistoryState) {
        state.generation++
        state.loading = false
        if (state.blame)
            state.blame.loading = false
        for (let id of state.requests)
            void options.api.cancelInspection(state.repositoryId, id)
    }

    async function read(state: FileHistoryState, more = false) {
        if (!state.alive || state.loading || more && !state.page?.cursor)
            return

        let generation = state.generation
        let composition = options.composition?.(state)
        let readKey = JSON.stringify([composition, state.choices])
        let id = `history:${++sequence}`
        state.requests.add(id)
        state.loading = true
        state.error = undefined
        update()
        let target = (more ? state.page!.entries.length : 0) + 40
        let append = more

        try {
            while (state.alive && generation == state.generation && !options.signal.aborted) {
                let result = await options.api.readFileHistory(state.repositoryId, id, {
                    source: state.source,
                    path: state.path,
                    choices: state.choices,
                    composition,
                    limit: Math.min(40, target - (append ? state.page!.entries.length : 0)),
                    ...(append ? { cursor: state.page?.cursor } : {}),
                })
                if (!state.alive || generation != state.generation)
                    return
                if (!result.ok)
                    throw new Error(result.error.message)
                let changed = !!state.page && (state.page.tip != result.page.tip || state.readKey != readKey)
                // A moving source invalidates the continuation. Restart at its new tip
                // instead of combining pages from different histories.
                if (append && changed) {
                    append = false
                    continue
                }
                if (append)
                    result.page.entries = [...state.page!.entries, ...result.page.entries]
                // Empty scan windows still advance the cursor. A first-page refresh
                // must not rewind that progress just because no matching rows were added.
                if (!append && !changed && state.page && state.page.entries.length >= result.page.entries.length) {
                    if (!state.page.cursor || state.page.entries.length >= target)
                        return
                    append = true
                    continue
                }
                state.readKey = readKey
                state.page = result.page
                if (changed)
                    options.changed?.(state)
                for (let oid of state.expanded) {
                    if (oid != "working" && !state.page.entries.some(entry => entry.objectId == oid))
                        state.expanded.delete(oid)
                }
                update()
                if (!state.page.cursor || state.page.entries.length >= target)
                    return
                append = true
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
        let view = more ? state.blame! : { entry, loading: false }
        state.blame = view
        view.loading = true
        let generation = state.generation
        let id = `blame:${++sequence}`
        state.requests.add(id)
        update()

        try {
            let objectId = entry.status == "D" ? entry.followedParent ?? entry.objectId : entry.objectId
            let result = await options.api.readFileHistory(state.repositoryId, id, {
                source: { kind: "commit", objectId },
                path: state.path,
                blame: { objectId, path: entry.path, offset: more ? view.page?.nextBlameOffset : undefined },
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
}
