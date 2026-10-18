import type { BranchGraph, PullProgress, PullResult } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface PullSnapshot {
    /** Pulls under way, by repository, with the engine's latest progress. */
    running: Record<string, { message: string; cancelling: boolean }>
    /** A finished pull that needs attention, or one that failed outright. */
    outcome?: { repositoryId: string; result?: PullResult; error?: string }
}

export interface PullLatest extends Store<PullSnapshot> {
    /** Fetches and brings the open columns' stacks up to date; only an outcome that needs attention opens a dialog. */
    start(repositoryId: string): Promise<void>
    /** Stops the pull at the next safe boundary. */
    cancel(repositoryId: string): Promise<void>
    close(): void
    dispose(): void
}

interface PullOptions {
    api: Pick<Api, "pullLatest" | "cancelPull" | "onPullProgress">
    notify(notice: Notice): void
    mutating(busy: boolean): void
    /** The open columns' branch refs, frozen as the pull starts. */
    scope(repositoryId: string): string[]
    graph(repositoryId: string): BranchGraph | undefined
    /** Runs after every pull, which can move any branch in its scope. */
    completed(repositoryId: string): Promise<void>
}

/** Pull latest: fetch the selected remote and synchronize the open stacks, reporting each stack's outcome. */
export function createPullLatest({ api, notify, mutating, scope, graph, completed }: PullOptions): PullLatest {
    let store = createStore<PullSnapshot>({ running: {} })
    let set = (change: Partial<PullSnapshot>) => store.publish({ ...store.snapshot(), ...change })
    let setRunning = (repositoryId: string, value?: { message: string; cancelling: boolean }) => {
        let running = { ...store.snapshot().running }
        if (value)
            running[repositoryId] = value
        else
            delete running[repositoryId]
        set({ running })
    }
    let unsubscribe = api.onPullProgress((progress: PullProgress) => {
        let active = store.snapshot().running[progress.repositoryId]
        if (active && !active.cancelling)
            setRunning(progress.repositoryId, { ...active, message: progress.message })
    })

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        async start(repositoryId) {
            if (store.snapshot().running[repositoryId])
                return
            let branches = scope(repositoryId)
            setRunning(repositoryId, { message: "Fetching…", cancelling: false })
            set({ outcome: undefined })
            mutating(true)
            try {
                let response = await api.pullLatest(repositoryId, { branches, remote: graph(repositoryId)?.selectedRemote })
                if (!response.ok)
                    throw new Error(response.error.message)
                // Only an outcome that needs a decision interrupts; a clean pull is confirmed in passing.
                if (needsAttention(response.result))
                    set({ outcome: { repositoryId, result: response.result } })
                else
                    notify({ code: "pull.latest", message: response.result.message, transient: true })
            } catch (error) {
                set({ outcome: { repositoryId, error: errorMessage(error) } })
            } finally {
                setRunning(repositoryId, undefined)
                mutating(false)
            }
            await completed(repositoryId)
        },

        async cancel(repositoryId) {
            let active = store.snapshot().running[repositoryId]
            if (!active || active.cancelling)
                return
            setRunning(repositoryId, { message: "Cancelling at the next safe boundary…", cancelling: true })
            await api.cancelPull(repositoryId)
        },

        close: () => set({ outcome: undefined }),

        dispose: unsubscribe,
    }
}

function needsAttention(result: PullResult) {
    return result.fetches.some(fetch => fetch.status == "failed") || result.stacks.some(stack => stack.status != "updated" && stack.status != "current")
}
