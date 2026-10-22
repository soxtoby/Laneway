import type { PublishActionResult, PublishPlan, PublishProgress, PublishReceipt, PublishRequest, PublishUpdate } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import type { Notice } from "../src/renderer/react/notice"
import { createPublish } from "../src/renderer/react/publish"

let repositoryId = "repository"
let branch = "refs/heads/two"

describe("publish controller", () => {
    test("publishes the reviewed plan with its token, confirms in passing without Undo, and shows the new receipt", async () => {
        let receipt = publishReceipt("published")
        let fake = fakeApi(request =>
            request.action == "plan"
                ? planned(fake.requests.length > 1 ? { ...plan(), updates: [], receipt } : plan())
                : { ok: true, result: { type: "result", command: "publish", status: "published", message: "Published one, two.", receipt } }
        )
        let { sut, notices, completed } = publisher(fake)

        await sut.review(repositoryId, branch)
        await sut.publish()

        expect(fake.requests).toEqual([{ action: "plan", branch, remote: "origin" }, { action: "publish", branch, remote: "origin", token: "reviewed" }, {
            action: "plan",
            branch,
            remote: "origin",
        }])
        expect(notices).toEqual([{ code: "publish.completed", message: "Published one, two.", transient: true }])
        expect(completed).toEqual([repositoryId])
        expect(sut.snapshot().outcomes).toEqual({})
        expect(sut.snapshot().review?.plan?.receipt).toEqual(receipt)
    })

    test("shows the Engine's progress while publishing", async () => {
        let finish: (result: PublishActionResult) => void = () => {}
        let fake = fakeApi(request => request.action == "plan" ? planned(plan()) : new Promise(resolve => finish = resolve))
        let { sut } = publisher(fake)
        await sut.review(repositoryId, branch)

        let publishing = sut.publish()
        fake.progress({ repositoryId, message: "Publishing one…", completed: 1, total: 3 })
        expect(sut.snapshot().running).toEqual({ [repositoryId]: "Publishing one…" })

        finish({ ok: true, result: { type: "result", command: "publish", status: "published", message: "Published one, two." } })
        await publishing
        expect(sut.snapshot().running).toEqual({})
    })

    test("a stale lease opens an outcome whose way forward is Pull latest", async () => {
        let fake = fakeApi(request =>
            request.action == "plan"
                ? planned(plan())
                : {
                    ok: true,
                    result: {
                        type: "result",
                        command: "publish",
                        status: "stale",
                        message: "Nothing was published. origin/one changed since the last pull. Pull latest, then publish again.",
                        receipt: publishReceipt("stale"),
                    },
                }
        )
        let { sut, notices, pulled } = publisher(fake)
        await sut.review(repositoryId, branch)

        await sut.publish()
        expect(notices).toEqual([])
        expect(sut.snapshot().outcomes[repositoryId]?.result?.status).toBe("stale")

        sut.pull(repositoryId)
        expect(pulled).toEqual([repositoryId])
        expect(sut.snapshot().outcomes).toEqual({})
    })

    test.each([[["first", "second"]], [["second", "first"]]])(
        "publishes in two repositories each keep their outcome until it is closed, finishing in the order %p",
        async order => {
            let answers = new Map<string, (result: PublishActionResult) => void>()
            let fake = fakeApi((_request, id) => new Promise(resolve => answers.set(id, resolve)))
            let { sut } = publisher(fake)
            let runs = new Map(["first", "second"].map(id => [id, sut.resume(id, "receipt")]))

            for (let id of order) {
                answers.get(id)!({ ok: true, result: { type: "result", command: "publish", status: "failed", message: `${id} was not published.` } })
                await runs.get(id)
            }
            sut.close("first")

            expect(sut.snapshot().outcomes).toEqual({
                second: { result: { type: "result", command: "publish", status: "failed", message: "second was not published." } },
            })
        },
    )

    test("an earlier review answering after a later one is dropped", async () => {
        let answers: Array<() => void> = []
        let fake = fakeApi(request =>
            new Promise(resolve => answers.push(() => resolve(planned({ ...plan(), stack: ["main", (request as { branch: string }).branch] }))))
        )
        let { sut } = publisher(fake)

        let first = sut.review(repositoryId, "refs/heads/one")
        let second = sut.review(repositoryId, branch)
        answers[1]!()
        await second
        answers[0]!()
        await first

        expect(sut.snapshot().review).toMatchObject({ branch, plan: { stack: ["main", branch] } })
    })
})

function publisher(fake: ReturnType<typeof fakeApi>) {
    let notices: Notice[] = []
    let completed: string[] = []
    let pulled: string[] = []
    let sut = createPublish({
        api: fake.api,
        notify: notice => notices.push(notice),
        remote: () => "origin",
        pull: id => pulled.push(id),
        completed: async id => {
            completed.push(id)
        },
    })
    return { sut, notices, completed, pulled }
}

function fakeApi(respond: (request: PublishRequest, repositoryId: string) => PublishActionResult | Promise<PublishActionResult>) {
    let requests: PublishRequest[] = []
    let listener: (progress: PublishProgress) => void = () => {}
    return {
        requests,
        progress: (progress: PublishProgress) => listener(progress),
        api: {
            publish: async (id: string, request: PublishRequest) => {
                requests.push(request)
                return respond(request, id)
            },
            onPublishProgress(next: (progress: PublishProgress) => void) {
                listener = next
                return () => {}
            },
        },
    }
}

function planned(value: PublishPlan): PublishActionResult {
    return { ok: true, result: { type: "result", command: "publish", status: "planned", message: "Publish one, two to origin.", plan: value } }
}

function plan(): PublishPlan {
    return { stack: ["main", "one", "two"], updates: updates(), token: "reviewed" }
}

function publishReceipt(outcome: "published" | "stale"): PublishReceipt {
    return {
        version: 1,
        id: "20261022T000000000-abcd",
        timestamp: "2026-10-22T00:00:00.000Z",
        kind: "publish",
        stack: ["main", "one", "two"],
        updates: updates().map(update => ({ ...update, status: outcome == "published" ? "published" : update.branch == "one" ? "stale" : "pending" })),
    }
}

function updates(): PublishUpdate[] {
    return [{ branch: "one", remote: "origin", ref: "refs/heads/one", expected: "1".repeat(40), target: "2".repeat(40), kind: "update", setUpstream: false }, {
        branch: "two",
        remote: "origin",
        ref: "refs/heads/two",
        expected: null,
        target: "3".repeat(40),
        kind: "create",
        setUpstream: true,
    }]
}
