import type { Workspace } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, hover, installReactDom, press, startReactApp, stopReactApps } from "./react-dom"
import { appState, branchGraph, fakeLaneway, inspectionScenario, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React Workspace Columns", () => {
    test("restores saved columns, and moves and resizes them by keyboard, saving each change", async () => {
        let repository = repositoryInfo("D:\\Source\\persisted-graph")
        let graph = branchGraph(repository.id)
        let [main, feature] = [graph.branches[0]!, graph.branches[1]!]
        let saved: Workspace = {
            repositories: [{
                status: "available",
                id: repository.id,
                path: repository.mainWorktree,
                info: repository,
                layoutInitialized: true,
                focusedColumnId: main.id,
                columns: [main, feature].map(branch => ({ kind: "branch", id: branch.id, ref: branch.preferredRef, lastSeenObjectId: branch.tip, width: 380 })),
            }],
            activeRepositoryId: repository.id,
        }
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: saved }),
            readBranchGraph: async () => ({ ok: true, graph: structuredClone(graph) }),
            updateWorkspace: async workspace => saved = structuredClone(workspace),
        }))
        expect(columnIds()).toEqual([main.id, feature.id])
        expect(tabs()).toEqual(["main *", "feature/laneway"])
        expect(columnHeaders()).not.toContain("refs/heads/")

        await app.act(() => key(button(column(main.id), "Filter files"), ">", { ctrlKey: true, shiftKey: true }))
        await app.act(() => frame())
        expect(savedColumns(saved).map(column => column.id)).toEqual([feature.id, main.id])
        expect(document.activeElement?.getAttribute("data-column-id")).toBe(main.id)

        await app.act(() => key(divider(main.id), "ArrowRight"))
        expect(savedColumns(saved).find(column => column.id == main.id)?.width).toBe(390)
    })

    test("only a column showing a diff column maximizes, and closing the diff column restores it", async () => {
        let app = await startReactApp(inspectionScenario().api)
        let id = columnIds()[0]!
        let header = () => column(id).querySelector("header")!

        await app.act(() => dblclick(header()))
        let alone = { maximized: maximized(), offered: header().querySelector("[aria-label='Maximize column']") != null }

        await openDiffColumn(app, id)
        await app.act(() => press(button(header(), "Maximize column")))
        expect(maximized()).toEqual([id])

        await app.act(() => press(button(document.querySelector<HTMLElement>(".diff-column")!, "Close diff column")))
        expect(alone).toEqual({ maximized: [], offered: false })
        expect(maximized()).toEqual([])
        expect(document.querySelector(".column-group.maximized") == null).toBe(true)

        // Opening it again leaves the column at its own width.
        await openDiffColumn(app, id)
        expect(maximized()).toEqual([])
    })

    test("double-clicking a column header toggles maximizing it, but not on its controls", async () => {
        let app = await startReactApp(inspectionScenario().api)
        let id = columnIds()[0]!
        let header = () => column(id).querySelector("header")!
        await openDiffColumn(app, id)

        await app.act(() => dblclick(button(header(), "Maximize column")))
        expect(maximized()).toEqual([])

        await app.act(() => dblclick(header()))
        expect(maximized()).toEqual([id])

        await app.act(() => dblclick(header()))
        expect(maximized()).toEqual([])
    })

    test("a maximized column scrolls into view beside the others, and stays maximized while a tab scrolls to another", async () => {
        let scenario = inspectionScenario()
        scenario.graph.branches[0]!.checkedOut = [{ path: "D:/other", name: "other", head: scenario.graph.branches[0]!.tip, main: false }]
        let app = await startReactApp(scenario.api)
        let opened = columnIds()
        let chosen = column(opened[1]!).getAttribute("aria-label")!
        await openDiffColumn(app, opened[0]!)
        await app.act(() => frame())
        let scrolled: string[] = []
        let original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")!
        // A maximized column scrolls into view with its group, which holds its card.
        Object.defineProperty(Element.prototype, "scrollIntoView", {
            configurable: true,
            value(this: HTMLElement) {
                scrolled.push(this.dataset.columnId ?? this.querySelector<HTMLElement>("[data-column-id]")?.dataset.columnId ?? "")
            },
        })
        let maximizing: string[]
        try {
            await app.act(() => press(button(column(opened[0]!), "Maximize column")))
            await app.act(() => frame())
            maximizing = scrolled.splice(0)
            await app.act(() => press(tab(chosen)))
        } finally {
            Object.defineProperty(Element.prototype, "scrollIntoView", original)
        }

        expect(columnIds()).toEqual(opened)
        expect(maximizing).toEqual([opened[0]])
        expect(scrolled).toEqual([opened[1]])
        expect(maximized()).toEqual([opened[0]])
    })

    test("a tab chosen by pointer scrolls to its column without moving focus, and one chosen by Enter gives the column focus", async () => {
        let scenario = inspectionScenario()
        scenario.graph.branches[0]!.checkedOut = [{ path: "D:/other", name: "other", head: scenario.graph.branches[0]!.tip, main: false }]
        let app = await startReactApp(scenario.api)
        let opened = columnIds()
        let [first, second] = opened.map(id => column(id).getAttribute("aria-label")!)
        let scrolled: string[] = []
        let original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")!
        Object.defineProperty(Element.prototype, "scrollIntoView", {
            configurable: true,
            value(this: HTMLElement) {
                scrolled.push(this.dataset.columnId ?? "")
            },
        })
        let clicked: { scrolled: string[]; focusInColumn: boolean }
        try {
            // The browser focuses the tab after the press; moving focus during it would make React Aria take that
            // focus as programmatic, re-rendering every list that shows focus.
            await app.act(() => press(tab(second!)))
            clicked = { scrolled: scrolled.splice(0), focusInColumn: document.activeElement?.closest("[data-column-id]") != null }
            await app.act(() => {
                tab(first!).focus()
                key(tab(first!), "Enter")
            })
        } finally {
            Object.defineProperty(Element.prototype, "scrollIntoView", original)
        }

        expect(clicked).toEqual({ scrolled: [opened[1]], focusInColumn: false })
        expect(scrolled).toEqual([opened[0]])
        expect(document.activeElement?.getAttribute("data-column-id")).toBe(opened[0])
    })

    test("a column header's buttons show their tooltips, and the header's hint stays away from them", async () => {
        let app = await startReactApp(inspectionScenario().api)
        let header = column(columnIds()[0]!).querySelector("header")!
        let actions = header.querySelector(".column-actions")!
        let filter = button(header, "Filter files")

        // The pointer rests on the header on its way to a button, then moves over the button's tooltip and the gap beside it.
        await app.act(() => hover(header))
        await app.act(() => wait(300))
        await app.act(() => hover(filter, header))
        await app.act(() => wait(1600))
        let overButton = tooltips()
        let tooltip = document.querySelector("[role=tooltip]")!
        await app.act(() => hover(tooltip, filter))
        await app.act(() => wait(300))
        let overItsTooltip = tooltips()
        await app.act(() => hover(actions, tooltip))
        await app.act(() => wait(300))
        let betweenButtons = tooltips()

        expect(overButton).toEqual(["Filter files (Ctrl+F)"])
        expect(overItsTooltip).not.toContain(dragHint)
        expect(betweenButtons).not.toContain(dragHint)
    })

    test("a column header's tooltip shows below its button where the window's controls would cover it", async () => {
        let app = await startReactApp(inspectionScenario().api)
        let filter = button(column(columnIds()[0]!), "Filter files")
        // Happy DOM lays nothing out, so a tooltip is given the place a window gives it above or below its button.
        let restoreLayout = layOutTooltips(placement => placement == "bottom" ? new DOMRect(900, 110, 120, 28) : new DOMRect(900, 30, 120, 28))
        try {
            showWindowControls(new DOMRect(0, 0, 1100, 47))
            await app.act(() => hover(filter))
            await app.act(() => wait(1600))
            let clear = placements()
            await app.act(() => hover(document.body, filter))
            await app.act(() => wait(1000))

            showWindowControls(new DOMRect(0, 0, 940, 47))
            await app.act(() => hover(filter))
            await app.act(() => wait(1600))
            let covered = placements()

            expect(clear).toEqual(["top"])
            expect(covered).toEqual(["bottom"])
        } finally {
            restoreLayout()
            delete (navigator as { windowControlsOverlay?: unknown }).windowControlsOverlay
        }
    })

    test("a column header's hint shows over the header, and its name's own over the name", async () => {
        let app = await startReactApp(inspectionScenario().api)
        let header = column(columnIds()[0]!).querySelector("header")!
        let name = header.querySelector(".column-name")!

        await app.act(() => hover(header))
        await app.act(() => wait(1800))
        let overHeader = tooltips()
        await app.act(() => hover(name, header))
        await app.act(() => wait(300))
        let overName = tooltips()

        expect(overHeader).toEqual([dragHint])
        // The Main Worktree's name can't be renamed, and says why.
        expect(overName).toEqual(["Main worktree"])
    })

    test("worktree columns stay open, collapse in place across restart, and close when their worktree goes", async () => {
        let scenario = inspectionScenario()
        let [main, branch] = [scenario.graph.branches[0]!, scenario.graph.branches[1]!]
        main.checkedOut = [{ path: "D:/other", name: "other", head: main.tip, main: false }]
        let app = await startReactApp(scenario.api)
        expect(columnIds()).toEqual([branch.id, main.id])
        let first = column(branch.id)
        expect(first.querySelector("[aria-label='Close column']") == null).toBe(true)
        expect(divider(branch.id).getAttribute("aria-label")).toBe("Resize branch column")

        await app.act(() => key(divider(branch.id), "ArrowRight"))
        await app.act(() => press(button(first, "Collapse inspection")))
        expect(first.classList.contains("collapsed")).toBe(true)
        expect(first.textContent).toContain("2 changed files")
        expect(savedColumns(scenario.saved()).map(column => column.id)).toEqual([branch.id, main.id])
        expect(savedColumns(scenario.saved())[0]).toMatchObject({ collapsed: true, width: 390 })

        await stopReactApps()
        app = await startReactApp(scenario.api)
        let restored = column(branch.id)
        expect(restored.classList.contains("collapsed")).toBe(true)
        await app.act(() => press(button(restored, "Expand inspection")))
        expect(column(branch.id).classList.contains("collapsed")).toBe(false)
        expect(column(branch.id).style.width).toBe("390px")
        await app.act(() => dblclick(divider(branch.id)))
        expect(column(branch.id).style.width).toBe("380px")
        expect(savedColumns(scenario.saved())[0]).toMatchObject({ width: 380 })

        // The window regaining focus reads the Branch Graph again.
        main.checkedOut = []
        await app.act(() => window.dispatchEvent(new Event("focus")))
        await app.act(() => frame())
        expect(savedColumns(scenario.saved()).map(column => column.id)).toEqual([branch.id])
    })
})

