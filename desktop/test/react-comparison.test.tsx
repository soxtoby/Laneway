import type { DiffSource, FileHistoryRequest, FileListView } from "@laneway/shared"
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

describe("React Branch Comparison", () => {
    test("opens from a branch menu, offers the workspace first, and swaps its Working Changes with the branch", async () => {
        let scenario = inspectionScenario()
        let [main, feature] = scenario.graph.branches
        feature!.checkedOut[0]!.branchRef = feature!.preferredRef
        let app = await startReactApp({
            ...scenario.api,
            comparisonRefs: async () => ({ ok: true, refs: [main!, feature!].map(branch => ({ kind: "branch", ref: branch.preferredRef })) }),
        })
        await app.act(() => app.controller.columns.open(main!.id))
        await app.act(() => press(button(column(feature!.id)!, `Actions for branch ${feature!.name}`)))
        await app.act(() => press(menuItem("Compare with…")))
        let shortlist = document.querySelector<HTMLElement>('[aria-label="In this workspace"]')!
        expect(shortlist.textContent).toContain(main!.name)
        await app.act(() => press(shortlist.querySelector<HTMLElement>('[role="menuitem"]')!))
        expect(comparison()!.querySelector("h2")?.textContent).toBe(`${main!.name} → ${feature!.name}`)
        await app.act(() => press(button(comparison()!, `Include Working Changes on ${feature!.name}`)))
        await app.act(() => press(button(comparison()!, "Swap sides")))
        expect(comparison()!.querySelector("h2")?.textContent).toBe(`${feature!.name} → ${main!.name}`)
        expect(scenario.saved().repositories[0]!.columns.find(item => item.kind == "comparison")).toMatchObject({
            from: { kind: "branch", ref: feature!.preferredRef },
            to: { kind: "branch", ref: main!.preferredRef },
            includeFromWorking: true,
        })
    })

    test("chooses Working Changes independently on two checked-out branches and focuses an existing reverse comparison", async () => {
        let scenario = inspectionScenario()
        let [main, feature] = scenario.graph.branches
        let worktree = feature!.checkedOut[0]!
        worktree.branchRef = feature!.preferredRef
        main!.checkedOut = [{ ...worktree, branchRef: main!.preferredRef, path: worktree.path + "-main", main: false, head: main!.tip }]
        let app = await startReactApp(scenario.api)
        let from = { kind: "branch" as const, ref: main!.preferredRef }, to = { kind: "branch" as const, ref: feature!.preferredRef }
        await app.act(() => app.controller.columns.openComparison(feature!.id, to, from))
        await app.act(() => app.controller.columns.openComparison(feature!.id, from, to))
        let source = comparison()!
        await app.act(() => press(button(source, "Include Working Changes")))
        let check = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(item => item.textContent == label)!
        await app.act(() => press(check(`From · ${main!.name}`)))
        if (!check(`To · ${feature!.name}`))
            await app.act(() => press(button(source, "Include Working Changes")))
        await app.act(() => press(check(`To · ${feature!.name}`)))
        expect(scenario.saved().repositories[0]!.columns.find(column => column.id == source.dataset.columnId)).toMatchObject({
            includeWorking: true,
            includeFromWorking: true,
        })
        if (check(`To · ${feature!.name}`))
            await app.act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
        await app.act(() => press(button(source, "Swap sides")))
        let snapshot = app.controller.columns.snapshot()
        let reverse = snapshot.columns.find(column => column.id == snapshot.focusedId)
        expect(reverse).toMatchObject({
            kind: "comparison",
            comparison: { from: { ref: to, includeWorking: false }, to: { ref: from, includeWorking: false } },
        })
        expect(reverse!.id).not.toBe(source.dataset.columnId)
        expect(snapshot.columns.filter(column => column.kind == "comparison")).toHaveLength(2)
    })

    test("Command Lens compares a tag with a typed commit outside the workspace", async () => {
        let scenario = inspectionScenario()
        let priorTagCommit = "c".repeat(40), tagCommit = "a".repeat(40), typedCommit = "b".repeat(40)
        let details = { subject: "First release", authorName: "Alice", authoredAt: 100 }
        scenario.saved().repositories[0]!.columns.push({
            id: "comparison:saved",
            kind: "comparison",
            width: 380,
            from: { kind: "commit", tag: "v1", objectId: priorTagCommit },
            to: { kind: "branch", ref: "refs/heads/main" },
        })
        let app = await startReactApp({
            ...scenario.api,
            comparisonCommitDetails: async (_id, ids) => {
                expect(ids).toEqual([priorTagCommit])
                return { [priorTagCommit]: details }
            },
            comparisonRefs: async () => ({
                ok: true,
                refs: [{ kind: "commit", objectId: tagCommit, tag: "v1", details: { ...details, subject: "Second release" } }],
            }),
            resolveComparisonCommit: async (_repositoryId, revision) => {
                if (revision == typedCommit.slice(0, 8))
                    return { ok: true, objectId: typedCommit, details: { ...details, subject: "Fix layout" } }
                return { ok: false, error: { code: "git.command-failed", message: "Unknown revision" } }
            },
        })
        await app.act(() => press(button(document.body, "Command Lens")))
        await app.act(() => type(document.querySelector<HTMLInputElement>('[aria-label="Command Lens"] input')!, "compare"))
        await app.act(() => press(document.querySelector<HTMLElement>('[aria-label="Command Lens"] [role="menuitem"]')!))
        expect(menuItem("v1Tag · First release").closest("[aria-label='In this workspace']") != null).toBe(true)
        await app.act(() => press(menuItem("v1Tag · Second release")))
        let search = () => document.querySelector<HTMLInputElement>('[aria-label="Compare refs"] input')!
        await app.act(() => type(search(), "missing"))
        await app.act(() => press(menuItem("missingResolve revision")))
        expect(document.querySelector('[aria-label="Compare refs"] [role="alert"]')?.textContent).toContain("Unknown revision")
        await app.act(() => type(search(), typedCommit.slice(0, 8)))
        await app.act(() => press(menuItem("Entered commitResolve revision")))
        let opened = app.controller.columns.snapshot().focusedId
        expect(column(opened!)!.querySelector("h2")?.textContent).toBe("v1 → Fix layout")
        expect(scenario.saved().repositories[0]!.columns.find(item => item.id == opened)).toMatchObject({
            from: { kind: "commit", objectId: tagCommit, tag: "v1" },
            to: { kind: "commit", objectId: typedCommit },
        })
    })

    test("distinguishes two commits with the same subject when reopening a comparison", async () => {
        let scenario = inspectionScenario()
        let [from, to] = ["a".repeat(40), "b".repeat(40)]
        scenario.saved().repositories[0]!.columns.push({
            kind: "comparison",
            id: "comparison:older",
            width: 380,
            from: { kind: "commit", objectId: from },
            to: { kind: "commit", objectId: to },
        })
        await startReactApp({
            ...scenario.api,
            comparisonCommitDetails: async () => ({
                [from]: { subject: "Update layout", authorName: "Ari", authoredAt: 100 },
                [to]: { subject: "Update layout", authorName: "Sam", authoredAt: 200 },
            }),
        })
        expect(comparison()!.querySelector("h2")!.textContent).toMatch(/^Update layout · Ari .* → Update layout · Sam /)
    })

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
        // Its diffs are read once its diff column opens: from the header's control, a file's own, or a press on a file.
        expect(patches).toBe(0)
        let openDiffColumn = () => button(header(), "Open diff column")
        expect(openDiffColumn().hasAttribute("disabled")).toBe(false)
        let openers = [openDiffColumn, () => button(row, "Open src/file.txt in diff column"), () => row.querySelector<HTMLElement>(".file-path")!]
        for (let opener of openers) {
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
        expect(histories).toEqual([{ kind: "commit", objectId: main!.tip }])
        expect(document.querySelector<HTMLElement>(".file-history")!.dataset.sourceColumnId).toBe(comparison()!.dataset.columnId)

        await app.act(() => press(button(header(), "Close column")))
        expect(comparison() == null).toBe(true)
        expect(document.querySelector(".file-history") == null).toBe(true)
        expect(scenario.saved().repositories[0]!.columns).toHaveLength(1)
    })

    test("includes the Working Changes of the worktree its branch is checked out in, reading them again as they change", async () => {
        let scenario = inspectionScenario()
        let [main, feature] = scenario.graph.branches
        let worktree = feature!.checkedOut[0]!
        worktree.branchRef = feature!.preferredRef
        let requested: Extract<DiffSource, { kind: "refs" }>[] = []
        let histories: FileHistoryRequest["source"][] = []
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (...args) => {
                let request = args[2]
                if (request.source.kind != "refs")
                    return scenario.api.readChanges(...args)
                requested.push(request.source)
                let source = { kind: "comparison" as const, fromObjectId: main!.tip, toObjectId: feature!.tip }
                return {
                    ok: true,
                    inventory: { source, version: String(requested.length), parents: [], files: [{ ...scenario.page.file, path: "src/file.txt" }] },
                }
            },
            readFileHistory: async (_repositoryId, _id, request) => {
                histories.push(request.source)
                return { ok: true, page: { entries: [] } }
            },
        })
        let header = () => comparison()!.querySelector<HTMLElement>(".column-header")!
        let include = () => button(header(), `Include Working Changes on ${feature!.name}`)
        await app.act(() => press(button(column(feature!.id)!, `Compare ${feature!.name} with ${main!.name}`)))
        expect(include().getAttribute("aria-pressed")).toBe("false")
        expect(requested.map(source => source.worktreePath)).toEqual([undefined])

        await app.act(() => press(include()))
        expect(include().getAttribute("aria-pressed")).toBe("true")
        expect(requested.at(-1)).toEqual({ ...requested[0]!, worktreePath: worktree.path })
        expect(comparison()!.querySelector(".column-kind")?.getAttribute("aria-description")).toBe(
            `Changes on ${feature!.name} since it left ${main!.name}, with its Working Changes`,
        )
        expect(scenario.saved().repositories[0]!.columns[1]).toMatchObject({ kind: "comparison", includeWorking: true })

        // Its end changes as the worktree's files do, so a refresh of Working Changes reads it again.
        let reads = requested.length
        await app.act(() => app.controller.columns.refresh())
        expect(requested.length).toBe(reads + 1)
        expect(requested.at(-1)!.worktreePath).toBe(worktree.path)

        // A file's history at that end includes the Working Changes too.
        let row = comparison()!.querySelector<HTMLElement>(".branch-comparison .file-row")!
        await app.act(() => press(button(row, "Actions for src/file.txt")))
        await app.act(() => press(menuItem(`History in ${feature!.name}`)))
        expect(histories).toEqual([{ kind: "worktree", worktreePath: worktree.path }])

        await app.act(() => press(include()))
        expect(requested.at(-1)!.worktreePath).toBeUndefined()
        expect(scenario.saved().repositories[0]!.columns[1]!).not.toHaveProperty("includeWorking")
        reads = requested.length
        await app.act(() => app.controller.columns.refresh())
        expect(requested.length).toBe(reads)
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
