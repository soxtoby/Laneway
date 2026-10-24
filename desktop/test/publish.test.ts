import type { PublishActionResult, PublishBranchPlan, PublishPlan, PublishProgress, PublishReceipt, PublishRequest, PublishUpdate } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import type { Notice } from "../src/renderer/react/notice"
import { createPublish } from "../src/renderer/react/publish"

let repositoryId = "repository"
let one = "refs/heads/one"
let two = "refs/heads/two"

describe("publish controller", () => {
    test("reviewing several branches plans them in one Engine call, and each publishes its own plan", async () => {
        let fake = fakeApi(request =>
            request.action == "plans"
                ? planned([{ branch: one, message: "Publish one to origin.", plan: plan(updates().slice(0, 1), "one") }, {
                    branch: two,
                    message: "Publish one, two to origin.",
                    plan: plan(updates(), "two"),
                }])
                : published("Published one, two.")
        )
        let { sut } = publisher(fake)

        await sut.review(repositoryId, [one, two])
        await sut.publish(repositoryId, two)

        expect(fake.requests).toEqual([{ action: "plans", branches: [one, two], remote: "origin" }, {
            action: "publish",
            branch: two,
            remote: "origin",
            token: "two",
        }])
    })

    test("a successful publish confirms in passing without Undo and reads the repository again", async () => {
        let fake = fakeApi(request =>
            request.action == "plans" ? planned([{ branch: two, message: "Publish one, two to origin.", plan: plan() }]) : published("Published one, two.")
        )
        let { sut, notices, completed } = publisher(fake)
        await sut.review(repositoryId, [two])

        await sut.publish(repositoryId, two)

        expect(notices).toEqual([{ code: "publish.completed", message: "Published one, two.", transient: true }])
        expect(completed).toEqual([repositoryId])
        expect(sut.snapshot().outcomes).toEqual({})
    })

    test("a branch the Engine couldn't plan gives the Engine's reason", async () => {
        let fake = fakeApi(() => planned([{ branch: two, message: "two is not a local branch." }]))
        let { sut } = publisher(fake)

        await sut.review(repositoryId, [two])

        expect(sut.snapshot().review).toEqual({ repositoryId, branches: { [two]: { error: "two is not a local branch." } } })
    })

    test("reviewing again keeps each branch's plan until the new one arrives, and drops branches no longer asked for", async () => {
        let answers: Array<() => void> = []
        let fake = fakeApi(request =>
            new Promise(resolve =>
                answers.push(() =>
                    resolve(planned((request as { branches: string[] }).branches.map(branch => ({ branch, message: "Publish.", plan: plan() }))))
                )
            )
        )
        let { sut } = publisher(fake)
        let first = sut.review(repositoryId, [one, two])
        answers[0]!()
        await first

        let second = sut.review(repositoryId, [two])

        expect(sut.snapshot().review).toEqual({ repositoryId, branches: { [two]: { plan: plan() } } })
        answers[1]!()
        await second
    })

    test("shows the Engine's progress for the publishing branch", async () => {
        let finish: (result: PublishActionResult) => void = () => {}
        let fake = fakeApi(request =>
            request.action == "plans" ? planned([{ branch: two, message: "Publish.", plan: plan() }]) : new Promise(resolve => finish = resolve)
        )
        let { sut } = publisher(fake)
        await sut.review(repositoryId, [two])

        let publishing = sut.publish(repositoryId, two)
        fake.progress({ repositoryId, message: "Publishing one…", completed: 1, total: 3 })
        expect(sut.snapshot().running).toEqual({ [repositoryId]: { branch: two, message: "Publishing one…" } })

        finish(published("Published one, two."))
        await publishing
        expect(sut.snapshot().running).toEqual({})
    })

    test("a stale lease opens an outcome whose way forward is Pull latest", async () => {
        let fake = fakeApi(request =>
            request.action == "plans"
                ? planned([{ branch: two, message: "Publish.", plan: plan() }])
                : {
                    ok: true,
                    result: {
                        type: "result",
                        command: "publish",
                        status: "stale",
                        message: "Nothing was published. origin/one changed since the last pull. Pull latest, then publish again.",
                        receipt: staleReceipt(),
                    },
                }
        )
        let { sut, notices, pulled } = publisher(fake)
        await sut.review(repositoryId, [two])

        await sut.publish(repositoryId, two)
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
            let fake = fakeApi((request, id) =>
                request.action == "plans"
                    ? planned([{ branch: two, message: "Publish.", plan: plan() }])
                    : new Promise(resolve => answers.set(id, resolve))
            )
            let { sut } = publisher(fake)
            let runs = new Map<string, Promise<void>>()
            for (let id of ["first", "second"]) {
                await sut.review(id, [two])
                runs.set(id, sut.publish(id, two))
            }

            for (let id of order) {
                answers.get(id)!(failed(`${id} was not published.`))
                await runs.get(id)
            }
            sut.close("first")

            expect(sut.snapshot().outcomes).toEqual({ second: { result: failed("second was not published.").result } })
        },
    )

    test("closing a repository forgets its outcome, so reopening it shows none", async () => {
        let fake = fakeApi(request =>
            request.action == "plans" ? planned([{ branch: two, message: "Publish.", plan: plan() }]) : failed("Nothing was published.")
        )
        let { sut } = publisher(fake)
        await sut.review(repositoryId, [two])
        await sut.publish(repositoryId, two)

        sut.retain([])
        sut.retain([repositoryId])

        expect(sut.snapshot().outcomes).toEqual({})
    })

    test("an earlier review answering after a later one is dropped", async () => {
        let answers: Array<() => void> = []
        let fake = fakeApi(request =>
            new Promise(resolve => {
                let [branch] = (request as { branches: string[] }).branches
                answers.push(() => resolve(planned([{ branch: branch!, message: "Publish.", plan: plan(updates(), branch) }])))
            })
        )
        let { sut } = publisher(fake)

        let first = sut.review(repositoryId, [one])
        let second = sut.review(repositoryId, [two])
        answers[1]!()
        await second
        answers[0]!()
        await first

        expect(sut.snapshot().review).toEqual({ repositoryId, branches: { [two]: { plan: plan(updates(), two) } } })
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

function planned(plans: PublishBranchPlan[]): PublishActionResult {
    return { ok: true, result: { type: "result", command: "publish", status: "planned", message: "Planned.", plans } }
}

function published(message: string): PublishActionResult {
    return { ok: true, result: { type: "result", command: "publish", status: "published", message } }
}

function failed(message: string) {
    return { ok: true, result: { type: "result", command: "publish", status: "failed", message } } satisfies PublishActionResult
}

function plan(planned = updates(), token = "reviewed"): PublishPlan {
    return { stack: ["main", "one", "two"], updates: planned, token }
}

function staleReceipt(): PublishReceipt {
    return {
        version: 1,
        id: "20261022T000000000-abcd",
        timestamp: "2026-10-22T00:00:00.000Z",
        kind: "publish",
        stack: ["main", "one", "two"],
        updates: updates().map(update => ({ ...update, status: update.branch == "one" ? "stale" : "pending" })),
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
