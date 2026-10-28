import type { FetchResult } from "@laneway/shared"
import { errorMessage } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface BackgroundFetchSnapshot {
    /** Repositories with a fetch under way. */
    running: Record<string, boolean>
    /** When each repository's last fetch finished without failing, in milliseconds since the epoch. */
    fetched: Record<string, number>
    /** Why each repository's last fetch failed, until one succeeds. */
    failures: Record<string, string>
}

export interface BackgroundFetch extends Store<BackgroundFetchSnapshot> {
    /** Fetches the active repository unless it fetched within the last minute. */
    refresh(): Promise<void>
    /** Fetches the active repository however recently it fetched, unless it is fetching already. */
    fetchNow(): Promise<void>
    dispose(): void
}

/** The window's focus and the clock, which tests replace. */
export interface BackgroundFetchEnvironment {
    now(): number
    focused(): boolean
    every(milliseconds: number, run: () => void): () => void
    onFocus(run: () => void): () => void
}

interface BackgroundFetchOptions {
    api: Pick<Api, "fetchLatest">
    /** The active repository's open columns' branch refs and selected remote, once its Branch Graph has loaded. */
    active(): { repositoryId: string; branches: string[]; remote?: string } | undefined
    environment?: BackgroundFetchEnvironment
}

// While the window is in use, the active repository fetches every five minutes; returning to the window fetches at once
// unless the last fetch is under a minute old.
let interval = 5 * 60_000
let fresh = 60_000

/**
 * Keeps remote branches current without Pull latest. Each fetch fast-forwards only branches outside the open columns'
 * stacks and those checked out, so the stacks being worked on change only when Pull latest runs.
 */
export function createBackgroundFetch({ api, active, environment = windowEnvironment() }: BackgroundFetchOptions): BackgroundFetch {
    let store = createStore<BackgroundFetchSnapshot>({ running: {}, fetched: {}, failures: {} })
    let started = new Map<string, number>()

    async function fetch(stale: boolean) {
        let scope = active()
        let last = scope && started.get(scope.repositoryId)
        if (!scope || store.snapshot().running[scope.repositoryId] || stale && last != undefined && environment.now() - last < fresh)
            return

        let { repositoryId, branches, remote } = scope
        started.set(repositoryId, environment.now())
        update(repositoryId, { running: true })
        let failure: string | undefined
        try {
            let response = await api.fetchLatest(repositoryId, { branches, remote })
            // Pull latest fetched instead, and reports its own failures.
            if (response.ok && response.result.status == "cancelled") {
                update(repositoryId, { running: false })
                return
            }
            failure = response.ok ? failed(response.result) : response.error.message
        } catch (error) {
            failure = errorMessage(error)
        }
        update(repositoryId, failure ? { running: false, failure } : { running: false, fetched: environment.now() })
    }

    function update(repositoryId: string, change: { running: boolean; fetched?: number; failure?: string }) {
        let { running, fetched, failures } = store.snapshot()
        running = { ...running, [repositoryId]: change.running }
        if (change.fetched != undefined) {
            fetched = { ...fetched, [repositoryId]: change.fetched }
            failures = { ...failures }
            delete failures[repositoryId]
        }
        if (change.failure)
            failures = { ...failures, [repositoryId]: change.failure }
        store.publish({ running, fetched, failures })
    }

    let stops = [
        environment.every(interval, () => {
            if (environment.focused())
                void fetch(true)
        }),
        environment.onFocus(() => void fetch(true)),
    ]

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        refresh: () => fetch(true),
        fetchNow: () => fetch(false),
        dispose() {
            for (let stop of stops)
                stop()
            store.clear()
        },
    }
}

function failed(result: FetchResult) {
    let failures = result.fetches.filter(fetch => fetch.status == "failed")
    return failures.length ? failures.map(fetch => `${fetch.remote}: ${fetch.message ?? "Git could not fetch it."}`).join("\n") : undefined
}

// Controllers also run without a window, as their tests do; there, nothing has focus.
function windowEnvironment(): BackgroundFetchEnvironment {
    return {
        now: () => Date.now(),
        focused: () => typeof document != "undefined" && document.hasFocus(),
        every(milliseconds, run) {
            let timer = setInterval(run, milliseconds)
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
