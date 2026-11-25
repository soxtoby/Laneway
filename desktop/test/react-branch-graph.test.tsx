import type { BranchGraph, LocalRequest, WorktreeRequest } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps, submit, type } from "./react-dom"
import { appState, branchGraph, fakeLaneway, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow
let restoreSizes: () => void

type ReactApp = Awaited<ReturnType<typeof startReactApp>>

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

    test("a double-click or Enter opens a branch column, its menu checks it out, and F2 renames it", async () => {
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

        await app.act(() => press(row(feature!.id).querySelector<HTMLElement>(".graph-name")!))
        await app.act(() => doubleClick(button(row(feature!.id), "Actions for feature/laneway")))
        await app.act(() => key(document.querySelector<HTMLElement>("[role=menu]")!, "Escape"))
        expect(columnNames()).not.toContain(feature!.name)

        await app.act(() => doubleClick(row(feature!.id).querySelector<HTMLElement>(".graph-name")!))
        expect(columnNames()).toContain(feature!.name)
        expect(executions).toEqual([])

        await app.act(() => press(row(team!.id).querySelector<HTMLElement>(".graph-name")!))
        await app.act(() => key(row(team!.id), "Enter"))
        expect(app.controller.columns.snapshot().focusedId).toBe(team!.id)
        await app.act(() => key(row(feature!.id), "Enter"))
        expect(app.controller.columns.snapshot().focusedId).toBe(feature!.id)
        expect(executions).toEqual([])

        await app.act(() => rightClick(row(feature!.id)))
        expect(menuLabels()).toEqual([
            "Check out",
            "Check out in",
            "Open column",
            "Compare with…",
            "Rebase onto…",
            "Move commits into main",
            "Create branch here…",
            "Create tag here…",
            "Rename branch…",
            "Delete branch",
            "Copy branch name",
        ])
        await app.act(() => press(menuItem("Check out")))
        expect(executions).toEqual([checkedOut(repository.root)])
        expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Checked out feature/laneway in graph-project.")
        await app.act(() => rightClick(row(feature!.id)))
        await app.act(() => press(menuItem("Check out in")))
        expect(menuLabels(submenu())).toEqual(["main · graph-project", "other/team · team", "New worktree"])
        await app.act(() => press(menuItem("other/team · team", submenu())))
        expect(executions.at(-1)).toEqual(checkedOut(linked.path))
        expect(document.querySelector("[role=menu]") == null).toBe(true)

        // A branch already checked out doesn't check out again, and the worktree holding it shows without acting.
        await app.act(() => rightClick(row(team!.id)))
        expect(menuItem("Check out").getAttribute("aria-disabled")).toBe("true")
        await app.act(() => press(menuItem("Check out in")))
        expect(menuItem("other/team · team", submenu()).getAttribute("aria-disabled")).toBe("true")

        await app.act(() => rightClick(row(feature!.id)))
        await app.act(() => press(menuItem("Copy branch name")))
        expect(await navigator.clipboard.readText()).toBe("feature/laneway")

        await app.act(() => key(row(feature!.id), "F2"))
        expect(document.querySelector("[role=dialog]")?.textContent).toContain("Rename")
    })

    test("a remote-only branch checks out detached in the main, chosen, or new worktree", async () => {
        let repository = repositoryInfo("D:\\Source\\remote-checkout")
        let graph: BranchGraph = branchGraph(repository.id)
        let [main, feature, remote] = graph.branches
        let remoteRef = "refs/remotes/origin/team"
        Object.assign(remote!, {
            id: `branch:${remoteRef}`,
            name: "origin/team",
            preferredRef: remoteRef,
            refs: [remoteRef],
            remoteRefs: [remoteRef],
            localRefs: [],
            remoteOnly: true,
        })
        graph.history.find(point => point.objectId == remote!.tip)!.lineId = remote!.id
        let linkedPath = repository.root + ".worktrees/feature"
        main!.checkedOut = [{ id: "main", path: repository.root, name: "main-tree", head: main!.tip, branchRef: main!.preferredRef, main: true }]
        feature!.checkedOut = [{ id: "feature", path: linkedPath, name: "feature-tree", head: feature!.tip, branchRef: feature!.preferredRef, main: false }]
        let createdPath = repository.root + ".worktrees/detached"
        let requests: WorktreeRequest[] = []
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph: structuredClone(graph) }),
            executeWorktree: async (_id, request) => {
                requests.push(request)
                if (request.action == "create") {
                    let worktree = { id: "detached", path: createdPath, name: "detached", head: remote!.tip, main: false }
                    graph.virtualBranches.push({ id: "virtual:detached", kind: "virtual", name: worktree.name, worktree, objectId: remote!.tip, tooltip: "" })
                    return { ok: true, createdPath }
                }
                return { ok: true }
            },
        }))
        await app.act(() => press(button(document.body, "Show Branch Graph")))
        let open = () => app.act(() => rightClick(row(remote!.id)))
        await open()
        await app.act(() => press(menuItem("Check out detached")))
        expect(requests.at(-1)).toEqual({ action: "switch", path: repository.root, commit: remote!.tip, move: false })

        await open()
        await app.act(() => press(menuItem("Check out detached in")))
        await app.act(() => press(menuItem("feature/laneway · feature-tree", submenu())))
        expect(requests.at(-1)).toEqual({ action: "switch", path: linkedPath, commit: remote!.tip, move: false })

        await open()
        await app.act(() => press(menuItem("Check out detached in")))
        await app.act(() => press(menuItem("New worktree", submenu())))

        expect(requests.at(-1)).toEqual({ action: "create", commit: remote!.tip, move: false })
        expect(app.controller.columns.snapshot().focusedId).toBe("virtual:detached")
        let toast = document.querySelector<HTMLElement>("[role=alertdialog]")!
        expect(toast.querySelector("[slot=title]")?.textContent).toBe("Checked out “origin/team” in a new worktree (detached).")
        expect(button(toast, "Undo").hasAttribute("disabled")).toBe(false)
    })

    test("Create branch here checks the new branch out in the Main Worktree by default, as one operation with Undo", async () => {
        let { repository, main, app, worktreeRequests } = await startBranchCreation("create-checkout")
        let dialog = await openBranchCreation(app, main.id)
        expect(checkoutSelect(dialog).querySelector(".react-aria-SelectValue [slot=label]")?.textContent).toBe("main · main-tree")

        await submitBranch(app, dialog, "topic")

        expect(worktreeRequests).toEqual([{ action: "switch", path: repository.root, commit: main.tip, newBranch: "topic", move: false }])
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        expect(app.controller.columns.snapshot().focusedId).toBe("branch:refs/heads/topic")
        let toast = document.querySelector<HTMLElement>("[role=alertdialog]")!
        expect(toast.querySelector("[slot=title]")?.textContent).toBe("Checked out new branch topic in create-checkout.")
        expect(button(toast, "Undo").hasAttribute("disabled")).toBe(false)
    })

    test("Create branch here checks the new branch out in a chosen worktree, a new one, or none", async () => {
        let { main, linkedPath, app, worktreeRequests, localRequests } = await startBranchCreation("create-choices")
        let dialog = await openBranchCreation(app, main.id)
        await app.act(() => press(checkoutSelect(dialog)))
        expect(optionLabels()).toEqual(["main · main-tree", "feature/laneway · feature-tree", "New worktree", "Don't check out"])

        await app.act(() => press(option("feature/laneway · feature-tree")))
        await submitBranch(app, dialog, "in-linked")
        await createBranch(app, main.id, "in-new", "New worktree")
        await createBranch(app, main.id, "unchecked", "Don't check out")

        let atMain = { commit: main.tip, move: false }
        expect(worktreeRequests).toEqual([{ action: "switch", path: linkedPath, newBranch: "in-linked", ...atMain }, {
            action: "create",
            newBranch: "in-new",
            ...atMain,
        }])
        expect(localRequests).toEqual([{ action: "branch-create", name: "unchecked", commit: main.tip }])
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
        expect(menuItems().map(item => item.textContent)).toEqual(["Compare with…", "Copy tag name"])
        await app.act(() => press(menuItem("Copy tag name")))
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

/** Shows the Branch Graph of a repository whose Main Worktree has main and a linked worktree feature/laneway, recording what creating a branch asks for. */
async function startBranchCreation(directory: string) {
    let repository = repositoryInfo(`D:\\Source\\${directory}`)
    let graph: BranchGraph = branchGraph(repository.id)
    let main = graph.branches[0]!
    let feature = graph.branches[1]!
    let linkedPath = repository.root + ".worktrees/feature"
    main.checkedOut = [{ id: "main", path: repository.root, name: "main-tree", head: main.tip, branchRef: main.preferredRef, main: true }]
    feature.checkedOut = [{ id: "feature", path: linkedPath, name: "feature-tree", head: feature.tip, branchRef: feature.preferredRef, main: false }]
    let worktreeRequests: WorktreeRequest[] = []
    let localRequests: LocalRequest[] = []
    let base = fakeLaneway()
    let app = await startReactApp(fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph: structuredClone(graph) }),
        executeWorktree: async (_id, request) => {
            worktreeRequests.push(request)
            if ((request.action == "switch" || request.action == "create") && request.newBranch) {
                let ref = `refs/heads/${request.newBranch}`
                let names = { id: `branch:${ref}`, name: request.newBranch, preferredRef: ref, refs: [ref], aliases: [request.newBranch], localRefs: [ref] }
                graph.branches.push({ ...structuredClone(feature), ...names, checkedOut: [] })
            }
            return { ok: true }
        },
        localOperation: async (id, request, token) => {
            if (!token)
                return base.localOperation(id, request)
            localRequests.push(request)
            return { ok: true, result: { type: "result", command: "local", status: "performed" } }
        },
    }))
    await app.act(() => press(button(document.body, "Show Branch Graph")))
    return { repository, main, linkedPath, app, worktreeRequests, localRequests }
}

