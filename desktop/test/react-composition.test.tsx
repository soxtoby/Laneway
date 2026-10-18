import type { CompositionPreview, CompositionRequest, ConflictResult, LocalActionResult, LocalRequest } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps, type } from "./react-dom"
import { inspectionScenario } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React composition", () => {
    test("while composing, a file moves from the unstaged list to the staged one to stage it", async () => {
        let scenario = inspectionScenario()
        let staged = false
        let stages: LocalRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (...args) => {
                let result = await scenario.api.readChanges(...args)
                if (!result.ok)
                    return result
                let files = result.inventory.files.map((file, index) => ({ ...file, staged: staged && index == 0, unstaged: true }))
                return { ok: true, inventory: { ...result.inventory, version: String(staged), files } }
            },
            localOperation: async (id, request, token) => {
                if (!token)
                    return scenario.api.localOperation(id, request)
                stages.push(request)
                staged = request.action == "stage" && !request.unstage
                return performed()
            },
        })
        expect(list("working-staged")).toBeNull()
        await app.act(() => press(button(working(), "Commit…")))
        expect(list("working-staged")?.textContent).toContain("Drop files here to stage them")

        await app.act(() => press(button(list("working-unstaged")!, "Move or copy src/file.txt")))
        expect(toast()?.textContent).toContain("Move src/file.txt · Choose a destination, then Enter.")
        expect(list("working-staged")!.hasAttribute("data-transfer-target")).toBe(true)
        expect(list("working-unstaged")!.hasAttribute("data-transfer-target")).toBe(false)
        await app.act(() => list("working-staged")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))

        expect(stages).toEqual([{ action: "stage", path: "D:\\Source\\inspection", files: ["src/file.txt"], unstage: false }])
        expect(list("working-staged")!.textContent).toContain("src/file.txt")
        expect(toast()?.textContent ?? "").not.toContain("Choose a destination")
    })

    test("a commit chosen with M moves to a destination by the arrow keys and Enter, and runs once the review finds nothing to confirm", async () => {
        let scenario = inspectionScenario()
        let { api, calls } = composing(scenario)
        let app = await startReactApp(api)
        let commit = trail().querySelector<HTMLElement>(".trail-commit")!

        await app.act(() => key(button(commit, "Move or copy Inspect changes"), "m"))
        // A whole commit can't land back where it is, so only the base branch's tip seam takes it.
        expect([...trail().querySelectorAll(".transfer-seam[data-transfer-target]")].map(seam => seam.getAttribute("aria-label"))).toEqual([
            "Move commit here on main",
        ])
        let destinations = [...document.querySelectorAll<HTMLElement>("[data-transfer-target]")]
        await app.act(() => key(document.activeElement!, "ArrowDown"))
        expect(document.activeElement).toBe(destinations[0]!)
        expect(destinations[0]!.matches("[aria-label='Working Changes']")).toBe(true)
        await app.act(() => key(document.activeElement!, "ArrowDown"))
        expect(document.activeElement).toBe(destinations[1]!)
        expect(destinations[1]!.matches(".stack-heading")).toBe(true)
        await app.act(() => key(document.activeElement!, "Enter"))

        expect(calls.map(call => [call.request.target.kind, call.request.mode, call.token])).toEqual([["branch", "move", undefined], [
            "branch",
            "move",
            "reviewed-1",
        ]])
        expect(calls[0]!.request).toMatchObject({ source: { kind: "commit", objectId: scenario.graph.branches[1]!.tip, branch: "refs/heads/feature/laneway" } })
        expect(toast()?.textContent).toContain("Changes transferred.")
        expect(trail().querySelector("[aria-label='Review transfer']")).toBeNull()
    })

    test("chosen commit files move to Working Changes, and published history waits behind a warning", async () => {
        let scenario = inspectionScenario()
        let { api, calls, review } = composing(scenario)
        review({ published: ["feature/laneway"] })
        let app = await startReactApp(api)
        await app.act(() => press(button(trail(), "Inspect changes")))
        let files = trail().querySelector<HTMLElement>(".commit-files")!
        await app.act(() => press(files.querySelector<HTMLElement>("input[aria-label='Select file src/file.txt']")!))
        await app.act(() => press(files.querySelector<HTMLElement>("input[aria-label='Select file other.txt']")!))

        await app.act(() => key(button(files, "Move or copy 2 files"), "c"))
        expect(toast()?.textContent).toContain("Copy 2 files")
        await app.act(() => working().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))

        expect(calls.map(call => call.token)).toEqual([undefined])
        expect(calls[0]!.request).toMatchObject({
            source: { kind: "commit", objectId: scenario.graph.branches[1]!.tip },
            target: { kind: "working", worktreePath: "D:\\Source\\inspection" },
            mode: "copy",
            files: [{ path: "src/file.txt" }, { path: "other.txt" }],
            inventoryVersion: "inventory",
        })
        let reviewPanel = working().querySelector<HTMLElement>("[aria-label='Review transfer']")!
        expect(reviewPanel.querySelector("[role=alert]")?.textContent).toContain("Rewrites history already published on feature/laneway")
        await app.act(() => press(button(reviewPanel, "Transfer")))
        expect(calls.map(call => call.token)).toEqual([undefined, "reviewed-1"])
        expect(working().querySelector("[aria-label='Review transfer']")).toBeNull()
    })

    test("files landing on a seam ask for the new commit's message before the review, and Escape cancels a choice", async () => {
        let scenario = inspectionScenario()
        let { api, calls } = composing(scenario)
        let app = await startReactApp(api)
        let row = working().querySelector<HTMLElement>("[data-group='working-unstaged'] .file-row")!

        await app.act(() => key(button(row, "Move or copy src/file.txt"), "m"))
        await app.act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
        expect(trail().querySelector("[data-transfer-target]")).toBeNull()

        await app.act(() => key(button(row, "Move or copy src/file.txt"), "m"))
        let seam = trail().querySelector<HTMLElement>(".transfer-seam[aria-label='New commit on feature/laneway']")!
        await app.act(() => {
            seam.focus()
            key(seam, "Enter")
        })
        expect(calls).toEqual([])
        let reviewPanel = trail().querySelector<HTMLElement>("[aria-label='Review transfer']")!
        expect(button(reviewPanel, "Review transfer").hasAttribute("disabled")).toBe(true)
        await app.act(() => type(reviewPanel.querySelector<HTMLInputElement>("[aria-label='New commit message']")!, "Split out file"))
        await app.act(() => press(button(reviewPanel, "Review transfer")))

        expect(calls.map(call => [call.request.target.kind, call.request.message, call.token])).toEqual([["seam", "Split out file", undefined], [
            "seam",
            "Split out file",
            "reviewed-1",
        ]])
        expect(calls[0]!.request).toMatchObject({ source: { kind: "working" }, view: "unstaged", files: [{ path: "src/file.txt" }] })
    })

    test("a transfer going on to resolve now opens its conflicted commit, showing only conflicted commits", async () => {
        let scenario = inspectionScenario()
        let { api, calls, review } = composing(scenario)
        let conflicted = false
        review({ conflicts: [{ subject: "commit 22222222", files: ["src/file.txt"] }] })
        let app = await startReactApp({
            ...api,
            readBranchGraph: async () => ({ ok: true, graph: structuredClone(scenario.graph) }),
            readBranchHistory: async (...args) => {
                let result = await scenario.api.readBranchHistory(...args)
                if (!result.ok || !conflicted)
                    return result
                return { ...result, page: { ...result.page, commits: result.page.commits.map(commit => ({ ...commit, conflictId: "conflict-1" })) } }
            },
            localOperation: async (id, request, token) => {
                let result = await api.localOperation(id, request, token)
                if (token) {
                    conflicted = true
                    Object.assign(scenario.graph.branches[1]!, { unresolved: { subjects: ["conflict-1"] } })
                }
                return result
            },
            conflictOperation: async (_id, request) => ({
                ok: true,
                result: {
                    type: "result",
                    command: "conflict",
                    conflicts: [{ id: "conflict-1", kind: "commit", branch: "feature/laneway", title: "Inspect changes", files: 1 }],
                    recovery: [],
                    view: request.action == "inspect" ? conflictView("conflict-1") : undefined,
                },
            }),
        })
        let commit = trail().querySelector<HTMLElement>(".trail-commit")!
        await app.act(() => key(button(commit, "Move or copy Inspect changes"), "m"))
        await app.act(() => key(document.activeElement!, "ArrowDown"))
        await app.act(() => key(document.activeElement!, "ArrowDown"))
        await app.act(() => key(document.activeElement!, "Enter"))

        await app.act(() => press(button(document.querySelector<HTMLElement>("[aria-label='Review transfer']")!, "Continue and resolve now")))

        expect(calls.map(call => call.token)).toEqual([undefined, "reviewed-1"])
        expect(button(document.body, "Show only conflicted commits").getAttribute("aria-pressed")).toBe("true")
        let resolution = trail().querySelector<HTMLElement>(".trail-commit [aria-label='Conflict resolution']")
        expect(resolution?.querySelector(".conflict-file")?.getAttribute("data-file")).toBe("src/file.txt")
    })
})

