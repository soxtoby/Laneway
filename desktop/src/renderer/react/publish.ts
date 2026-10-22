import type { PublishPlan, PublishRequest, PublishResult } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface PublishSnapshot {
    /** What Publish would do for the focused column's branch, or why it can't. */
    review?: PublishReview
    /** Publishes under way, by repository, with the Engine's latest progress. */
    running: Record<string, string>
    /**
     * Publishes that didn't simply succeed, by repository, until acknowledged: partial, failed, stale, or refused.
     * Each shows only while its repository is active, so Pull latest from it takes that repository's open stacks.
     */
    outcomes: Record<string, PublishOutcome>
}

export interface PublishOutcome {
    result?: PublishResult
    error?: string
}

export interface PublishReview {
    repositoryId: string
    /** The column's branch ref, whose Active Stack publishes. */
    branch: string
    /** Absent until the Engine has planned this branch. */
    plan?: PublishPlan
    error?: string
}

export interface Publish extends Store<PublishSnapshot> {
    /** Plans the branch's Active Stack; the focused column asks again whenever the Branch Graph changes. */
    review(repositoryId: string, branch: string): Promise<void>
    /** Publishes the reviewed plan exactly as shown; the Engine refuses it if the stack changed since. */
    publish(): Promise<void>
    /** Publishes what a receipt left unpublished, with the receipt's own leases. */
    resume(repositoryId: string, receipt: string): Promise<void>
    /** Force publishes the remote tips a receipt replaced, leasing on what it published. */
    restore(repositoryId: string, receipt: string): Promise<void>
    /** Closes the repository's outcome and starts Pull latest, the way past a stale lease. */
    pull(repositoryId: string): void
    close(repositoryId: string): void
    /** Forgets every other repository's publishes, ignoring their results, since a reopened repository starts afresh. */
    retain(repositoryIds: string[]): void
    dispose(): void
}

interface PublishOptions {
    api: Pick<Api, "publish" | "onPublishProgress">
    notify(notice: Notice): void
    /** The remote that branches without an upstream publish to. */
    remote(repositoryId: string): string | undefined
    pull(repositoryId: string): void
    /** Runs after every publish, which moves remote-tracking branches and records upstreams. */
    completed(repositoryId: string): Promise<void>
}

/**
 * Publish: the focused column's Active Stack goes to its remote branches. It is outside Operation History, so
 * success passes in a notice with no Undo; anything less opens an outcome, and the stack's latest Publish Receipt
 * offers Resume and restoration.
 */
export function createPublish({ api, notify, remote, pull, completed }: PublishOptions): Publish {
    let store = createStore<PublishSnapshot>({ running: {}, outcomes: {} })
    let reviews = 0
    // The run under way in each repository, so a result for a repository closed meanwhile is ignored.
    let runs = new Map<string, object>()
    let set = (change: Partial<PublishSnapshot>) => store.publish({ ...store.snapshot(), ...change })
    let setRunning = (repositoryId: string, message?: string) => {
        let running = { ...store.snapshot().running }
        if (message == undefined)
            delete running[repositoryId]
        else
            running[repositoryId] = message
        set({ running })
    }
    let setOutcome = (repositoryId: string, outcome?: PublishOutcome) => {
        let outcomes = { ...store.snapshot().outcomes }
        if (outcome)
            outcomes[repositoryId] = outcome
        else
            delete outcomes[repositoryId]
        set({ outcomes })
    }
    let unsubscribe = api.onPublishProgress(progress => {
        if (store.snapshot().running[progress.repositoryId] != undefined)
            setRunning(progress.repositoryId, progress.message)
    })

    async function review(repositoryId: string, branch: string) {
        let serial = ++reviews
        let current = store.snapshot().review
        // Another branch shows nothing until its own plan arrives; the same one keeps its plan meanwhile.
        if (current?.repositoryId != repositoryId || current.branch != branch)
            set({ review: { repositoryId, branch } })
        let reviewed: PublishReview
        try {
            let response = await api.publish(repositoryId, { action: "plan", branch, remote: remote(repositoryId) })
            if (!response.ok)
                throw new Error(response.error.message)
            reviewed = { repositoryId, branch, plan: response.result.plan, error: response.result.plan ? undefined : response.result.message }
        } catch (error) {
            reviewed = { repositoryId, branch, error: errorMessage(error) }
        }
        if (serial == reviews)
            set({ review: reviewed })
    }

    async function run(repositoryId: string, request: PublishRequest) {
        if (runs.has(repositoryId))
            return
        let started = {}
        runs.set(repositoryId, started)
        setRunning(repositoryId, request.action == "restore" ? "Restoring…" : "Publishing…")
        setOutcome(repositoryId)

        let outcome = await attempt(repositoryId, request)
        if (runs.get(repositoryId) == started) {
            runs.delete(repositoryId)
            setRunning(repositoryId)
            if (outcome.result?.status == "published" || outcome.result?.status == "nothing")
                notify({ code: "publish.completed", message: outcome.result.message, transient: true })
            else
                setOutcome(repositoryId, outcome)

            await completed(repositoryId)
            let current = store.snapshot().review
            if (current?.repositoryId == repositoryId)
                await review(repositoryId, current.branch)
        }
    }

    async function attempt(repositoryId: string, request: PublishRequest): Promise<PublishOutcome> {
        try {
            let response = await api.publish(repositoryId, request)
            if (!response.ok)
                throw new Error(response.error.message)
            return { result: response.result }
        } catch (error) {
            return { error: errorMessage(error) }
        }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        review,

        async publish() {
            let current = store.snapshot().review
            if (current?.plan)
                await run(current.repositoryId, { action: "publish", branch: current.branch, remote: remote(current.repositoryId), token: current.plan.token })
        },

        resume: (repositoryId, receipt) => run(repositoryId, { action: "resume", receipt }),

        restore: (repositoryId, receipt) => run(repositoryId, { action: "restore", receipt }),

        pull(repositoryId) {
            setOutcome(repositoryId)
            pull(repositoryId)
        },

        close: repositoryId => setOutcome(repositoryId),

        retain(repositoryIds) {
            let open = new Set(repositoryIds)
            let kept = <T>(byRepository: Record<string, T>) => Object.fromEntries(Object.entries(byRepository).filter(([id]) => open.has(id)))
            for (let id of [...runs.keys()].filter(id => !open.has(id)))
                runs.delete(id)
            let { review, running, outcomes } = store.snapshot()
            set({ review: review && open.has(review.repositoryId) ? review : undefined, running: kept(running), outcomes: kept(outcomes) })
        },

        dispose: unsubscribe,
    }
}
