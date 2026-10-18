import type { BranchGraphBranchNode, LocalPreview, LocalRequest } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

/** The branch dialog open: creating a branch at a commit, or renaming one. */
export type BranchDialog =
    | { action: "branch-create"; name: string; commit: string }
    | { action: "branch-rename"; name: string; original: string }

export interface LocalBranchesSnapshot {
    repositoryId?: string
    dialog?: BranchDialog
    busy: boolean
    error?: string
}

/** Creating and renaming local branches, in a dialog or in place, and deleting them at once. */
export interface LocalBranches extends Store<LocalBranchesSnapshot> {
    createAt(repositoryId: string, objectId: string): void
    rename(repositoryId: string, branch: BranchGraphBranchNode): void
    /** Deletes a branch straight away, with any commits only it holds; a failure shows as a notice. */
    delete(repositoryId: string, branch: BranchGraphBranchNode): Promise<void>
    setName(name: string): void
    submit(): Promise<void>
    /** Closes the dialog, unless an operation is under way. */
    close(): void
    /** Runs one operation straight away, for names edited in place; throws its failure for the editor to show. */
    perform(repositoryId: string, request: LocalRequest): Promise<void>
}

interface LocalBranchesOptions {
    api: Api
    /** Runs after an operation succeeds and before the dialog closes, with the review it ran from. */
    completed(repositoryId: string, request: LocalRequest, preview: LocalPreview): Promise<void>
    mutating(busy: boolean): void
    notify(notice: Notice): void
}

export function createLocalBranches({ api, completed, mutating, notify }: LocalBranchesOptions): LocalBranches {
    let store = createStore<LocalBranchesSnapshot>({ busy: false })
    let state = store.snapshot
    let set = (change: Partial<LocalBranchesSnapshot>) => store.publish({ ...state(), ...change })

    function open(repositoryId: string, dialog: BranchDialog) {
        if (!state().busy)
            store.publish({ repositoryId, dialog, busy: false })
    }

    async function inspect(repositoryId: string, request: LocalRequest) {
        let response = await api.localOperation(repositoryId, request)
        if (!response.ok)
            throw new Error(response.error.message)
        return response.result.preview!
    }

    async function run(repositoryId: string, request: LocalRequest, preview: LocalPreview) {
        let response = await api.localOperation(repositoryId, request, preview.token)
        if (!response.ok)
            throw new Error(response.error.message)
        if (response.result.status == "failed")
            throw new Error(response.result.message)
        await completed(repositoryId, request, preview)
    }

    function request(dialog: BranchDialog): LocalRequest {
        if (dialog.action == "branch-create")
            return { action: dialog.action, name: dialog.name.trim(), commit: dialog.commit }
        return { action: dialog.action, name: dialog.original, newName: dialog.name.trim() }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        createAt: (repositoryId, objectId) => open(repositoryId, { action: "branch-create", name: "", commit: objectId }),

        rename: (repositoryId, branch) => open(repositoryId, { action: "branch-rename", name: branch.name, original: branch.name }),

        async delete(repositoryId, branch) {
            if (state().busy)
                return
            let value: LocalRequest = { action: "branch-delete", name: branch.name, confirmed: true }
            set({ busy: true })
            mutating(true)
            try {
                await run(repositoryId, value, await inspect(repositoryId, value))
            } catch (error) {
                notify({ code: "branch.delete.failed", message: errorMessage(error) })
            } finally {
                set({ busy: false })
                mutating(false)
            }
        },

        setName(name) {
            let dialog = state().dialog
            if (dialog)
                set({ dialog: { ...dialog, name }, error: undefined })
        },

        async submit() {
            let { repositoryId, dialog, busy } = state()
            if (!repositoryId || !dialog || busy)
                return
            let value = request(dialog)
            set({ busy: true, error: undefined })
            mutating(true)
            try {
                await run(repositoryId, value, await inspect(repositoryId, value))
                store.publish({ busy: false })
            } catch (error) {
                set({ error: errorMessage(error) })
            } finally {
                if (state().busy)
                    set({ busy: false })
                mutating(false)
            }
        },

        close() {
            if (!state().busy)
                store.publish({ busy: false })
        },

        async perform(repositoryId, value) {
            mutating(true)
            try {
                await run(repositoryId, value, await inspect(repositoryId, value))
            } finally {
                mutating(false)
            }
        },
    }
}
