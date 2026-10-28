import { type BranchGraph, type BranchGraphBranchNode, primaryLocalRef, type PublishPlan, type PublishResult } from "@laneway/shared"
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
     * Each shows only while its repository is active, so Pull latest from it carries that repository's open stacks.
     */
    outcomes: Record<string, PublishOutcome>
    /** A publish that asks first, as the Primary Branch's does, until it goes ahead or is cancelled. */
    confirming?: PublishConfirmation
}

export interface PublishConfirmation {
    repositoryId: string
    branch: string
    /** The plan as it was when asked, which going ahead publishes; the Engine refuses it if the stack changed since. */
    plan: PublishPlan
}

export interface PublishOutcome {
    /** The branch whose header started it. */
    branch: string
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
    /** Asks before publishing the branch's reviewed plan, keeping it as shown: `proceed` publishes it, and `cancel` doesn't. */
    confirm(repositoryId: string, branch: string): void
    proceed(): Promise<void>
    cancel(): void
    /** Closes the repository's outcome and starts Pull latest for its branch's stack, the way past a stale lease. */
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
    /** Pulls the branch's Active Stack. */
    pull(repositoryId: string, branch: string): void
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

    async function start(repositoryId: string, branch: string, plan: PublishPlan) {
        if (runs.has(repositoryId))
            return
        let started = {}
        runs.set(repositoryId, started)
        setRunning(repositoryId, { branch, message: "Publishing…" })
        setOutcome(repositoryId)

        let outcome = await attempt(repositoryId, branch, plan)
        // A repository closed meanwhile has forgotten its publish.
        if (runs.get(repositoryId) == started) {
            runs.delete(repositoryId)
            setRunning(repositoryId)
            if (outcome.result?.status == "published" || outcome.result?.status == "nothing")
                notify({ code: "publish.completed", message: outcome.result.message, transient: true })
            else
                setOutcome(repositoryId, outcome)
            await completed(repositoryId)
        }
    }

    async function attempt(repositoryId: string, branch: string, plan: PublishPlan): Promise<PublishOutcome> {
        try {
            let response = await api.publish(repositoryId, { action: "publish", branch, remote: remote(repositoryId), token: plan.token })
            if (!response.ok)
                throw new Error(response.error.message)
            return { branch, result: response.result }
        } catch (error) {
            return { branch, error: errorMessage(error) }
        }
    }

    function reviewedPlan(repositoryId: string, branch: string) {
        let current = store.snapshot().review
        return current?.repositoryId == repositoryId ? current.branches[branch]?.plan : undefined
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        review,

        async publish(repositoryId, branch) {
            let plan = reviewedPlan(repositoryId, branch)
            if (plan)
                await start(repositoryId, branch, plan)
        },

        confirm(repositoryId, branch) {
            let plan = reviewedPlan(repositoryId, branch)
            if (plan)
                set({ confirming: { repositoryId, branch, plan } })
        },

        async proceed() {
            let { confirming } = store.snapshot()
            set({ confirming: undefined })
            if (confirming)
                await start(confirming.repositoryId, confirming.branch, confirming.plan)
        },

        cancel: () => set({ confirming: undefined }),

        pull(repositoryId) {
            let outcome = store.snapshot().outcomes[repositoryId]
            setOutcome(repositoryId)
            if (outcome)
                pull(repositoryId, outcome.branch)
        },

        close: repositoryId => setOutcome(repositoryId),

        retain(repositoryIds) {
            let open = new Set(repositoryIds)
            let kept = <T>(byRepository: Record<string, T>) => Object.fromEntries(Object.entries(byRepository).filter(([id]) => open.has(id)))
            for (let id of [...runs.keys()].filter(id => !open.has(id)))
                runs.delete(id)
            let { review, running, outcomes, confirming } = store.snapshot()
            set({
                review: review && open.has(review.repositoryId) ? review : undefined,
                running: kept(running),
                outcomes: kept(outcomes),
                confirming: confirming && open.has(confirming.repositoryId) ? confirming : undefined,
            })
        },

        dispose: unsubscribe,
    }
}

/**
 * Whether a branch's header in a Commit Trail offers Publish: a local branch above the trail's Base whose own remote
 * branch doesn't have its tip, which the header's colour shows too, in a repository with a remote to publish to. The
 * Base, at the foot of the trail, never publishes, except the Primary Branch, which has no Base of its own and
 * publishes alone.
 */
export function offersPublish(graph: BranchGraph, branch: BranchGraphBranchNode, below: BranchGraphBranchNode | undefined) {
    return graph.availableRemotes.length > 0 && (below != undefined || branch.primary) && publishRef(graph, branch) != undefined && !branch.published
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
                branches.add(publishRef(graph, branch)!)
        })
    }
    return [...branches].sort()
}

/**
 * The local branch a branch's header publishes. Local branches sharing a tip share a Branch Node, so the Primary
 * Branch's node publishes its own local branch, never another at its tip.
 */
export function publishRef(graph: BranchGraph, branch: BranchGraphBranchNode) {
    return branch.primary ? branch.localRefs.find(ref => ref == primaryLocalRef(graph)) : branch.localRefs[0]
}
