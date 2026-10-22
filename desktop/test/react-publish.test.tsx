import type { PublishActionResult, PublishPlan, PublishReceipt, PublishRequest, PublishUpdate, PullRequest, Workspace } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps } from "./react-dom"
import { appState, branchGraph, fakeLaneway, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

let one: PublishUpdate = {
    branch: "one",
    remote: "origin",
    ref: "refs/heads/one",
    expected: "a".repeat(40),
    target: "b".repeat(40),
    kind: "update",
    setUpstream: false,
}
let feature: PublishUpdate = {
    branch: "feature/laneway",
    remote: "origin",
    ref: "refs/heads/feature/laneway",
    expected: null,
    target: "2".repeat(40),
    kind: "create",
    setUpstream: true,
}

describe("React Publish", () => {
    test("the focused column lists every destination, and publishing them confirms in passing without Undo", async () => {
        let { app, requests } = await startPublishing(request =>
            request.action == "plan" ? planned([one, feature]) : result("published", "Published one, feature/laneway.")
        )

        expect(document.querySelectorAll(".publish-control").length).toBe(1)
        expect(control().closest(".column")?.getAttribute("aria-label")).toBe("feature/laneway")
        expect(destinations()).toEqual(["Update origin/one", "New origin/feature/laneway sets upstream"])
        expect(control().querySelector(".publish-stack")?.textContent).toBe("Stack: main › one › feature/laneway")

        await app.act(() => press(button(control(), "Publish")))
        expect(requests.find(request => request.action == "publish")).toEqual({
            action: "publish",
            branch: "refs/heads/feature/laneway",
            remote: "origin",
            token: "reviewed",
        })
        let notice = document.querySelector<HTMLElement>("[role=alertdialog]")!
        expect(notice.textContent).toContain("Published one, feature/laneway.")
        expect([...notice.querySelectorAll("button")].some(element => element.textContent == "Undo")).toBe(false)
    })

    test("with nothing to publish, Publish is disabled and says why", async () => {
        await startPublishing(() => planned([]))

        expect(button(control(), "Publish").hasAttribute("disabled")).toBe(true)
        expect(control().querySelector(".publish-button")?.getAttribute("aria-description")).toBe("Everything in this stack is already published.")
        expect(destinations()).toEqual([])
    })

    test("a non-fast-forward update turns the control into Force publish, naming each force-with-lease ref", async () => {
        await startPublishing(() => planned([{ ...one, kind: "force" }, feature]))

        expect(button(control(), "Force publish").hasAttribute("data-force")).toBe(true)
        expect(destinations()).toEqual(["Force with lease origin/one", "New origin/feature/laneway sets upstream"])
    })

    test("a stale lease shows that nothing was published and offers Pull latest, which pulls", async () => {
        let pulled: unknown[] = []
        let { app } = await startPublishing(
            request =>
                request.action == "plan"
                    ? planned([one, feature])
                    : result(
                        "stale",
                        "Nothing was published. origin/one changed since the last pull. Pull latest, then publish again.",
                        receipt([{ ...one, status: "stale", message: "origin/one changed since the last pull." }, { ...feature, status: "pending" }]),
                    ),
            { pullLatest: async (_id, request) => (pulled.push(request), { ok: false, error: { message: "Offline" } }) },
        )

        await app.act(() => press(button(control(), "Publish")))
        let outcome = document.querySelector<HTMLElement>(".publish-outcome")!
        expect([...outcome.querySelectorAll(".publish-status")].map(status => status.textContent)).toEqual(["Changed on remote", "Not published"])
        expect(outcome.querySelector(".publish-note")?.textContent).toContain("Pull latest brings in what changed")
        expect([...outcome.querySelectorAll("button")].some(element => element.textContent == "Resume")).toBe(false)

        await app.act(() => press(button(outcome, "Pull latest")))
        expect(pulled.length).toBe(1)
        expect(document.querySelector(".publish-outcome") == null).toBe(true)
    })

    test("a partial publish's receipt offers Resume after a restart, and an outcome that stops again offers it too", async () => {
        let partial = receipt([{ ...one, status: "published" }, { ...feature, status: "failed", message: "[remote rejected] (pre-receive hook declined)" }])
        let { app, requests } = await startPublishing(request =>
            request.action == "plan"
                ? planned([feature], partial)
                : result("partial", "Published one. origin/feature/laneway was not published. Resume once the cause is fixed.", partial)
        )

        expect(control().querySelector(".publish-receipt")?.textContent).toContain("Last publish stopped: feature/laneway not published.")
        expect(control().querySelector(".publish-restore")?.getAttribute("aria-description")).toContain("origin/one")
        await app.act(() => press(button(control(), "Resume")))
        let outcome = document.querySelector<HTMLElement>(".publish-outcome")!
        expect(outcome.querySelector(".publish-message")?.textContent).toBe("[remote rejected] (pre-receive hook declined)")

        await app.act(() => press(button(outcome, "Resume")))
        expect(requests.filter(request => request.action == "resume")).toEqual([{ action: "resume", receipt: partial.id }, {
            action: "resume",
            receipt: partial.id,
        }])
    })

    test("a stale outcome in a repository left while it published waits for it, and its Pull latest pulls that repository's stacks", async () => {
        let answer = Promise.withResolvers<PublishActionResult>()
        let pulled: [string, PullRequest][] = []
        let [first, second] = [repositoryEntry("D:\\Source\\first", ["main", "feature/laneway"]), repositoryEntry("D:\\Source\\second", ["main"])]
        let workspace: Workspace = { repositories: [first, second], activeRepositoryId: first.id }
        let { app } = await startPublishing(request => request.action == "plan" ? planned([one, feature]) : answer.promise, {
            getState: async () => ({ ...appState(), workspace }),
            readBranchGraph: async id => ({ ok: true, graph: branchGraph(id) }),
            selectRepository: async id => workspace = { ...workspace, activeRepositoryId: id },
            pullLatest: async (id, request) => (pulled.push([id, request]), { ok: false, error: { message: "Offline" } }),
        })

        await app.act(() => press(button(control(), "Publish")))
        await app.act(() => app.controller.selectRepository(second.id))
        await app.act(() => answer.resolve(result("stale", "Nothing was published.", receipt([{ ...one, status: "stale" }, { ...feature, status: "pending" }]))))
        expect(document.querySelector(".publish-outcome") == null).toBe(true)

        await app.act(() => app.controller.selectRepository(first.id))
        await app.act(() => press(button(document.querySelector<HTMLElement>(".publish-outcome")!, "Pull latest")))
        expect(pulled).toEqual([[first.id, { branches: ["refs/heads/main", "refs/heads/feature/laneway"], remote: "origin" }]])
    })
})

async function startPublishing(
    respond: (request: PublishRequest) => PublishActionResult | Promise<PublishActionResult>,
    overrides: Partial<Window["laneway"]> = {},
) {
    let repository = repositoryEntry("D:\\Source\\publish", ["main", "feature/laneway"])
    let graph = branchGraph(repository.id)
    let workspace = { repositories: [repository], activeRepositoryId: repository.id }
    let requests: PublishRequest[] = []
    let app = await startReactApp(fakeLaneway({
        getState: async () => ({ ...appState(), workspace }),
        readBranchGraph: async () => ({ ok: true, graph }),
        publish: async (_id, request) => {
            requests.push(request)
            return respond(request)
        },
        ...overrides,
    }))
    return { app, requests }
}

// A repository whose columns show the named branches, the last focused.
function repositoryEntry(path: string, branches: string[]) {
    let info = repositoryInfo(path)
    let shown = branches.map(name => branchGraph(info.id).branches.find(branch => branch.name == name)!)
    return {
        status: "available" as const,
        id: info.id,
        path: info.mainWorktree,
        info,
        layoutInitialized: true,
        focusedColumnId: shown.at(-1)!.id,
        columns: shown.map(item => ({ kind: "branch" as const, id: item.id, ref: item.preferredRef, lastSeenObjectId: item.tip, width: 380 })),
    }
}

function control() {
    return document.querySelector<HTMLElement>(".publish-control")!
}

function destinations() {
    return [...control().querySelectorAll(".publish-destinations li")].map(item => [...item.children].map(part => part.textContent).join(" "))
}

function planned(updates: PublishUpdate[], latest?: PublishReceipt): PublishActionResult {
    let plan: PublishPlan = { stack: ["main", "one", "feature/laneway"], updates, token: "reviewed", receipt: latest }
    return {
        ok: true,
        result: updates.length
            ? { type: "result", command: "publish", status: "planned", message: "Publish one, feature/laneway to origin.", plan }
            : { type: "result", command: "publish", status: "nothing", message: "Everything in this stack is already published.", plan },
    }
}

function result(status: "published" | "partial" | "stale", message: string, published?: PublishReceipt): PublishActionResult {
    return { ok: true, result: { type: "result", command: "publish", status, message, receipt: published } }
}

function receipt(updates: PublishReceipt["updates"]): PublishReceipt {
    return {
        version: 1,
        id: "20261022T000000000-abcd",
        timestamp: "2026-10-22T00:00:00.000Z",
        kind: "publish",
        stack: ["main", "one", "feature/laneway"],
        updates,
    }
}
