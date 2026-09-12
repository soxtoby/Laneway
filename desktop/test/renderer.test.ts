import type { ChangesResult, EntryProgress, EntryResult, FileDiffResult } from "@git-workbench/shared"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Window as HappyWindow } from "happy-dom"
import type { createElement as createRemixElement, createRoot as createRemixRoot, VirtualRoot } from "remix/ui"
import type { WorkbenchApp as WorkbenchAppComponent } from "../src/renderer/src/app"
import { appState, branchGraph, fakeWorkbench, inspectionScenario, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow
let createElement: typeof createRemixElement
let createRoot: typeof createRemixRoot
let WorkbenchApp: typeof WorkbenchAppComponent

beforeAll(async () => {
    browserWindow = new HappyWindow({ url: "file:///renderer/index.html" })
    const browserGlobal = browserWindow as unknown as Record<string, unknown>
    const globals = [
        "window",
        "document",
        "Node",
        "Element",
        "HTMLElement",
        "HTMLDialogElement",
        "HTMLInputElement",
        "HTMLFormElement",
        "Comment",
        "Text",
        "Event",
        "CustomEvent",
        "ErrorEvent",
        "CSSStyleSheet",
        "EventTarget",
        "MouseEvent",
        "KeyboardEvent",
        "SubmitEvent",
        "customElements",
        "ResizeObserver",
        "IntersectionObserver",
        "MutationObserver",
        "HTMLPreElement",
        "Document",
        "SVGElement",
    ]
    browserGlobal.window = browserWindow
    browserGlobal.document = browserWindow.document
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browserWindow.requestAnimationFrame.bind(browserWindow) })
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browserWindow.cancelAnimationFrame.bind(browserWindow) })
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: browserWindow.getComputedStyle.bind(browserWindow) })
    for (const name of globals)
        Object.defineProperty(globalThis, name, { configurable: true, value: browserGlobal[name] })
    // Happy DOM does not parse CSS layers. These tests exercise DOM behavior;
    // renderer-styles.test.ts checks the real stylesheet cascade in Electron.
    Object.defineProperty(globalThis, "CSSStyleSheet", {
        configurable: true,
        value: class extends browserWindow.CSSStyleSheet {
            override insertRule(_cssText: string, index = 0) {
                return super.insertRule(":root {}", index)
            }
        },
    })
    ;({ createElement, createRoot } = await import("remix/ui"))
    ;({ WorkbenchApp } = await import("../src/renderer/src/app"))
})

afterAll(() => browserWindow.close())

