import type { BranchGraph, BranchGraphBranchNode, PublishPlan, PublishResult } from "@laneway/shared"
import type { ColumnView } from "./branch-workspace"
import { branchStack } from "./inspection"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface PublishSnapshot {
    /** What Publish would do for each branch whose header offers it, or why it can't. */
    review?: PublishReview
    /** Publishes under way, by repository: the branch whose header started it, and the Engine's latest progress. */
    running: Record<string, PublishRun>
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
    /** By branch ref; a branch the Engine hasn't planned yet has neither a plan nor an error. */
    branches: Record<string, BranchPublishReview>
}

export interface BranchPublishReview {
    /** The branch's Active Stack, up to and including the branch. */
    plan?: PublishPlan
    error?: string
}

export interface PublishRun {
    /** The branch whose header started it. */
    branch: string
    message: string
}

export interface Publish extends Store<PublishSnapshot> {
    /** Plans every branch's Active Stack in one Engine call; the columns ask again whenever the Branch Graph changes. */
    review(repositoryId: string, branches: string[]): Promise<void>
    /** Publishes the branch's reviewed plan exactly as shown; the Engine refuses it if the stack changed since. */
    publish(repositoryId: string, branch: string): Promise<void>
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
    /**
     * Runs after every publish, which moves remote-tracking branches and records upstreams. The Branch Graph it
     * reads again has the columns plan again.
     */
    completed(repositoryId: string): Promise<void>
}

/**
 * Publish: a branch header's Active Stack goes to its remote branches. It is outside Operation History, so success
 * passes in a notice with no Undo, and anything less opens an outcome.
 */
export function createPublish({ api, notify, remote, pull, completed }: PublishOptions): Publish {
    let store = createStore<PublishSnapshot>({ running: {}, outcomes: {} })
    let reviews = 0
    // The run under way in each repository, so a result for a repository closed meanwhile is ignored.
    let runs = new Map<string, object>()
    let set = (change: Partial<PublishSnapshot>) => store.publish({ ...store.snapshot(), ...change })
    let setRunning = (repositoryId: string, run?: PublishRun) => {
        let running = { ...store.snapshot().running }
        if (run)
            running[repositoryId] = run
        else
            delete running[repositoryId]
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
        let run = store.snapshot().running[progress.repositoryId]
        if (run)
            setRunning(progress.repositoryId, { ...run, message: progress.message })
    })

    async function review(repositoryId: string, branches: string[]) {
        let serial = ++reviews
        let current = store.snapshot().review
        // A branch planned before keeps its plan until the new one arrives; another shows nothing until its own does.
        let kept = current?.repositoryId == repositoryId ? current.branches : {}
        set({ review: { repositoryId, branches: Object.fromEntries(branches.map(branch => [branch, kept[branch] ?? {}])) } })
        if (!branches.length)
            return
        let reviewed: (branch: string) => BranchPublishReview
        try {
            let response = await api.publish(repositoryId, { action: "plans", branches, remote: remote(repositoryId) })
            if (!response.ok)
                throw new Error(response.error.message)
            let plans = new Map(response.result.plans?.map(planned => [planned.branch, planned]))
            reviewed = branch => {
                let planned = plans.get(branch)
                return planned?.plan ? { plan: planned.plan } : { error: planned?.message ?? "Laneway could not plan this branch's publish." }
            }
        } catch (error) {
            let message = errorMessage(error)
            reviewed = () => ({ error: message })
        }
        if (serial == reviews)
            set({ review: { repositoryId, branches: Object.fromEntries(branches.map(branch => [branch, reviewed(branch)])) } })
    }

    async function attempt(repositoryId: string, branch: string, plan: PublishPlan): Promise<PublishOutcome> {
        try {
            let response = await api.publish(repositoryId, { action: "publish", branch, remote: remote(repositoryId), token: plan.token })
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

        async publish(repositoryId, branch) {
            let current = store.snapshot().review
            let plan = current?.repositoryId == repositoryId ? current.branches[branch]?.plan : undefined
            if (!plan || runs.has(repositoryId))
                return
            let started = {}
            runs.set(repositoryId, started)
            setRunning(repositoryId, { branch, message: "Publishing…" })
            setOutcome(repositoryId)

            let outcome = await attempt(repositoryId, branch, plan)
            if (runs.get(repositoryId) != started)
                return
            runs.delete(repositoryId)
            setRunning(repositoryId)
            if (outcome.result?.status == "published" || outcome.result?.status == "nothing")
                notify({ code: "publish.completed", message: outcome.result.message, transient: true })
            else
                setOutcome(repositoryId, outcome)
            await completed(repositoryId)
        },

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

/**
 * Whether a branch's header in a Commit Trail offers Publish: a local branch above the trail's Base whose own remote
 * branch doesn't have its tip, which the header's colour shows too, in a repository with a remote to publish to. The
 * Base, at the foot of the trail, never publishes.
 */
export function offersPublish(graph: BranchGraph, branch: BranchGraphBranchNode, below: BranchGraphBranchNode | undefined) {
    return graph.availableRemotes.length > 0 && below != undefined && branch.localRefs.length > 0 && !branch.primary && !branch.published
}

/** Every branch whose header offers Publish in the columns' Commit Trails, once each, in a stable order. */
export function publishBranches(graph: BranchGraph, columns: ColumnView[], bases: (columnId: string) => Record<string, string>) {
    let branches = new Set<string>()
    for (let column of columns) {
        if (column.kind != "branch")
            continue
        let stack = branchStack(graph, column.branch, bases(column.id))
        stack.forEach((branch, index) => {
            if (offersPublish(graph, branch, stack[index + 1]))
                branches.add(branch.localRefs[0]!)
        })
    }
    return [...branches].sort()
}