/** Creates a branch at a Branch Node's tip from its menu, checked out where the `checkout` option says. */
async function createBranch(app: ReactApp, id: string, name: string, checkout: string) {
    let dialog = await openBranchCreation(app, id)
    await app.act(() => press(checkoutSelect(dialog)))
    await app.act(() => press(option(checkout)))
    await submitBranch(app, dialog, name)
}

async function openBranchCreation(app: ReactApp, id: string) {
    await app.act(() => rightClick(row(id)))
    await app.act(() => press(menuItem("Create branch here…")))
    return document.querySelector<HTMLElement>("[role=dialog]")!
}

function checkoutSelect(dialog: HTMLElement) {
    return dialog.querySelector<HTMLElement>(".react-aria-Select button")!
}

async function submitBranch(app: ReactApp, dialog: HTMLElement, name: string) {
    await app.act(() => type(dialog.querySelector<HTMLInputElement>("input")!, name))
    await app.act(() => press(button(dialog, "Create branch")))
}

function options() {
    return [...document.querySelectorAll<HTMLElement>("[role=listbox] [role=option]")]
}

/** The open list box's option with a label, which its description doesn't take part in. */
function option(label: string) {
    let item = options().find(item => item.querySelector("[slot=label]")?.textContent == label)
    if (!item)
        throw new Error(`No ${label} option in: ${optionLabels().join(", ")}`)
    return item
}

function optionLabels() {
    return options().map(item => item.querySelector("[slot=label]")?.textContent)
}

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
