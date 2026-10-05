import { describe, expect, test } from "bun:test"
import { EntryQueue } from "../src/main/entry-queue"

describe("repository entry queue", () => {
    test("runs requests in FIFO order and continues after failure results", async () => {
        let first = deferred<string>()
        let started: string[] = []
        let queue = new EntryQueue(() => "cancelled")
        let one = queue.enqueue(async () => {
            started.push("one")
            return first.promise
        })
        let two = queue.enqueue(async () => {
            started.push("two")
            return "failed"
        })
        let three = queue.enqueue(async () => {
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
        let queue = new EntryQueue(() => "cancelled")
        let failed = queue.enqueue(async () => {
            throw new Error("failed")
        })
        let next = queue.enqueue(async () => "opened")

        await expect(failed).rejects.toThrow("failed")
        expect(await next).toBe("opened")
    })

    test("cancels the active clone and clears queued requests", async () => {
        let active = deferred<string>()
        let cancelled = false
        let queue = new EntryQueue(() => "cancelled")
        let clone = queue.enqueue(async setCancel => {
            setCancel(() => {
                cancelled = true
                active.resolve("cancelled")
            })
            return active.promise
        })
        let queued = queue.enqueue(async () => "should not run")

        await Promise.resolve()
        expect(queue.cancel()).toBeTrue()
        expect(cancelled).toBeTrue()
        expect(await Promise.all([clone, queued])).toEqual(["cancelled", "cancelled"])
        expect(queue.cancel()).toBeFalse()
    })
})

function deferred<T>() {
    let resolve!: (value: T) => void
    let promise = new Promise<T>(complete => resolve = complete)

    return { promise, resolve }
}
