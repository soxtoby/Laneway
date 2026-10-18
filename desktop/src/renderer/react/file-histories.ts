import type { FileHistoryEntry, FileHistoryPage, FileHistorySource } from "@laneway/shared"
import { errorMessage } from "./notice"

type Api = Window["laneway"]

/** Where a history's composable commits can move: the column's branch tip and the primary branch's, as read. */
export interface CompositionTips {
    tip: string
    primaryTip: string
}

/** A copy origin chosen for a history entry Git couldn't follow on its own. */
export interface OriginChoice {
    objectId: string
    path: string
    previousPath: string
}

/** One file's history, read a page of matching commits at a time. */
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
    /** Entries showing their diff, by object ID, and `working` for a worktree's Working Changes. */
    expanded: Set<string>
    choices: OriginChoice[]
    /** The composition tips and choices the page was read with; a change reads it again. */
    readKey?: string
    blame?: BlameState
}

export interface BlameState {
    entry: FileHistoryEntry
    page?: FileHistoryPage
    error?: string
    loading: boolean
}

/** A history entry's whole commit, with the files related to its file read on request. */
export interface CommitDiffState {
    kind: "commit"
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

interface Options {
    api: Api
    update(): void
    /** The tips a history's commits compose against, which the engine marks its entries composable for. */
    composition(state: FileHistoryState): CompositionTips | undefined
    /** The history now shows different commits, so whatever was chosen in the old ones no longer applies. */
    changed(state: FileHistoryState): void
}

let pageSize = 40

/** Reads File History columns' pages, blame, and related files; their columns own what they show. */
export function createFileHistories({ api, update, composition, changed }: Options) {
    let histories = new Set<FileHistoryState>()
    let sequence = 0

    function cancel(state: FileHistoryState | CommitDiffState) {
        state.generation++
        state.loading = false
        if (state.kind == "history" && state.blame)
            state.blame.loading = false
        for (let id of state.requests)
            void api.cancelInspection(state.repositoryId, id)
    }

    /**
     * Reads a page of matching commits, scanning on until it has a page's worth. With `more` it reads the next
     * page; otherwise a quiet re-read keeps the pages already read unless the history changed.
     */
    async function read(state: FileHistoryState, more = false) {
        if (!state.alive || state.loading || more && !state.page?.cursor)
            return
        let generation = state.generation
        let tips = composition(state)
        let readKey = JSON.stringify([tips, state.choices])
        let id = `history:${++sequence}`
        state.requests.add(id)
        state.loading = true
        state.error = undefined
        update()
        let target = (more ? state.page!.entries.length : 0) + pageSize
        let append = more

        try {
            while (state.alive && generation == state.generation) {
                let result = await api.readFileHistory(state.repositoryId, id, {
                    source: state.source,
                    path: state.path,
                    choices: state.choices,
                    composition: tips,
                    limit: Math.min(pageSize, target - (append ? state.page!.entries.length : 0)),
                    ...(append ? { cursor: state.page?.cursor } : {}),
                })
                if (!state.alive || generation != state.generation)
                    return
                if (!result.ok)
                    throw new Error(result.error.message)
                let moved = !!state.page && (state.page.tip != result.page.tip || state.readKey != readKey)
                // A moved source invalidates the continuation, so it starts again at the new tip rather than
                // joining pages from different histories.
                if (append && moved) {
                    append = false
                    continue
                }
                if (append)
                    result.page.entries = [...state.page!.entries, ...result.page.entries]
                // Empty scan windows still advance the cursor, so a quiet first page keeps the progress already made.
                if (!append && !moved && state.page && state.page.entries.length >= result.page.entries.length) {
                    if (!state.page.cursor || state.page.entries.length >= target)
                        return
                    append = true
                    continue
                }
                state.readKey = readKey
                state.page = result.page
                if (moved)
                    changed(state)
                for (let objectId of state.expanded) {
                    if (objectId != "working" && !state.page.entries.some(entry => entry.objectId == objectId))
                        state.expanded.delete(objectId)
                }
                update()
                if (!state.page.cursor || state.page.entries.length >= target)
                    return
                append = true
            }
        } catch (error) {
            if (state.alive && generation == state.generation)
                state.error = errorMessage(error)
        } finally {
            state.requests.delete(id)
            if (state.alive && generation == state.generation) {
                state.loading = false
                update()
            }
        }
    }

    // A deleted file's lines are blamed in the parent it was followed from.
    async function blame(state: FileHistoryState, entry: FileHistoryEntry, more = false) {
        let view: BlameState = more && state.blame ? state.blame : { entry, loading: false }
        state.blame = view
        view.loading = true
        view.error = undefined
        let generation = state.generation
        let id = `blame:${++sequence}`
        state.requests.add(id)
        update()
        try {
            let objectId = entry.status == "D" ? entry.followedParent ?? entry.objectId : entry.objectId
            let result = await api.readFileHistory(state.repositoryId, id, {
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
            if (state.alive && generation == state.generation && state.blame == view)
                view.error = errorMessage(error)
        } finally {
            state.requests.delete(id)
            if (state.alive && generation == state.generation) {
                view.loading = false
                update()
            }
        }
    }

    async function related(state: CommitDiffState, more = false) {
        if (state.loading || !state.alive)
            return
        let id = `related:${++sequence}`
        let generation = state.generation
        state.requests.add(id)
        state.loading = true
        state.error = undefined
        update()
        try {
            let result = await api.readFileHistory(state.repositoryId, id, {
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
                state.error = errorMessage(error)
        } finally {
            state.requests.delete(id)
            if (state.alive && state.generation == generation) {
                state.loading = false
                update()
            }
        }
    }

    return {
        history(repositoryId: string, source: FileHistorySource, path: string): FileHistoryState {
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
            histories.add(state)
            return state
        },

        commit(repositoryId: string, entry: FileHistoryEntry): CommitDiffState {
            return { kind: "commit", repositoryId, entry, parentId: entry.followedParent, loading: false, generation: 0, requests: new Set(), alive: true }
        },

        read,
        blame,
        related,

        /** Reads histories again: a branch's or worktree's may have moved, and a commit's when its composition did. */
        refresh(repositoryId: string) {
            for (let state of histories) {
                if (
                    state.repositoryId == repositoryId
                    && (state.source.kind != "commit" || state.readKey != JSON.stringify([composition(state), state.choices]))
                ) {
                    void read(state)
                }
            }
        },

        renamed(repositoryId: string, oldRef: string, newRef: string) {
            for (let state of histories) {
                if (state.repositoryId == repositoryId && state.source.kind == "branch" && state.source.ref == oldRef)
                    state.source = { kind: "branch", ref: newRef }
            }
        },

        /** Follows a copy origin the user chose, or none, reading the history again from the start. */
        chooseOrigin(state: FileHistoryState, entry: FileHistoryEntry, previousPath?: string) {
            state.choices = state.choices.filter(choice => choice.objectId != entry.objectId || choice.path != entry.path)
            if (previousPath)
                state.choices.push({ objectId: entry.objectId, path: entry.path, previousPath })
            cancel(state)
            void read(state)
        },

        cancel,

        dispose(state: FileHistoryState | CommitDiffState) {
            state.alive = false
            cancel(state)
            if (state.kind == "history")
                histories.delete(state)
        },
    }
}
