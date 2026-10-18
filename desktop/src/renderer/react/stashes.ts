import type { LocalPreview, LocalRequest } from "@laneway/shared"
import { errorMessage } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface StashesSnapshot {
    repositoryId?: string
    open: boolean
    /** Every stash and worktree, from the engine's review of the main worktree. */
    preview?: LocalPreview
    /** The stash chosen to apply, by object ID, and the worktree it goes to. */
    chosen?: { objectId: string; destination: string }
    busy: boolean
    error?: string
}

/** The repository's stashes, wherever they were made: applying one to a chosen worktree, or dropping it. */
export interface Stashes extends Store<StashesSnapshot> {
    /** Lists the stashes; `objectId` chooses one to apply. */
    open(repositoryId: string, mainWorktree: string, objectId?: string): Promise<void>
    choose(objectId: string): void
    setDestination(path: string): void
    apply(): Promise<void>
    drop(objectId: string): Promise<void>
    close(): void
}

interface StashesOptions {
    api: Api
    completed(repositoryId: string): Promise<void>
    mutating(busy: boolean): void
}

export function createStashes({ api, completed, mutating }: StashesOptions): Stashes {
    let store = createStore<StashesSnapshot>({ open: false, busy: false })
    let state = store.snapshot
    let set = (change: Partial<StashesSnapshot>) => store.publish({ ...state(), ...change })
    let mainWorktree = ""

    async function review(repositoryId: string, request: LocalRequest) {
        let response = await api.localOperation(repositoryId, request)
        if (!response.ok)
            throw new Error(response.error.message)
        return response.result.preview!
    }

    async function act(request: LocalRequest) {
        let { repositoryId, busy } = state()
        if (!repositoryId || busy)
            return
        set({ busy: true, error: undefined })
        mutating(true)
        try {
            let { token } = await review(repositoryId, request)
            let response = await api.localOperation(repositoryId, request, token)
            if (!response.ok)
                throw new Error(response.error.message)
            if (response.result.status == "failed")
                throw new Error(response.result.message)
            await completed(repositoryId)
            set({ preview: await review(repositoryId, { action: "stage", path: mainWorktree, unstage: false }), chosen: undefined })
        } catch (error) {
            set({ error: errorMessage(error) })
        } finally {
            set({ busy: false })
            mutating(false)
        }
    }

    function chooseIn(preview: LocalPreview | undefined, objectId: string) {
        let destination = preview?.worktrees.find(worktree => worktree.path == mainWorktree)?.path ?? preview?.worktrees[0]?.path ?? mainWorktree
        return { objectId, destination }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        async open(repositoryId, main, objectId) {
            mainWorktree = main
            store.publish({ repositoryId, open: true, busy: false })
            try {
                let preview = await review(repositoryId, { action: "stage", path: main, unstage: false })
                set({ preview, chosen: objectId ? chooseIn(preview, objectId) : undefined })
            } catch (error) {
                set({ error: errorMessage(error) })
            }
        },

        choose: objectId => set({ chosen: chooseIn(state().preview, objectId) }),

        setDestination(path) {
            let chosen = state().chosen
            if (chosen)
                set({ chosen: { ...chosen, destination: path } })
        },

        apply() {
            let chosen = state().chosen
            return chosen ? act({ action: "stash-apply", path: chosen.destination, objectId: chosen.objectId }) : Promise.resolve()
        },

        drop: objectId => act({ action: "stash-drop", objectId }),

        close() {
            if (!state().busy)
                store.publish({ open: false, busy: false })
        },
    }
}
