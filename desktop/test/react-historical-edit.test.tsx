import type { CompositionRequest, HistoricalEdit, HistoricalEditActionResult, HistoricalEditRequest } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps, type } from "./react-dom"
import { inspectionScenario } from "./renderer-fixtures"

let browserWindow: HappyWindow
let root = "D:\\Source\\inspection"

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React Historical Edit", () => {
    test("Edit from here on a commit row enters a Historical Edit in the column's own worktree", async () => {
        let scenario = inspectionScenario()
        let { api, requests } = editing(scenario)
        let app = await startReactApp(api)

        await app.act(() => press(button(commitRows()[0]!, "Actions for commit Inspect changes")))
        await app.act(() => press(menuItem("Edit from here")))

        expect(requests).toEqual([{ action: "enter", path: root, commit: scenario.graph.branches[1]!.tip }])
    })

    test("entering with the commit form open closes it, and its draft comes back after the return", async () => {
        let scenario = inspectionScenario()
        let draft = { title: "", message: "", branch: "" }
        let { api } = editing(scenario)
        let app = await startReactApp({
            ...api,
            readCommitDraft: async () => ({ ...draft }),
            saveCommitDraft: async (_id, _path, value) => {
                draft = { ...value }
            },
        })
        await app.act(() => press(button(working(), "Commit…")))
        await app.act(() => type(commitTitle()!, "Half written"))

        await app.act(() => press(button(commitRows()[0]!, "Actions for commit Inspect changes")))
        await app.act(() => press(menuItem("Edit from here")))
        expect(commitTitle() == undefined).toBe(true)

        await app.act(() => press(button(banner(), "Return to feature/laneway")))
        await app.act(() => press(button(document.querySelector<HTMLElement>("[role=dialog]")!, "Drop")))
        await app.act(() => press(button(working(), "Commit…")))
        expect(commitTitle()?.value).toBe("Half written")
    })

    test("a branch-only column offers no Historical Edit", async () => {
        let scenario = inspectionScenario()
        scenario.graph.branches[1]!.checkedOut = []
        let saved = scenario.saved().repositories[0]!
        if (saved.status == "available" && saved.columns[0]?.kind == "branch")
            delete saved.columns[0].worktreePath
        let app = await startReactApp(scenario.api)

        await app.act(() => press(button(commitRows()[0]!, "Actions for commit Inspect changes")))

        expect(menuItems()).not.toContain("Edit from here")
        expect(menuItems()).toContain("Reword commit…")
    })

    test("a column in Historical Edit names the commit and its branch, and Apply changes moves every change into that commit", async () => {
        let scenario = inSession(inspectionScenario())
        let { api, transfers } = editing(scenario)
        let app = await startReactApp(api)

        expect(banner().textContent).toContain("Editing from Inspect changes on feature/laneway")
        expect(commitRows()[0]!.hasAttribute("data-editing")).toBe(true)
        expect([...working().querySelectorAll("button")].some(element => element.textContent == "Commit…")).toBe(false)

        await app.act(() => press(button(working(), "Apply changes")))

        expect(transfers).toHaveLength(1)
        expect(transfers[0]).toMatchObject({
            source: { kind: "working", worktreePath: root },
            target: { kind: "commit", objectId: scenario.graph.branches[1]!.tip, branch: "refs/heads/feature/laneway" },
            mode: "move",
        })
        expect(transfers[0]!.files == undefined).toBe(true)
    })

    test("returning with Historical Working Changes left asks to drop or bring them, and Bring along offers Undo", async () => {
        let scenario = inSession(inspectionScenario())
        let { api, requests } = editing(scenario, true)
        let transitions: string[] = []
        let app = await startReactApp({
            ...api,
            transitionOperation: async (_repositoryId, action) => {
                transitions.push(action)
                return { ok: true }
            },
        })

        await app.act(() => press(button(banner(), "Return to feature/laneway")))
        let dialog = document.querySelector<HTMLElement>("[role=dialog]")!
        expect(dialog.textContent).toContain("Historical Working Changes remain in 2 files")
        expect(requests).toEqual([])

        await app.act(() => press(button(dialog, "Bring along")))

        expect(requests).toEqual([{ action: "return", path: root, mode: "bring" }])
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        expect(toast().textContent).toContain("Returned to feature/laneway.")
        await app.act(() => press(button(toast(), "Undo")))
        expect(transitions).toEqual(["undo"])
    })

    test("a stale session explains why, holds Apply, and restarts on the latest tip", async () => {
        let scenario = inSession(inspectionScenario(), { state: "stale", reason: "feature/laneway moved outside this Historical Edit." })
        let { api, requests } = editing(scenario)
        let app = await startReactApp(api)

        expect(banner().querySelector("[role=alert]")?.textContent).toBe("feature/laneway moved outside this Historical Edit.")
        expect(button(working(), "Apply changes").hasAttribute("disabled")).toBe(true)

        await app.act(() => press(button(banner(), "Restart on latest")))

        expect(requests).toEqual([{ action: "restart", path: root }])
    })

    test("a session whose worktree was renamed restarts and returns from where the worktree is now", async () => {
        let scenario = inSession(inspectionScenario(), { path: "D:\\Source\\before-rename", state: "stale", reason: "feature/laneway moved." })
        let { api, requests } = editing(scenario)
        let app = await startReactApp(api)

        await app.act(() => press(button(banner(), "Restart on latest")))
        await app.act(() => press(button(banner(), "Return to feature/laneway")))
        await app.act(() => press(button(document.querySelector<HTMLElement>("[role=dialog]")!, "Drop")))

        expect(requests).toEqual([{ action: "restart", path: root }, { action: "return", path: root, mode: "drop" }])
    })

    test("returning asks about Historical Working Changes saved since the column last read them", async () => {
        let scenario = inSession(inspectionScenario())
        let saved = false
        let { api, requests } = editing(scenario)
        let app = await startReactApp({
            ...api,
            readChanges: async (...args) => {
                let result = await api.readChanges(...args)
                return result.ok && !saved ? { ok: true, inventory: { ...result.inventory, files: [] } } : result
            },
        })
        expect(working().textContent).toContain("No Working Changes")
        saved = true

        await app.act(() => press(button(banner(), "Return to feature/laneway")))

        expect(document.querySelector("[role=dialog]")?.textContent).toContain("Historical Working Changes remain in 2 files")
        expect(requests).toEqual([])
    })

    test("a paused session waits for its conflicts before applying or returning", async () => {
        let scenario = inSession(inspectionScenario(), { state: "paused", reason: "Resolve the conflicts on feature/laneway to continue." })
        await startReactApp(editing(scenario).api)

        expect(banner().querySelector("[role=status]")?.textContent).toBe("Resolve the conflicts on feature/laneway to continue.")
        expect(button(banner(), "Return to feature/laneway").hasAttribute("disabled")).toBe(true)
        expect(button(working(), "Apply changes").hasAttribute("disabled")).toBe(true)
    })
})

