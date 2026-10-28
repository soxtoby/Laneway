import type { BranchGraph, PublishActionResult, PublishPlan, PublishReceipt, PublishRequest, PublishUpdate, PullRequest, Workspace } from "@laneway/shared"
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
let main: PublishUpdate = {
    branch: "main",
    remote: "origin",
    ref: "refs/heads/main",
    expected: "a".repeat(40),
    target: "1".repeat(40),
    kind: "update",
    setUpstream: false,
}

describe("React Publish", () => {
    test("each unpublished branch's header offers Publish, and one Engine call plans them all", async () => {
        let repository = repositoryEntry("D:\\Source\\publish", ["main", "feature/laneway", "other/team"])
        let workspace = { repositories: [repository], activeRepositoryId: repository.id }
        let { requests } = await startPublishing(() => planned([one, feature]), { getState: async () => ({ ...appState(), workspace }) })

        let offering = [...document.querySelectorAll(".stack-heading")].filter(heading => heading.querySelector(".publish-button"))

        expect(offering.map(heading => heading.closest("section")?.getAttribute("aria-label"))).toEqual(["Branch feature/laneway", "Branch other/team"])
        expect(requests).toEqual([{ action: "plans", branches: ["refs/heads/feature/laneway", "refs/heads/other/team"], remote: "origin" }])
    })

    test("Publish's tooltip lists every destination before it is pressed", async () => {
        let { app } = await startPublishing(() => planned([one, feature]))

        await app.act(() => focusWithKeyboard(publishButton("Publish one, feature/laneway")))

        expect(tooltipDestinations()).toEqual(["Update origin/one", "New origin/feature/laneway sets upstream"])
    })

    test("pressing Publish publishes the reviewed plan and confirms in passing without Undo", async () => {
        let { app, requests } = await startPublishing(request =>
            request.action == "plans" ? planned([one, feature]) : result("published", "Published one, feature/laneway.")
        )

        await app.act(() => press(publishButton("Publish one, feature/laneway")))

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

    test("a branch whose plan has nothing to publish offers no Publish", async () => {
        await startPublishing(() => planned([]))

        expect(document.querySelector(".publish-button") == null).toBe(true)
    })

    test("a repository without a remote offers no Publish", async () => {
        let graph = { ...publishingGraph(repositoryEntry("D:\\Source\\publish", []).id), availableRemotes: [], selectedRemote: undefined }

        await startPublishing(() => planned([], "Add a remote to publish."), { readBranchGraph: async () => ({ ok: true, graph }) })

        expect(document.querySelector(".publish-button") == null).toBe(true)
    })

    test("a non-fast-forward update turns Publish into Force publish, naming each force-with-lease ref", async () => {
        let { app } = await startPublishing(() => planned([{ ...one, kind: "force" }, feature]))

        await app.act(() => focusWithKeyboard(publishButton("Force publish one, feature/laneway")))

        expect(tooltipDestinations()).toEqual(["Force with lease origin/one", "New origin/feature/laneway sets upstream"])
    })

    test.each<[string, PublishUpdate[], string]>([["fast-forwards", [one], "update"], ["creates a remote branch", [one, feature], "create"], [
        "forces a remote branch",
        [{ ...one, kind: "force" }, feature],
        "force",
    ]])("a stack that %s shows Publish as its most consequential update", async (_, updates, kind) => {
        await startPublishing(() => planned(updates))

        expect(document.querySelector(".publish-button")?.getAttribute("data-kind")).toBe(kind)
    })

    test("a stack that can't publish has Publish disabled, saying why", async () => {
        await startPublishing(() => planned([], "Resolve this stack's conflicts before publishing."))

        let publish = publishButton("Publish feature/laneway")

        expect(publish.hasAttribute("disabled")).toBe(true)
        expect(publish.closest(".publish-slot")?.getAttribute("aria-description")).toBe("Resolve this stack's conflicts before publishing.")
    })

    test("a stale lease shows that nothing was published and offers Pull latest, which pulls the published branch's stack", async () => {
        let pulled: unknown[] = []
        let { app } = await startPublishing(
            request =>
                request.action == "plans"
                    ? planned([one, feature])
                    : result(
                        "stale",
                        "Nothing was published. origin/one changed since the last pull. Pull latest, then publish again.",
                        receipt([{ ...one, status: "stale", message: "origin/one changed since the last pull." }, { ...feature, status: "pending" }]),
                    ),
            { pullLatest: async (_id, request) => (pulled.push(request), { ok: false, error: { message: "Offline" } }) },
        )

        await app.act(() => press(publishButton("Publish one, feature/laneway")))
        let outcome = document.querySelector<HTMLElement>(".publish-outcome")!
        expect([...outcome.querySelectorAll(".publish-status")].map(status => status.textContent)).toEqual(["Changed on remote", "Not published"])
        expect(outcome.querySelector(".publish-note")?.textContent).toContain("Pull latest brings what changed into this stack")

        await app.act(() => press(button(outcome, "Pull latest")))
        expect(pulled).toMatchObject([{ branches: ["refs/heads/feature/laneway"] }])
        expect(document.querySelector(".publish-outcome") == null).toBe(true)
    })

    test("a publish started from the keyboard keeps focus on its button while it runs, and the outcome returns focus there", async () => {
        let answer = Promise.withResolvers<PublishActionResult>()
        let { app } = await startPublishing(request => request.action == "plans" ? planned([one, feature]) : answer.promise)
        let publish = publishButton("Publish one, feature/laneway")
        await app.act(() => publish.focus())

        await app.act(() => key(publish, "Enter"))
        expect(document.querySelector(".publish-progress")?.textContent).toBe("Publishing…")
        expect(document.activeElement == publish).toBe(true)

        await app.act(() => answer.resolve(result("partial", "Published one.", receipt([{ ...one, status: "published" }, { ...feature, status: "failed" }]))))
        await app.act(() => key(document.activeElement as HTMLElement, "Escape"))
        await app.act(() => new Promise(resolve => requestAnimationFrame(resolve)))
        expect(document.querySelector(".publish-outcome") == null).toBe(true)
        expect(document.activeElement == publish).toBe(true)
    })

    test("while a publish runs, its button keeps its name and names its progress", async () => {
        let { app } = await startPublishing(request => request.action == "plans" ? planned([one, feature]) : new Promise(() => {}))
        let publish = publishButton("Publish one, feature/laneway")

        await app.act(() => press(publish))

        expect(accessibleName(publish)).toBe("Publish one, feature/laneway Publishing…")
    })

    test("once its branch is published, focus moves from Publish to its column", async () => {
        let graph = publishingGraph(repositoryEntry("D:\\Source\\publish", []).id)
        let { app } = await startPublishing(request => {
            if (request.action == "plans")
                return planned([one, feature])
            graph.branches[1]!.published = true
            return result("published", "Published one, feature/laneway.")
        }, { readBranchGraph: async () => ({ ok: true, graph: structuredClone(graph) }) })
        let publish = publishButton("Publish one, feature/laneway")
        let column = publish.closest(".column")
        await app.act(() => publish.focus())

        await app.act(() => key(publish, "Enter"))

        expect(document.querySelector(".publish-button") == null).toBe(true)
        expect(document.activeElement == column).toBe(true)
    })

    test("a stale outcome in a repository left while it published waits for it, and its Pull latest carries that repository's open stacks", async () => {
        let answer = Promise.withResolvers<PublishActionResult>()
        let pulled: [string, PullRequest][] = []
        let [first, second] = [repositoryEntry("D:\\Source\\first", ["main", "feature/laneway"]), repositoryEntry("D:\\Source\\second", ["main"])]
        let workspace: Workspace = { repositories: [first, second], activeRepositoryId: first.id }
        let { app } = await startPublishing(request => request.action == "plans" ? planned([one, feature]) : answer.promise, {
            getState: async () => ({ ...appState(), workspace }),
            readBranchGraph: async id => ({ ok: true, graph: publishingGraph(id) }),
            selectRepository: async id => workspace = { ...workspace, activeRepositoryId: id },
            pullLatest: async (id, request) => (pulled.push([id, request]), { ok: false, error: { message: "Offline" } }),
        })

        await app.act(() => press(publishButton("Publish one, feature/laneway")))
        await app.act(() => app.controller.selectRepository(second.id))
        await app.act(() =>
            answer.resolve(result("stale", "Nothing was published.", receipt([{ ...one, status: "stale" }, { ...feature, status: "pending" }])))
        )
        expect(document.querySelector(".publish-outcome") == null).toBe(true)

        await app.act(() => app.controller.selectRepository(first.id))
        await app.act(() => press(button(document.querySelector<HTMLElement>(".publish-outcome")!, "Pull latest")))
        expect(pulled).toEqual([[first.id, {
            branches: ["refs/heads/feature/laneway"],
            open: ["refs/heads/main", "refs/heads/feature/laneway"],
            remote: "origin",
        }]])
    })

    test("a repository closed while it publishes is ready to publish again when reopened, with no outcome from before", async () => {
        let answer = Promise.withResolvers<PublishActionResult>()
        let repository = repositoryEntry("D:\\Source\\publish", ["main", "feature/laneway"])
        let workspace: Workspace = { repositories: [repository], activeRepositoryId: repository.id }
        let { app } = await startPublishing(request => request.action == "plans" ? planned([one, feature]) : answer.promise, {
            getState: async () => ({ ...appState(), workspace }),
            closeRepository: async () => workspace = { repositories: [] },
            openRepository: async () => ({ ok: true, workspace: workspace = { repositories: [repository], activeRepositoryId: repository.id } }),
        })
        await app.act(() => press(publishButton("Publish one, feature/laneway")))
        await app.act(() => app.controller.closeRepository(repository.id))

        await app.act(() =>
            answer.resolve(result("stale", "Nothing was published.", receipt([{ ...one, status: "stale" }, { ...feature, status: "pending" }])))
        )
        await app.act(() => app.controller.openRepository())

        expect(document.querySelector(".publish-outcome") == null).toBe(true)
        expect(publishButton("Publish one, feature/laneway").hasAttribute("data-pending")).toBe(false)
    })

    test("the Primary Branch's header offers Publish, which asks first and publishes once confirmed", async () => {
        let { app, requests } = await startPublishingPrimary(request => request.action == "plans" ? plannedAlone(main) : result("published", "Published main."))

        await app.act(() => press(publishButton("Publish main")))
        let confirmation = document.querySelector<HTMLElement>(".publish-confirmation")!
        expect(confirmation.textContent).toContain("main is the Primary Branch")
        expect(requests.some(request => request.action == "publish")).toBe(false)

        await app.act(() => press(button(confirmation, "Publish")))
        expect(requests.find(request => request.action == "publish")).toEqual({
            action: "publish",
            branch: "refs/heads/main",
            remote: "origin",
            token: "reviewed",
        })
    })

    test("a Primary Branch publish that would force warns that the remote's commits go, and Escape publishes nothing and returns focus to it", async () => {
        let { app, requests } = await startPublishingPrimary(() => plannedAlone({ ...main, kind: "force" }))
        let publish = publishButton("Force publish main")
        await app.act(() => publish.focus())

        await app.act(() => key(publish, "Enter"))
        let confirmation = document.querySelector<HTMLElement>(".publish-confirmation")!
        expect(confirmation.querySelector(".publish-warning")?.textContent).toContain("origin/main has commits that main doesn't.")

        await app.act(() => key(document.activeElement as HTMLElement, "Escape"))
        await app.act(() => new Promise(resolve => requestAnimationFrame(resolve)))
        expect(document.querySelector(".publish-confirmation") == null).toBe(true)
        expect(requests.some(request => request.action == "publish")).toBe(false)
        expect(document.activeElement == publish).toBe(true)
    })

    test("the Primary Branch's header publishes main, not another local branch sharing its tip", async () => {
        let { requests } = await startPublishingPrimary(() => plannedAlone(main), "refs/heads/backup")

        expect(requests).toEqual([{ action: "plans", branches: ["refs/heads/main"], remote: "origin" }])
    })
})

async function startPublishing(
    respond: (request: PublishRequest) => PublishActionResult | Promise<PublishActionResult>,
    overrides: Partial<Window["laneway"]> = {},
) {
    let repository = repositoryEntry("D:\\Source\\publish", ["main", "feature/laneway"])
    let graph = publishingGraph(repository.id)
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

// The Primary Branch's own column, with commits origin/main lacks, and any other local branches named sharing its tip.
function startPublishingPrimary(
    respond: (request: PublishRequest) => PublishActionResult | Promise<PublishActionResult>,
    ...sharingTip: string[]
) {
    let repository = repositoryEntry("D:\\Source\\publish", ["main"])
    let workspace = { repositories: [repository], activeRepositoryId: repository.id }
    return startPublishing(respond, {
        getState: async () => ({ ...appState(), workspace }),
        readBranchGraph: async id => ({ ok: true, graph: primaryGraph(id, sharingTip) }),
    })
}

// Local branches sharing a tip share a Branch Node, which is the Primary Branch's when it holds origin/main.
function primaryGraph(repositoryId: string, sharingTip: string[]) {
    let graph: BranchGraph = branchGraph(repositoryId)
    graph.primaryBranch.ref = "refs/remotes/origin/main"
    graph.branches[0]!.localRefs = [...sharingTip, "refs/heads/main"].sort()
    return graph
}

// The fixture's graph with main on its remote, as a Primary Branch usually is, so only the branches built on it publish.
function publishingGraph(repositoryId: string) {
    let graph = branchGraph(repositoryId)
    graph.branches[0]!.published = true
    return graph
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
        focusedColumnId: shown.at(-1)?.id,
        columns: shown.map(item => ({ kind: "branch" as const, id: item.id, ref: item.preferredRef, lastSeenObjectId: item.tip, width: 380 })),
    }
}

function publishButton(label: string) {
    let found = [...document.querySelectorAll<HTMLElement>(".publish-button")].find(element => element.getAttribute("aria-label") == label)
    if (!found)
        throw new Error(`No ${label} button among ${[...document.querySelectorAll(".publish-button")].map(element => element.getAttribute("aria-label"))}`)
    return found
}

// A key press first, so React Aria treats the focus as the keyboard's and shows the tooltip at once.
function focusWithKeyboard(element: HTMLElement) {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    element.focus()
}

function tooltipDestinations() {
    return [...document.querySelectorAll(".publish-tooltip [aria-label=Destinations] li")].map(item =>
        [...item.children].map(part => part.textContent).join(" ")
    )
}

// Happy DOM computes no accessible names, so this follows a button's aria-labelledby to each part's label.
function accessibleName(element: Element) {
    return element.getAttribute("aria-labelledby")!.split(" ").map(id => document.getElementById(id)?.getAttribute("aria-label")).join(" ")
}

// React Aria completes a keyboard press on its keyup.
function key(element: HTMLElement, name: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
    element.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true, cancelable: true }))
}

// The same plan for each branch the fixture can offer; the columns take only those they asked for.
function planned(updates: PublishUpdate[], blocked?: string): PublishActionResult {
    let plan: PublishPlan = { stack: ["main", "one", "feature/laneway"], updates, token: "reviewed", blocked }
    return {
        ok: true,
        result: {
            type: "result",
            command: "publish",
            status: "planned",
            message: "Planned.",
            plans: ["refs/heads/feature/laneway", "refs/heads/other/team"].map(branch => ({ branch, message: blocked ?? "Publish.", plan })),
        },
    }
}

// The Primary Branch's plan, publishing it alone.
function plannedAlone(update: PublishUpdate): PublishActionResult {
    let plan: PublishPlan = { stack: ["main"], updates: [update], token: "reviewed" }
    return {
        ok: true,
        result: {
            type: "result",
            command: "publish",
            status: "planned",
            message: "Planned.",
            plans: [{ branch: "refs/heads/main", message: "Publish.", plan }],
        },
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
