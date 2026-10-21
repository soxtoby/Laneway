import type { BranchGraph } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps, submit, type } from "./react-dom"
import { appState, branchGraph, fakeLaneway, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow
let restoreSizes: () => void

beforeAll(() => {
    browserWindow = installReactDom()
    restoreSizes = sizeGraphRows(400)
})

afterEach(stopReactApps)

afterAll(() => {
    restoreSizes()
    browserWindow.close()
})

describe("React Branch Graph", () => {
    test("selects rows apart from opening them, shows every branch on request, and folds a branch's stack", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-project")
        let graph = branchGraph(repository.id)
        let [main, feature, team] = graph.branches
        // The engine only adds someone else's remote-only branch when every branch is asked for.
        let remoteOnly = {
            ...team!,
            id: "branch:refs/remotes/origin/other/remote",
            name: "origin/other/remote",
            preferredRef: "refs/remotes/origin/other/remote",
            refs: ["refs/remotes/origin/other/remote"],
            aliases: ["origin/other/remote"],
            localRefs: [],
            remoteRefs: ["refs/remotes/origin/other/remote"],
            tip: "4".repeat(40),
            remoteOnly: true,
        }
        let everything: BranchGraph = {
            ...graph,
            branches: [...graph.branches, remoteOnly],
            history: [{ objectId: remoteOnly.tip, lineId: remoteOnly.id, parentIds: [main!.tip] }, ...graph.history],
        }
        let reads: boolean[] = []
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async (_repositoryId, _refreshRemote, allBranches) => {
                reads.push(allBranches == true)
                return { ok: true, graph: allBranches ? everything : graph }
            },
        }))
        expect(panel() == null).toBe(true)

        await app.act(() => press(button(document.body, "Show Branch Graph")))
        expect(names()).toEqual(["feature/laneway", "other/team", "main"])
        expect(panel()!.querySelector(".graph-row svg path")).not.toBeNull()
        await app.act(() => press(button(panel()!, "Show all")))
        expect(reads.at(-1)).toBe(true)
        expect(names()).toContain("origin/other/remote")
        expect(button(panel()!, "Show relevant").getAttribute("aria-pressed")).toBe("true")

        // Choosing a row only selects it; its Open button opens its column.
        await app.act(() => press(row(feature!.id).querySelector<HTMLElement>(".graph-name")!))
        expect(row(feature!.id).hasAttribute("data-selected")).toBe(true)
        expect(columnNames()).toEqual([])
        await app.act(() => press(button(row(feature!.id), "Open")))
        expect(columnNames()).toEqual(["feature/laneway"])

        // Left folds the selected branch's stack, hiding the branches built on it; Right unfolds it.
        await app.act(() => press(row(main!.id).querySelector<HTMLElement>(".graph-name")!))
        await app.act(() => key(rows(), "ArrowLeft"))
        expect(names()).not.toContain("feature/laneway")
        await app.act(() => key(rows(), "ArrowRight"))
        expect(names()).toContain("feature/laneway")

        // Choosing the repository already shown hides its Branch Graph.
        await app.act(() => press(document.querySelector<HTMLElement>(".repository-row")!))
        expect(panel() == null).toBe(true)
    })

    test("Enter opens the selected branch, its menu acts on it and copies its name, and F2 renames it", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-project")
        let graph = branchGraph(repository.id)
        let feature = graph.branches[1]!
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        }))
        await app.act(() => press(button(document.body, "Show Branch Graph")))
        await app.act(() => press(row(feature.id).querySelector<HTMLElement>(".graph-name")!))

        await app.act(() => key(row(feature.id), "Enter"))
        expect(columnNames()).toEqual(["feature/laneway"])
        await app.act(() =>
            row(feature.id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }))
        )
        expect([...document.querySelectorAll("[role=menu] [role=menuitem]")].map(item => item.textContent)).toEqual([
            "Rebase onto…",
            "Create branch here…",
            "Rename branch…",
            "Delete branch",
            "Copy branch name",
        ])
        await app.act(() => press([...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].at(-1)!))
        expect(await navigator.clipboard.readText()).toBe("feature/laneway")

        await app.act(() => key(row(feature.id), "F2"))
        expect(document.querySelector("[role=dialog]")?.textContent).toContain("Rename")
    })

    test("settings apply patterns on Enter, close on Escape, and offer no remote choice for a single remote", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-settings")
        let graph = branchGraph(repository.id)
        let applied: unknown[] = []
        let reads = 0
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => {
                reads++
                return { ok: true, graph }
            },
            setRepositoryGraphSettings: async (_id, settings) => {
                applied.push(settings)
                return settings
            },
        }))
        await app.act(() => press(button(document.body, "Show Branch Graph")))
        let toggle = button(panel()!, "Branch Graph settings")

        await app.act(() => press(toggle))
        let dialog = settings()!
        expect(toggle.getAttribute("aria-expanded")).toBe("true")
        expect(dialog.querySelector("h2")?.textContent).toBe("Branch Graph settings")
        expect(dialog.querySelector("[role=radiogroup]") == null).toBe(true)
        let before = reads
        await app.act(() => type(patterns()!, "origin/release/**, upstream/topic/*"))
        // Enter submits the form in a browser; Happy DOM doesn't, so the form submits as Enter would.
        await app.act(() => submit(settings()!.querySelector("form")!))
        expect(applied).toEqual([{ selectedRemote: "origin", remotePatterns: ["origin/release/**", "upstream/topic/*"] }])
        expect(reads).toBeGreaterThan(before)
        expect(settings() == null).toBe(true)

        await app.act(() => press(toggle))
        await app.act(() => key(patterns()!, "Escape"))
        expect(settings() == null).toBe(true)
    })

    test("settings choose among several remotes, and keep a typed draft across quiet refreshes", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-settings-draft")
        let graph: BranchGraph = { ...branchGraph(repository.id), availableRemotes: ["origin", "upstream"] }
        let applied: unknown[] = []
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph: structuredClone(graph) }),
            setRepositoryGraphSettings: async (_id, settings) => {
                applied.push(settings)
                graph = { ...graph, selectedRemote: settings.selectedRemote, remotePatterns: settings.remotePatterns }
                return settings
            },
        }))
        await app.act(() => press(button(document.body, "Show Branch Graph")))
        await app.act(() => press(button(panel()!, "Branch Graph settings")))

        await app.act(() => type(patterns()!, "origin/releases/**"))
        await app.act(() => app.controller.columns.refresh())
        expect(patterns()!.value).toBe("origin/releases/**")
        let upstream = [...settings()!.querySelectorAll<HTMLElement>("[role=radio], label")].find(option => option.textContent == "upstream")!
        await app.act(() => press(upstream))
        expect(applied).toEqual([{ selectedRemote: "upstream", remotePatterns: ["origin/releases/**"] }])
        await app.act(() => press(button(panel()!, "Branch Graph settings")))
        expect(patterns()!.value).toBe("origin/releases/**")
    })

    test("a quiet refresh leaves the panel's toolbar and rows still while it reads", async () => {
        let repository = repositoryInfo("D:\Source\refresh-graph")
        let graph = branchGraph(repository.id)
        let reads = 0
        let finish = () => {}
        let pending = new Promise<void>(resolve => finish = resolve)
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => {
                reads++
                if (reads > 2)
                    await pending
                return { ok: true, graph }
            },
        }))
        await app.act(() => press(button(document.body, "Show Branch Graph")))
        let toolbar = panel()!.querySelector<HTMLElement>(".graph-toolbar")!
        let before = toolbar.innerHTML
        let shown = names()

        // The refresh waits on its read, so it starts here and finishes below.
        await app.act(() => {
            void app.controller.columns.refresh()
        })
        expect(reads).toBe(3)
        expect(panel()!.querySelector("[role=status]") == null).toBe(true)
        expect(toolbar.innerHTML).toBe(before)
        await app.act(() => finish())
        expect(toolbar.innerHTML).toBe(before)
        expect(names()).toEqual(shown)
    })

    test("draws only the rows near the viewport of a large graph", async () => {
        let repository = repositoryInfo("D:\\Source\\large-graph")
        let graph = branchGraph(repository.id)
        let template = graph.branches[1]!
        graph.branches = [
            graph.branches[0]!,
            ...Array.from({ length: 120 }, (_, index) => ({
                ...template,
                id: `branch:refs/heads/feature/${index}`,
                name: `feature/${index}`,
                preferredRef: `refs/heads/feature/${index}`,
                refs: [`refs/heads/feature/${index}`],
                aliases: [`feature/${index}`],
                localRefs: [`refs/heads/feature/${index}`],
                tip: index.toString(16).padStart(40, "0"),
            })),
        ]
        graph.history = [...graph.branches.slice(1).map(branch => ({ objectId: branch.tip, lineId: branch.id, parentIds: [graph.branches[0]!.tip] })), {
            objectId: graph.branches[0]!.tip,
            lineId: graph.branches[0]!.id,
            parentIds: [],
        }]
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        }))
        await app.act(() => press(button(document.body, "Show Branch Graph")))

        expect(panel()!.querySelectorAll(".graph-row").length).toBeLessThan(30)
        expect(panel()!.querySelector(".graph-summary")?.textContent).toContain("121 branches")
        rows().scrollTop = 1600
        await app.act(() => rows().dispatchEvent(new Event("scroll", { bubbles: true })))
        expect(panel()!.querySelectorAll(".graph-row").length).toBeLessThan(30)
        expect(names()).toContain("feature/45")
        expect(panel()!.querySelector(".graph-row svg path[d='M 13 0 V 40']")).not.toBeNull()
    })
})

