import type { DiffSource, FileHistoryRequest, FileListView } from "@laneway/shared"
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

describe("React Branch Comparison", () => {
    test("opens beside its source, reads diffs lazily, breaks them out, follows moved tips, and persists", async () => {
        let scenario = inspectionScenario()
        let [main, feature] = scenario.graph.branches
        let inventories = 0
        let patches = 0
        let requested: Extract<DiffSource, { kind: "refs" }>[] = []
        let histories: FileHistoryRequest["source"][] = []
        let app = await startReactApp({
            ...scenario.api,
            // Each read is a new graph, as the engine's are, so a moved tip shows as a change.
            readBranchGraph: async () => ({ ok: true, graph: structuredClone(scenario.graph) }),
            readChanges: async (...args) => {
                let request = args[2]
                if (request.source.kind != "refs")
                    return scenario.api.readChanges(...args)
                inventories++
                requested.push(request.source)
                return {
                    ok: true,
                    inventory: {
                        source: { kind: "comparison", fromObjectId: main!.tip, toObjectId: feature!.tip },
                        version: `${main!.tip}:${feature!.tip}`,
                        parents: [],
                        files: [{ ...scenario.page.file, path: "src/file.txt" }],
                    },
                }
            },
            readFileDiff: async (...args) => {
                let request = args[2]
                if (request.source.kind != "comparison")
                    return scenario.api.readFileDiff(...args)
                patches++
                return {
                    ok: true,
                    page: {
                        ...scenario.page,
                        source: request.source,
                        version: request.inventoryVersion ?? "",
                        selectable: false,
                        file: { ...scenario.page.file, path: request.path },
                    },
                }
            },
            readFileHistory: async (_repositoryId, _id, request) => {
                histories.push(request.source)
                return { ok: true, page: { entries: [] } }
            },
        })
        let source = column(feature!.id)!
        let compare = () => button(column(feature!.id)!, `Compare ${feature!.name} with ${main!.name}`)
        let header = () => comparison()!.querySelector<HTMLElement>(".column-header")!

        await app.act(() => press(compare()))
        await app.act(frame)
        // Elements compare as booleans; a failed comparison of two elements would serialize the whole document.
        let order = [...document.querySelectorAll(".column-row .column")]
        expect(order.indexOf(comparison()!)).toBe(order.indexOf(source) + 1)
        expect(comparison()!.querySelector("h2")?.textContent).toBe(`${main!.name} → ${feature!.name}`)
        expect(document.activeElement == comparison()).toBe(true)
        expect(requested).toEqual([{
            kind: "refs",
            from: { kind: "merge-base", ref: main!.preferredRef, withRef: feature!.preferredRef },
            to: { kind: "branch", ref: feature!.preferredRef },
        }])
        expect(patches).toBe(0)

        // A comparison only reads, so its files can't be chosen, moved, or discarded.
        let row = comparison()!.querySelector<HTMLElement>(".branch-comparison .file-row")!
        expect(comparison()!.querySelectorAll(".branch-comparison .file-row")).toHaveLength(1)
        expect(row.querySelector("[slot=selection], .transfer-grip") == null).toBe(true)
        // Its diffs are read once its diff column opens, from the header's control or a file's own.
        await app.act(() => press(row.querySelector<HTMLElement>(".file-path")!))
        expect(patches).toBe(0)
        let openDiffColumn = () => button(header(), "Open diff column")
        expect(openDiffColumn().hasAttribute("disabled")).toBe(false)
        for (let opener of [openDiffColumn, () => button(row, "Open src/file.txt in diff column")]) {
            await app.act(() => press(opener()))
            let diffColumn = document.querySelector<HTMLElement>(".diff-column")!
            expect(comparison()!.nextElementSibling?.nextElementSibling == diffColumn).toBe(true)
            expect(diffColumn.querySelector("header")!.textContent).toContain(`Diff · ${main!.name} → ${feature!.name}`)
            expect(openDiffColumn().getAttribute("aria-pressed")).toBe("true")
            await app.act(() => press(button(diffColumn, "Close diff column")))
            expect(document.querySelector(".diff-column") == null).toBe(true)
        }
        expect(patches).toBe(1)

        let saved = scenario.saved().repositories[0]!.columns
        expect(saved.map(saved => saved.kind)).toEqual(["branch", "comparison"])
        expect(saved[1]).toMatchObject({ id: comparison()!.dataset.columnId, from: requested[0]!.from, to: requested[0]!.to })
        // Asking again shows the open comparison.
        await app.act(() => press(compare()))
        expect(document.querySelectorAll("[data-column-id^='comparison:']")).toHaveLength(1)
        expect(inventories).toBe(1)

        // A compared branch that moves reads the comparison again, and its open diff with it.
        await app.act(() => press(openDiffColumn()))
        main!.tip = "a".repeat(40)
        await app.act(() => app.controller.columns.refresh())
        expect(inventories).toBe(2)
        expect(patches).toBe(2)

        // A file's history opens at either end of the comparison.
        await app.act(() => press(button(row, "Actions for src/file.txt")))
        expect(menuItems().slice(0, 2)).toEqual([`History in ${main!.name}`, `History in ${feature!.name}`])
        await app.act(() => press(menuItem(`History in ${main!.name}`)))
        expect(histories).toEqual([{ kind: "branch", ref: main!.preferredRef }])
        expect(document.querySelector<HTMLElement>(".file-history")!.dataset.sourceColumnId).toBe(comparison()!.dataset.columnId)

        await app.act(() => press(button(header(), "Close column")))
        expect(comparison() == null).toBe(true)
        expect(document.querySelector(".file-history") == null).toBe(true)
        expect(scenario.saved().repositories[0]!.columns).toHaveLength(1)
    })

    test("a branch compares with its base from its heading, but the base at the bottom offers nothing", async () => {
        let scenario = inspectionScenario()
        let [main, feature] = scenario.graph.branches
        let app = await startReactApp(scenario.api)
        let source = column(feature!.id)!
        let compares = [...source.querySelectorAll<HTMLElement>("[aria-label^='Compare ']")]

        expect(compares.map(control => control.getAttribute("aria-label"))).toEqual([`Compare ${feature!.name} with ${main!.name}`])
        await app.act(() => press(compares[0]!))
        expect(comparison()!.querySelector(".column-kind")?.getAttribute("aria-description")).toBe(`Changes on ${feature!.name} since it left ${main!.name}`)
        expect(comparison()!.querySelector(".column-path") == null).toBe(true)
    })

    test("the header's view menu lays out and groups the comparison's files, as every file list's does", async () => {
        let scenario = inspectionScenario()
        let [main, feature] = scenario.graph.branches
        let saved: FileListView[] = []
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (...args) => {
                let request = args[2]
                if (request.source.kind != "refs")
                    return scenario.api.readChanges(...args)
                let source = { kind: "comparison" as const, fromObjectId: main!.tip, toObjectId: feature!.tip }
                let files = ["src/file.txt", "test/file.test.ts"].map(path => ({ ...scenario.page.file, path }))
                return { ok: true, inventory: { source, version: "inventory", parents: [], files } }
            },
            setFileListView: async view => {
                saved.push(view)
                return view
            },
        })
        let header = () => comparison()!.querySelector<HTMLElement>(".column-header")!
        let choose = async (item: string) => {
            await app.act(() => press(button(header(), `File list view for ${main!.name} → ${feature!.name}`)))
            await app.act(() => press(menuItem(item)))
        }
        await app.act(() => press(button(column(feature!.id)!, `Compare ${feature!.name} with ${main!.name}`)))

        await choose("Folders")
        expect(saved).toEqual([{ layout: "tree", grouping: "none" }])
        expect(folderNames()).toEqual(["src", "test"])

        await choose("Flat list")
        await choose("Group by file kind")
        expect(saved.at(-1)).toEqual({ layout: "flat", grouping: "kind" })
        expect(folderNames()).toEqual(["Implementation", "Tests"])
    })
})

function column(id: string) {
    return [...document.querySelectorAll<HTMLElement>(".column-row .column")].find(element => element.dataset.columnId == id)
}

function comparison() {
    return document.querySelector<HTMLElement>("[data-column-id^='comparison:']")
}

// A column that opens takes focus on the next frame, after whatever opened it has returned focus.
function frame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
}

function folderNames() {
    return [...comparison()!.querySelectorAll(".branch-comparison .folder-name")].map(name => name.textContent)
}

function menuItems() {
    return [...document.querySelectorAll("[role=menu] :is([role=menuitem], [role=menuitemradio])")].map(item => item.textContent)
}

function menuItem(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] :is([role=menuitem], [role=menuitemradio])")].find(candidate =>
        candidate.textContent == label
    )
    if (!item)
        throw new Error(`No ${label} menu item in: ${menuItems().join(", ")}`)
    return item
}