describe("Remix repository entry renderer", () => {
    test("initializes a repository and opens the resulting workspace", async () => {
        const repository = repositoryInfo("D:\\Source\\new-project")
        const api = fakeWorkbench({
            initializeRepository: async (path, branch) => {
                expect(path).toBe("D:\\Source\\new-project")
                expect(branch).toBe("trunk")
                return { ok: true, workspace: openedWorkspace(repository) }
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelectorAll<HTMLElement>(".welcome .entry-card")[2]!)
        root.flush()
        const dialog = container.querySelector<HTMLDialogElement>("dialog[aria-labelledby='init-heading']")!
        input(container.querySelector<HTMLInputElement>("#init-path")!, "D:\\Source\\new-project")
        input(container.querySelector<HTMLInputElement>("#init-branch")!, "trunk")
        submit(container.querySelector<HTMLInputElement>("#init-path")!.form!)
        await flush(root)

        expect(dialog.open).toBe(false)
        expect(container.textContent).toContain("new-project")
        expect(container.textContent).toContain("Repository initialized and opened.")
        dispose()
    })

    test("updates Git settings without entering the repository operation state", async () => {
        let chooseCalls = 0
        const api = fakeWorkbench({
            chooseGit: async () => {
                chooseCalls++
                return {
                    path: "C:\\Users\\developer\\settings.json",
                    override: "D:\\Tools\\Git\\git.exe",
                    git: { path: "D:\\Tools\\Git\\git.exe", version: "2.52.0" },
                    authorIdentities: { secondary: [] },
                }
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelector<HTMLElement>("button[aria-label='Git settings']")!)
        root.flush()
        click(button(container, "Choose executable"))
        await flush(root)

        expect(chooseCalls).toBe(1)
        expect(container.textContent).toContain("D:\\Tools\\Git\\git.exe")
        expect(container.textContent).toContain("Application override")
        expect(document.body.classList.contains("busy")).toBe(false)
        dispose()
    })

    test("keeps clone values and its dialog when cancellation completes", async () => {
        let progressListener: ((progress: EntryProgress) => void) | undefined
        let finishClone: (result: EntryResult) => void = () => undefined
        let cancelCalls = 0
        const cloneResult = new Promise<EntryResult>(resolve => finishClone = resolve)
        const api = fakeWorkbench({
            cloneRepository: () => cloneResult,
            cancelEntry: async () => {
                cancelCalls++
                return true
            },
            onEntryProgress: listener => {
                progressListener = listener
                return () => progressListener = undefined
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelectorAll<HTMLElement>(".welcome .entry-card")[1]!)
        root.flush()

        const dialog = container.querySelector<HTMLDialogElement>("dialog[aria-labelledby='clone-heading']")!
        const source = container.querySelector<HTMLInputElement>("#clone-source")!
        const destination = container.querySelector<HTMLInputElement>("#clone-destination")!
        input(source, "https://host/team/project.git")
        await flush(root)
        input(destination, "D:\\Source\\project")
        submit(source.form!)
        await flush(root)

        progressListener?.({ message: "Receiving objects: 61%" })
        root.flush()
        expect(dialog.open).toBe(true)
        expect(container.textContent).toContain("Receiving objects: 61%")

        click(button(container, "Cancel clone"))
        await flush(root)
        expect(cancelCalls).toBe(1)
        expect(container.textContent).toContain("Stopping…")

        finishClone({ ok: false, error: { code: "git.cancelled", message: "Clone cancelled." } })
        await flush(root)
        expect(dialog.open).toBe(true)
        expect(source.value).toBe("https://host/team/project.git")
        expect(destination.value).toBe("D:\\Source\\project")
        expect(container.textContent).not.toContain("Starting Git")
        expect(container.textContent).not.toContain("Clone cancelled.")
        dispose()
    })

    test("applies the saved appearance and persists a toggle", async () => {
        const saved: string[] = []
        const api = fakeWorkbench({
            getState: async () => ({ ...appState(), appearance: "dark" as const }),
            setAppearance: async appearance => {
                saved.push(appearance)
                return appearance
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(document.documentElement.dataset.appearance).toBe("dark")

        click(container.querySelector<HTMLButtonElement>("[aria-label='Switch to light appearance']")!)
        await flush(root)
        expect(document.documentElement.dataset.appearance).toBe("light")
        expect(saved).toEqual(["light"])
        dispose()
    })

    test("shows a retryable fatal state when bootstrap rejects", async () => {
        let attempts = 0
        const api = fakeWorkbench({
            getState: async () => {
                attempts++
                if (attempts == 1)
                    throw new Error("Preload unavailable")
                return appState()
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(container.textContent).toContain("Git Workbench could not start.")
        expect(container.textContent).toContain("Preload unavailable")

        click(button(container, "Retry"))
        await flush(root)
        expect(container.textContent).toContain("No repository open")
        expect(attempts).toBe(2)
        dispose()
    })

    test("separates graph selection, branch opening, filtering, and Command Lens navigation", async () => {
        const repository = repositoryInfo("D:\\Source\\graph-project")
        const graph = branchGraph(repository.id)
        const api = fakeWorkbench({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
            selectRepository: async () => openedWorkspace(repository),
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(container.textContent).toContain("feature/workbench")
        expect(container.textContent).not.toContain("other/team")
        expect(container.querySelector(".graph-row svg path")).not.toBeNull()
        click(container.querySelector<HTMLButtonElement>("[aria-label='Collapse repository sidebar']")!)
        root.flush()
        expect(container.querySelector(".shell")?.classList.contains("rail-collapsed")).toBe(true)
        expect(container.querySelector(".repository-close")).toBeNull()
        expect(container.querySelector(".rail-footer > button")?.getAttribute("aria-label")).toBe("Expand repository sidebar")
        expect(container.querySelector(".rail-heading svg")).not.toBeNull()
        expect(container.querySelector("nav[aria-label='Open repositories']")?.lastElementChild?.getAttribute("aria-label")).toBe("Add repository")
        expect(container.querySelector(".repository-item")?.getAttribute("title")).toBe(repository.selectedWorktree)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Expand repository sidebar']")!)
        root.flush()
        expect(container.querySelector(".shell")?.classList.contains("rail-collapsed")).toBe(false)
        click(container.querySelector<HTMLButtonElement>(".masthead .lens-button")!)
        root.flush()
        expect(container.querySelector(".command-lens")).not.toBeNull()
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        root.flush()

        expect(container.querySelector(".rail-heading")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Open repositories")

        click(button(container, "Show all"))
        root.flush()
        expect(container.textContent).toContain("other/team")

        const feature = container.querySelector<HTMLElement>("[data-node-id='branch:refs/heads/feature/workbench']")!
        feature.dispatchEvent(new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true, cancelable: true }))
        root.flush()
        expect(feature.classList.contains("selected")).toBe(true)
        expect(container.querySelector(".branch-column")).toBeNull()
        feature.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }))
        root.flush()
        expect(feature.classList.contains("selected")).toBe(true)

        click(feature.querySelector<HTMLButtonElement>(".open-branch")!)
        await flush(root)
        expect(container.querySelector(".branch-column")?.textContent).toContain("feature/workbench")

        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))
        root.flush()
        expect(container.querySelector(".command-lens")?.textContent).toContain("Search open repositories and branches.")
        input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, "workbench")
        root.flush()
        expect(container.querySelector(".lens-results")?.textContent).toContain("feature/workbench")
        dispose()
    })

    test("virtualizes large semantic Branch Graph row sets", async () => {
        const repository = repositoryInfo("D:\\Source\\large-graph")
        const graph = branchGraph(repository.id)
        const template = graph.branches[1]
        graph.branches = [
            graph.branches[0],
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
        graph.history = [...graph.branches.slice(1).map(branch => ({ objectId: branch.tip, lineId: branch.id, parentIds: [graph.branches[0].tip] })), {
            objectId: graph.branches[0].tip,
            lineId: graph.branches[0].id,
            parentIds: [],
        }]
        const api = fakeWorkbench({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(container.querySelectorAll(".graph-row").length).toBeLessThan(30)
        expect(container.querySelector(".graph-spacer")).not.toBeNull()
        const rows = container.querySelector<HTMLElement>(".graph-rows")!
        rows.scrollTop = 1600
        rows.dispatchEvent(new Event("scroll", { bubbles: true }))
        root.flush()
        expect(container.querySelectorAll(".graph-row").length).toBeLessThan(30)
        expect(container.querySelector(".graph-row svg path[d='M 13 0 V 40']")).not.toBeNull()
        dispose()
    })

    test("shows polling activity inside the fixed-size refresh control", async () => {
        const repository = repositoryInfo("D:\\Source\\refresh-graph")
        const graph = branchGraph(repository.id)
        let calls = 0
        let finishRefresh: () => void = () => {}
        const refresh = new Promise<void>(resolve => finishRefresh = resolve)
        const api = fakeWorkbench({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => {
                calls++
                if (calls > 2)
                    await refresh
                return { ok: true, graph }
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Refresh Branch Graph']")!)
        await flush(root)
        expect(container.querySelector(".graph-status")).toBeNull()
        expect(container.querySelector(".refresh-button.refreshing")).not.toBeNull()

        finishRefresh()
        await flush(root)
        expect(container.querySelector(".refresh-button.refreshing")).toBeNull()
        dispose()
    })

    test("restores, reorders, resizes, and persists Workspace Columns", async () => {
        const repository = repositoryInfo("D:\\Source\\persisted-graph")
        const graph = branchGraph(repository.id)
        const main = graph.branches[0]
        const feature = graph.branches[1]
        let saved = {
            repositories: [{
                status: "available" as const,
                id: repository.id,
                path: repository.mainWorktree,
                info: repository,
                layoutInitialized: true,
                focusedColumnId: main.id,
                columns: [main, feature].map(branch => ({
                    kind: "branch" as const,
                    id: branch.id,
                    ref: branch.preferredRef,
                    lastSeenObjectId: branch.tip,
                    width: 380,
                })),
            }],
            activeRepositoryId: repository.id,
        }
        const api = fakeWorkbench({
            getState: async () => ({ ...appState(), workspace: saved }),
            readBranchGraph: async () => ({ ok: true, graph }),
            updateWorkspace: async workspace => saved = structuredClone(workspace) as typeof saved,
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(container.querySelector(".status-bar")).toBeNull()
        const columnHeaders = [...container.querySelectorAll(".branch-column > header")].map(header => header.textContent).join(" ")
        expect(columnHeaders).not.toContain("refs/heads/")
        expect(columnHeaders).not.toContain(main.tip.slice(0, 8))
        const mainColumn = container.querySelector<HTMLElement>(`[data-column-id='${main.id}']`)!
        mainColumn.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: ">", ctrlKey: true, shiftKey: true, bubbles: true }))
        await flush(root)
        expect(saved.repositories[0].columns.map(column => column.id)).toEqual([feature.id, main.id])
        expect(document.activeElement?.getAttribute("data-column-id")).toBe(main.id)

        const divider = container.querySelector<HTMLElement>(`[data-column-id='${main.id}'] [role='separator']`)!
        divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
        await flush(root)
        expect(saved.repositories[0].columns.find(column => column.id == main.id)?.width).toBe(390)
        dispose()
    })
})

test("retains worktree columns and restores collapse in place across restart", async () => {
    const scenario = inspectionScenario()
    const initial = await scenario.api.getState()
    const graphResult = await scenario.api.readBranchGraph(initial.workspace.activeRepositoryId!, false)
    if (!graphResult.ok)
        throw new Error("Missing graph")
    const graph = graphResult.graph
    const branch = graph.branches[1]
    const main = graph.branches[0]
    main.checkedOut = [{ path: "D:/other", name: "other", head: main.tip, main: false }]
    let view = render(scenario.api)
    await flush(view.root)
    expect([...view.container.querySelectorAll("[data-column-id]")].map(node => node.getAttribute("data-column-id"))).toEqual([branch.id, main.id])
    const column = view.container.querySelector<HTMLElement>(".branch-column")!
    expect(column.querySelector('[title="Close column"]')).toBeNull()
    const divider = column.querySelector<HTMLElement>('[role="separator"]')!
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    await flush(view.root)
    click(column.querySelector<HTMLButtonElement>('[title="Collapse column"]')!)
    await flush(view.root)
    expect(column.classList.contains("collapsed")).toBe(true)
    expect(column.textContent).toContain("2 changed files")
    const saved = (await scenario.api.getState()).workspace.repositories[0].columns
    expect(saved.map(column => column.id)).toEqual([branch.id, main.id])
    expect(saved[0]).toMatchObject({ collapsed: true, width: 390 })
    view.dispose()
    view = render(scenario.api)
    await flush(view.root)
    const restored = view.container.querySelector<HTMLElement>(".branch-column")!
    expect(restored.classList.contains("collapsed")).toBe(true)
    click(restored.querySelector<HTMLButtonElement>(".expand-column")!)
    await flush(view.root)
    expect(restored.classList.contains("collapsed")).toBe(false)
    expect(restored.style.width).toBe("390px")
    click(view.container.querySelector<HTMLButtonElement>('[aria-label="Hide Branch Graph"]')!)
    await flush(view.root)
    expect(view.container.querySelector(".graph-layout")?.classList.contains("graph-collapsed")).toBe(true)
    expect(view.container.querySelector('[aria-label="Show Branch Graph"]')).not.toBeNull()
    click(view.container.querySelector<HTMLButtonElement>('[aria-label="Show Branch Graph"]')!)
    await flush(view.root)
    expect(view.container.querySelector('[aria-label="Show Branch Graph"]')).toBeNull()
    main.checkedOut = []
    click(view.container.querySelector<HTMLButtonElement>('[aria-label="Refresh Branch Graph"]')!)
    await flush(view.root)
    expect((await scenario.api.getState()).workspace.repositories[0].columns.map(column => column.id)).toEqual([branch.id])
    view.dispose()
})

describe("Branch Comparison", () => {
    test("rejects obsolete inventories and cancels only affected requests", async () => {
        const { createBranchComparisons } = await import("../src/renderer/src/branch-comparison")
        const graph = branchGraph("repo")
        const [main, feature, other] = graph.branches
        const pending = new Map<string, (result: ChangesResult) => void>()
        const cancelled: string[] = []
        const signal = new AbortController().signal
        const comparisons = createBranchComparisons({
            api: fakeWorkbench({
                readChanges: async (_repo, id) => new Promise<ChangesResult>(resolve => pending.set(id, resolve)),
                cancelInspection: async (_repo, id) => {
                    cancelled.push(id)
                    return true
                },
            }),
            update: async () => signal,
            signal,
        })
        comparisons.activate("repo")
        const first = comparisons.create("repo", feature, main, graph)
        const sibling = comparisons.create("repo", other, main, graph)
        const [oldId, siblingId] = [...pending.keys()]
        feature.tip = "a".repeat(40)
        comparisons.refresh("repo", graph)
        expect(cancelled).toContain(oldId)
        expect(cancelled).not.toContain(siblingId)
        const freshId = [...pending.keys()].at(-1)!
        const result = (version: string): ChangesResult => ({
            ok: true,
            inventory: { source: { kind: "comparison", fromObjectId: feature.tip, toObjectId: main.tip }, version, files: [], parents: [] },
        })
        pending.get(freshId)!(result("fresh"))
        await new Promise(resolve => setTimeout(resolve, 0))
        pending.get(oldId)!(result("obsolete"))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(first.inventory?.version).toBe("fresh")
        comparisons.dispose(sibling)
        expect(cancelled).toContain(siblingId)
        pending.get(siblingId)!(result("closed"))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(sibling.inventory).toBeUndefined()
        comparisons.dispose(first)
    })
    test("opens ordered comparisons through a context menu, pages files lazily, reuses identities and refreshes moved tips", async () => {
        const scenario = inspectionScenario()
        const graphResult = await scenario.api.readBranchGraph("repository")
        if (!graphResult.ok)
            throw new Error("Fixture graph unavailable")
        const graph = graphResult.graph
        const [main, feature] = graph.branches
        let inventories = 0, patches = 0
        const requested: string[] = []
        const api = {
            ...scenario.api,
            readChanges: async (...args: Parameters<Window["workbench"]["readChanges"]>): Promise<ChangesResult> => {
                const request = args[2]
                if (request.source.kind != "branches" && request.source.kind != "comparison")
                    return scenario.api.readChanges(...args)
                inventories++
                const anchor = request.source
                if (
                    anchor.kind == "branches"
                    && (!graph.branches.some(branch => branch.preferredRef == anchor.fromRef)
                        || !graph.branches.some(branch => branch.preferredRef == anchor.toRef))
                ) {
                    return { ok: false, error: { code: "git.command-failed", message: "Compared branch unavailable" } }
                }
                const source = anchor.kind == "branches"
                    ? {
                        kind: "comparison" as const,
                        fromObjectId: graph.branches.find(branch => branch.preferredRef == anchor.fromRef)!.tip,
                        toObjectId: main.tip,
                    }
                    : anchor
                if (anchor.kind == "branches") {
                    requested.push(`${anchor.fromRef} -> ${anchor.toRef}`)
                    if (!graph.branches.some(branch => branch.preferredRef == anchor.toRef))
                        return { ok: false, error: { code: "git.command-failed", message: "Compared branch unavailable" } }
                }
                return {
                    ok: true,
                    inventory: {
                        source,
                        version: main.tip,
                        parents: [],
                        files: [{ ...scenario.page.file, path: request.offset ? "later.txt" : "file.txt" }],
                        ...(request.offset ? {} : { nextOffset: 1 }),
                    },
                }
            },
            readFileDiff: async (...args: Parameters<Window["workbench"]["readFileDiff"]>) => {
                if (args[2].source.kind != "comparison")
                    return scenario.api.readFileDiff(...args)
                patches++
                return {
                    ok: true as const,
                    page: {
                        ...scenario.page,
                        source: args[2].source,
                        version: main.tip,
                        selectable: false,
                        file: { ...scenario.page.file, path: args[2].path },
                    },
                }
            },
        }
        const { container, root, dispose } = render(api)
        await flush(root)
        const chooseComparison = async () => {
            container.querySelector<HTMLElement>(`[data-node-id='${feature.id}']`)!.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }),
            )
            await flush(root)
            click(container.querySelector<HTMLButtonElement>("[role='menuitem']")!)
            await flush(root)
            input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, main.name)
            await flush(root)
            click(container.querySelector<HTMLButtonElement>(".lens-results button")!)
            await flush(root)
        }
        await chooseComparison()
        const comparison = container.querySelector<HTMLElement>(".branch-comparison")!
        expect(comparison).not.toBeNull()
        expect(comparison.previousElementSibling?.classList.contains("branch-column")).toBe(true)
        expect(comparison.textContent).toContain(`${feature.name} → ${main.name}`)
        expect(document.activeElement).toBe(comparison)
        expect(requested).toEqual([`${feature.preferredRef} -> ${main.preferredRef}`])
        expect(patches).toBe(0)
        const id = comparison.dataset.auxiliaryId
        click(container.querySelector<HTMLButtonElement>(".branch-column [title='src/file.txt']")!)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!)
        await flush(root)
        expect(container.querySelector(".inspection-breakout")?.nextElementSibling).toBe(comparison)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(root)
        expect(container.querySelector(".branch-comparison")).toBe(comparison)
        await chooseComparison()
        expect(container.querySelectorAll(".branch-comparison")).toHaveLength(1)
        expect(container.querySelector<HTMLElement>(".branch-comparison")!.dataset.auxiliaryId).toBe(id)
        expect(inventories).toBe(1)
        click(button(comparison, "Load more files"))
        await flush(root)
        expect(comparison.querySelectorAll(".file-tree .change-file")).toHaveLength(2)
        click(comparison.querySelector<HTMLButtonElement>(".change-file button")!)
        await flush(root)
        expect(patches).toBe(1)
        expect(comparison.querySelector(".pierre-diff")).not.toBeNull()
        expect(scenario.saved().repositories[0].columns).toHaveLength(1)
        main.tip = "a".repeat(40)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Refresh Branch Graph']")!)
        await flush(root)
        expect(inventories).toBe(3)
        expect(patches).toBe(2)
        expect(comparison.querySelector("header strong")?.getAttribute("title")).toContain("aaaaaaaa")
        graph.branches = graph.branches.filter(branch => branch != main)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Refresh Branch Graph']")!)
        await flush(root)
        expect(comparison.textContent).toContain("Showing the last comparison")
        graph.branches = [...graph.branches.filter(branch => branch != feature), main]
        click(container.querySelector<HTMLButtonElement>("[aria-label='Refresh Branch Graph']")!)
        await flush(root)
        const orphaned = container.querySelector<HTMLElement>(".branch-comparison")!
        expect(orphaned).not.toBeNull()
        expect(orphaned.textContent).toContain("Showing the last comparison")
        click(button(orphaned, "Compare with…"))
        await flush(root)
        input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, "other/team")
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".lens-results button")!)
        await flush(root)
        expect(container.querySelectorAll(".branch-comparison")).toHaveLength(1)
        expect(container.querySelector(".branch-comparison")?.textContent).toContain("other/team → main")
        click(container.querySelector<HTMLButtonElement>("[aria-label='Close comparison']")!)
        await flush(root)
        expect(container.querySelector(".branch-comparison")).toBeNull()
        dispose()
    })
})

describe("Working Changes inspection", () => {
    test("pages unresolved branch commits before offering a continuation branch", async () => {
        const scenario = inspectionScenario()
        const graphResult = await scenario.api.readBranchGraph((await scenario.api.getState()).workspace.activeRepositoryId!, false)
        if (!graphResult.ok)
            throw new Error("Missing graph")
        const graph = graphResult.graph
        const branch = graph.branches[1]
        const candidates = [graph.branches[0], graph.branches[2]]
        branch.base = {
            status: "ambiguous",
            candidates: candidates.map(candidate => ({
                branchId: candidate.id,
                name: candidate.name,
                ref: candidate.preferredRef,
                tip: candidate.tip,
            })),
        }
        const requests: Parameters<Window["workbench"]["readBranchHistory"]>[1][] = []
        scenario.api.readBranchHistory = async (_repositoryId, request) => {
            requests.push(request)
            return {
                ok: true,
                page: {
                    branchRef: request.branchRef,
                    tip: request.tip,
                    baseTips: request.baseTips,
                    commits: request.offset ? [] : [{
                        objectId: branch.tip,
                        parentIds: [graph.branches[0].tip],
                        subject: "Inspect changes",
                        authorName: "Test",
                        authorEmail: "test@example.test",
                        authoredAt: 1788566400,
                    }],
                    ...(request.offset ? {} : { nextOffset: 1 }),
                },
            }
        }

        const { container, root, dispose } = render(scenario.api)
        await flush(root)
        expect(requests[0]).toMatchObject({ limit: 50, baseTips: candidates.map(candidate => candidate.tip) })
        expect(container.querySelector("[aria-label='Branch after feature/workbench']")).toBeNull()
        click(button(container, "Load more"))
        await flush(root)
        const continuation = container.querySelector<HTMLSelectElement>("[aria-label='Branch after feature/workbench']")!
        expect(continuation).not.toBeNull()
        expect([...continuation.options].map(option => option.textContent)).toEqual(["Choose branch…", "main", "other/team"])
        continuation.value = graph.branches[0].id
        continuation.dispatchEvent(new Event("change", { bubbles: true }))
        await flush(root)
        expect(container.querySelector(".stack-heading")?.textContent).toContain("main")
        dispose()
    })

    test("opens column filtering on demand and clears it with Escape", async () => {
        const { container, root, dispose } = render(inspectionScenario().api)
        await flush(root)
        const column = container.querySelector<HTMLElement>(".branch-column")!
        const search = column.querySelector<HTMLButtonElement>('[aria-label="Filter files"]')!
        expect(column.querySelector(".inspection-filters")).toBeNull()
        click(search)
        await flush(root)
        const input = column.querySelector<HTMLInputElement>('[aria-label="Filter changed files"]')!
        expect(document.activeElement).toBe(input)
        input.value = "SRC/FI"
        input.dispatchEvent(new Event("input", { bubbles: true }))
        await flush(root)
        expect([...column.querySelectorAll(".working-changes mark")].map(mark => mark.textContent).join("")).toBe("src/fi")
        click(column.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        expect([...column.querySelectorAll(".inspect-commit mark")].map(mark => mark.textContent).join("")).toBe("src/fi")
        input.value = "no-matching-file"
        input.dispatchEvent(new Event("input", { bubbles: true }))
        await flush(root)
        expect(column.querySelector(".working-changes .change-file")).toBeNull()
        search.focus()
        click(search)
        await flush(root)
        expect(document.activeElement == input).toBe(true)
        expect(input.value).toBe("no-matching-file")
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await flush(root)
        expect(column.querySelector(".inspection-filters")).toBeNull()
        expect(column.querySelector(".working-changes .change-file")).not.toBeNull()
        expect(column.querySelectorAll("mark").length).toBe(0)
        expect(document.activeElement).toBe(search)
        column.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }))
        await flush(root)
        expect(column.querySelector<HTMLInputElement>('[aria-label="Filter changed files"]')?.value).toBe("")
        expect(document.activeElement).toBe(column.querySelector('[aria-label="Filter changed files"]'))
        dispose()
    })
    test("expands and selects on mousedown without toggling again on mouseup", async () => {
        const scenario = inspectionScenario()
        const { container, root, dispose } = render(scenario.api)
        await flush(root)
        const down = (element: HTMLElement, button = 0) =>
            element.dispatchEvent(new MouseEvent("mousedown", { button, detail: 1, bubbles: true, cancelable: true, composed: true }))
        const release = (element: HTMLElement) => {
            element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }))
            element.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true, composed: true }))
        }
        const file = container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!
        down(file)
        await flush(root)
        expect(file.getAttribute("aria-expanded")).toBe("true")
        release(file)
        await flush(root)
        expect(file.getAttribute("aria-expanded")).toBe("true")
        const checkbox = container.querySelector<HTMLInputElement>("[aria-label='Select file src/file.txt']")!
        down(checkbox)
        await flush(root)
        expect(checkbox.checked).toBe(true)
        release(checkbox)
        await flush(root)
        expect(checkbox.checked).toBe(true)
        const line = diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!
        down(line)
        await flush(root)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        release(line)
        await flush(root)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        down(file, 2)
        await flush(root)
        expect(file.getAttribute("aria-expanded")).toBe("true")
        click(file)
        await flush(root)
        expect(file.getAttribute("aria-expanded")).toBe("false")
        const commit = container.querySelector<HTMLButtonElement>(".commit-heading")!
        down(commit)
        await flush(root)
        expect(commit.getAttribute("aria-expanded")).toBe("true")
        release(commit)
        await flush(root)
        expect(commit.getAttribute("aria-expanded")).toBe("true")
        down(commit)
        await flush(root)
        expect(commit.getAttribute("aria-expanded")).toBe("false")
        const ignored = container.querySelector<HTMLInputElement>(".ignored-toggle input")!
        const label = ignored.closest("label")!
        down(label)
        await flush(root)
        expect(ignored.checked).toBe(true)
        release(label)
        await flush(root)
        expect(ignored.checked).toBe(true)
        ignored.disabled = true
        down(label)
        await flush(root)
        expect(ignored.checked).toBe(true)
        dispose()
    })

    test("reopens working snapshots immediately and discards them when the file list changes", async () => {
        const scenario = inspectionScenario()
        let reads = 0
        let version = "one"
        const { container, root, dispose } = render({
            ...scenario.api,
            readChanges: async (...args) => {
                const result = await scenario.api.readChanges(...args)
                return result.ok ? { ...result, inventory: { ...result.inventory, version } } : result
            },
            readFileDiff: async (...args) => {
                reads++
                expect(args[2].inventoryVersion).toBe(version)
                return scenario.api.readFileDiff(...args)
            },
        })
        await flush(root)
        const file = () => container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!
        click(file())
        await flush(root)
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!)
        await flush(root)
        click(file())
        await flush(root)
        click(file())
        await flush(root)
        expect(reads).toBe(1)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(0)
        click(file())
        await flush(root)
        version = "two"
        click(container.querySelector<HTMLButtonElement>("[aria-label='Refresh Working Changes']")!)
        await flush(root)
        click(file())
        await flush(root)
        expect(reads).toBe(2)
        dispose()
    })

    test("reopens a committed file without another diff read", async () => {
        const scenario = inspectionScenario()
        let reads = 0
        const { container, root, dispose } = render({
            ...scenario.api,
            readFileDiff: async (...args) => {
                reads++
                return scenario.api.readFileDiff(...args)
            },
        })
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        const file = () => container.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!
        click(file())
        await flush(root)
        click(file())
        await flush(root)
        click(file())
        await flush(root)
        expect(reads).toBe(1)
        expect(container.querySelector(".diff-inspector")).not.toBeNull()
        dispose()
    })

    test("offers a complete commit diff only from an expanded commit", async () => {
        const scenario = inspectionScenario()
        let commitInventories = 0
        let commitDiffs = 0
        const api = {
            ...scenario.api,
            readChanges: async (...args: Parameters<Window["workbench"]["readChanges"]>) => {
                if (args[2].source.kind == "commit")
                    commitInventories++
                return scenario.api.readChanges(...args)
            },
            readFileDiff: async (...args: Parameters<Window["workbench"]["readFileDiff"]>) => {
                if (args[2].source.kind == "commit")
                    commitDiffs++
                return scenario.api.readFileDiff(...args)
            },
        }
        const { container, root, dispose } = render(api)
        await flush(root)
        const commit = container.querySelector<HTMLButtonElement>(".commit-heading")!
        expect(commit.getAttribute("aria-expanded")).toBe("false")
        expect(container.querySelector("[aria-label='Show full diff for commit Inspect changes']")).toBeNull()
        click(commit)
        await flush(root)
        expect(commit.getAttribute("aria-expanded")).toBe("true")
        click(container.querySelector<HTMLButtonElement>("[aria-label='Show full diff for commit Inspect changes']")!)
        await flush(root)
        expect(commit.getAttribute("aria-expanded")).toBe("true")
        expect(commitInventories).toBe(1)
        expect(commitDiffs).toBe(2)
        expect(container.querySelectorAll(".branch-column .diff-inspector")).toHaveLength(0)
        expect(container.querySelectorAll(".inspection-breakout .diff-inspector")).toHaveLength(2)
        const auxiliaryId = container.querySelector<HTMLElement>(".inspection-breakout")!.dataset.auxiliaryId
        click(container.querySelector<HTMLButtonElement>("[aria-label='Show full diff for commit Inspect changes']")!)
        await flush(root)
        expect(container.querySelector<HTMLElement>(".inspection-breakout")!.dataset.auxiliaryId).toBe(auxiliaryId)
        expect(commitDiffs).toBe(2)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(root)
        expect(container.querySelectorAll(".diff-inspector")).toHaveLength(0)
        dispose()
    })

    test("disposes pending commit breakout reads with its source and restores no auxiliary columns", async () => {
        const scenario = inspectionScenario()
        const pending = new Map<string, (result: FileDiffResult) => void>()
        const cancelled: string[] = []
        const api = {
            ...scenario.api,
            readFileDiff: async (_repositoryId: string, id: string) => new Promise<FileDiffResult>(resolve => pending.set(id, resolve)),
            cancelInspection: async (_repositoryId: string, id: string) => {
                cancelled.push(id)
                return true
            },
        }
        const { container, root, dispose } = render(api)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Show full diff for commit Inspect changes']")!)
        await flush(root)
        expect(pending.size).toBe(2)
        dispose()
        for (const [id, finish] of pending) {
            expect(cancelled).toContain(id)
            finish({ ok: true, page: scenario.page })
        }
        const restarted = render(scenario.api)
        await flush(restarted.root)
        expect(restarted.container.querySelector(".inspection-breakout")).toBeNull()
        expect(restarted.container.querySelector(".diff-inspector")).toBeNull()
        restarted.dispose()
    })

    test("opens file diffs independently beneath their rows and isolates pending reads", async () => {
        const scenario = inspectionScenario()
        const pending = new Map<string, { id: string; finish(result: FileDiffResult): void; request: Parameters<Window["workbench"]["readFileDiff"]>[2] }>()
        const { container, root, dispose } = render({
            ...scenario.api,
            readFileDiff: async (_repositoryId, id, request) => new Promise<FileDiffResult>(finish => pending.set(request.path, { id, request, finish })),
        })
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        const first = container.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!
        const second = container.querySelector<HTMLButtonElement>(".inspect-commit [title='other.txt']")!
        const firstRow = first.closest(".file-inspection")!
        const secondRow = second.closest(".file-inspection")!
        click(first)
        click(second)
        await flush(root)
        expect(pending.size).toBe(2)
        expect(pending.get("src/file.txt")!.id).not.toBe(pending.get("other.txt")!.id)
        expect(firstRow.nextElementSibling).toBe(secondRow)
        expect(firstRow.querySelector(".change-file")!.nextElementSibling?.classList.contains("diff-inspector")).toBe(true)
        expect(secondRow.querySelector(".diff-inspector")).not.toBeNull()
        const complete = async (path: string) => {
            const read = pending.get(path)!
            read.finish(await scenario.api.readFileDiff("repository", read.id, read.request))
            await flush(root)
        }
        await complete("other.txt")
        const secondViewer = secondRow.querySelector(".pierre-diff")!
        click(diffRoot(secondRow).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!)
        await flush(root)
        click(first)
        await flush(root)
        await complete("src/file.txt")
        expect(firstRow.querySelector(".diff-inspector")).toBeNull()
        expect(secondRow.querySelector(".pierre-diff")).toBe(secondViewer)
        expect(diffRoot(secondRow).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        click(first)
        await flush(root)
        await complete("src/file.txt")
        expect(container.querySelectorAll(".inspect-commit .diff-inspector")).toHaveLength(2)
        click(secondRow.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!)
        await flush(root)
        expect(container.querySelectorAll(".branch-column .diff-inspector")).toHaveLength(0)
        expect(container.querySelector(".inspection-breakout [aria-label='Diff for other.txt']")).not.toBeNull()
        click(first)
        await flush(root)
        expect(container.querySelectorAll(".branch-column .diff-inspector")).toHaveLength(0)
        expect(container.querySelector(".inspection-breakout [aria-label='Diff for src/file.txt']")).not.toBeNull()
        click(container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(root)
        expect(firstRow.querySelector(".diff-inspector")).not.toBeNull()
        expect(secondRow.querySelector(".diff-inspector")).not.toBeNull()
        expect(diffRoot(secondRow).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Show full diff for commit Inspect changes']")!)
        await flush(root)
        expect(container.querySelectorAll(".branch-column .diff-inspector")).toHaveLength(0)
        expect(container.querySelector(".inspection-breakout")?.textContent).toContain("Commit · Inspect changes")
        expect(container.querySelectorAll(".inspection-breakout .diff-inspector")).toHaveLength(2)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        expect(container.querySelectorAll(".diff-inspector")).toHaveLength(0)
        dispose()
    })

    test("reads patches lazily, respects literal selection, and restores only diff layout", async () => {
        const scenario = inspectionScenario()
        let reads = 0
        const api = {
            ...scenario.api,
            readFileDiff: async (...args: Parameters<Window["workbench"]["readFileDiff"]>) => {
                reads++
                return scenario.api.readFileDiff(...args)
            },
        }
        const { container, root, dispose } = render(api)
        await flush(root)
        expect(container.textContent).toContain("Working Changes")
        expect(container.textContent).toContain("staged")
        expect(reads).toBe(0)
        click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        expect(reads).toBe(1)
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!)
        await flush(root)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        expect(diffRoot(container).querySelector(".diff-line.addition.selected")).toBeNull()
        click(button(container, "Staged"))
        await flush(root)
        expect(diffRoot(container).querySelector(".diff-line.selected")).toBeNull()
        expect(diffRoot(container).querySelector("[aria-label='Select deletion line 1']")).toBeNull()
        click(button(container, "Working Changes"))
        await flush(root)
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select hunk']")!)
        await flush(root)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(2)
        click(button(container, "Side by side"))
        await flush(root)
        expect(scenario.saved().repositories[0].columns[0].diffLayout).toBe("split")
        click(button(container, "Break out diff"))
        await flush(root)
        expect(container.querySelector(".branch-column")?.nextElementSibling?.classList.contains("inspection-breakout")).toBe(true)
        const breakout = container.querySelector<HTMLElement>(".inspection-breakout")!
        expect(document.activeElement).toBe(breakout)
        expect(breakout.dataset.sourceColumnId).toBe(container.querySelector<HTMLElement>(".branch-column")!.dataset.columnId)
        expect(breakout.querySelector(".auxiliary-source")?.textContent).toContain("From ")
        const auxiliaryId = breakout.dataset.auxiliaryId
        click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        expect(container.querySelector<HTMLElement>(".inspection-breakout")!.dataset.auxiliaryId).toBe(auxiliaryId)
        expect(scenario.saved().repositories[0].columns).toHaveLength(1)
        expect(container.textContent).not.toContain("Focus diff")
        click(container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(root)
        expect(container.querySelector(".inspection-breakout")).toBeNull()
        expect(document.activeElement).toBe(container.querySelector(".branch-column"))
        expect(container.querySelector(".branch-column .diff-inspector")).not.toBeNull()
        dispose()
        const restarted = render(api)
        await flush(restarted.root)
        expect(restarted.container.querySelector(".diff-inspector")).toBeNull()
        click(restarted.container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(restarted.root)
        expect(restarted.container.querySelector(".diff-lines.split")).not.toBeNull()
        expect(diffRoot(restarted.container).querySelector(".diff-line.selected")).toBeNull()
        restarted.dispose()
    })

    test("rejects superseded reads and clears stale or collapsed-file selections", async () => {
        const scenario = inspectionScenario()
        let finish: (page: FileDiffResult) => void = () => {}
        let first = true
        let version = "one"
        const api = {
            ...scenario.api,
            readFileDiff: async (...args: Parameters<Window["workbench"]["readFileDiff"]>) => {
                if (first) {
                    first = false
                    return new Promise<FileDiffResult>(resolve => finish = resolve)
                }
                const result = await scenario.api.readFileDiff(...args)
                return result.ok ? { ...result, page: { ...result.page, version } } : result
            },
        }
        const { container, root, dispose } = render(api)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>("[title='other.txt']")!)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        finish({ ok: true, page: scenario.page })
        await flush(root)
        expect(container.querySelector(".diff-inspector")?.getAttribute("aria-label")).toBe("Diff for other.txt")
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!)
        await flush(root)
        version = "two"
        click(container.querySelector<HTMLButtonElement>("[aria-label='Refresh Working Changes']")!)
        await flush(root)
        expect(container.textContent).toContain("Change Selection cleared")
        expect(diffRoot(container).querySelector(".diff-line.selected")).toBeNull()
        click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!)
        await flush(root)
        expect(container.querySelector(".file-tree details")).toBeNull()
        click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        expect(container.querySelector("[aria-label='Diff for src/file.txt']")).toBeNull()
        expect(container.querySelector("[aria-label='Diff for other.txt']")).not.toBeNull()
        dispose()
    })

    test("expands pinned commit history and keeps large patches virtualized", async () => {
        const scenario = inspectionScenario()
        let historyReads = 0
        const api = {
            ...scenario.api,
            readBranchHistory: async (...args: Parameters<Window["workbench"]["readBranchHistory"]>) => {
                historyReads++
                return scenario.api.readBranchHistory(...args)
            },
            readFileDiff: async (...args: Parameters<Window["workbench"]["readFileDiff"]>) => {
                const result = await scenario.api.readFileDiff(...args)
                return result.ok
                    ? {
                        ...result,
                        page: {
                            ...result.page,
                            lines: Array.from({ length: 2000 }, (_, id) => ({ id, kind: "addition" as const, text: `line ${id}`, newLine: id + 1, hunk: 0 })),
                        },
                    }
                    : result
            },
        }
        const { container, root, dispose } = render(api)
        await flush(root)
        expect(historyReads).toBe(1)
        expect(container.querySelector(".stack-branch")?.querySelector(".stack-heading") == null).toBe(true)
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!)
        await flush(root)
        expect(container.querySelector(".inspect-commit .file-tree details")).toBeNull()
        expect(container.querySelector(".inspect-commit .file-tree")?.textContent).toContain("src/file.txt")
        expect(container.querySelector(".inspect-commit .change-file")?.nextElementSibling?.classList.contains("diff-inspector")).toBe(true)
        expect(diffRoot(container).querySelectorAll(".diff-line").length).toBeLessThanOrEqual(80)
        expect(container.querySelector(".diff-views")).toBeNull()
        click(container.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!)
        await flush(root)
        expect(container.querySelector(".diff-inspector")).toBeNull()
        click(container.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!)
        await flush(root)
        expect(container.querySelector(".diff-inspector")).not.toBeNull()
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        expect(container.querySelector(".diff-inspector")).toBeNull()
        expect(container.querySelector(".commit-heading")?.getAttribute("aria-expanded")).toBe("false")
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        expect(container.querySelector(".diff-inspector")).toBeNull()
        dispose()
    })
})