/** The scenario's worktree, editing from its branch's only commit. */
function inSession(scenario: ReturnType<typeof inspectionScenario>, change: Partial<HistoricalEdit> = {}) {
    let branch = scenario.graph.branches[1]!
    let worktree = branch.checkedOut[0]!
    worktree.historicalEdit = {
        version: 1,
        worktreeId: "main",
        path: worktree.path,
        branch: branch.preferredRef,
        tip: branch.tip,
        selected: branch.tip,
        commit: branch.tip,
        state: "active",
        subject: "Inspect changes",
        ...change,
    }
    return scenario
}

function editing(scenario: ReturnType<typeof inspectionScenario>, recorded = false) {
    let requests: HistoricalEditRequest[] = []
    let transfers: CompositionRequest[] = []
    let api: Window["laneway"] = {
        ...scenario.api,
        historicalEdit: async (_repositoryId, request): Promise<HistoricalEditActionResult> => {
            requests.push(request)
            if (request.action == "enter")
                inSession(scenario)
            else if (request.action == "return")
                delete scenario.graph.branches[1]!.checkedOut[0]!.historicalEdit
            let operation = recorded
                ? { id: "bring", timestamp: "2026-10-22T00:00:00.000Z", kind: "edit.bring", summary: "Bring", affectedRefs: [], affectedWorktrees: [] }
                : undefined
            return { ok: true, result: { type: "result", command: "edit", message: "Returned to feature/laneway.", sessions: [], operation } }
        },
        localOperation: async (id, request, token) => {
            if (request.action != "compose")
                return scenario.api.localOperation(id, request, token)
            transfers.push(request)
            return { ok: true, result: { type: "result", command: "local", status: "performed", message: "Changes transferred." } }
        },
    }
    return { api, requests, transfers }
}

function banner() {
    return document.querySelector<HTMLElement>("[aria-label='Historical Edit']")!
}

function working() {
    return document.querySelector<HTMLElement>("[aria-label='Working Changes']")!
}

function commitTitle() {
    return document.querySelector<HTMLInputElement>("[aria-label='Commit title']") ?? undefined
}

function commitRows() {
    return [...document.querySelectorAll<HTMLElement>(".commit-trail .trail-commit")]
}

function toast() {
    return document.querySelector<HTMLElement>("[role=alertdialog]")!
}

function menuItems() {
    return [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].map(item => item.textContent)
}

function menuItem(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(item => item.textContent == label)
    if (!item)
        throw new Error(`No ${label} menu item`)
    return item
}
