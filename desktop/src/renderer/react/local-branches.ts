import type { BranchGraphBranchNode, LocalPreview, LocalRequest } from "@laneway/shared"
import { errorMessage } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

/** The branch dialog open: creating a branch at a commit, renaming one, or deleting one. */
export type BranchDialog =
    | { action: "branch-create"; name: string; commit: string }
    | { action: "branch-rename"; name: string; original: string }
    | {
        action: "branch-delete"
        original: string
        /** The reviewed deletion, which says whether commits only this branch holds would go with it. */
        preview?: LocalPreview
        /** Deleting those commits too was confirmed. */
        confirmed: boolean
    }

export interface LocalBranchesSnapshot {
    repositoryId?: string
    dialog?: BranchDialog
    busy: boolean
    error?: string
}

/** Creating, renaming, and deleting local branches, in a dialog or in place. */
export interface LocalBranches extends Store<LocalBranchesSnapshot> {
    createAt(repositoryId: string, objectId: string): void
    rename(repositoryId: string, branch: BranchGraphBranchNode): void
    /** Opens the deletion dialog, reviewing the deletion at once. */
    delete(repositoryId: string, branch: BranchGraphBranchNode): void
    setName(name: string): void
    setConfirmed(confirmed: boolean): void
    submit(): Promise<void>
    /** Closes the dialog, unless an operation is under way. */
    close(): void
    /** Runs one operation straight away, for names edited in place; throws its failure for the editor to show. */
    perform(repositoryId: string, request: LocalRequest): Promise<void>
}

interface LocalBranchesOptions {
    api: Api
    /** Runs after an operation succeeds and before the dialog closes. */
    completed(repositoryId: string, request: LocalRequest): Promise<void>
    mutating(busy: boolean): void
}

export function createLocalBranches({ api, completed, mutating }: LocalBranchesOptions): LocalBranches {
    let store = createStore<LocalBranchesSnapshot>({ busy: false })
    let state = store.snapshot
    let set = (change: Partial<LocalBranchesSnapshot>) => store.publish({ ...state(), ...change })
    let reviews = 0

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

    async function run(repositoryId: string, request: LocalRequest, token: string) {
        let response = await api.localOperation(repositoryId, request, token)
        if (!response.ok)
            throw new Error(response.error.message)
        if (response.result.status == "failed")
            throw new Error(response.result.message)
        await completed(repositoryId, request)
    }

    function request(dialog: BranchDialog): LocalRequest {
        if (dialog.action == "branch-create")
            return { action: dialog.action, name: dialog.name.trim(), commit: dialog.commit }
        if (dialog.action == "branch-rename")
            return { action: dialog.action, name: dialog.original, newName: dialog.name.trim() }
        return { action: dialog.action, name: dialog.original, confirmed: dialog.confirmed }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        createAt: (repositoryId, objectId) => open(repositoryId, { action: "branch-create", name: "", commit: objectId }),

        rename: (repositoryId, branch) => open(repositoryId, { action: "branch-rename", name: branch.name, original: branch.name }),

        delete(repositoryId, branch) {
            if (state().busy)
                return
            open(repositoryId, { action: "branch-delete", original: branch.name, confirmed: false })
            let review = ++reviews
            inspect(repositoryId, { action: "branch-delete", name: branch.name, confirmed: false })
                .then(preview => {
                    let dialog = state().dialog
                    if (review == reviews && dialog?.action == "branch-delete")
                        set({ dialog: { ...dialog, preview } })
                })
                .catch(error => {
                    if (review == reviews)
                        set({ error: errorMessage(error) })
                })
        },

        setName(name) {
            let dialog = state().dialog
            if (dialog && dialog.action != "branch-delete")
                set({ dialog: { ...dialog, name }, error: undefined })
        },

        setConfirmed(confirmed) {
            let dialog = state().dialog
            if (dialog?.action == "branch-delete")
                set({ dialog: { ...dialog, confirmed } })
        },

        async submit() {
            let { repositoryId, dialog, busy } = state()
            if (!repositoryId || !dialog || busy)
                return
            let value = request(dialog)
            set({ busy: true, error: undefined })
            mutating(true)
            try {
                // The delete dialog already holds a review; the engine checks its token, so reviewing again
                // would only add a round trip before the branch goes.
                let reviewed = dialog.action == "branch-delete" ? dialog.preview : undefined
                let fresh = reviewed ?? await inspect(repositoryId, value)
                if (dialog.action == "branch-delete" && fresh.uniqueCommits && !dialog.confirmed)
                    return set({ dialog: { ...dialog, preview: fresh } })
                try {
                    await run(repositoryId, value, fresh.token)
                } catch (error) {
                    // A branch that moved since the review is reviewed again before anything is deleted.
                    let current = reviewed && await inspect(repositoryId, value).catch(() => undefined)
                    if (dialog.action == "branch-delete" && reviewed && current && current.token != reviewed.token) {
                        set({ dialog: { ...dialog, preview: current, confirmed: false } })
                        throw new Error("The branch changed. Review deletion again.")
                    }
                    throw error
                }
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
            if (!state().busy) {
                reviews++
                store.publish({ busy: false })
            }
        },

        async perform(repositoryId, value) {
            mutating(true)
            try {
                let fresh = await inspect(repositoryId, value)
                await run(repositoryId, value, fresh.token)
            } finally {
                mutating(false)
            }
        },
    }
}
