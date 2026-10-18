import type { WorktreePreview, WorktreeRequest } from "@laneway/shared"
import { errorMessage } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface WorktreeActionsSnapshot {
    repositoryId?: string
    /** The reviewed operation waiting for confirmation. */
    preview?: WorktreePreview
    /** A failed review, operation, undo, or redo; the dialog shows it. */
    error?: string
    busy: boolean
    /** Removing keeps the worktree's Working Changes and its commits no branch holds. */
    preserve: boolean
    /** An undo that has to restore a removed worktree under a new name, because its directory is taken. */
    restore?: { repositoryId: string; name: string }
}

/**
 * Creating, switching, renaming, repairing, unlocking, and removing worktrees, each reviewed by the engine
 * first and confirmed in a dialog; and undoing or redoing the Operation History.
 */
export interface WorktreeActions extends Store<WorktreeActionsSnapshot> {
    /** Reviews an operation; the dialog then shows what it would do. `columnId` is the column it was asked from. */
    prepare(repositoryId: string, request: WorktreeRequest, columnId?: string): Promise<void>
    setPreserve(preserve: boolean): void
    /** Runs the reviewed operation with the review's token. */
    execute(): Promise<void>
    /** Undoes or redoes the latest operation; `basename` restores a removed worktree under another name. */
    transition(repositoryId: string, action: "undo" | "redo", basename?: string): Promise<void>
    setRestoreName(name: string): void
    /** Closes the dialog, unless an operation is under way. */
    close(): void
}

interface WorktreeActionsOptions {
    api: Api
    /** Runs after an operation succeeds; `columnId` is the column it was asked from. */
    completed(repositoryId: string, request: WorktreeRequest, columnId?: string): Promise<void>
    /** Runs after an undo or redo. */
    transitioned(repositoryId: string): Promise<void>
    mutating(busy: boolean): void
}

export function createWorktreeActions({ api, completed, transitioned, mutating }: WorktreeActionsOptions): WorktreeActions {
    let store = createStore<WorktreeActionsSnapshot>({ busy: false, preserve: true })
    let state = store.snapshot
    let set = (change: Partial<WorktreeActionsSnapshot>) => store.publish({ ...state(), ...change })
    let columnId: string | undefined

    async function act(action: () => Promise<void>) {
        if (state().busy)
            return
        set({ busy: true, error: undefined })
        mutating(true)
        try {
            await action()
        } catch (error) {
            set({ error: errorMessage(error) })
        } finally {
            set({ busy: false })
            mutating(false)
        }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        prepare: (repositoryId, request, sourceColumn) =>
            act(async () => {
                columnId = sourceColumn
                store.publish({ repositoryId, busy: true, preserve: true })
                let result = await api.previewWorktree(repositoryId, request)
                if (!result.ok)
                    throw new Error(result.error.message)
                set({ preview: result.preview })
            }),

        setPreserve: preserve => set({ preserve }),

        execute: () =>
            act(async () => {
                let { repositoryId, preview, preserve } = state()
                if (!repositoryId || !preview)
                    return
                // Choosing what a removal keeps leaves the token valid; the engine re-reads the worktree under
                // its lock and refuses if anything reviewed has changed since.
                let request = preview.request.action == "remove" ? { ...preview.request, preserve, allowIgnoredLoss: true } : preview.request
                let result = await api.executeWorktree(repositoryId, request, preview.token)
                if (!result.ok)
                    throw new Error(result.error.message)
                set({ preview: undefined })
                await completed(repositoryId, request, columnId)
            }),

        transition: (repositoryId, action, basename) =>
            act(async () => {
                let name = state().restore?.name ?? ""
                store.publish({ repositoryId, busy: true, preserve: true })
                let result = await api.transitionOperation(repositoryId, action, basename)
                if (!result.ok) {
                    // A removed worktree whose directory has since been taken comes back under a new name.
                    if (action == "undo" && /occupied/.test(result.error.message))
                        set({ restore: { repositoryId, name } })
                    throw new Error(result.error.message)
                }
                set({ restore: undefined })
                await transitioned(repositoryId)
            }),

        setRestoreName(name) {
            let restore = state().restore
            if (restore)
                set({ restore: { ...restore, name } })
        },

        close() {
            if (!state().busy)
                store.publish({ busy: false, preserve: true })
        },
    }
}
