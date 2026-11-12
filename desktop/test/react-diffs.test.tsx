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
    test("each file's diff in the diff column arrives on its own read, and lines chosen in one stay as another arrives", async () => {
        let scenario = inspectionScenario()
        let pending = new Map<string, { id: string; finish(result: FileDiffResult): void; request: Parameters<Window["laneway"]["readFileDiff"]>[2] }>()
        let app = await startReactApp({
            ...scenario.api,
            readFileDiff: async (_repositoryId, id, request) => new Promise<FileDiffResult>(finish => pending.set(request.path, { id, request, finish })),
        })
        await app.act(() => press(button(trail(), "Inspect changes")))
        let complete = async (path: string) => {
            let read = pending.get(path)!
            await app.act(async () => read.finish(await scenario.api.readFileDiff("repository", read.id, read.request)))
        }

        await app.act(() => openDiff(commitFileRows()[1]!))
        expect(pending.size).toBe(2)
        expect(pending.get("src/file.txt")!.id).not.toBe(pending.get("other.txt")!.id)
        expect(diffPanel(shown("src/file.txt"))?.getAttribute("aria-label")).toBe("Diff for src/file.txt")
        expect(diffPanel(shown("other.txt"))?.getAttribute("aria-label")).toBe("Diff for other.txt")
        await complete("other.txt")
        await drawn(app)
        let viewer = shown("other.txt").querySelector(".pierre-diff")
        await app.act(() => gutter(shown("other.txt"), "Select deletion line 1").click())
        expect(shown("other.txt").querySelector(".line-selection")?.textContent).toContain("1 line selected")

        await complete("src/file.txt")
        await drawn(app)
        expect(shown("other.txt").querySelector(".pierre-diff")).toBe(viewer)
        expect(diffRoot(shown("other.txt")).querySelectorAll(".diff-line.selected")).toHaveLength(1)
    })

    test("reopening the diff column reuses its diff pages, and a changed list reads them again", async () => {
        let scenario = inspectionScenario(["src/file.txt"])
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

        await app.act(() => openDiff(row()))
        await app.act(closeDiffColumn)
        await app.act(() => openDiff(row()))
        expect(reads).toBe(1)
        expect(diffPanel(shown("src/file.txt"))).not.toBeNull()
        await app.act(closeDiffColumn)
        version = "two"
        await app.act(() => app.controller.columns.refresh())
        await app.act(() => openDiff(row()))
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
        let file = () => shown("src/file.txt")

        await app.act(() => openDiff(staged!))
        await drawn(app)
        expect(views).toEqual(["staged", "staged"])
        expect(document.querySelector(".diff-views") == null).toBe(true)
        await app.act(() => gutter(file(), "Select deletion line 1").click())
        expect(diffRoot(file()).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        expect(diffRoot(file()).querySelector(".diff-line.addition.selected") == null).toBe(true)
        await app.act(() => openDiff(unstaged!))
        await drawn(app)
        expect(views).toEqual(["staged", "staged", "unstaged", "unstaged"])
        await app.act(() => gutter(file(), "Select addition line 1").click())
        expect(diffRoot(file()).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        expect(diffRoot(file()).querySelector(".diff-line.deletion.selected") == null).toBe(true)

        await app.act(() => press(button(file(), "Side by side")))
        expect(scenario.saved().repositories[0]!.columns[0]!.diffLayout).toBe("split")
        expect(file().querySelector(".diff-lines.split")).not.toBeNull()
        expect(button(file(), "Side by side").getAttribute("aria-pressed")).toBe("true")
        expect(diffRoot(file()).querySelectorAll(".diff-line.selected").length).toBeGreaterThan(0)
    })

    test("wrapping lines from one diff wraps every diff in every column, including those opened later, until it is turned off", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp({
            ...scenario.api,
            readFileHistory: async (_repositoryId, _id, request) => {
                let entry = { objectId: "1".repeat(40), parentIds: [], authorName: "Test", authorEmail: "test@example.test", authoredAt: 1 }
                return { ok: true, page: { entries: [{ ...entry, subject: "History commit", status: "M", path: request.path }] } }
            },
        })
        let [staged] = fileRows("working-staged")
        let [unstaged] = fileRows("working-unstaged")
        let wraps = (scope: HTMLElement) => diffRoot(scope).querySelector("pre[data-overflow='wrap']") != null
        let history = () => document.querySelector<HTMLElement>(".file-history")!
        // A diff in the File History column, which lays out its diffs apart from the Workspace Column.
        await app.act(() => press(button(staged!, `Actions for ${staged!.getAttribute("aria-label")}`)))
        await app.act(() => press(menuItem("File history")))
        await app.act(() => press(button(history(), "History commit")))

        await app.act(() => openDiff(staged!))
        await drawn(app)
        await app.act(() => press(button(shown("src/file.txt"), "Wrap lines")))
        expect(wraps(shown("other.txt"))).toBe(true)
        expect(wraps(history())).toBe(true)
        // The diff column's diffs of another list are opened later.
        await app.act(() => openDiff(unstaged!))
        await drawn(app)
        expect(wraps(shown("src/file.txt"))).toBe(true)
        expect(button(shown("src/file.txt"), "Wrap lines").getAttribute("aria-pressed")).toBe("true")

        await app.act(() => press(button(history(), "Wrap lines")))
        expect(wraps(shown("src/file.txt"))).toBe(false)
        expect(wraps(history())).toBe(false)
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
        let row = () => shown("src/file.txt")
        let show = (count: number) => gutter(row(), `Show ${count} hidden lines`)
        await app.act(() => openDiff(fileRows("working-staged")[0]!))
        await drawn(app)

        expect(show(3).textContent).toBe("3 hidden lines")
        expect(show(5).textContent).toBe("5 hidden lines")
        expect(fullReads).toBe(0)
        await app.act(() => gutter(row(), "Select addition line 5").click())
        await app.act(async () => {
            show(3).click()
            await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(diffRoot(row()).querySelector("[data-line='1']")?.textContent?.trimEnd()).toBe("line 1")
        expect(diffRoot(row()).querySelector("[data-line='8']") == null).toBe(true)
        expect(diffRoot(row()).querySelector(".addition.selected")?.textContent?.trimEnd()).toBe("new 5")
        await app.act(() => press(button(row(), "Side by side")))
        await app.act(async () => {
            show(5).click()
            await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(diffRoot(row()).querySelector("[data-line='8']")?.textContent?.trimEnd()).toBe("line 8")
        expect(diffRoot(row()).querySelector("[data-line='16']") == null).toBe(true)
        await app.act(async () => {
            show(4).click()
            await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(diffRoot(row()).querySelector("[data-line='18']")?.textContent?.trimEnd()).toBe("line 18")
        expect(fullReads).toBe(2)
        expect(diffRoot(row()).querySelector(".addition.selected")?.textContent?.trimEnd()).toBe("new 5")
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
        let row = () => fileRows("working-staged")[0]!
        await app.act(() => openDiff(row()))
        await drawn(app)
        await app.act(() => gutter(shown("other.txt"), "Select deletion line 1").click())

        version = "two"
        await app.act(() => app.controller.columns.refresh())
        await drawn(app)
        expect(shown("other.txt").textContent).toContain("File changed. Change Selection cleared.")
        expect(diffRoot(shown("other.txt")).querySelector(".diff-line.selected") == null).toBe(true)

        await app.act(() => gutter(shown("src/file.txt"), "Select deletion line 1").click())
        await app.act(closeDiffColumn)
        await app.act(() => openDiff(row()))
        await drawn(app)
        expect(diffRoot(shown("src/file.txt")).querySelector(".diff-line.selected") == null).toBe(true)
    })

    test("a large patch draws only the lines in view", async () => {
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
        await app.act(() => openDiff(commitFileRows()[0]!))
        await drawn(app)

        expect(diffRoot(shown("src/file.txt")).querySelectorAll(".diff-line").length).toBeLessThanOrEqual(80)
        expect(document.querySelector(".diff-views") == null).toBe(true)
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

        await app.act(() => openDiff(staged!))
        await drawn(app)
        await app.act(() => gutter(shown("src/file.txt"), "Select deletion line 1").click())
        expect(shown("src/file.txt").querySelector(".discard-lines") == null).toBe(true)
        await app.act(() => openDiff(unstaged!))
        await drawn(app)
        await app.act(() => gutter(shown("src/file.txt"), "Select addition line 1").click())
        await app.act(() => press(button(shown("src/file.txt"), "Discard selected")))

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
        let file = () => shown("art/logo.png")

        await app.act(async () => {
            openDiff(row)
            await new Promise(resolve => setTimeout(resolve, 20))
        })
        expect(imageReads).toEqual(["art/logo.png"])
        expect(file().querySelector(".pierre-diff") == null).toBe(true)
        expect(file().querySelector(".diff-summary") == null).toBe(true)
        expect(file().querySelector(".image-diff [role=alert]")?.textContent).toBe("Pictures unavailable here")
        expect(button(file(), "Side by side").getAttribute("aria-pressed")).toBe("true")
        await app.act(() => press(button(file(), "Swipe")))
        expect(button(file(), "Swipe").getAttribute("aria-pressed")).toBe("true")

        // A picture opened next starts in the mode chosen last.
        await app.act(closeDiffColumn)
        await app.act(() => openDiff(row))
        expect(button(file(), "Swipe").getAttribute("aria-pressed")).toBe("true")
    })

    test("a Markdown file's diff shows its rendered documents, with their pictures and links, until source is chosen for every Markdown diff after", async () => {
        let scenario = inspectionScenario()
        let readme = { path: "docs/README.md", status: "modified", staged: true, unstaged: false, untracked: false, ignored: false, conflicted: false }
        let documents = {
            old: "# Guide\n\nThe old words.\n\n![Logo](images/logo.png)\n",
            new: "# Guide\n\nThe new words.\n\nSee [the site](https://example.com/).\n\n![Logo](images/logo.png)\n",
        }
        let picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        let pictureReads: string[] = []
        let opened: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (_id, _requestId, request) => ({
                ok: true,
                inventory: { source: request.source, files: [readme], version: "docs", parents: [] },
            }),
            readFileDiff: async (_id, _requestId, request) => ({
                ok: true,
                page: {
                    source: request.source,
                    file: readme,
                    view: request.view ?? "combined",
                    version: "one",
                    summary: [],
                    lines: [{ id: 0, kind: "hunk", text: "@@ -3 +3 @@", hunk: 0 }, { id: 1, kind: "deletion", text: "The old words.", oldLine: 3, hunk: 0 }, {
                        id: 2,
                        kind: "addition",
                        text: "The new words.",
                        newLine: 3,
                        hunk: 0,
                    }],
                    selectable: false,
                },
            }),
            readFileVersion: async (_id, _requestId, request) => {
                if (request.path == "docs/README.md")
                    return { ok: true, content: { state: "ready", bytes: new TextEncoder().encode(documents[request.side]), size: 0 } }
                pictureReads.push(`${request.side} ${request.path}`)
                return { ok: true, content: { state: "ready", bytes: picture, size: picture.length } }
            },
            openLink: async url => void opened.push(url),
        })
        let row = fileRows("working-staged")[0]!
        let file = () => shown("docs/README.md")
        await app.act(() => openDiff(row))
        // The diff engine loads with the first rendered diff, which can take a while.
        for (let tries = 0; tries < 100 && file().querySelector(".markdown-diff [data-diff]") == null; tries++)
            await app.act(() => new Promise(resolve => setTimeout(resolve, 20)))
        expect(button(file(), "Show rendered Markdown").getAttribute("aria-pressed")).toBe("true")
        let rendered = file().querySelector(".markdown-diff")!
        expect([...rendered.querySelectorAll("del[data-diff]")].map(element => element.textContent)).toEqual(["old"])
        expect([...rendered.querySelectorAll("ins[data-diff]")].map(element => element.textContent)).toEqual(["new"])
        expect(rendered.querySelector("[data-diff='added'] a")?.textContent).toBe("the site")
        expect(rendered.querySelector("img")?.getAttribute("src")?.startsWith("blob:")).toBe(true)
        expect(pictureReads).toEqual(["new docs/images/logo.png"])
        expect(file().querySelector("[aria-label='Wrap lines']") == null).toBe(true)

        await app.act(() => rendered.querySelector<HTMLElement>("a")!.click())
        expect(opened).toEqual(["https://example.com/"])

        await app.act(() => press(button(file(), "Side by side")))
        expect(file().querySelector(".markdown-diff")?.getAttribute("data-layout")).toBe("split")

        await app.act(() => press(button(file(), "Show rendered Markdown")))
        expect(file().querySelector(".markdown-diff") == null).toBe(true)

        // A Markdown diff opened next starts as source too.
        await app.act(closeDiffColumn)
        await app.act(() => openDiff(row))
        expect(button(file(), "Show rendered Markdown").getAttribute("aria-pressed")).toBe("false")
        expect(file().querySelector(".markdown-diff") == null).toBe(true)
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

// The row's own button opens its list's whole diff in the diff column.
function openDiff(row: HTMLElement) {
    press(button(row, `Open ${row.getAttribute("aria-label")} in diff column`))
}

function closeDiffColumn() {
    press(button(document.querySelector<HTMLElement>(".diff-column")!, "Close diff column"))
}

// A file's diff in the diff column, under its toolbar.
function shown(path: string) {
    let found = [...document.querySelectorAll<HTMLElement>(".diff-column [data-diff-path]")].find(section => section.dataset.diffPath == path)
    if (!found)
        throw new Error(`No ${path} in the diff column`)
    return found
}

function menuItem(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(candidate => candidate.textContent == label)
    if (!item)
        throw new Error(`No ${label} menu item`)
    return item
}

function diffPanel(row: HTMLElement) {
    return row.querySelector<HTMLElement>(".diff-panel")
}

function diffRoot(scope: Element) {
    return scope.querySelector(".pierre-diff")!.shadowRoot!
}

// Pierre draws once its highlighter has loaded, which takes a moment the first time.
async function drawn(app: { act(action: () => unknown): Promise<void> }) {
    for (let attempt = 0; attempt < 100; attempt++) {
        await app.act(() => new Promise(resolve => setTimeout(resolve, 10)))
        if ([...document.querySelectorAll(".pierre-diff")].every(host => host.shadowRoot?.querySelector("[data-code]")))
            return
    }
}

function gutter(scope: Element, label: string) {
    let found = diffRoot(scope).querySelector<HTMLButtonElement>(`[aria-label='${label}']`)
    if (!found)
        throw new Error(`No ${label} in the diff`)
    return found
}
