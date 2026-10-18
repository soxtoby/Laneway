/** @jsxImportSource react */
import type { FileDiffResult } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps } from "./react-dom"
import { inspectionScenario } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React diff column", () => {
    test("opens beside its source column before the next one, and maximizes its source column with it", async () => {
        let scenario = inspectionScenario()
        scenario.graph.branches[0]!.checkedOut = [{ path: "D:/other", name: "other", head: scenario.graph.branches[0]!.tip, main: false }]
        let app = await startReactApp(scenario.api)
        let [source, next] = columns()
        let row = fileRows(source!, "working-staged")[0]!
        await app.act(() => openRow(row))

        for (let opening = 0; opening < 2; opening++) {
            await app.act(() => press(button(row, "Break out diff")))
            expect(order()).toEqual(["column", "column-divider", "auxiliary-column", "column-divider", "column", "column-divider"])
            expect(columns()).toEqual([source!, next!])
            expect(source!.classList.contains("attached")).toBe(true)
            await app.act(() => press(button(diffColumn()!, "Close diff column")))
            expect(order()).toEqual(["column", "column-divider", "column", "column-divider"])
        }

        // Maximizing from the diff column maximizes its source column, which shares the window with it.
        await app.act(() => press(button(row, "Break out diff")))
        await app.act(() => press(button(diffColumn()!, "Maximize column")))
        expect(order()).toEqual(["column", "column-divider", "auxiliary-column"])
        expect(source!.classList.contains("split")).toBe(true)
        await app.act(() => press(button(diffColumn()!, "Restore columns")))
        expect(order()).toHaveLength(6)
        await app.act(() => diffColumn()!.querySelector("header")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
        expect(order()).toEqual(["column", "column-divider", "auxiliary-column"])
        // Closing it leaves the source column maximized on its own.
        await app.act(() => press(button(diffColumn()!, "Close diff column")))
        expect(order()).toEqual(["column"])
    })

    test("shows a commit's whole diff, takes the files chosen in its source column, and gives the inline diffs back", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        await app.act(() => press(button(trail(), "Inspect changes")))
        let [first, second] = commitFileRows()
        await app.act(() => openRow(first!))
        await app.act(() => openRow(second!))
        await settle(app)
        await app.act(() => gutter(second!, "Select deletion line 1").click())

        await app.act(() => press(button(second!, "Break out diff")))
        let column = diffColumn()!
        expect(document.querySelectorAll(".column .diff-panel")).toHaveLength(0)
        expect(diffPaths(column)).toEqual(["src/file.txt", "other.txt"])
        expect(column.querySelector("header")!.textContent).toContain("Commit · Inspect changes")
        expect(marked()).toEqual([false, true])

        // Each file folds to its toolbar, keeping its chosen lines.
        let toggle = button(column, "Collapse other.txt")
        await app.act(() => press(toggle))
        expect(toggle.getAttribute("aria-expanded")).toBe("false")
        expect(file(column, "other.txt").querySelector(".diff-panel")).toBeNull()
        await app.act(() => press(button(column, "Expand other.txt")))
        await settle(app)
        expect(diffRoot(file(column, "other.txt")).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        await app.act(() => press(button(column, "Collapse all")))
        expect(column.querySelectorAll(".diff-panel")).toHaveLength(0)
        expect(column.querySelectorAll(".diff-toolbar [aria-expanded='false']")).toHaveLength(2)
        await app.act(() => press(button(column, "Expand all")))
        expect(column.querySelectorAll(".diff-panel")).toHaveLength(2)
        await app.act(() => press(button(column, "Collapse all")))

        // Choosing a file in the source column unfolds it there and scrolls it to the top of the files.
        let files = column.querySelector<HTMLElement>(".diff-column-files")!
        files.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
        for (let [index, section] of column.querySelectorAll<HTMLElement>("[data-diff-path]").entries())
            section.getBoundingClientRect = () => ({ top: index * 300 - files.scrollTop }) as DOMRect
        await app.act(() => openRow(first!))
        expect(diffColumn()).toBe(column)
        expect(document.querySelectorAll(".column .diff-panel")).toHaveLength(0)
        expect(marked()).toEqual([true, false])
        expect(column.querySelectorAll(".diff-panel")).toHaveLength(1)
        expect(button(column, "Collapse src/file.txt").getAttribute("aria-expanded")).toBe("true")
        expect(files.scrollTop).toBe(0)
        await app.act(() => openRow(second!))
        expect(marked()).toEqual([false, true])
        expect(files.scrollTop).toBe(300)

        // Closing it gives back the diffs that were open under their rows, and the source column takes focus.
        await app.act(async () => {
            press(button(column, "Close diff column"))
            await new Promise(resolve => requestAnimationFrame(resolve))
        })
        expect(diffColumn()).toBeNull()
        expect(document.activeElement).toBe(columns()[0]!)
        expect(first!.querySelector(".diff-panel")).not.toBeNull()
        await settle(app)
        expect(diffRoot(second!).querySelectorAll(".diff-line.selected")).toHaveLength(1)

        await app.act(() => press(button(trail(), "Show full diff for commit Inspect changes")))
        expect(diffColumn()!.textContent).toContain("Commit · Inspect changes")
        expect(diffColumn()!.querySelectorAll(".diff-panel")).toHaveLength(2)
        // Folding the commit closes its diff column with its diffs.
        await app.act(() => press(button(trail(), "Inspect changes")))
        expect(diffColumn()).toBeNull()
        await app.act(() => press(button(trail(), "Inspect changes")))
        expect(document.querySelectorAll(".diff-panel")).toHaveLength(0)
    })

    test("Working Changes open it on the diff opened last, focused, in the column's saved layout and not restored", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        let [staged] = fileRows(columns()[0]!, "working-staged")
        let [unstaged] = fileRows(columns()[0]!, "working-unstaged")
        await app.act(() => openRow(staged!))
        await app.act(() => openRow(unstaged!))
        await app.act(() => openRow(unstaged!))
        await app.act(() => press(button(staged!, "Side by side")))

        await app.act(() => press(button(workingChanges(), "Open diff column")))
        let column = diffColumn()!
        expect(document.activeElement).toBe(column)
        expect(column.querySelector("header")!.textContent).toContain("Staged · ")
        expect(column.querySelector(".auxiliary-source")!.textContent).toBe("From inspection")
        expect(column.dataset.sourceColumnId).toBe(columns()[0]!.dataset.columnId)
        expect(column.querySelector(".diff-lines.split")).not.toBeNull()
        let auxiliaryId = column.dataset.auxiliaryId
        columns()[0]!.focus()
        await app.act(() => press(button(workingChanges(), "Open diff column")))
        expect(document.querySelectorAll(".diff-column")).toHaveLength(1)
        expect(document.activeElement).toBe(column)

        await app.act(() => press(button(column, "Collapse all")))
        await app.act(() => openRow(staged!))
        expect(diffColumn()!.dataset.auxiliaryId).toBe(auxiliaryId)
        expect(column.querySelectorAll(".diff-panel")).toHaveLength(1)
        expect(scenario.saved().repositories[0]!.columns).toHaveLength(1)

        await stopReactApps()
        let restarted = await startReactApp(scenario.api)
        expect(diffColumn()).toBeNull()
        await restarted.act(() => press(button(workingChanges(), "Open diff column")))
        expect(diffColumn()!.querySelector("[aria-label='Diff for src/file.txt']")).not.toBeNull()
        expect(diffColumn()!.querySelector(".diff-lines.split")).not.toBeNull()
    })

    test("its toolbars show files whole, reading every diff again and dropping superseded reads", async () => {
        let scenario = inspectionScenario()
        let requests: Parameters<Window["laneway"]["readFileDiff"]>[2][] = []
        let pending: (() => void)[] = []
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (...args) => {
                let request = args[2]
                requests.push(request)
                let result = await scenario.api.readFileDiff(...args)
                if (request.entireFile) {
                    await new Promise<void>(resolve => pending.push(resolve))
                    if (result.ok) {
                        let outside = { id: 3, kind: "context" as const, text: "outside changes", oldLine: 2, newLine: 2, hunk: 0 }
                        result.page = { ...result.page, entireFile: true, version: "entire", lines: [...result.page.lines, outside] }
                    }
                }
                return result
            },
        })
        let row = fileRows(columns()[0]!, "working-staged")[0]!
        await app.act(() => openRow(row))
        await app.act(() => press(button(row, "Break out diff")))
        let column = diffColumn()!
        let toggle = () => button(file(column, "src/file.txt"), "Show entire files")
        let finish = () => app.act(() => pending.splice(0).forEach(resolve => resolve()))

        expect(toggle().getAttribute("aria-pressed")).toBe("false")
        await app.act(() => press(toggle()))
        expect(requests.at(-1)?.entireFile).toBe(true)
        expect(toggle().getAttribute("aria-pressed")).toBe("true")
        await finish()
        await settle(app)
        expect(diffRoot(file(column, "src/file.txt")).textContent).toContain("outside changes")
        await app.act(() => press(toggle()))
        await settle(app)
        expect(diffRoot(file(column, "src/file.txt")).textContent).not.toContain("outside changes")
        await app.act(() => press(toggle()))
        await app.act(() => press(toggle()))
        await finish()
        await settle(app)
        expect(toggle().getAttribute("aria-pressed")).toBe("false")
        expect(diffRoot(file(column, "src/file.txt")).textContent).not.toContain("outside changes")

        // The diffs left under their rows show only around their changes once the diff column closes.
        await app.act(() => press(toggle()))
        await finish()
        await app.act(() => press(button(column, "Close diff column")))
        expect(requests.at(-1)?.entireFile).toBeFalsy()
        await settle(app)
        expect(diffRoot(row).textContent).not.toContain("outside changes")
    })

    test("resizes from its own divider and keeps its width when it moves to another list, for the session only", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        let row = fileRows(columns()[0]!, "working-staged")[0]!
        await app.act(() => openRow(row))
        await app.act(() => press(button(row, "Break out diff")))
        let divider = () => diffColumn()!.nextElementSibling as HTMLElement
        let key = (init: KeyboardEventInit) => app.act(() => divider().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })))

        expect(diffColumn()!.style.width).toBe("620px")
        expect(divider().getAttribute("aria-label")).toBe("Resize auxiliary column")
        expect(divider().classList.contains("attached")).toBe(false)
        await key({ key: "ArrowRight", shiftKey: true })
        expect(diffColumn()!.style.width).toBe("670px")
        expect(divider().getAttribute("aria-valuenow")).toBe("670")
        await app.act(() => press(button(trail(), "Inspect changes")))
        await app.act(() => press(button(trail(), "Show full diff for commit Inspect changes")))
        expect(diffColumn()!.textContent).toContain("Commit · Inspect changes")
        expect(diffColumn()!.style.width).toBe("670px")
        await key({ key: "Home" })
        expect(diffColumn()!.style.width).toBe("380px")
        await app.act(() => divider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
        expect(diffColumn()!.style.width).toBe("620px")
        expect(scenario.saved().repositories[0]!.columns.map(column => column.width)).toEqual([380])
    })

    test("closes with its source column, cancelling the reads it started", async () => {
        let scenario = inspectionScenario()
        let main = scenario.graph.branches[0]!
        let state = await scenario.api.getState()
        let repository = state.workspace.repositories[0]!
        await scenario.api.updateWorkspace({
            ...state.workspace,
            repositories: [{
                ...repository,
                columns: [...repository.columns, { kind: "branch", id: main.id, ref: main.preferredRef, lastSeenObjectId: main.tip, width: 380 }],
            }],
        })
        let pending = new Map<string, (result: FileDiffResult) => void>()
        let cancelled: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (_repositoryId, id) => new Promise<FileDiffResult>(finish => pending.set(id, finish)),
            cancelInspection: async (_repositoryId, id) => {
                cancelled.push(id)
                return true
            },
        })
        let branchColumn = columns()[1]!
        await app.act(() => press(button(branchColumn, "Inspect changes")))
        await app.act(() => press(button(branchColumn, "Show full diff for commit Inspect changes")))
        expect(pending.size).toBe(2)

        await app.act(() => press(button(branchColumn, "Close column")))
        expect(diffColumn()).toBeNull()
        expect([...pending.keys()].every(id => cancelled.includes(id))).toBe(true)
        await app.act(() => [...pending.values()].forEach(finish => finish({ ok: true, page: scenario.page })))
        expect(diffColumn()).toBeNull()
    })
})