describe("React worktree recovery", () => {
    for (let action of ["restore", "remove"] as const) {
        test(`an interrupted worktree removal has one recovery column, and ${action == "restore" ? "Recover" : "Remove"} resolves it`, async () => {
            let scenario = inspectionScenario()
            let failed = scenario.graph.branches[2]!
            let recovery = {
                operationId: "c290421f-295c-4e27-8934-eeb57e63369c",
                worktreeId: "failed",
                path: "D:/project.worktrees/failed",
                head: failed.tip,
                branchRef: failed.preferredRef,
                message: "Files remain in the worktree directory after its Git registration was removed.",
            }
            let recoveries = [recovery]
            let requests: unknown[] = []
            let saved = scenario.saved()
            saved.repositories[0]!.columns.push({
                kind: "branch",
                id: failed.id,
                ref: failed.preferredRef,
                lastSeenObjectId: failed.tip,
                worktreePath: recovery.path,
                worktreeId: recovery.worktreeId,
                width: 420,
            })
            await scenario.api.updateWorkspace(saved)
            scenario.api.readBranchGraph = async () => ({ ok: true, graph: structuredClone(scenario.graph), worktreeRecoveries: recoveries })
            scenario.api.recoverWorktree = async (_id, request) => {
                requests.push(request)
                recoveries = []
                if (request.action == "restore") {
                    failed.checkedOut = [{
                        id: recovery.worktreeId,
                        path: recovery.path,
                        name: "failed",
                        main: false,
                        head: recovery.head,
                        branchRef: recovery.branchRef,
                    }]
                }
                return { ok: true }
            }
            let app = await startReactApp(scenario.api)
            let recoveryColumn = column(`recovery:${recovery.operationId}`)
            expect(recoveryColumn.style.width).toBe("420px")
            expect(document.querySelectorAll("[aria-label='Worktree recovery']")).toHaveLength(1)
            expect(recoveryColumn.textContent).toContain("Worktree removal interrupted")
            expect(recoveryColumn.textContent).toContain(recovery.path)
            expect(recoveryColumn.textContent).toContain("Remove deletes leftover files and keeps only the saved Git state for Undo.")

            await app.act(() => press(button(recoveryColumn, action == "restore" ? "Recover" : "Remove")))

            expect(requests).toEqual([{ operationId: recovery.operationId, action }])
            expect(document.querySelector("[aria-label='Worktree recovery']") == null).toBe(true)
            let restored = savedColumns(scenario.saved()).find(column => column.id == failed.id)
            if (action == "restore")
                expect(restored).toMatchObject({ width: 420, worktreeId: recovery.worktreeId })
            else
                expect(restored).toBeUndefined()
        })
    }

    test("a failed recovery stays in its column across restart and says why", async () => {
        let scenario = inspectionScenario()
        let recovery = {
            operationId: "c290421f-295c-4e27-8934-eeb57e63369c",
            worktreeId: "failed",
            path: "D:/project.worktrees/failed",
            head: scenario.graph.branches[2]!.tip,
            message: "Files remain in the directory.",
        }
        scenario.api.readBranchGraph = async () => ({ ok: true, graph: structuredClone(scenario.graph), worktreeRecoveries: [recovery] })
        scenario.api.recoverWorktree = async () => ({ ok: false, error: { message: "The directory is locked by another program." } })
        let app = await startReactApp(scenario.api)

        await app.act(() => press(button(document.querySelector("[aria-label='Worktree recovery']")!, "Recover")))

        expect(document.querySelector("[aria-label='Worktree recovery'] [role=alert]")?.textContent).toBe("The directory is locked by another program.")
        expect(savedColumns(scenario.saved()).some(column => column.id == `recovery:${recovery.operationId}`)).toBe(true)
        await stopReactApps()
        await startReactApp(scenario.api)
        expect(document.querySelectorAll("[aria-label='Worktree recovery']")).toHaveLength(1)
        expect(button(document.querySelector("[aria-label='Worktree recovery']")!, "Remove")).toBeDefined()
    })
})

