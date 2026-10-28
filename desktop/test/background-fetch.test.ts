import type { FetchActionResult, FetchRequest } from "@laneway/shared"
import { expect, test } from "bun:test"
import { type BackgroundFetchEnvironment, createBackgroundFetch } from "../src/renderer/react/background-fetch"

test("fetches the active repository's open scope at most once a minute, every five minutes while focused, and on focus", async () => {
    let { environment, advance, focus, setFocused } = fakeEnvironment()
    let requests: Array<[string, FetchRequest]> = []
    let fetching = createBackgroundFetch({
        api: {
            fetchLatest: async (repositoryId, request) => {
                requests.push([repositoryId, request])
                return fetched()
            },
        },
        active: () => ({ repositoryId: "repo", branches: ["refs/heads/feature"], remote: "origin" }),
        environment,
    })

    await fetching.refresh()
    await fetching.refresh()

    expect(requests).toEqual([["repo", { branches: ["refs/heads/feature"], remote: "origin" }]])

    await advance(30_000)
    await focus()

    expect(requests).toHaveLength(1)

    await advance(30_000)
    await focus()

    expect(requests).toHaveLength(2)

    setFocused(false)
    await advance(5 * 60_000)

    expect(requests).toHaveLength(2)

    setFocused(true)
    await advance(5 * 60_000)

    expect(requests).toHaveLength(3)

    fetching.dispose()
    await advance(5 * 60_000)

    expect(requests).toHaveLength(3)
})

test("keeps a failed fetch's reason until a fetch succeeds, ignoring fetches Pull latest made instead", async () => {
    let { environment, advance } = fakeEnvironment()
    let responses: FetchActionResult[] = [fetched([{ remote: "origin", status: "failed", message: "terminal prompts disabled" }]), fetched([], "cancelled"), {
        ok: false,
        error: { message: "The engine stopped." },
    }, fetched()]
    let fetching = createBackgroundFetch({
        api: { fetchLatest: async () => responses.shift()! },
        active: () => ({ repositoryId: "repo", branches: [] }),
        environment,
    })
    let failures: Array<string | undefined> = []
    for (let index = 0; index < 4; index++) {
        await fetching.refresh()
        failures.push(fetching.snapshot().failures.repo)
        await advance(60_000)
    }

    expect(failures).toEqual(["origin: terminal prompts disabled", "origin: terminal prompts disabled", "The engine stopped.", undefined])
})

test("waits for the active repository's Branch Graph before fetching", async () => {
    let { environment } = fakeEnvironment()
    let requests = 0
    let scope: { repositoryId: string; branches: string[] } | undefined
    let fetching = createBackgroundFetch({
        api: {
            fetchLatest: async () => {
                requests++
                return fetched()
            },
        },
        active: () => scope,
        environment,
    })

    await fetching.refresh()

    expect(requests).toBe(0)

    scope = { repositoryId: "repo", branches: [] }
    await fetching.refresh()

    expect(requests).toBe(1)
})

function fetched(fetches: Extract<FetchActionResult, { ok: true }>["result"]["fetches"] = [], status: "fetched" | "cancelled" = "fetched"): FetchActionResult {
    return { ok: true, result: { type: "result", command: "fetch", status, message: "", fetches, fastForwarded: [] } }
}

function fakeEnvironment() {
    let now = 0
    let focused = true
    let timers: Array<{ every: number; next: number; run: () => void }> = []
    let focusListeners = new Set<() => void>()
    let environment: BackgroundFetchEnvironment = {
        now: () => now,
        focused: () => focused,
        every(milliseconds, run) {
            let timer = { every: milliseconds, next: now + milliseconds, run }
            timers.push(timer)
            return () => timers.splice(timers.indexOf(timer), 1)
        },
        onFocus(run) {
            focusListeners.add(run)
            return () => focusListeners.delete(run)
        },
    }
    return {
        environment,
        setFocused: (value: boolean) => focused = value,
        async advance(milliseconds: number) {
            now += milliseconds
            for (let timer of [...timers]) {
                while (timer.next <= now) {
                    timer.next += timer.every
                    timer.run()
                }
            }
            await Bun.sleep(0)
        },
        async focus() {
            for (let listener of focusListeners)
                listener()
            await Bun.sleep(0)
        },
    }
}
