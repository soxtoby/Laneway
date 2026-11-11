import type { BranchGraph, BranchGraphBranchNode, CompositionRequest, LocalPreview } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

/** A tip a Branch Node offers as the new base: its local tip, or its upstream tip when that has commits the local one lacks. */
export interface RebaseDestination {
    branch: string
    tip: string
    name: string
    detail: string
}

/** A rebase under review: open as a dialog only for a choice or a decision the rebase can't make by itself. */
export interface PendingRebase {
    repositoryId: string
    source: BranchGraphBranchNode
    destinations: RebaseDestination[]
    destination: RebaseDestination
    selectedRemote?: string
    descendants: boolean
    /** Branches carried along by the rebase, as first reviewed with them included. */
    dependents: string[]
    preview?: LocalPreview
    dialog: boolean
    error: string
}

export interface RebaseSnapshot {
    /** The branch whose destination is being chosen by keyboard. */
    choosing?: { repositoryId: string; sourceId: string }
    pending?: PendingRebase
    busy: boolean
    executing: boolean
}

export interface BranchRebase extends Store<RebaseSnapshot> {
    /** Starts choosing a destination by keyboard: the graph's selection chooses it, Enter rebases, Escape cancels. */
    choose(repositoryId: string, source: BranchGraphBranchNode): void
    stopChoosing(): void
    /** Rebases the chosen branch onto `targetId`, or explains why it can't. */
    chooseDestination(repositoryId: string, graph: BranchGraph, targetId: string): void
    /** Reviews rebasing `sourceId` onto `targetId`; it runs at once unless something needs deciding. */
    start(repositoryId: string, graph: BranchGraph, sourceId: string, targetId: string): Promise<void>
    setDestination(destination: RebaseDestination): void
    setDescendants(descendants: boolean): void
    review(): Promise<void>
    /** Runs the reviewed rebase; with `resolveNow`, its conflicts open to resolve straight away. */
    execute(resolveNow?: boolean): Promise<void>
    /** Whether a rebase with conflicts can go on to resolve them now. */
    readonly resolves: boolean
    cancel(): void
}

interface RebaseOptions {
    api: Pick<Api, "localOperation">
    notify(notice: Notice): () => void
    mutating(busy: boolean): void
    /** Runs after a rebase, which rewrites the branches it moves. */
    completed(repositoryId: string): Promise<void>
    /** Opens the rebased stack to resolve its conflicts now: the named branches, the rebased one first. */
    resolve?(repositoryId: string, branches: string[]): void
}