function columnIds() {
    return [...document.querySelectorAll<HTMLElement>("[data-column-id]")].map(element => element.dataset.columnId!)
}

function column(id: string) {
    return [...document.querySelectorAll<HTMLElement>("[data-column-id]")].find(element => element.dataset.columnId == id)!
}

function divider(id: string) {
    return column(id).nextElementSibling as HTMLElement
}

function columnHeaders() {
    return [...document.querySelectorAll("[data-column-id] > header")].map(header => header.textContent).join(" ")
}

let dragHint = "Drag to reorder · Ctrl+Shift+< / >"

function wait(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function tooltips() {
    return [...document.querySelectorAll("[role=tooltip]")].map(tooltip => tooltip.textContent)
}

function placements() {
    return [...document.querySelectorAll<HTMLElement>("[role=tooltip]")].map(tooltip => tooltip.dataset.placement)
}

/** Places each tooltip where `place` puts it for its placement. */
function layOutTooltips(place: (placement?: string) => DOMRect) {
    let original = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
        configurable: true,
        value(this: Element) {
            return this instanceof HTMLElement && this.classList.contains("react-aria-Tooltip")
                ? place(this.dataset.placement)
                : original.value.call(this)
        },
    })
    return () => Object.defineProperty(Element.prototype, "getBoundingClientRect", original)
}

