import type { BranchHistoryCommit, LocalPreview, RewordRequest } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface RewordSnapshot {
    title: string
    message: string
    /** Whether the title or message differs from the commit's. */
    edited: boolean
    busy: boolean
    /** A reviewed rewrite waiting for the user's decision: it rewrites published history or drops emptied commits. */
    preview?: LocalPreview
    error?: string
}

/**
 * Edits one commit's title and message. Applying rewrites straight away, unless the engine's review finds
 * published history or commits that replay would empty; then the rewrite waits for an explicit decision.
 */
export interface Reword extends Store<RewordSnapshot> {
    edit(change: Partial<Pick<RewordSnapshot, "title" | "message">>): void
    apply(): Promise<void>
    /** Rewrites the history the review reported. */
    execute(): Promise<void>
}

export interface RewordOptions {
    api: Api
    repositoryId: string
    /** The local branch whose history shows the commit. */
    branch: string
    commit: Pick<BranchHistoryCommit, "objectId" | "subject" | "body">
    selectedRemote?: string
    notify(notice: Notice): void
    /** Runs after the commit is rewritten and before the form closes. */
    changed(): Promise<void>
    mutating(busy: boolean): void
    close(): void
}

export function createReword({ api, repositoryId, branch, commit, selectedRemote, notify, changed, mutating, close }: RewordOptions): Reword {
    let store = createStore<RewordSnapshot>({ title: commit.subject, message: commit.body ?? "", edited: false, busy: false })
    let state = store.snapshot
    let set = (change: Partial<RewordSnapshot>) => store.publish({ ...state(), ...change })

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

    async function send(token?: string) {
        let request: RewordRequest = { action: "reword", objectId: commit.objectId, branch, title: state().title, message: state().message, selectedRemote }
        let response = await api.localOperation(repositoryId, request, token)
        if (!response.ok)
            throw new Error(response.error.message)
        if (response.result.status == "failed")
            throw new Error(response.result.message)
        return response.result
    }

    async function completed(message?: string) {
        notify({ code: "reword.applied", message: message ?? "Commit reworded.", transient: true })
        await changed()
        close()
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        // Published rather than read through a method: the React Compiler memoizes a call on the stable controller.
        edit: change => {
            let { title, message } = { ...state(), ...change }
            let edited = title.trim() != commit.subject || message.trimEnd() != (commit.body ?? "").trimEnd()
            set({ ...change, edited, preview: undefined })
        },

        apply: () =>
            act(async () => {
                let result = await send()
                if (result.status == "performed")
                    await completed(result.message)
                else if (result.preview)
                    set({ preview: result.preview })
                else
                    throw new Error("Laneway could not review the reword.")
            }),

        execute: () =>
            act(async () => {
                let token = state().preview?.token
                if (!token)
                    return
                set({ preview: undefined })
                await completed((await send(token)).message)
            }),
    }
}
