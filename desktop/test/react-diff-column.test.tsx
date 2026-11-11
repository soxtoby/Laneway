import type { FileDiffResult } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, doubleClick, installReactDom, press, startReactApp, stopReactApps } from "./react-dom"
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

        for (let opening = 0; opening < 2; opening++) {
            await app.act(() => press(openButton(row)))
            expect(order()).toEqual(["column", "column-divider", "auxiliary-column", "column-divider", "column", "column-divider"])
            // Elements compare as booleans; a failed comparison of two elements would serialize the whole document.
            expect(columns()[0] == source && columns()[1] == next).toBe(true)
            expect(source!.classList.contains("attached")).toBe(true)
            await app.act(() => press(button(diffColumn()!, "Close diff column")))
            expect(order()).toEqual(["column", "column-divider", "column", "column-divider"])
        }

        // Maximizing from the diff column maximizes its source column, which shares the row's view with it; the
        // next column stays beside them.
        await app.act(() => press(openButton(row)))
        await app.act(() => press(button(diffColumn()!, "Maximize column")))
        expect(order()).toEqual(["column", "column-divider", "auxiliary-column", "column", "column-divider"])
        expect(source!.closest(".column-group")!.classList.contains("maximized")).toBe(true)
        await app.act(() => press(button(diffColumn()!, "Restore column")))
        expect(order()).toHaveLength(6)
        await app.act(() => diffColumn()!.querySelector("header")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
        expect(order()).toEqual(["column", "column-divider", "auxiliary-column", "column", "column-divider"])
        // Closing it restores the source column.
        await app.act(() => press(button(diffColumn()!, "Close diff column")))
        expect(order()).toEqual(["column", "column-divider", "column", "column-divider"])
    })

    test("opens on a file double-clicked in its source column, shows its list's whole diff, and takes the files pressed there", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        await app.act(() => press(button(trail(), "Inspect changes")))
        let [first, second] = commitFileRows()
        // A single press on a file opens nothing.
        await app.act(() => openRow(first!))
        expect(diffColumn() == null).toBe(true)
        expect(document.querySelectorAll(".diff-panel")).toHaveLength(0)

        await app.act(() => doubleClick(second!.querySelector<HTMLElement>(".file-path")!))
        let column = diffColumn()!
        expect(document.querySelectorAll(".column .diff-panel")).toHaveLength(0)
        expect(diffPaths(column)).toEqual(["src/file.txt", "other.txt"])
        expect(column.querySelector("header")!.textContent).toContain("Commit · Inspect changes")
        expect(marked()).toEqual([false, true])
        await settle(app)
        await app.act(() => gutter(file(column, "other.txt"), "Select deletion line 1").click())

        // Each file folds to its toolbar, keeping its chosen lines.
        let toggle = button(column, "Collapse other.txt")
        await app.act(() => press(toggle))
        expect(toggle.getAttribute("aria-expanded")).toBe("false")
        expect(file(column, "other.txt").querySelector(".diff-panel") == null).toBe(true)
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

        // Closing it closes its diffs, and the source column takes focus; pressing a file again opens nothing.
        await app.act(() => press(button(column, "Close diff column")))
        await app.act(frame)
        expect(diffColumn() == null).toBe(true)
        expect(document.activeElement == columns()[0]).toBe(true)
        expect(document.querySelectorAll(".diff-panel")).toHaveLength(0)
        await app.act(() => openRow(first!))
        expect(diffColumn() == null).toBe(true)

        // Enter on a file's row opens it there too, leaving focus on the row.
        first!.focus()
        await app.act(() => {
            first!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
            first!.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }))
        })
        expect(diffColumn()).not.toBeNull()
        expect(marked()).toEqual([true, false])
        expect(document.activeElement == first).toBe(true)
        await app.act(() => press(button(diffColumn()!, "Close diff column")))

        await app.act(() => press(button(trail(), "Show full diff for commit Inspect changes")))
        expect(diffColumn()!.textContent).toContain("Commit · Inspect changes")
        expect(diffColumn()!.querySelectorAll(".diff-panel")).toHaveLength(2)
        // Folding the commit closes its diff column with its diffs.
        await app.act(() => press(button(trail(), "Inspect changes")))
        expect(diffColumn() == null).toBe(true)
        await app.act(() => press(button(trail(), "Inspect changes")))
        expect(document.querySelectorAll(".diff-panel")).toHaveLength(0)
    })

    test("lists its files in the order and groups of its source list, following the list's view as it changes", async () => {
        let scenario = inspectionScenario(["file.test.ts", "src/file.txt", "other.txt"])
        let app = await startReactApp(scenario.api)
        await app.act(() => press(button(trail(), "Inspect changes")))
        await app.act(() => press(button(trail(), "Show full diff for commit Inspect changes")))
        let column = diffColumn()!
        expect(listing(column)).toEqual(["file.test.ts", "src/file.txt", "other.txt"])

        await app.act(() => app.controller.setFileListView({ layout: "flat", grouping: "kind" }))
        expect(listing(column)).toEqual(["# Implementation", "src/file.txt", "other.txt", "# Tests", "file.test.ts"])
        // Folders list before the files beside them.
        await app.act(() => app.controller.setFileListView({ layout: "tree", grouping: "none" }))
        expect(listing(column)).toEqual(["src/file.txt", "file.test.ts", "other.txt"])
    })

    test("reads its files' diffs in the order its source list shows them", async () => {
        let scenario = inspectionScenario(["file.test.ts", "src/file.txt", "other.txt"])
        let read: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (...args) => {
                read.push(args[2].path)
                return scenario.api.readFileDiff(...args)
            },
        })
        await app.act(() => app.controller.setFileListView({ layout: "flat", grouping: "kind" }))
        await app.act(() => press(button(trail(), "Inspect changes")))

        await app.act(() => press(button(trail(), "Show full diff for commit Inspect changes")))

        expect(read).toEqual(["src/file.txt", "other.txt", "file.test.ts"])
    })

    test("marks the file at the top of its files in the source list as the user scrolls, and the chosen file while it scrolls there", async () => {
        let scenario = inspectionScenario()
        // The first file's diff is still loading, so the column keeps aiming at a file chosen below it.
        let reading: (() => void)[] = []
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (...args) => {
                let result = await scenario.api.readFileDiff(...args)
                if (args[2].path == "src/file.txt")
                    await new Promise<void>(resolve => reading.push(resolve))
                return result
            },
        })
        await app.act(() => press(button(trail(), "Inspect changes")))
        await app.act(() => press(button(trail(), "Show full diff for commit Inspect changes")))
        let column = diffColumn()!
        let files = column.querySelector<HTMLElement>(".diff-column-files")!
        files.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
        for (let [index, section] of column.querySelectorAll<HTMLElement>("[data-diff-path]").entries())
            section.getBoundingClientRect = () => ({ top: index * 300 - files.scrollTop }) as DOMRect
        let scroll = (top: number, user = true) =>
            app.act(() => {
                if (user)
                    files.dispatchEvent(new Event("wheel", { bubbles: true }))
                files.scrollTop = top
                files.dispatchEvent(new Event("scroll"))
            })
        // The source list scrolls to show the marked row.
        let revealed: (string | null)[] = []
        for (let row of commitFileRows())
            row.scrollIntoView = () => revealed.push(row.getAttribute("aria-label"))

        await scroll(0)
        expect(marked()).toEqual([true, false])
        await scroll(290)
        expect(marked()).toEqual([true, false])
        await scroll(300)
        expect(marked()).toEqual([false, true])
        await app.act(frame)
        expect(revealed.at(-1)).toBe("other.txt")

        // Scrolling to a chosen file passes the files between without marking them, until the user scrolls.
        await app.act(() => openRow(first()))
        expect(marked()).toEqual([true, false])
        await app.act(() => openRow(second()))
        await scroll(100, false)
        expect(marked()).toEqual([false, true])
        // The user's scrolling stands, even once the diffs above the chosen file have loaded.
        await scroll(100)
        expect(marked()).toEqual([true, false])
        await app.act(() => reading.splice(0).forEach(finish => finish()))
        expect(files.scrollTop).toBe(100)
        expect(marked()).toEqual([true, false])

        await app.act(() => press(button(column, "Close diff column")))
        expect(marked()).toEqual([false, false])

        function first() {
            return commitFileRows()[0]!
        }

        function second() {
            return commitFileRows()[1]!
        }
    })

    test("keeps a file chosen below a loading diff at the top once that diff grows, through keys that don't scroll the column", async () => {
        let scenario = inspectionScenario()
        let reading: (() => void)[] = []
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (...args) => {
                let result = await scenario.api.readFileDiff(...args)
                if (args[2].path == "src/file.txt")
                    await new Promise<void>(resolve => reading.push(resolve))
                return result
            },
        })
        await app.act(() => press(button(trail(), "Inspect changes")))
        await app.act(() => press(button(trail(), "Show full diff for commit Inspect changes")))
        let column = diffColumn()!
        let files = column.querySelector<HTMLElement>(".diff-column-files")!
        files.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
        let firstHeight = 300
        for (let [index, section] of column.querySelectorAll<HTMLElement>("[data-diff-path]").entries())
            section.getBoundingClientRect = () => ({ top: index * firstHeight - files.scrollTop }) as DOMRect
        await app.act(() => openRow(commitFileRows()[1]!))

        for (let key of ["Escape", "Tab"])
            await app.act(() => files.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })))
        firstHeight = 500
        await app.act(() => reading.splice(0).forEach(finish => finish()))

        expect(files.scrollTop).toBe(500)
    })

    test("shownFile takes the last section at the top, allowing a pixel, or the first before any reaches it", async () => {
        let { shownFile } = await import("../src/renderer/react/diff-column")

        expect(shownFile([{ path: "a", top: -500 }, { path: "b", top: 0.5 }, { path: "c", top: 300 }])).toBe("b")
        expect(shownFile([{ path: "a", top: 20 }, { path: "b", top: 300 }])).toBe("a")
    })

    test("Working Changes open it on the staged files, focused, in the column's saved layout and not restored", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        let [staged] = fileRows(columns()[0]!, "working-staged")

        await app.act(() => press(button(workingChanges(), "Open diff column")))
        await app.act(frame)
        let column = diffColumn()!
        expect(document.activeElement == column).toBe(true)
        expect(column.querySelector("header")!.textContent).toContain("Staged · ")
        expect(column.querySelector(".auxiliary-source")!.textContent).toBe("From inspection")
        expect(column.dataset.sourceColumnId).toBe(columns()[0]!.dataset.columnId)
        await app.act(() => press(button(file(column, "src/file.txt"), "Side by side")))
        expect(column.querySelector(".diff-lines.split")).not.toBeNull()
        let auxiliaryId = column.dataset.auxiliaryId
        columns()[0]!.focus()
        await app.act(() => press(button(workingChanges(), "Open diff column")))
        await app.act(frame)
        expect(document.querySelectorAll(".diff-column")).toHaveLength(1)
        expect(document.activeElement == column).toBe(true)

        await app.act(() => press(button(column, "Collapse all")))
        await app.act(() => openRow(staged!))
        expect(diffColumn()!.dataset.auxiliaryId).toBe(auxiliaryId)
        expect(column.querySelectorAll(".diff-panel")).toHaveLength(1)
        expect(scenario.saved().repositories[0]!.columns).toHaveLength(1)

        await stopReactApps()
        let restarted = await startReactApp(scenario.api)
        expect(diffColumn() == null).toBe(true)
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
        await app.act(() => press(openButton(row)))
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
    })

    test("resizes from its own divider and keeps its width when it moves to another list, for the session only", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        let row = fileRows(columns()[0]!, "working-staged")[0]!
        await app.act(() => press(openButton(row)))
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
        expect(diffColumn() == null).toBe(true)
        expect([...pending.keys()].every(id => cancelled.includes(id))).toBe(true)
        await app.act(() => [...pending.values()].forEach(finish => finish({ ok: true, page: scenario.page })))
        expect(diffColumn() == null).toBe(true)
    })
})