/** The window's controls, beside the title bar area they leave the page. */
function showWindowControls(titlebarArea: DOMRect) {
    Object.defineProperty(navigator, "windowControlsOverlay", { configurable: true, value: { visible: true, getTitlebarAreaRect: () => titlebarArea } })
}

function tabs() {
    return [...document.querySelectorAll("[aria-label='Open columns'] [role=tab]")].map(tab =>
        tab.textContent + (tab.getAttribute("aria-selected") == "true" ? " *" : "")
    )
}

function tab(name: string) {
    return [...document.querySelectorAll<HTMLElement>("[aria-label='Open columns'] [role=tab]")].find(tab => tab.textContent == name)!
}

/** Opens the column's first Working Changes file in its diff column. */
async function openDiffColumn(app: { act(action: () => unknown): Promise<void> }, id: string) {
    let row = column(id).querySelector<HTMLElement>("[data-group^='working-'] .file-row")!
    await app.act(() => press(button(row, `Open ${row.getAttribute("aria-label")} in diff column`)))
}

/** The columns offering to restore their width, which only a maximized one does. */
function maximized() {
    return columnIds().filter(id => column(id).querySelector("[aria-label='Restore column']") != null)
}

function savedColumns(workspace: Workspace) {
    let repository = workspace.repositories[0]!
    return repository.columns
}

function key(target: Element, key: string, modifiers: KeyboardEventInit = {}) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }))
}

function dblclick(target: Element) {
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))
}

// Lets an animation frame, such as focusing a moved column, run.
function frame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve(undefined)))
}