function columns() {
    return [...document.querySelectorAll<HTMLElement>(".column-row > .column")]
}

function order() {
    return [...document.querySelector(".column-row")!.children].map(node => node.classList[0])
}

function diffColumn() {
    return document.querySelector<HTMLElement>(".diff-column")
}

function diffPaths(column: HTMLElement) {
    return [...column.querySelectorAll<HTMLElement>("[data-diff-path]")].map(element => element.dataset.diffPath)
}

function file(column: HTMLElement, path: string) {
    return [...column.querySelectorAll<HTMLElement>("[data-diff-path]")].find(element => element.dataset.diffPath == path)!
}

function marked() {
    return commitFileRows().map(row => row.classList.contains("active"))
}

function trail() {
    return document.querySelector<HTMLElement>(".commit-trail")!
}

function workingChanges() {
    return document.querySelector<HTMLElement>(".working-changes .commit-header")!
}

function fileRows(column: HTMLElement, group: string) {
    return [...column.querySelectorAll<HTMLElement>(`[data-group='${group}'] .file-row`)]
}

function commitFileRows() {
    return [...document.querySelectorAll<HTMLElement>(".commit-files .file-row")]
}

// Pressing the file's name presses its row, which opens its diff, or shows it in the diff column.
function openRow(row: HTMLElement) {
    press(row.querySelector<HTMLElement>(".file-path")!)
}

// Pierre draws once its highlighter has loaded, which takes a moment the first time.
async function settle(app: { act(action: () => unknown): Promise<void> }) {
    await app.act(() => new Promise(resolve => setTimeout(resolve, 50)))
}

function diffRoot(scope: Element) {
    return scope.querySelector(".pierre-diff")!.shadowRoot!
}

function gutter(scope: Element, label: string) {
    let found = diffRoot(scope).querySelector<HTMLButtonElement>(`[aria-label='${label}']`)
    if (!found)
        throw new Error(`No ${label} in the diff`)
    return found
}