function conflictView(id: string): NonNullable<ConflictResult["view"]> {
    let objectId = "2".repeat(40)
    let text = "before\n"
    let file = { path: "src/file.txt", base: null, left: null, right: null, provisional: null, text: true }
    return {
        subject: { id, input: objectId, tree: objectId, leftLabel: "Before this commit", rightLabel: "This commit", markerSize: 7, files: [file] },
        sourceCommit: objectId,
        candidate: { subject: id, input: objectId, revision: "1", files: {} },
        files: [{
            ...file,
            baseText: text,
            leftText: text,
            rightText: text,
            resultText: null,
            suggestionText: null,
            diff: "",
            resolved: false,
            hunks: [],
        }],
        reviewTree: objectId,
        resultTree: objectId,
        ready: false,
    }
}

function composing(scenario: ReturnType<typeof inspectionScenario>) {
    let calls: { request: CompositionRequest; token?: string }[] = []
    let changes: Partial<CompositionPreview> = {}
    let api: Window["laneway"] = {
        ...scenario.api,
        localOperation: async (id, request, token) => {
            if (request.action != "compose")
                return scenario.api.localOperation(id, request, token)
            calls.push({ request, token })
            if (token)
                return { ok: true, result: { type: "result", command: "local", status: "performed", message: "Changes transferred." } }
            let preview = (await scenario.api.localOperation(id, { action: "stage", path: "", unstage: false })) as Extract<LocalActionResult, { ok: true }>
            let composition = { branches: ["feature/laneway"], removed: [], conflicts: [], published: [], skipped: [], noop: false, ...changes }
            return { ok: true, result: { ...preview.result, preview: { ...preview.result.preview!, token: `reviewed-${calls.length}`, composition } } }
        },
    }
    return { api, calls, review: (value: Partial<CompositionPreview>) => changes = value }
}

function performed(): LocalActionResult {
    return { ok: true, result: { type: "result", command: "local", status: "performed" } }
}

function working() {
    return document.querySelector<HTMLElement>("[aria-label='Working Changes']")!
}

function trail() {
    return document.querySelector<HTMLElement>(".commit-trail")!
}

function list(group: string) {
    return working().querySelector<HTMLElement>(`[data-group='${group}']`)
}

function toast() {
    return document.querySelector<HTMLElement>("[role=alertdialog]")
}

function key(target: Element, key: string) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}