function columns() {
    return [...document.querySelectorAll<HTMLElement>(".column-row .column")]
}

function order() {
    return [...document.querySelectorAll(".column-group > *")].map(node => node.classList[0])
}

function diffColumn() {
    return document.querySelector<HTMLElement>(".diff-column")
}

function diffPaths(column: HTMLElement) {
    return [...column.querySelectorAll<HTMLElement>("[data-diff-path]")].map(element => element.dataset.diffPath)
}

// Its group headings, marked with "#", among the paths of its files' diffs.
function listing(column: HTMLElement) {
    return [...column.querySelectorAll<HTMLElement>(".diff-column-files > h3, [data-diff-path]")]
        .map(element => element.dataset.diffPath ?? `# ${element.firstChild!.textContent}`)
}

function file(column: HTMLElement, path: string) {
    return [...column.querySelectorAll<HTMLElement>("[data-diff-path]")].find(element => element.dataset.diffPath == path)!
}

function marked() {
    return commitFileRows().map(row => row.hasAttribute("data-active"))
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

// Pressing the file's name presses its row, which shows it in the diff column while that is open.
function openRow(row: HTMLElement) {
    press(row.querySelector<HTMLElement>(".file-path")!)
}

function openButton(row: HTMLElement) {
    return button(row, `Open ${row.getAttribute("aria-label")} in diff column`)
}

// Focus moves to a column that opens on the next frame, after any menu that opened it has returned focus.
function frame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
}

// Pierre draws once its highlighter has loaded, which takes a moment the first time.
async function settle(app: { act(action: () => unknown): Promise<void> }) {
    for (let attempt = 0; attempt < 100; attempt++) {
        await app.act(() => new Promise(resolve => setTimeout(resolve, 10)))
        if ([...document.querySelectorAll(".pierre-diff")].every(host => host.shadowRoot?.querySelector("[data-code]")))
            return
    }
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
