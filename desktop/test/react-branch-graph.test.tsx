import type { BranchGraph, WorktreeRequest } from "@laneway/shared"
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

        // Choosing a row only selects it; the menu button it shows opens its column.
        await app.act(() => press(row(feature!.id).querySelector<HTMLElement>(".graph-name")!))
        expect(row(feature!.id).hasAttribute("data-selected")).toBe(true)
        expect(columnNames()).toEqual([])
        expect([...row(feature!.id).querySelectorAll("button")].map(control => control.getAttribute("aria-label"))).toEqual([
            "Drag feature/laneway",
            "Actions for feature/laneway",
        ])
        await app.act(() => press(button(row(feature!.id), "Actions for feature/laneway")))
        await app.act(() => press(menuItem("Open column")))
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

    test("a double-click or Enter checks a branch out in the Main Worktree, its menu checks it out in another, and F2 renames it", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-project")
        let graph: BranchGraph = branchGraph(repository.id)
        let [main, feature, team] = graph.branches
        main!.checkedOut = [{ id: "main", path: repository.root, name: "graph-project", head: main!.tip, branchRef: main!.preferredRef, main: true }]
        let linked = {
            id: "team",
            path: "D:\\Source\\graph-project.worktrees\\team",
            name: "team",
            head: team!.tip,
            branchRef: team!.preferredRef,
            main: false,
        }
        team!.checkedOut = [linked]
        let executions: { request: WorktreeRequest; token?: string }[] = []
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
            executeWorktree: async (_id, request, token) => {
                executions.push({ request, token })
                return { ok: true }
            },
        }))
        await app.act(() => press(button(document.body, "Show Branch Graph")))
        let checkedOut = (path: string) => ({ request: { action: "switch" as const, path, branch: feature!.preferredRef, move: true }, token: undefined })

        // A double-click on a row's button is the button's; on the row, it checks out at once and offers Undo.
        await app.act(() => press(row(feature!.id).querySelector<HTMLElement>(".graph-name")!))
        await app.act(() => doubleClick(button(row(feature!.id), "Actions for feature/laneway")))
        await app.act(() => key(document.querySelector<HTMLElement>("[role=menu]")!, "Escape"))
        expect(executions).toEqual([])
        await app.act(() => doubleClick(row(feature!.id).querySelector<HTMLElement>(".graph-name")!))
        expect(executions).toEqual([checkedOut(repository.root)])
        expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Checked out feature/laneway in graph-project.")
        await app.act(() => key(row(feature!.id), "Enter"))
        expect(executions).toEqual([checkedOut(repository.root), checkedOut(repository.root)])

        // A branch already checked out brings its worktree's column forward instead.
        await app.act(() => press(row(team!.id).querySelector<HTMLElement>(".graph-name")!))
        await app.act(() => key(row(team!.id), "Enter"))
        expect(executions).toHaveLength(2)
        expect(app.controller.columns.snapshot().focusedId).toBe(team!.id)

        await app.act(() => rightClick(row(feature!.id)))
        expect(menuLabels()).toEqual([
            "Check out",
            "Check out in",
            "Open column",
            "Rebase onto…",
            "Create branch here…",
            "Rename branch…",
            "Delete branch",
            "Copy branch name",
        ])
        // Check out does as a double-click does; the chevron beside it, Check out in, chooses the worktree.
        await app.act(() => press(menuItem("Check out")))
        expect(executions.at(-1)).toEqual(checkedOut(repository.root))
        expect(executions).toHaveLength(3)
        await app.act(() => rightClick(row(feature!.id)))
        await app.act(() => press(menuItem("Check out in")))
        expect(menuLabels(submenu())).toEqual(["graph-project · main", "team · other/team", "New worktree"])
        await app.act(() => press(menuItem("team · other/team", submenu())))
        expect(executions.at(-1)).toEqual(checkedOut(linked.path))
        expect(document.querySelector("[role=menu]") == null).toBe(true)

        // A branch already checked out doesn't check out again, and the worktree holding it shows without acting.
        await app.act(() => rightClick(row(team!.id)))
        expect(menuItem("Check out").getAttribute("aria-disabled")).toBe("true")
        await app.act(() => press(menuItem("Check out in")))
        expect(menuItem("team · other/team", submenu()).getAttribute("aria-disabled")).toBe("true")

        await app.act(() => rightClick(row(feature!.id)))
        await app.act(() => press(menuItem("Copy branch name")))
        expect(await navigator.clipboard.readText()).toBe("feature/laneway")

        await app.act(() => key(row(feature!.id), "F2"))
        expect(document.querySelector("[role=dialog]")?.textContent).toContain("Rename")
    })

    test("a tag's name copies from its Tag Node's menu, or from the menu of the Branch Node it sits on", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-tags")
        let graph = branchGraph(repository.id)
        let [main, feature, team] = graph.branches
        let tagged = "5".repeat(40)
        let tag = { kind: "tag" as const, id: "tag:refs/tags/v1.0", name: "v1.0", objectId: tagged, parentBranchId: main!.id, tooltip: "Tag v1.0" }
        let tags: BranchGraph = {
            ...graph,
            branches: [main!, { ...feature!, tags: ["v2.0"] }, team!],
            history: [...graph.history.map(point => point.objectId == main!.tip ? { ...point, parentIds: [tagged] } : point), {
                objectId: tagged,
                lineId: main!.id,
                parentIds: [],
            }],
            tags: [tag],
        }
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph: tags }),
        }))
        await app.act(() => press(button(document.body, "Show Branch Graph")))

        await app.act(() => rightClick(row(tag.id)))
        expect(menuItems().map(item => item.textContent)).toEqual(["Copy tag name"])
        await app.act(() => press(menuItems()[0]!))
        expect(await navigator.clipboard.readText()).toBe("v1.0")

        await app.act(() => rightClick(row(feature!.id)))
        await app.act(() => press(menuItems().find(item => item.textContent == "Copy tag v2.0")!))
        expect(await navigator.clipboard.readText()).toBe("v2.0")
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

    test("resizes by keyboard up to half the work area, and keeps its width for the next start", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-project")
        let saved: number | undefined
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository), graphWidth: saved }),
            readBranchGraph: async () => ({ ok: true, graph: branchGraph(repository.id) }),
            setGraphWidth: async width => saved = width,
        })
        let app = await startReactApp(api)
        await app.act(() => press(button(document.body, "Show Branch Graph")))
        layOutWorkArea(1001)
        expect(panel()!.style.width).toBe("380px")

        await app.act(() => key(graphDivider(), "ArrowRight"))
        expect(panel()!.style.width).toBe("390px")
        await app.act(() => key(graphDivider(), "End"))
        expect(panel()!.style.width).toBe("500px")
        expect(saved).toBe(500)

        // In a narrower window it shows at half the work area, and resizes from there.
        await stopReactApps()
        app = await startReactApp(api)
        await app.act(() => press(button(document.body, "Show Branch Graph")))
        layOutWorkArea(800)
        expect(panel()!.style.width).toBe("500px")
        await app.act(() => key(graphDivider(), "ArrowLeft"))
        expect(panel()!.style.width).toBe("390px")

        await app.act(() => graphDivider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })))
        expect(panel()!.style.width).toBe("380px")
        expect(saved).toBe(380)
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

