import { type TrackingBranch, trackingBranchName, type WorktreePreview, type WorktreeRequest } from "@laneway/shared"
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
    /** A checkout of a remote-tracking branch waiting to choose between resetting the local branch with its name and a new one. */
    tracking?: { request: CheckoutRequest; branch: TrackingBranch }
}

type CheckoutRequest = Extract<WorktreeRequest, { action: "create" | "switch" }>

/**
 * Creating, switching, renaming, repairing, unlocking, and removing worktrees; and undoing or redoing the Operation
 * History. Checking a branch out, in a worktree or a new one, and removing a worktree without Working Changes run at
 * once; any other operation is reviewed by the engine first and confirmed in a dialog. A remote-tracking branch checks
 * out as a local branch tracking it, and asks first only when a local branch has its name already.
 */
export interface WorktreeActions extends Store<WorktreeActionsSnapshot> {
    /**
     * Starts an operation: a checkout, or a removal without Working Changes, runs at once, and any other shows in the
     * dialog once reviewed. `columnId` is the column it was asked from.
     */
    prepare(repositoryId: string, request: WorktreeRequest, columnId?: string): Promise<void>
    setPreserve(preserve: boolean): void
    /** Checks out the remote-tracking branch waiting on a choice, resetting the local branch with its name or making a new one. */
    track(choice: "reset" | "new"): Promise<void>
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
    /**
     * Runs after an operation succeeds; `columnId` is the column it was asked from, and `branch` the local branch a
     * checkout left checked out.
     */
    completed(repositoryId: string, request: WorktreeRequest, columnId?: string, branch?: string): Promise<void>
    /** Runs after an undo or redo. */
    transitioned(repositoryId: string): Promise<void>
    mutating(busy: boolean): void
}

export function createWorktreeActions({ api, completed, transitioned, mutating }: WorktreeActionsOptions): WorktreeActions {
    let store = createStore<WorktreeActionsSnapshot>({ busy: false, preserve: true })
    let state = store.snapshot
    let set = (change: Partial<WorktreeActionsSnapshot>) => store.publish({ ...state(), ...change })
    let columnId: string | undefined

    // Choosing what a removal keeps leaves the token valid; the engine re-reads the worktree under
    // its lock and refuses if anything reviewed has changed since.
    async function run(repositoryId: string, preview: WorktreePreview, preserve: boolean) {
        await perform(repositoryId, preview.request.action == "remove" ? { ...preview.request, preserve } : preview.request, preview.token)
    }

    // Without a token, the engine reviews the operation itself as it starts.
    async function perform(repositoryId: string, request: WorktreeRequest, token?: string, branch = checkoutRef(request)) {
        let result = await api.executeWorktree(repositoryId, request, token)
        if (!result.ok)
            throw new Error(result.error.message)
        set({ preview: undefined, tracking: undefined })
        await completed(repositoryId, request, columnId, branch)
    }

    // The engine names the local branch a remote-tracking branch checks out as, and whether one has its name already.
    async function checkOutRemote(repositoryId: string, request: CheckoutRequest) {
        let result = await api.previewWorktree(repositoryId, request)
        if (!result.ok)
            throw new Error(result.error.message)
        let branch = result.preview.tracking!
        if (branch.taken)
            set({ tracking: { request, branch } })
        else
            await perform(repositoryId, request, undefined, `refs/heads/${branch.name}`)
    }

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
                // A checkout stashes the Working Changes it leaves behind and detaches any worktree it takes the
                // branch from, all of which Undo restores, so it has nothing to ask.
                if (request.action == "switch" || request.action == "create")
                    return request.branch?.startsWith("refs/remotes/") ? checkOutRemote(repositoryId, request) : perform(repositoryId, request)
                let result = await api.previewWorktree(repositoryId, request)
                if (!result.ok)
                    throw new Error(result.error.message)
                // A worktree without Working Changes has nothing to choose about, so it goes at once; commits
                // only it holds stay on a protective branch.
                if (result.preview.request.action == "remove" && !result.preview.dirty)
                    await run(repositoryId, result.preview, true)
                else
                    set({ preview: result.preview })
            }),

        setPreserve: preserve => set({ preserve }),

        track: choice =>
            act(async () => {
                let { repositoryId, tracking } = state()
                if (repositoryId && tracking)
                    await perform(repositoryId, { ...tracking.request, local: choice }, undefined, `refs/heads/${trackingBranchName(tracking.branch, choice)}`)
            }),

        execute: () =>
            act(async () => {
                let { repositoryId, preview, preserve } = state()
                if (repositoryId && preview)
                    await run(repositoryId, preview, preserve)
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

function checkoutRef(request: WorktreeRequest) {
    if ((request.action == "switch" || request.action == "create") && request.branch)
        return request.branch.startsWith("refs/heads/") ? request.branch : `refs/heads/${request.branch}`
}
