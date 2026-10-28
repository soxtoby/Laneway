import type { FetchResult } from "@laneway/shared"
import { errorMessage } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface BackgroundFetchSnapshot {
    /** Why each repository's last background fetch failed, until one succeeds. */
    failures: Record<string, string>
}

export interface BackgroundFetch extends Store<BackgroundFetchSnapshot> {
    /** Fetches the active repository unless it fetched within the last minute. */
    refresh(): Promise<void>
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
    let store = createStore<BackgroundFetchSnapshot>({ failures: {} })
    let fetched = new Map<string, number>()
    let running = new Set<string>()

    async function refresh() {
        let scope = active()
        let last = scope && fetched.get(scope.repositoryId)
        if (!scope || running.has(scope.repositoryId) || last != undefined && environment.now() - last < fresh)
            return

        let { repositoryId, branches, remote } = scope
        running.add(repositoryId)
        fetched.set(repositoryId, environment.now())
        try {
            let response = await api.fetchLatest(repositoryId, { branches, remote })
            // Pull latest fetched instead, and reports its own failures.
            if (!response.ok || response.result.status != "cancelled")
                fail(repositoryId, response.ok ? failure(response.result) : response.error.message)
        } catch (error) {
            fail(repositoryId, errorMessage(error))
        } finally {
            running.delete(repositoryId)
        }
    }

    function fail(repositoryId: string, message: string | undefined) {
        let failures = { ...store.snapshot().failures }
        if (message)
            failures[repositoryId] = message
        else
            delete failures[repositoryId]
        if (failures[repositoryId] != store.snapshot().failures[repositoryId])
            store.publish({ failures })
    }

    let stops = [
        environment.every(interval, () => {
            if (environment.focused())
                void refresh()
        }),
        environment.onFocus(() => void refresh()),
    ]

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        refresh,
        dispose() {
            for (let stop of stops)
                stop()
            store.clear()
        },
    }
}

function failure(result: FetchResult) {
    let failed = result.fetches.filter(fetch => fetch.status == "failed")
    return failed.length ? failed.map(fetch => `${fetch.remote}: ${fetch.message ?? "Git could not fetch it."}`).join("\n") : undefined
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