test("File History shares file inspection, opens blame origins, reuses inputs and closes descendants", async () => {
    const scenario = inspectionScenario()
    const oid = "2".repeat(40)
    let reads = 0
    scenario.api.readFileHistory = async (_repo, _id, request) => {
        reads++
        return {
            ok: true,
            page: request.related ? { entries: [], related: [{ path: "other.txt", objectId: oid, evidence: "shared lines", score: 2 }] } : request.blame
                ? { entries: [], blame: [{ objectId: "1".repeat(40), path: "other.txt", originalLine: 1, line: 1, author: "Test", text: "origin" }] }
                : {
                    tip: oid,
                    entries: [{
                        objectId: oid,
                        parentIds: ["1".repeat(40), "3".repeat(40)],
                        followedParent: "1".repeat(40),
                        path: request.path,
                        status: "M",
                        composable: request.source.kind != "commit",
                        subject: "History commit",
                        authorName: "Test",
                        authorEmail: "test@example.test",
                        authoredAt: 1,
                    }],
                },
        }
    }
    const { container, root, dispose } = render(scenario.api)
    try {
        await flush(root)
        const row = container.querySelector<HTMLElement>(".change-file")!
        const menu = async () => {
            row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }))
            await flush(root)
            click(button(container, "File history"))
            await flush(root)
        }
        await menu()
        const history = container.querySelector<HTMLElement>(".file-history")!
        expect(history).not.toBeNull()
        expect(history.textContent).toContain("Following parent 1")
        expect(history.textContent).toContain("Working Changes")
        await menu()
        expect(container.querySelectorAll(".file-history")).toHaveLength(1)
        expect(reads).toBe(1)
        click(button(history, "History commit"))
        await flush(root)
        click(history.querySelector<HTMLButtonElement>(".change-file button")!)
        await flush(root)
        expect(history.querySelector(".pierre-diff")).not.toBeNull()
        expect(history.querySelector("input[type='checkbox']")).not.toBeNull()
        click(button(history, "Complete commit diff"))
        await flush(root)
        const commit = container.querySelector<HTMLElement>(".trail-commit")!
        expect(commit.querySelectorAll(".change-file")).toHaveLength(2)
        const parent = commit.querySelector<HTMLSelectElement>("[aria-label='Commit diff parent']")!
        parent.value = "3".repeat(40)
        parent.dispatchEvent(new Event("change", { bubbles: true }))
        await flush(root)
        click(button(commit, "Find related files"))
        await flush(root)
        expect(commit.textContent).toContain("shared lines")
        click(commit.querySelector<HTMLButtonElement>(".related-file")!)
        await flush(root)
        expect(container.querySelectorAll(".file-history")).toHaveLength(2)
        click(commit.querySelector<HTMLButtonElement>("[aria-label='Close commit diff']")!)
        await flush(root)
        expect(container.querySelectorAll(".file-history")).toHaveLength(1)
        click(button(history, "Blame context"))
        await flush(root)
        click(history.querySelector<HTMLButtonElement>(".blame-line button")!)
        await flush(root)
        expect(container.querySelectorAll(".file-history")).toHaveLength(2)
        expect(container.querySelectorAll(".file-history")[1].textContent).not.toContain("Working Changes")
        click(history.querySelector<HTMLButtonElement>("[aria-label='Close file history']")!)
        await flush(root)
        expect(container.querySelector(".file-history")).toBeNull()
    } finally {
        dispose()
    }
})

function render(api: Window["workbench"]) {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    root.render(createElement(WorkbenchApp, { api }))
    root.flush()
    return {
        container,
        root,
        dispose() {
            root.dispose()
            container.remove()
            document.body.className = ""
        },
    }
}

async function flush(root: VirtualRoot) {
    for (let index = 0; index < 4; index++) {
        await new Promise(resolve => setTimeout(resolve, 0))
        root.flush()
    }
}

function click(element: HTMLElement) {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

function input(element: HTMLInputElement, value: string) {
    element.value = value
    element.dispatchEvent(new Event("input", { bubbles: true }))
}

function submit(form: HTMLFormElement) {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))
}

function button(container: HTMLElement, label: string) {
    const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate =>
        candidate.getAttribute("aria-label") == label || candidate.textContent?.trim() == label
    )
    if (!result)
        throw new Error(`Button not found: ${label}. Rendered: ${container.textContent}`)
    return result
}

function diffRoot(container: Element): ShadowRoot | Element {
    return container.querySelector(".pierre-diff")?.shadowRoot ?? container
}
