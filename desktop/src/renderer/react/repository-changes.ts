import type { Inspection, InspectionSnapshot } from "./inspection"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

/** A repository's Working Changes, as its row in the repository panel shows them. */
export interface RepositoryChangesState {
    /** How many of its worktrees have Working Changes. */
    count: number
    /** They changed since the repository was last left, or it hasn't shown since Laneway started. */
    unseen: boolean
}

/** Each repository's Working Changes; a repository not yet checked is absent. */
export type RepositoryChangesSnapshot = Record<string, RepositoryChangesState>

export interface RepositoryChanges extends Store<RepositoryChangesSnapshot> {
    /**
     * Keeps these available repositories' Working Changes only, checking any not yet checked. The active repository's
     * are seen, and a repository left behind's are seen as they were when it was left.
     */
    retain(repositoryIds: string[], activeRepositoryId?: string): void
    /** Checks a repository again, unless its columns already show its Working Changes. */
    check(repositoryId: string): Promise<void>
    dispose(): void
}

/** The window's focus and the clock, which tests replace. */
export interface RepositoryChangesEnvironment {
    focused(): boolean
    every(intervalMs: number, run: () => void): () => void
    onFocus(run: () => void): () => void
}

interface RepositoryChangesOptions {
    api: Pick<Api, "readChangedWorktrees">
    inspection: Pick<Inspection, "subscribe" | "snapshot">
    environment?: RepositoryChangesEnvironment
}

// Returning to the window checks at once, as changes made elsewhere usually come from another window.
let checkIntervalMs = 15_000

/**
 * Whether each open repository has Working Changes, and whether they changed since it last showed. The active
 * repository's count comes from the Working Changes its columns read; the others are checked in turn while the window
 * is in use.
 */
export function createRepositoryChanges({ api, inspection, environment = windowEnvironment() }: RepositoryChangesOptions): RepositoryChanges {
    let store = createStore<RepositoryChangesSnapshot>({})
    let retained: string[] = []
    let activeId: string | undefined
    let counts = new Map<string, number>()
    let versions = new Map<string, string>()
    // Each repository's version when it was last left. One left but not yet checked again counts as seen.
    let seenVersions = new Map<string, string>()
    let leaving = new Set<string>()
    let checking = new Set<string>()
    let sweeping: Promise<void> | undefined

    function publish() {
        let next = Object.fromEntries(retained.filter(repositoryId => counts.has(repositoryId)).map(repositoryId => [repositoryId, state(repositoryId)]))
        if (JSON.stringify(next) != JSON.stringify(store.snapshot()))
            store.publish(next)
    }

    function state(repositoryId: string): RepositoryChangesState {
        let count = counts.get(repositoryId)!
        let changedSinceSeen = seenVersions.get(repositoryId) != versions.get(repositoryId)
        return { count, unseen: count > 0 && repositoryId != activeId && !leaving.has(repositoryId) && changedSinceSeen }
    }

    function shown() {
        let counted = shownChangedWorktrees(inspection.snapshot())
        return counted?.repositoryId == activeId ? counted : undefined
    }

    // A failed check leaves the last count in place.
    async function check(repositoryId: string) {
        if (checking.has(repositoryId) || shown()?.repositoryId == repositoryId)
            return

        checking.add(repositoryId)
        let result = await api.readChangedWorktrees(repositoryId).catch(() => undefined)
        checking.delete(repositoryId)
        if (result?.ok && retained.includes(repositoryId))
            take(repositoryId, result.changes.count, result.changes.version)
    }

    function take(repositoryId: string, count: number, version: string) {
        versions.set(repositoryId, version)
        if (leaving.delete(repositoryId))
            seenVersions.set(repositoryId, version)
        // The columns may have read the repository's Working Changes meanwhile, which are newer.
        if (shown()?.repositoryId != repositoryId)
            counts.set(repositoryId, count)
        publish()
    }

    // One repository at a time, so a workspace of many repositories never starts Git in all of them at once.
    async function sweep(repositoryIds: string[]) {
        for (let repositoryId of repositoryIds)
            await check(repositoryId)
    }

    function sweepAll() {
        sweeping ??= sweep(retained).finally(() => sweeping = undefined)
    }

    function forgetClosed() {
        for (let known of [counts, versions, seenVersions, leaving]) {
            for (let repositoryId of [...known.keys()].filter(repositoryId => !retained.includes(repositoryId)))
                known.delete(repositoryId)
        }
    }

    let stops = [
        inspection.subscribe(() => {
            let counted = shown()
            if (counted && retained.includes(counted.repositoryId)) {
                counts.set(counted.repositoryId, counted.count)
                publish()
            }
        }),
        environment.every(checkIntervalMs, () => {
            if (environment.focused())
                sweepAll()
        }),
        environment.onFocus(sweepAll),
    ]

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        retain(repositoryIds, activeRepositoryId) {
            let left = activeId && activeId != activeRepositoryId && repositoryIds.includes(activeId) ? [activeId] : []
            retained = repositoryIds
            activeId = activeRepositoryId
            forgetClosed()
            for (let repositoryId of left)
                leaving.add(repositoryId)
            publish()
            // The repository left behind goes first, so what it showed soon counts as seen.
            void sweep([...new Set([...left, ...repositoryIds.filter(repositoryId => !counts.has(repositoryId))])])
        },

        check,

        dispose() {
            for (let stop of stops)
                stop()
            store.clear()
        },
    }
}

/**
 * How many worktrees the inspected repository's columns show Working Changes for, once every worktree column has
 * read them. Until then, and without worktree columns, the repository is checked like any other.
 */
export function shownChangedWorktrees(snapshot: InspectionSnapshot) {
    let worktrees = Object.values(snapshot.columns).flatMap(column =>
        column.worktreePath ? [{ path: column.worktreePath, inventory: column.files.working?.inventory }] : []
    )
    if (!snapshot.repositoryId || worktrees.length == 0 || worktrees.some(worktree => !worktree.inventory))
        return undefined

    let changed = worktrees.filter(worktree => worktree.inventory!.files.some(file => !file.ignored))
    return { repositoryId: snapshot.repositoryId, count: new Set(changed.map(worktree => worktree.path)).size }
}

// Controllers also run without a window, as their tests do; there, nothing has focus.
function windowEnvironment(): RepositoryChangesEnvironment {
    return {
        focused: () => typeof document != "undefined" && document.visibilityState == "visible" && document.hasFocus(),
        every(intervalMs, run) {
            let timer = setInterval(run, intervalMs)
            return () => clearInterval(timer)
        },
        onFocus(run) {
            if (typeof window == "undefined")
                return () => {}
            window.addEventListener("focus", run)
            return () => window.removeEventListener("focus", run)
        },
    }
}