function graphDivider() {
    return panel()!.nextElementSibling as HTMLElement
}

// Happy DOM lays nothing out, so the work area the graph's divider measures is given a width.
function layOutWorkArea(width: number) {
    Object.defineProperty(panel()!.parentElement, "clientWidth", { configurable: true, value: width })
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

function doubleClick(element: HTMLElement) {
    press(element)
    press(element)
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }))
}

function rightClick(element: HTMLElement) {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }))
}

function menuItems(menu?: Element) {
    return [...(menu ?? document.querySelector("[role=menu]")!).querySelectorAll<HTMLElement>("[role=menuitem]")]
}

function menuItem(label: string, menu?: Element) {
    let item = menuItems(menu).find(item => itemName(item) == label)
    if (!item)
        throw new Error(`No ${label} menu item in: ${menuLabels(menu).join(", ")}`)
    return item
}

/** Each menu item's label, without its description. */
function menuLabels(menu?: Element) {
    return menuItems(menu).map(itemName)
}

/** A menu item's label, or the name of one that shows only an icon. */
function itemName(item: Element) {
    return item.getAttribute("aria-label") ?? (item.querySelector("[slot=label]") ?? item).textContent
}

/** The open submenu, which shows after the menu it comes from. */
function submenu() {
    return [...document.querySelectorAll<HTMLElement>("[role=menu]")].at(-1)!
}

function columnNames() {
    return [...document.querySelectorAll(".column-row .column")].map(column => column.getAttribute("aria-label"))
}

// React Aria completes a keyboard press on its keyup.
function key(element: HTMLElement, name: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
    element.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true, cancelable: true }))
}
