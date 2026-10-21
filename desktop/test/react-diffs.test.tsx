import type { DiffLine, DiscardRequest, FileDiffResult } from "@laneway/shared"
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

describe("React diffs", () => {
    test("a file's diff opens beneath its row on its own read, and closing one leaves the other with its chosen lines", async () => {
        let scenario = inspectionScenario()
        let pending = new Map<string, { id: string; finish(result: FileDiffResult): void; request: Parameters<Window["laneway"]["readFileDiff"]>[2] }>()
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (_repositoryId, id, request) => new Promise<FileDiffResult>(finish => pending.set(request.path, { id, request, finish })),
        })
        await app.act(() => press(button(trail(), "Inspect changes")))
        let [first, second] = commitFileRows()
        // Pierre draws once its highlighter has loaded, which takes a moment the first time.
        let complete = async (path: string) => {
            let read = pending.get(path)!
            await app.act(async () => {
                read.finish(await scenario.api.readFileDiff("repository", read.id, read.request))
                await new Promise(resolve => setTimeout(resolve, 50))
            })
        }

        await app.act(() => openRow(first!))
        await app.act(() => openRow(second!))
        expect(pending.size).toBe(2)
        expect(pending.get("src/file.txt")!.id).not.toBe(pending.get("other.txt")!.id)
        expect(diffPanel(first!)?.getAttribute("aria-label")).toBe("Diff for src/file.txt")
        expect(diffPanel(second!)?.getAttribute("aria-label")).toBe("Diff for other.txt")
        await complete("other.txt")
        let secondViewer = second!.querySelector(".pierre-diff")
        await app.act(() => gutter(second!, "Select deletion line 1").click())
        expect(second!.querySelector(".line-selection")?.textContent).toContain("1 line selected")

        // Closing the first while its read is still out drops that read's result.
        await app.act(() => openRow(first!))
        await complete("src/file.txt")
        expect(diffPanel(first!) == null).toBe(true)
        expect(second!.querySelector(".pierre-diff")).toBe(secondViewer)
        expect(diffRoot(second!).querySelectorAll(".diff-line.selected")).toHaveLength(1)
    })

    test("reopening a file reuses its diff page, and a changed list reads it again", async () => {
        let scenario = inspectionScenario()
        let reads = 0
        let version = "one"
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (...args) => {
                let result = await scenario.api.readChanges(...args)
                return result.ok ? { ...result, inventory: { ...result.inventory, version } } : result
            },
            readFileDiff: async (...args) => {
                reads++
                expect(args[2].inventoryVersion).toBe(version)
                return scenario.api.readFileDiff(...args)
            },
        })
        let row = () => fileRows("working-staged")[0]!

        await app.act(() => openRow(row()))
        await app.act(() => openRow(row()))
        await app.act(() => openRow(row()))
        expect(reads).toBe(1)
        expect(diffPanel(row())).not.toBeNull()
        await app.act(() => openRow(row()))
        version = "two"
        await app.act(() => app.controller.columns.refresh())
        await app.act(() => openRow(row()))
        expect(reads).toBe(2)
    })

    test("each side of a partially staged file opens from its own list, and the chosen layout is saved with the column", async () => {
        let scenario = inspectionScenario()
        let views: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (...args) => {
                views.push(args[2].view ?? "combined")
                return scenario.api.readFileDiff(...args)
            },
        })
        let [staged] = fileRows("working-staged")
        let [unstaged] = fileRows("working-unstaged")

        await app.act(() => openRow(staged!))
        expect(views).toEqual(["staged"])
        expect(document.querySelector(".diff-views") == null).toBe(true)
        await app.act(() => gutter(staged!, "Select deletion line 1").click())
        expect(diffRoot(staged!).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        expect(diffRoot(staged!).querySelector(".diff-line.addition.selected") == null).toBe(true)
        await app.act(() => openRow(unstaged!))
        expect(views).toEqual(["staged", "unstaged"])
        await app.act(() => gutter(unstaged!, "Select addition line 1").click())
        expect(document.querySelectorAll(".diff-panel")).toHaveLength(2)
        expect(diffRoot(staged!).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        expect(diffRoot(unstaged!).querySelectorAll(".diff-line.selected")).toHaveLength(1)

        await app.act(() => press(button(staged!, "Side by side")))
        expect(scenario.saved().repositories[0]!.columns[0]!.diffLayout).toBe("split")
        expect(staged!.querySelector(".diff-lines.split")).not.toBeNull()
        expect(button(staged!, "Side by side").getAttribute("aria-pressed")).toBe("true")
        expect(diffRoot(staged!).querySelectorAll(".diff-line.selected").length).toBeGreaterThan(0)
    })

    test("wrapping lines from one diff wraps every diff, including those opened later, until it is turned off", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        let [staged] = fileRows("working-staged")
        let [unstaged] = fileRows("working-unstaged")
        let wraps = (row: HTMLElement) => diffRoot(row).querySelector("pre[data-overflow='wrap']") != null

        await app.act(() => openRow(staged!))
        await app.act(() => press(button(staged!, "Wrap lines")))
        await app.act(() => openRow(unstaged!))
        expect(wraps(staged!)).toBe(true)
        expect(wraps(unstaged!)).toBe(true)
        expect(button(unstaged!, "Wrap lines").getAttribute("aria-pressed")).toBe("true")

        await app.act(() => press(button(unstaged!, "Wrap lines")))
        expect(wraps(staged!)).toBe(false)
        expect(wraps(unstaged!)).toBe(false)
    })

    test("hidden-line counts reveal each gap from the whole file, keeping the chosen lines across layouts", async () => {
        let scenario = inspectionScenario()
        scenario.page.lines = [
            { id: 0, kind: "hunk", text: "@@ -4,3 +4,3 @@", hunk: 0 },
            { id: 1, kind: "context", text: "line 4", oldLine: 4, newLine: 4, hunk: 0 },
            { id: 2, kind: "deletion", text: "old 5", oldLine: 5, hunk: 0 },
            { id: 3, kind: "addition", text: "new 5", newLine: 5, hunk: 0 },
            { id: 4, kind: "context", text: "line 6", oldLine: 6, newLine: 6, hunk: 0 },
            { id: 5, kind: "hunk", text: "@@ -12,3 +12,3 @@", hunk: 1 },
            { id: 6, kind: "context", text: "line 12", oldLine: 12, newLine: 12, hunk: 1 },
            { id: 7, kind: "deletion", text: "old 13", oldLine: 13, hunk: 1 },
            { id: 8, kind: "addition", text: "new 13", newLine: 13, hunk: 1 },
            { id: 9, kind: "context", text: "line 14", oldLine: 14, newLine: 14, hunk: 1 },
        ]
        let fullLines: DiffLine[] = [
            { id: 0, kind: "hunk", text: "@@ -1,18 +1,18 @@", hunk: 0 },
            ...Array.from({ length: 18 }, (_, index) => index + 1).flatMap<DiffLine>(number =>
                [5, 13].includes(number)
                    ? [{ id: number * 2, kind: "deletion", text: `old ${number}`, oldLine: number, hunk: 0 }, {
                        id: number * 2 + 1,
                        kind: "addition",
                        text: `new ${number}`,
                        newLine: number,
                        hunk: 0,
                    }]
                    : [{ id: number * 2, kind: "context", text: `line ${number}`, oldLine: number, newLine: number, hunk: 0 }]
            ),
        ]
        let fullReads = 0
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (...args) => {
                let result = await scenario.api.readFileDiff(...args)
                if (result.ok && args[2].entireFile) {
                    fullReads++
                    let offset = args[2].offset ?? 0
                    result.page = {
                        ...result.page,
                        entireFile: true,
                        version: "full",
                        lines: fullLines.slice(offset, offset ? undefined : 7),
                        nextOffset: offset ? undefined : 7,
                    }
                }
                return result
            },
        })
        let row = fileRows("working-staged")[0]!
        let show = (count: number) => gutter(row, `Show ${count} hidden lines`)
        await app.act(() => openRow(row))

        expect(show(3).textContent).toBe("3 hidden lines")
        expect(show(5).textContent).toBe("5 hidden lines")
        expect(fullReads).toBe(0)
        await app.act(() => gutter(row, "Select addition line 5").click())
        await app.act(async () => {
            show(3).click()
            await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(diffRoot(row).querySelector("[data-line='1']")?.textContent?.trimEnd()).toBe("line 1")
        expect(diffRoot(row).querySelector("[data-line='8']") == null).toBe(true)
        expect(diffRoot(row).querySelector(".addition.selected")?.textContent?.trimEnd()).toBe("new 5")
        await app.act(() => press(button(row, "Side by side")))
        await app.act(async () => {
            show(5).click()
            await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(diffRoot(row).querySelector("[data-line='8']")?.textContent?.trimEnd()).toBe("line 8")
        expect(diffRoot(row).querySelector("[data-line='16']") == null).toBe(true)
        await app.act(async () => {
            show(4).click()
            await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(diffRoot(row).querySelector("[data-line='18']")?.textContent?.trimEnd()).toBe("line 18")
        expect(fullReads).toBe(2)
        expect(diffRoot(row).querySelector(".addition.selected")?.textContent?.trimEnd()).toBe("new 5")
    })

    test("a changed file clears its chosen lines with a notice, and reopening a file starts with none chosen", async () => {
        let scenario = inspectionScenario()
        let version = "one"
        let app = await startReactApp({
            ...scenario.api,
            // A changed file changes the inventory's version too; open diffs are only read again once it does.
            readChanges: async (...args) => {
                let result = await scenario.api.readChanges(...args)
                return result.ok ? { ...result, inventory: { ...result.inventory, version: `${result.inventory.version}:${version}` } } : result
            },
            readFileDiff: async (...args) => {
                let result = await scenario.api.readFileDiff(...args)
                return result.ok ? { ...result, page: { ...result.page, version } } : result
            },
        })
        let [file, other] = fileRows("working-staged")
        await app.act(() => openRow(other!))
        await app.act(() => gutter(other!, "Select deletion line 1").click())

        version = "two"
        await app.act(() => app.controller.columns.refresh())
        expect(other!.textContent).toContain("File changed. Change Selection cleared.")
        expect(diffRoot(other!).querySelector(".diff-line.selected") == null).toBe(true)

        await app.act(() => openRow(file!))
        await app.act(() => gutter(file!, "Select deletion line 1").click())
        await app.act(() => openRow(file!))
        await app.act(() => openRow(file!))
        expect(diffRoot(file!).querySelector(".diff-line.selected") == null).toBe(true)
    })

    test("a large patch draws only the lines in view, and folding its commit closes its diffs", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (...args) => {
                let result = await scenario.api.readFileDiff(...args)
                let lines = Array.from({ length: 2000 }, (_, id) => ({ id, kind: "addition" as const, text: `line ${id}`, newLine: id + 1, hunk: 0 }))
                return result.ok ? { ...result, page: { ...result.page, lines } } : result
            },
        })
        await app.act(() => press(button(trail(), "Inspect changes")))
        await app.act(() => openRow(commitFileRows()[0]!))

        expect(diffRoot(commitFileRows()[0]!).querySelectorAll(".diff-line").length).toBeLessThanOrEqual(80)
        expect(document.querySelector(".diff-views") == null).toBe(true)
        await app.act(() => press(button(trail(), "Inspect changes")))
        expect(document.querySelector(".commit-files") == null).toBe(true)
        await app.act(() => press(button(trail(), "Inspect changes")))
        expect(document.querySelector(".diff-panel") == null).toBe(true)
    })

    test("chosen lines discard from the unstaged side only, with Undo in the notice", async () => {
        let scenario = inspectionScenario()
        let requests: DiscardRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            discardChanges: async (_id, request) => {
                requests.push(request)
                return { ok: true, id: `discard-${requests.length}`, undoable: true }
            },
        })
        let [staged] = fileRows("working-staged")
        let [unstaged] = fileRows("working-unstaged")

        await app.act(() => openRow(staged!))
        await app.act(() => gutter(staged!, "Select deletion line 1").click())
        expect(staged!.querySelector(".discard-lines") == null).toBe(true)
        await app.act(() => openRow(unstaged!))
        await app.act(() => gutter(unstaged!, "Select addition line 1").click())
        await app.act(() => press(button(unstaged!, "Discard selected")))

        expect(requests.at(-1)).toMatchObject({ kind: "lines", worktreePath: "D:\\Source\\inspection", path: "src/file.txt", lineIds: [2] })
        expect((requests.at(-1) as { lines: unknown[] }).lines).toHaveLength(3)
        expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Discarded 1 line in src/file.txt")
    })

    test("a changed picture compares its versions instead of lines, in the mode its row chooses for every picture", async () => {
        let scenario = inspectionScenario()
        let picture = { path: "art/logo.png", status: "modified", staged: true, unstaged: false, untracked: false, ignored: false, conflicted: false }
        let imageReads: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (_id, _requestId, request) => ({
                ok: true,
                inventory: { source: request.source, files: [picture], version: "pictures", parents: [] },
            }),
            readFileDiff: async (_id, _requestId, request) => ({
                ok: true,
                page: {
                    source: request.source,
                    file: picture,
                    view: request.view ?? "combined",
                    version: "one",
                    summary: ["Binary content changed."],
                    lines: [],
                    selectable: false,
                },
            }),
            readFileImage: async (_id, _requestId, request) => {
                imageReads.push(request.path)
                return { ok: false, error: { code: "git.command-failed", message: "Pictures unavailable here" } }
            },
        })
        let row = fileRows("working-staged")[0]!

        await app.act(async () => {
            openRow(row)
            await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(imageReads).toEqual(["art/logo.png"])
        expect(row.querySelector(".pierre-diff") == null).toBe(true)
        expect(row.querySelector(".diff-summary") == null).toBe(true)
        expect(row.querySelector(".image-diff [role=alert]")?.textContent).toBe("Pictures unavailable here")
        expect(button(row, "Side by side").getAttribute("aria-pressed")).toBe("true")
        await app.act(() => press(button(row, "Swipe")))
        expect(button(row, "Swipe").getAttribute("aria-pressed")).toBe("true")

        // A picture opened next starts in the mode chosen last.
        await app.act(() => openRow(row))
        await app.act(() => openRow(row))
        expect(button(row, "Swipe").getAttribute("aria-pressed")).toBe("true")
    })

    test("folding a folder closes the diffs of the files it hides", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        await app.act(() => app.controller.setFileListView({ layout: "tree", grouping: "none" }))
        let row = fileRows("working-staged").find(candidate => candidate.textContent?.includes("file.txt"))!
        await app.act(() => openRow(row))
        expect(document.querySelectorAll(".diff-panel")).toHaveLength(1)

        let folder = document.querySelector<HTMLElement>("[data-group='working-staged'] .folder-row")!
        await app.act(() => press(button(folder, "Fold src")))
        expect(document.querySelectorAll(".diff-panel")).toHaveLength(0)
    })
})

function trail() {
    return document.querySelector<HTMLElement>(".commit-trail")!
}

function fileRows(group: string) {
    return [...document.querySelectorAll<HTMLElement>(`[data-group='${group}'] .file-row`)]
}

function commitFileRows() {
    return [...document.querySelectorAll<HTMLElement>(".commit-files .file-row")]
}

// Pressing the file's name presses its row, which opens or closes its diff.
function openRow(row: HTMLElement) {
    press(row.querySelector<HTMLElement>(".file-path")!)
}

function diffPanel(row: HTMLElement) {
    return row.querySelector<HTMLElement>(".diff-panel")
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