// Happy DOM lays nothing out, so the graph's scroller is given a size for the virtualizer to fill.
function sizeGraphRows(height: number) {
    let sized = (element: HTMLElement, value: number, fallback: PropertyDescriptor | undefined) =>
        element.classList?.contains("graph-rows") ? value : fallback?.get?.call(element) ?? 0
    let descriptors = Object.fromEntries(
        ["clientHeight", "offsetHeight", "clientWidth", "offsetWidth"].map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
    )
    for (let name of Object.keys(descriptors)) {
        Object.defineProperty(HTMLElement.prototype, name, {
            configurable: true,
            get() {
                return sized(this, name.endsWith("Height") ? height : 300, descriptors[name])
            },
        })
    }
    return () => {
        for (let [name, descriptor] of Object.entries(descriptors)) {
            if (descriptor)
                Object.defineProperty(HTMLElement.prototype, name, descriptor)
        }
    }
}

function settings() {
    return document.querySelector<HTMLElement>(".graph-settings")
}

function patterns() {
    return settings()?.querySelector<HTMLInputElement>("input[type=text], input:not([type])")
}

function panel() {
    return document.querySelector<HTMLElement>(".graph-panel")
}

function rows() {
    return panel()!.querySelector<HTMLElement>(".graph-rows")!
}

function row(id: string) {
    let found = [...panel()!.querySelectorAll<HTMLElement>(".graph-row")].find(element => element.dataset.nodeId == id)
    if (!found)
        throw new Error(`No row for ${id} in: ${names().join(", ")}`)
    return found
}

function names() {
    return [...panel()!.querySelectorAll(".graph-row .graph-name")].map(name => name.textContent)
}

function columnNames() {
    return [...document.querySelectorAll(".column-row > .column")].map(column => column.getAttribute("aria-label"))
}

// React Aria completes a keyboard press on its keyup.
function key(element: HTMLElement, name: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
    element.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true, cancelable: true }))
}
