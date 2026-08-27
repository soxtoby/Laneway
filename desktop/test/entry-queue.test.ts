import { describe, expect, test } from "bun:test"
import { EntryQueue } from "../src/main/entry-queue"

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(complete => resolve = complete)
    return { promise, resolve }
}

describe("repository entry queue", () => {
    test("runs requests in FIFO order and continues after failure results", async () => {
        const first = deferred<string>()
        const started: string[] = []
        const queue = new EntryQueue(() => "cancelled")
        const one = queue.enqueue(async () => {
            started.push("one")
            return first.promise
        })
        const two = queue.enqueue(async () => {
            started.push("two")
            return "failed"
        })
        const three = queue.enqueue(async () => {
            started.push("three")
            return "done"
        })

        await Promise.resolve()
        expect(started).toEqual(["one"])
        first.resolve("opened")
        expect(await Promise.all([one, two, three])).toEqual(["opened", "failed", "done"])
        expect(started).toEqual(["one", "two", "three"])
    })

    test("continues after a request throws", async () => {
        const queue = new EntryQueue(() => "cancelled")
        const failed = queue.enqueue(async () => {
            throw new Error("failed")
        })
        const next = queue.enqueue(async () => "opened")

        await expect(failed).rejects.toThrow("failed")
        expect(await next).toBe("opened")
    })

    test("cancels the active clone and clears queued requests", async () => {
        const active = deferred<string>()
        let cancelled = false
        const queue = new EntryQueue(() => "cancelled")
        const clone = queue.enqueue(async setCancel => {
            setCancel(() => {
                cancelled = true
                active.resolve("cancelled")
            })
            return active.promise
        })
        const queued = queue.enqueue(async () => "should not run")

        await Promise.resolve()
        expect(queue.cancel()).toBeTrue()
        expect(cancelled).toBeTrue()
        expect(await Promise.all([clone, queued])).toEqual(["cancelled", "cancelled"])
        expect(queue.cancel()).toBeFalse()
    })
})