/** Rebasing a Branch Node's own commits onto another branch, by drag and drop or by keyboard. */
export function createBranchRebase({ api, notify: show, mutating, completed, resolve }: RebaseOptions): BranchRebase {
    let store = createStore<RebaseSnapshot>({ busy: false, executing: false })
    let state = store.snapshot
    let set = (change: Partial<RebaseSnapshot>) => store.publish({ ...state(), ...change })
    let generation = 0
    let dismiss = () => {}
    let notify = (notice: Notice) => {
        dismiss()
        dismiss = show(notice)
    }
    let setBusy = (busy: boolean) => {
        if (busy != state().busy)
            mutating(busy)
        set({ busy })
    }
    let request = (current: PendingRebase): CompositionRequest => ({
        action: "compose",
        source: { kind: "branch", branch: current.source.preferredRef, tip: current.source.tip },
        target: { kind: "branch", branch: current.destination.branch, tip: current.destination.tip },
        mode: "move",
        selectedRemote: current.selectedRemote,
        view: "combined",
        message: "",
        descendants: current.descendants,
        allowConflicts: false,
    })
    // The pending rebase changes in place, so each change publishes a copy.
    let update = (current: PendingRebase) => {
        if (state().pending == current)
            set({ pending: { ...current } })
    }

    async function prepare() {
        let current = state().pending
        if (!current || state().busy)
            return
        let version = ++generation
        current = { ...current, preview: undefined, error: "" }
        set({ pending: current })
        if (!current.dialog)
            notify({ code: "rebase.progress", message: `Rebasing ${current.source.name} onto ${current.destination.name}…` })
        setBusy(true)
        try {
            let response = await api.localOperation(current.repositoryId, request(current))
            if (version != generation || state().pending != current)
                return
            if (!response.ok)
                throw new Error(response.error.message)
            if (response.result.status == "failed" || !response.result.preview?.composition)
                throw new Error(response.result.message ?? "The rebase couldn't be reviewed.")
            let preview = response.result.preview
            current = {
                ...current,
                preview,
                dependents: current.descendants
                    ? preview.composition!.branches.filter(name => name != shortName(current!.source.preferredRef))
                    : current.dependents,
            }
            set({ pending: current })
        } catch (error) {
            if (version == generation && state().pending == current)
                fail(current, error)
        } finally {
            setBusy(false)
        }
        let reviewed = state().pending == current ? current.preview?.composition : undefined
        if (reviewed && !current.dialog) {
            if (reviewed.noop) {
                notify({ code: "rebase.current", message: `${current.source.name} is already on top of ${current.destination.name}.`, transient: true })
                return finish()
            }
            // Conflicts, rewritten published history, and emptied commits each need a decision first.
            if (reviewed.conflicts.length > 0 || reviewed.published.length > 0 || reviewed.removed.length > 0) {
                dismiss()
                update(Object.assign(current, { dialog: true }))
            } else {
                await execute()
            }
        }
    }

    async function execute(resolveNow = false) {
        let current = state().pending
        let reviewed = current?.preview?.composition
        if (!current?.preview || !reviewed || state().busy)
            return
        set({ executing: true })
        setBusy(true)
        try {
            let response = await api.localOperation(
                current.repositoryId,
                { ...request(current), allowConflicts: reviewed.conflicts.length > 0 },
                current.preview.token,
            )
            if (!response.ok)
                throw new Error(response.error.message)
            if (response.result.status == "failed")
                throw new Error(response.result.message)
            let moved = current.descendants ? current.dependents : []
            let hook = response.result.hookFailure
            notify({
                code: "rebase.completed",
                message: `Rebased ${current.source.name}${moved.length ? ` and ${moved.join(", ")}` : ""} onto ${current.destination.name}${
                    reviewed.conflicts.length ? ", with conflicts to resolve before publishing." : "."
                }${hook ? ` ${hook.message}` : ""}`,
                output: hook?.output,
                transient: !reviewed.conflicts.length && !hook,
            })
            set({ pending: undefined })
            await completed(current.repositoryId)
            if (resolveNow)
                resolve?.(current.repositoryId, [shortName(current.source.preferredRef), ...moved])
        } catch (error) {
            fail(current, error)
        } finally {
            set({ executing: false })
            setBusy(false)
        }
    }

    function fail(current: PendingRebase, error: unknown) {
        if (current.dialog) {
            // A failed or changed rebase is reviewed again before it can run.
            update(Object.assign(current, { error: errorMessage(error), preview: undefined }))
        } else {
            notify({ code: "rebase.failed", message: `Couldn't rebase ${current.source.name}: ${errorMessage(error)}` })
            set({ pending: undefined })
        }
    }

    function finish() {
        set({ pending: undefined })
    }

    let rebase: BranchRebase = {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        choose(repositoryId, source) {
            if (state().busy || state().pending || !rebaseable(source))
                return
            set({ choosing: { repositoryId, sourceId: source.id } })
            notify({ code: "rebase.choose", message: `Rebase ${source.name} · Choose a destination branch, then Enter. Escape cancels.` })
        },

        stopChoosing() {
            if (!state().choosing)
                return
            set({ choosing: undefined })
            dismiss()
        },

        chooseDestination(repositoryId, graph, targetId) {
            let sourceId = state().choosing?.sourceId
            let source = graph.branches.find(branch => branch.id == sourceId)
            let target = graph.branches.find(branch => branch.id == targetId)
            if (!source)
                return
            if (target && canRebaseOnto(graph, source, target))
                void rebase.start(repositoryId, graph, source.id, target.id)
            else
                notify({ code: "rebase.choose", message: `Choose a branch other than ${source.name} and the branches stacked on it.` })
        },

        async start(repositoryId, graph, sourceId, targetId) {
            let source = graph.branches.find(branch => branch.id == sourceId)
            let target = graph.branches.find(branch => branch.id == targetId)
            if (state().busy || state().pending || !source || !target || !canRebaseOnto(graph, source, target))
                return
            let choices = destinations(target)
            set({
                choosing: undefined,
                pending: {
                    repositoryId,
                    source,
                    destinations: choices,
                    destination: choices[0]!,
                    selectedRemote: graph.selectedRemote,
                    descendants: true,
                    dependents: [],
                    dialog: choices.length > 1,
                    error: "",
                },
            })
            if (choices.length > 1)
                dismiss()
            await prepare()
        },

        setDestination(destination) {
            let current = state().pending
            if (current && !state().busy) {
                set({ pending: { ...current, destination } })
                void prepare()
            }
        },

        setDescendants(descendants) {
            let current = state().pending
            if (current && !state().busy) {
                set({ pending: { ...current, descendants } })
                void prepare()
            }
        },

        review: prepare,
        execute,
        resolves: resolve != undefined,

        cancel() {
            if (state().executing)
                return
            generation++
            finish()
        },
    }
    return rebase
}

/**
 * A branch can't be rebased onto itself or onto a branch stacked on it, whose history the rebase rewrites. Branches
 * sharing its tip count as itself: Bases name only one of them.
 */
export function canRebaseOnto(graph: BranchGraph, source: BranchGraphBranchNode, target: BranchGraphBranchNode) {
    if (!rebaseable(source) || target.tip == source.tip)
        return false
    let seen = new Set<string>()
    for (let node: BranchGraphBranchNode | undefined = target; node?.base.status == "known" && !seen.has(node.id);) {
        seen.add(node.id)
        if (node.base.tip == source.tip)
            return false
        let baseId: string = node.base.branchId
        node = graph.branches.find(branch => branch.id == baseId)
    }
    return true
}

/** Only a local line of work with a Base has its own commits to move. */
export function rebaseable(branch: BranchGraphBranchNode) {
    return !branch.remoteOnly && !branch.primary && branch.localRefs.length > 0
}

// A node draws its local tip but combines it with its upstream; when the upstream holds commits the local tip lacks,
// "onto this branch" could mean either.
function destinations(target: BranchGraphBranchNode): RebaseDestination[] {
    let local = { branch: target.preferredRef, tip: target.tip, name: target.name, detail: "" }
    if (target.remoteOnly || !target.upstreamRef || !target.upstreamTip || target.upstreamTip == target.tip || target.behind == 0)
        return [local]
    let upstream = shortName(target.upstreamRef)
    local.detail = `Local tip, ${plural(target.behind, "commit")} behind ${upstream}${target.ahead ? ` and ${target.ahead} ahead` : ""}`
    return [local, { branch: target.upstreamRef, tip: target.upstreamTip, name: upstream, detail: "Upstream tip" }]
}

export function plural(count: number, noun: string) {
    return `${count} ${noun}${count == 1 ? "" : "s"}`
}

function shortName(ref: string) {
    return ref.replace(/^refs\/(heads|remotes)\//, "")
}
