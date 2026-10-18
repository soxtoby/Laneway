/** @jsxImportSource react */
import type { FileHistoryEntry, FileHistoryRequest } from "@laneway/shared"
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

describe("React File History", () => {
    test("fills a page of matching commits from sparse scans, stays lazy, and keeps its progress on refresh", async () => {
        let scenario = inspectionScenario()
        let cursors: (string | undefined)[] = []
        let release = new Map<number, () => void>()
        let cancellations = 0
        let patches = 0
        let app = await startReactApp({
            ...scenario.api,
            cancelInspection: async () => {
                cancellations++
                return true
            },
            readFileDiff: async (...args) => {
                patches++
                return scenario.api.readFileDiff(...args)
            },
            readFileHistory: async (_repositoryId, _id, request) => {
                cursors.push(request.cursor?.objectId)
                // Scans after the first find nothing, then the rest of the page; each waits to be released.
                let offset = request.cursor ? Number(request.cursor.objectId[0]) - 2 : 0
                if (offset == 1 || offset == 3)
                    await new Promise<void>(resolve => release.set(offset, resolve))
                let entries = Array.from(
                    { length: offset == 0 ? 1 : offset == 1 ? 0 : 39 },
                    (_, index) => entry(index + offset + 10, `File commit ${index + offset}`, request),
                )
                return { ok: true, page: { tip: "2".repeat(40), entries, cursor: { objectId: String(offset + 3).repeat(40), path: request.path } } }
            },
        })

        await openFileHistory(app, workingRow())
        let history = historyColumn()!
        expect(history.querySelectorAll(".history-entry")).toHaveLength(2)
        expect(cursors).toEqual([undefined, "3".repeat(40)])
        await app.act(() => release.get(1)!())
        expect(entries(history)).toHaveLength(40)
        expect(cursors).toEqual([undefined, "3".repeat(40), "4".repeat(40)])

        // A refresh reads the first page again, and keeps the page already filled.
        await app.act(() => app.controller.columns.refresh())
        expect(cursors.at(-1)).toBeUndefined()
        expect(entries(history)).toHaveLength(40)
        expect(patches).toBe(0)

        await app.act(() => press(button(history, "Load more history")))
        expect(cursors.at(-1)).toBe("5".repeat(40))
        await app.act(() => press(button(history, "Close file history")))
        expect(cancellations).toBeGreaterThan(0)
        await app.act(() => release.get(3)!())
        expect(historyColumn()).toBeNull()
        expect(cursors.at(-1)).toBe("5".repeat(40))
    })

    test("unfolds entries to their diffs, opens blame origins and commit diffs, and closes what was opened from it", async () => {
        let scenario = inspectionScenario()
        let oid = "2".repeat(40)
        let reads = 0
        let app = await startReactApp({
            ...scenario.api,
            readFileHistory: async (_repositoryId, _id, request) => {
                reads++
                if (request.related)
                    return { ok: true, page: { entries: [], related: [{ path: "other.txt", objectId: oid, evidence: "shared lines", score: 2 }] } }
                if (request.blame) {
                    let line = { objectId: "1".repeat(40), path: "other.txt", originalLine: 1, line: 1, author: "Test", text: "origin" }
                    return { ok: true, page: { entries: [], blame: [line] } }
                }
                let merge = { ...entry(2, "History commit", request), parentIds: ["1".repeat(40), "3".repeat(40)], followedParent: "1".repeat(40) }
                return { ok: true, page: { tip: oid, entries: [{ ...merge, composable: request.source.kind != "commit" }] } }
            },
        })

        await openFileHistory(app, workingRow())
        let history = historyColumn()!
        expect(history.textContent).toContain("History · src/file.txt")
        expect(history.textContent).toContain("Working Changes")
        // Asking again focuses the open history instead of reading another.
        await openFileHistory(app, workingRow())
        expect(document.querySelectorAll(".file-history")).toHaveLength(1)
        expect(reads).toBe(1)

        await app.act(() => press(button(history, "History commit")))
        let row = history.querySelector<HTMLElement>(".history-entry[data-expanded]")!
        expect(row.querySelector(".diff-panel")).not.toBeNull()
        expect(row.querySelector(".transfer-grip")).not.toBeNull()
        for (let label of ["Side by side", "Show whitespace"]) {
            await app.act(() => press(button(row, label)))
            expect(button(row, label).getAttribute("aria-pressed")).toBe("true")
        }
        // Its diffs lay out apart from the Workspace Column's, which keeps its saved layout.
        expect(scenario.saved().repositories[0]!.columns[0]!.diffLayout ?? "unified").toBe("unified")
        await app.act(() => press(button(history, "History commit")))
        expect(history.querySelector(".diff-panel")).toBeNull()

        await app.act(() => press(button(history, "Actions for History commit")))
        await app.act(() => press(menuItem("Complete commit diff")))
        let commit = document.querySelector<HTMLElement>(".commit-diff")!
        expect(commit.getAttribute("aria-label")).toBe("Commit diff · History commit")
        expect(commit.querySelectorAll(".file-row")).toHaveLength(2)
        await app.act(() => new Promise(resolve => requestAnimationFrame(resolve)))
        // Elements compare as booleans; a failed comparison of two elements would serialize the whole document.
        expect(document.activeElement == commit).toBe(true)
        await app.act(() => press(button(commit, "Find related files")))
        expect(commit.textContent).toContain("shared lines · 2")
        await app.act(() => press(commit.querySelector<HTMLElement>(".related-file")!))
        expect(document.querySelectorAll(".file-history")).toHaveLength(2)
        await app.act(() => press(button(commit, "Close commit diff")))
        await app.act(() => new Promise(resolve => requestAnimationFrame(resolve)))
        expect(document.querySelectorAll(".file-history")).toHaveLength(1)
        // Closing it returns focus to the history it was opened from.
        expect(document.activeElement == history).toBe(true)

        await app.act(() => press(button(history, "Actions for History commit")))
        await app.act(() => press(menuItem("Blame context")))
        expect(history.querySelector(".blame-context")?.textContent).toContain("origin")
        await app.act(() => press(button(history, "Open origin of line 1")))
        let histories = document.querySelectorAll(".file-history")
        expect(histories).toHaveLength(2)
        expect(histories[1]!.textContent).toContain("History · other.txt")
        expect(histories[1]!.textContent).not.toContain("Working Changes")
        await app.act(() => press(button(history, "Close file history")))
        expect(document.querySelector(".file-history")).toBeNull()
    })

    test("a commit diff compares another parent of a merge, closing the columns its related files opened", async () => {
        let scenario = inspectionScenario()
        let parents: (string | undefined)[] = []
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (...args) => {
                let request = args[2]
                if (request.source.kind == "commit")
                    parents.push(request.source.parentId)
                return scenario.api.readChanges(...args)
            },
            readFileHistory: async (_repositoryId, _id, request) => {
                if (request.related) {
                    return {
                        ok: true,
                        page: { entries: [], related: [{ path: "other.txt", objectId: "2".repeat(40), evidence: "changed together", score: 1 }] },
                    }
                }
                let merge = { ...entry(2, "History commit", request), parentIds: ["1".repeat(40), "3".repeat(40)], followedParent: "1".repeat(40) }
                return { ok: true, page: { tip: "2".repeat(40), entries: [merge] } }
            },
        })
        await openFileHistory(app, workingRow())
        await app.act(() => press(button(historyColumn()!, "Actions for History commit")))
        await app.act(() => press(menuItem("Complete commit diff")))
        let commit = document.querySelector<HTMLElement>(".commit-diff")!
        await app.act(() => press(button(commit, "Find related files")))
        await app.act(() => press(commit.querySelector<HTMLElement>(".related-file")!))
        expect(document.querySelectorAll(".file-history")).toHaveLength(2)

        await app.act(() => press(button(commit, "Commit diff parent")))
        await app.act(() => press([...document.querySelectorAll<HTMLElement>("[role=option]")].find(option => option.textContent?.startsWith("Parent 2"))!))
        expect(parents.at(-1)).toBe("3".repeat(40))
        expect(document.querySelectorAll(".file-history")).toHaveLength(1)
        expect(commit.textContent).toContain("Find related files")
    })

    test("opens from a commit's files and from the diff column, reading from where the file was listed", async () => {
        let scenario = inspectionScenario()
        let sources: FileHistoryRequest["source"][] = []
        let app = await startReactApp({
            ...scenario.api,
            readFileHistory: async (_repositoryId, _id, request) => {
                sources.push(request.source)
                return { ok: true, page: { tip: "2".repeat(40), entries: [] } }
            },
        })
        await app.act(() => press(button(document.querySelector<HTMLElement>(".commit-trail")!, "Inspect changes")))
        let commitRow = document.querySelector<HTMLElement>(".commit-files .file-row")!
        await openFileHistory(app, commitRow)
        expect(sources.at(-1)).toEqual({ kind: "commit", objectId: scenario.graph.branches[1]!.tip })
        expect(historyColumn()!.textContent).toContain("No committed history.")
        await app.act(() => press(button(historyColumn()!, "Close file history")))

        let row = workingRow()
        await app.act(() => press(row.querySelector<HTMLElement>(".file-path")!))
        await app.act(() => press(button(row, "Break out diff")))
        let toolbar = document.querySelector<HTMLElement>(".diff-column [data-diff-path='src/file.txt'] .diff-toolbar")!
        await app.act(() => toolbar.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 })))
        await app.act(() => press(menuItem("File history")))
        expect(sources.at(-1)).toEqual({ kind: "worktree", worktreePath: "D:\\Source\\inspection" })
        // It opens beside the diff column, which it closes with.
        expect(historyColumn()!.dataset.sourceColumnId).toBe(document.querySelector<HTMLElement>(".diff-column")!.dataset.auxiliaryId)
        await app.act(() => press(button(document.querySelector<HTMLElement>(".diff-column")!, "Close diff column")))
        expect(historyColumn()).toBeNull()
    })
})

function entry(index: number, subject: string, request: FileHistoryRequest): FileHistoryEntry {
    return {
        objectId: index.toString(16).padStart(40, "0"),
        parentIds: [],
        authorName: "Test",
        authorEmail: "test@example.test",
        authoredAt: 1,
        subject,
        status: "M",
        path: request.path,
    }
}

async function openFileHistory(app: { act(action: () => unknown): Promise<void> }, row: HTMLElement) {
    await app.act(() => press(button(row, `Actions for ${row.querySelector(".file-path")!.textContent}`)))
    await app.act(() => press(menuItem("File history")))
}

function workingRow() {
    return document.querySelector<HTMLElement>("[data-group='working-staged'] .file-row")!
}

function historyColumn() {
    return document.querySelector<HTMLElement>(".file-history")
}

// The Working Changes entry is a section of its own, ahead of the commits.
function entries(history: HTMLElement) {
    return [...history.querySelectorAll(".history-entry")].filter(section => !section.textContent?.startsWith("Working Changes"))
}

function menuItem(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(candidate => candidate.textContent == label)
    if (!item)
        throw new Error(`No ${label} menu item in: ${document.querySelector("[role=menu]")?.textContent}`)
    return item
}
