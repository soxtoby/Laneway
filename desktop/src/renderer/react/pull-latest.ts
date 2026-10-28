import type { BranchGraph, BranchGraphBranchNode, PullProgress, PullResult } from "@laneway/shared"
import { plural } from "./branch-rebase"
import { branchStack } from "./inspection"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface PullSnapshot {
    /** Pulls under way, by repository, with the engine's latest progress. */
    running: Record<string, PullRun>
    /** A finished pull that needs attention, or one that failed outright. */
    outcome?: { repositoryId: string; result?: PullResult; error?: string }
}

export interface PullRun {
    /** The local branch whose column started it. */
    branch: string
    message: string
    cancelling: boolean
}

export interface PullLatest extends Store<PullSnapshot> {
    /**
     * Fetches and brings a column's Active Stack up to date, with the open stacks sharing a branch above its Base;
     * only an outcome that needs attention opens a dialog.
     */
    start(repositoryId: string, branch: string): Promise<void>
    /** Stops the pull at the next safe boundary. */
    cancel(repositoryId: string): Promise<void>
    close(): void
    dispose(): void
}

interface PullOptions {
    api: Pick<Api, "pullLatest" | "cancelPull" | "onPullProgress">
    notify(notice: Notice): void
    mutating(busy: boolean): void
    /** The open columns' local branches, frozen as the pull starts. */
    open(repositoryId: string): string[]
    graph(repositoryId: string): BranchGraph | undefined
    /** Runs after every pull, which can move any branch in its scope. */
    completed(repositoryId: string): Promise<void>
}

/** Pull latest: fetch the selected remote and synchronize a column's stack, reporting each stack's outcome. */
export function createPullLatest({ api, notify, mutating, open, graph, completed }: PullOptions): PullLatest {
    let store = createStore<PullSnapshot>({ running: {} })
    let set = (change: Partial<PullSnapshot>) => store.publish({ ...store.snapshot(), ...change })
    let setRunning = (repositoryId: string, value?: PullRun) => {
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

        async start(repositoryId, branch) {
            if (store.snapshot().running[repositoryId])
                return
            let request = { branches: [branch], open: open(repositoryId), remote: graph(repositoryId)?.selectedRemote }
            setRunning(repositoryId, { branch, message: "Fetching…", cancelling: false })
            set({ outcome: undefined })
            mutating(true)
            try {
                let response = await api.pullLatest(repositoryId, request)
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
            setRunning(repositoryId, { ...active, message: "Cancelling at the next safe boundary…", cancelling: true })
            await api.cancelPull(repositoryId)
        },

        close: () => set({ outcome: undefined }),

        dispose: unsubscribe,
    }
}

function needsAttention(result: PullResult) {
    return result.fetches.some(fetch => fetch.status == "failed") || result.stacks.some(stack => stack.status != "updated" && stack.status != "current")
}

/**
 * What Pull latest would bring into a column's Active Stack, as far as the Branch Graph knows: each upstream with
 * commits its branch lacks, and each branch whose Base moved on after it forked.
 */
export function incoming(graph: BranchGraph, branch: BranchGraphBranchNode, bases: Record<string, string>) {
    let trail = branchStack(graph, branch, bases)
    // The Active Stack ends at the Primary Branch or a remote branch, as the Engine's does.
    let end = trail.findIndex(item => item.primary || item.remoteOnly)
    let stack = end < 0 ? trail : trail.slice(0, end + 1)
    let reasons: string[] = []
    for (let [index, item] of stack.entries()) {
        if (!item.remoteOnly && item.upstreamRef && item.behind > 0)
            reasons.push(`${item.upstreamRef.replace(/^refs\/remotes\//, "")} has ${plural(item.behind, "new commit")}`)
        let base = stack[index + 1]
        if (base && item.behindBase)
            reasons.push(`${item.name} is behind ${base.name}`)
    }
    return reasons
}
