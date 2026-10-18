import type { Workspace } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps } from "./react-dom"
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

        await app.act(() => key(button(column(main.id), "Maximize column"), ">", { ctrlKey: true, shiftKey: true }))
        await app.act(() => frame())
        expect(savedColumns(saved).map(column => column.id)).toEqual([feature.id, main.id])
        expect(document.activeElement?.getAttribute("data-column-id")).toBe(main.id)

        await app.act(() => key(divider(main.id), "ArrowRight"))
        expect(savedColumns(saved).find(column => column.id == main.id)?.width).toBe(390)
    })

    test("double-clicking a column header toggles maximizing it, but not on its controls", async () => {
        let scenario = inspectionScenario()
        scenario.graph.branches[0]!.checkedOut = [{ path: "D:/other", name: "other", head: scenario.graph.branches[0]!.tip, main: false }]
        let app = await startReactApp(scenario.api)
        let opened = columnIds()
        expect(opened.length).toBeGreaterThan(1)
        let header = () => column(opened[1]!).querySelector("header")!

        await app.act(() => dblclick(button(header(), "Maximize column")))
        expect(columnIds()).toEqual(opened)

        await app.act(() => dblclick(header()))
        expect(columnIds()).toEqual([opened[1]])

        await app.act(() => dblclick(header()))
        expect(columnIds()).toEqual(opened)
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

            await app.act(() => press(button(recoveryColumn, "Maximize column")))
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

function tabs() {
    return [...document.querySelectorAll("[aria-label='Open columns'] [role=tab]")].map(tab =>
        tab.textContent + (tab.getAttribute("aria-selected") == "true" ? " *" : "")
    )
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
