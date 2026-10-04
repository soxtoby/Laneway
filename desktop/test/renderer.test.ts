import type { BranchGraph, ChangesResult, CompositionPreview, CompositionRequest, EntryProgress, EntryResult, FileDiffResult, WorktreeRequest } from "@laneway/shared"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Window as HappyWindow } from "happy-dom"
import type { createElement as createRemixElement, createRoot as createRemixRoot, VirtualRoot } from "remix/ui"
import type { LanewayApp as LanewayAppComponent } from "../src/renderer/src/app"
import { appState, branchGraph, fakeLaneway, inspectionScenario, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow
let createElement: typeof createRemixElement
let createRoot: typeof createRemixRoot
let LanewayApp: typeof LanewayAppComponent

beforeAll(async () => {
    browserWindow = new HappyWindow({ url: "file:///renderer/index.html" })
    const browserGlobal = browserWindow as unknown as Record<string, unknown>
    const globals = [
        "window",
        "document",
        "Node",
        "NodeFilter",
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
        "PointerEvent",
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
    ;({ LanewayApp } = await import("../src/renderer/src/app"))
})

afterAll(() => browserWindow.close())

test("worktree creation previews the destination and mutates only after confirmation", async () => {
    const scenario = inspectionScenario()
    let executions = 0
    scenario.api.previewWorktree = async (_id, request) => ({
        ok: true,
        preview: {
            request,
            worktrees: [],
            destination: "D:/project.worktrees/feature",
            affected: ["D:/project.worktrees/feature"],
            ignored: [],
            dirty: false,
            uniqueCommits: false,
            populatedSubmodules: false,
            token: "current",
        },
    })
    scenario.api.executeWorktree = async (_id, request, token) => {
        expect(request.action).toBe("create")
        expect(token).toBe("current")
        executions++
        return { ok: true }
    }
    const { container, root, dispose } = render(scenario.api)
    await flush(root)
    click(button(container.querySelector("[data-node-id='branch:refs/heads/main']")!, "Open"))
    await flush(root)
    click(container.querySelector<HTMLElement>(".column-worktree [aria-label='Check out branch']")!)
    await flush(root)
    click(button(container, "New worktree"))
    await flush(root)
    const dialog = container.querySelector<HTMLDialogElement>('dialog[aria-label="Worktree operation"]')!
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain("D:/project.worktrees/feature")
    expect(executions).toBe(0)
    click(button(dialog, "Cancel"))
    await flush(root)
    expect(executions).toBe(0)
    click(container.querySelector<HTMLElement>(".column-worktree [aria-label='Check out branch']")!)
    await flush(root)
    click(button(container, "New worktree"))
    await flush(root)
    click(button(container.querySelector<HTMLDialogElement>('dialog[aria-label="Worktree operation"]')!, "Confirm"))
    await flush(root)
    expect(executions).toBe(1)
    dispose()
})

test("worktree row renames inline and switches through branch search; removal stays in overflow", async () => {
    const scenario = inspectionScenario()
    const readGraph = scenario.api.readBranchGraph
    scenario.api.readBranchGraph = async (...args) => {
        const result = await readGraph(...args)
        if (result.ok)
            result.graph.branches[1]!.checkedOut[0]!.main = false
        return result
    }
    const requests: WorktreeRequest[] = []
    scenario.api.previewWorktree = async (_id, request) => {
        requests.push(request)
        return { ok: false, error: { message: "Preview requested" } }
    }
    const { container, root, dispose } = render(scenario.api)
    try {
        await flush(root)
        const row = container.querySelector<HTMLElement>(".column-worktree")!
        expect(row.querySelector("details, select, input")).toBeNull()
        expect(row.textContent).not.toContain("Remove")
        expect(row.textContent).not.toContain("commit")
        const rename = row.querySelector<HTMLButtonElement>("[aria-label='Rename worktree']")!
        click(rename)
        await flush(root)
        const name = row.querySelector<HTMLInputElement>("[aria-label='Worktree directory name']")!
        expect(name.value).toBe("inspection")
        input(name, "cancelled")
        name.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await flush(root)
        expect(requests).toEqual([])
        expect(row.querySelector("input")).toBeNull()
        click(row.querySelector<HTMLButtonElement>("[aria-label='Rename worktree']")!)
        await flush(root)
        const nextName = row.querySelector<HTMLInputElement>("input")!
        input(nextName, "renamed")
        nextName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await flush(root)
        expect(requests).toEqual([{ action: "rename", path: "D:\\Source\\inspection", basename: "renamed" }])
        click(button(container.querySelector("dialog")!, "Cancel"))
        await flush(root)

        click(row.querySelector<HTMLButtonElement>("[aria-label='Worktree actions']")!)
        await flush(root)
        const switchBranch = row.querySelector<HTMLButtonElement>("[role='menu'] [aria-label='Switch worktree branch']")!
        click(switchBranch)
        await flush(root)
        expect(container.querySelector(".lens-results")!.textContent).not.toContain("feature/laneway")
        input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, "main")
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".lens-results button")!)
        await flush(root)
        expect(requests[1]).toEqual({ action: "switch", path: "D:\\Source\\inspection", branch: "refs/heads/main", move: true })
        expect(container.querySelector(".command-lens")).toBeNull()
        click(button(container.querySelector("dialog")!, "Cancel"))
        await flush(root)

        let executed: WorktreeRequest | undefined
        scenario.api.previewWorktree = async (_id, request) => {
            requests.push(request)
            return {
                ok: true,
                preview: {
                    request,
                    worktrees: [],
                    affected: ["D:\\Source\\inspection"],
                    ignored: ["D:\\Source\\inspection\\generated.bin"],
                    dirty: true,
                    uniqueCommits: false,
                    populatedSubmodules: false,
                    token: request.action == "remove" && request.allowIgnoredLoss ? "allowed" : "preview",
                },
            }
        }
        scenario.api.executeWorktree = async (_id, request) => {
            executed = request
            return { ok: true }
        }
        click(row.querySelector<HTMLButtonElement>("[aria-label='Worktree actions']")!)
        await flush(root)
        expect(row.querySelector("[role='menu']")!.textContent).not.toContain("New worktree")
        click(button(row.querySelector("[role='menu']")!, "Remove worktree…"))
        await flush(root)
        expect(requests[2]).toEqual({ action: "remove", path: "D:\\Source\\inspection", preserve: true, allowIgnoredLoss: false })
        expect(row.querySelector("[role='menu']")).toBeNull()
        const removeDialog = container.querySelector<HTMLDialogElement>('dialog[aria-label="Worktree operation"]')!
        expect(removeDialog.textContent).toContain("Working Changes detected")
        expect(removeDialog.textContent).not.toContain("ignored")
        click(button(removeDialog, "Remove worktree"))
        await flush(root)
        expect(executed).toEqual({ action: "remove", path: "D:\\Source\\inspection", preserve: true, allowIgnoredLoss: true })
    } finally {
        dispose()
    }
})

describe("Remix repository entry renderer", () => {
    test("initializes a repository and opens the resulting workspace", async () => {
        const repository = repositoryInfo("D:\\Source\\new-project")
        const api = fakeLaneway({
            initializeRepository: async (parent, name, branch) => {
                expect(parent).toBe("D:\\Source")
                expect(name).toBe("new-project")
                expect(branch).toBe("trunk")
                return { ok: true, workspace: openedWorkspace(repository) }
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelectorAll<HTMLElement>(".welcome .entry-card")[2]!)
        await flush(root)
        const dialog = container.querySelector<HTMLDialogElement>("dialog[aria-labelledby='init-heading']")!
        const parent = container.querySelector<HTMLInputElement>("#init-parent")!
        expect(parent.value).toBe("C:\\Users\\developer\\Documents")
        input(parent, "D:\\Source")
        input(container.querySelector<HTMLInputElement>("#init-name")!, "new-project")
        input(container.querySelector<HTMLInputElement>("#init-branch")!, "trunk")
        submit(parent.form!)
        await flush(root)

        expect(dialog.open).toBe(false)
        expect(container.querySelector(".repository-item.active")?.getAttribute("aria-label")).toBe("new-project")
        expect(container.textContent).toContain("Repository initialized and opened.")
        dispose()
    })

    test("updates Git settings without entering the repository operation state", async () => {
        let chooseCalls = 0
        const api = fakeLaneway({
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
        let cloneRequest: string[] = []
        const cloneResult = new Promise<EntryResult>(resolve => finishClone = resolve)
        const api = fakeLaneway({
            cloneRepository: (...request) => {
                cloneRequest = request
                return cloneResult
            },
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
        await flush(root)

        const dialog = container.querySelector<HTMLDialogElement>("dialog[aria-labelledby='clone-heading']")!
        const source = container.querySelector<HTMLInputElement>("#clone-source")!
        const parent = container.querySelector<HTMLInputElement>("#clone-parent")!
        const name = container.querySelector<HTMLInputElement>("#clone-name")!
        expect(parent.value).toBe("C:\\Users\\developer\\Documents")
        input(source, "https://host/team/project.git")
        await flush(root)
        expect(name.value).toBe("project")
        input(parent, "D:\\Source")
        submit(source.form!)
        await flush(root)
        expect(cloneRequest).toEqual(["https://host/team/project.git", "D:\\Source", "project"])

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
        expect(parent.value).toBe("D:\\Source")
        expect(name.value).toBe("project")
        expect(container.textContent).not.toContain("Starting Git")
        expect(container.textContent).not.toContain("Clone cancelled.")
        dispose()
    })

    test("pre-fills the clone source from a clipboard repository address", async () => {
        const api = fakeLaneway({
            entryDefaults: async form => ({ parent: "D:\\Source", ...(form == "clone" ? { source: "https://host/team/project.git" } : {}) }),
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelectorAll<HTMLElement>(".welcome .entry-card")[1]!)
        await flush(root)

        expect(container.querySelector<HTMLInputElement>("#clone-source")!.value).toBe("https://host/team/project.git")
        expect(container.querySelector<HTMLInputElement>("#clone-parent")!.value).toBe("D:\\Source")
        expect(container.querySelector<HTMLInputElement>("#clone-name")!.value).toBe("project")
        dispose()
    })

    test("applies the saved appearance and persists a toggle", async () => {
        const saved: string[] = []
        const api = fakeLaneway({
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
        const api = fakeLaneway({
            getState: async () => {
                attempts++
                if (attempts == 1)
                    throw new Error("Preload unavailable")
                return appState()
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(container.textContent).toContain("Laneway could not start.")
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
        const api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
            selectRepository: async () => openedWorkspace(repository),
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(container.textContent).toContain("feature/laneway")
        expect(container.textContent).not.toContain("other/team")
        expect(container.querySelector(".graph-row svg path")).not.toBeNull()
        // The rail starts as the collapsed icon strip.
        expect(container.querySelector(".shell")?.classList.contains("rail-collapsed")).toBe(true)
        expect(container.querySelector(".repository-close")).toBeNull()
        expect(container.querySelector(".rail-footer > button")?.getAttribute("aria-label")).toBe("Expand repository sidebar")
        expect(container.querySelector(".rail-heading svg")).not.toBeNull()
        expect(container.querySelector("nav[aria-label='Open repositories']")?.lastElementChild?.getAttribute("aria-label")).toBe("Add repository")
        expect(container.querySelector(".repository-item")?.getAttribute("title")).toBe(repository.selectedWorktree)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Expand repository sidebar']")!)
        root.flush()
        expect(container.querySelector(".shell")?.classList.contains("rail-collapsed")).toBe(false)
        expect(container.querySelector(".repository-close")).not.toBeNull()
        click(container.querySelector<HTMLButtonElement>("[aria-label='Collapse repository sidebar']")!)
        root.flush()
        expect(container.querySelector(".shell")?.classList.contains("rail-collapsed")).toBe(true)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Expand repository sidebar']")!)
        root.flush()
        click(container.querySelector<HTMLButtonElement>(".masthead .lens-button")!)
        root.flush()
        expect(container.querySelector(".command-lens")).not.toBeNull()
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        root.flush()

        expect(container.querySelector(".rail-heading")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Open repositories")

        click(button(container, "Show all"))
        root.flush()
        expect(container.textContent).toContain("other/team")

        // Graph rows drag onto columns, so pressing one must leave the native drag free to start; the click selects.
        const feature = container.querySelector<HTMLElement>("[data-node-id='branch:refs/heads/feature/laneway']")!
        const press = new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true, cancelable: true })
        feature.dispatchEvent(press)
        root.flush()
        expect(press.defaultPrevented).toBe(false)
        expect(feature.classList.contains("selected")).toBe(false)
        feature.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }))
        root.flush()
        expect(feature.classList.contains("selected")).toBe(true)
        expect(container.querySelector(".branch-column")).toBeNull()

        click(feature.querySelector<HTMLButtonElement>(".open-branch")!)
        await flush(root)
        expect(container.querySelector(".branch-column")?.textContent).toContain("feature/laneway")

        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))
        root.flush()
        expect(container.querySelector(".command-lens")?.textContent).toContain("Search open repositories and branches.")
        input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, "laneway")
        root.flush()
        expect(container.querySelector(".lens-results")?.textContent).toContain("feature/laneway")
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
        const api = fakeLaneway({
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

    test("background refreshes leave the Branch Graph header still", async () => {
        const repository = repositoryInfo("D:\\Source\\refresh-graph")
        const graph = branchGraph(repository.id)
        let calls = 0
        let finishRefresh: () => void = () => {}
        const refresh = new Promise<void>(resolve => finishRefresh = resolve)
        const api = fakeLaneway({
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
        const toolbar = container.querySelector<HTMLElement>(".graph-toolbar")!
        expect(toolbar.querySelector("h1")?.textContent).toBe("Branch Graph")
        const before = toolbar.innerHTML
        refreshGraph()
        await flush(root)
        expect(calls).toBe(3)
        expect(container.querySelector(".graph-status")).toBeNull()
        expect(toolbar.innerHTML).toBe(before)

        finishRefresh()
        await flush(root)
        expect(toolbar.innerHTML).toBe(before)
        dispose()
    })

    test("drags a repository along the rail while the others step aside, committing the order on release", async () => {
        const alpha = repositoryInfo("D:\\Source\\alpha")
        const beta = repositoryInfo("D:\\Source\\beta")
        const gamma = repositoryInfo("D:\\Source\\gamma")
        let saved = {
            repositories: [alpha, beta, gamma].flatMap(info => openedWorkspace(info).repositories),
            activeRepositoryId: alpha.id,
        }
        const selected: string[] = []
        const api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: saved }),
            readBranchGraph: async () => ({ ok: true, graph: branchGraph(alpha.id) }),
            selectRepository: async id => {
                selected.push(id)
                return saved
            },
            updateWorkspace: async workspace => saved = structuredClone(workspace) as typeof saved,
        })
        const { container, root, dispose } = render(api)
        await flush(root)
        const rows = () => [...container.querySelectorAll<HTMLElement>(".repository-row")]
        const item = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(".repository-item")!
        const order = () => rows().map(row => item(row).getAttribute("aria-label"))
        const offsets = () => rows().map(row => row.style.transform)
        const transitions = () => rows().map(row => row.style.transition)
        const pointer = (type: string, target: EventTarget, clientY: number) =>
            target.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientY, bubbles: true, cancelable: true }))
        const settle = async () => {
            await new Promise(resolve => setTimeout(resolve, 200))
            await flush(root)
        }
        // Happy DOM has no layout: rows are 36px tall with a 4px gap.
        for (const [index, row] of rows().entries()) {
            row.getBoundingClientRect = () => ({ top: index * 40, height: 36 }) as DOMRect
            row.setPointerCapture = () => undefined
        }
        const [first, second, third] = rows()

        // Pressing to drag must not choose the repository.
        const mousedown = new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true, cancelable: true })
        item(second).dispatchEvent(mousedown)
        expect(mousedown.defaultPrevented).toBe(false)

        pointer("pointerdown", item(first), 18)
        pointer("pointermove", document.body, 20)
        await flush(root)
        expect(first.classList.contains("dragging")).toBe(false)
        // A neighbour steps aside once the dragged row covers half of it.
        pointer("pointermove", document.body, 39)
        await flush(root)
        expect(offsets()).toEqual(["translateY(21px)", "", ""])
        pointer("pointermove", document.body, 40)
        await flush(root)
        expect(offsets()).toEqual(["translateY(22px)", "translateY(-40px)", ""])
        // The dragged row tracks the pointer directly while the others ease aside.
        expect(transitions()).toEqual(["", "transform 150ms ease", "transform 150ms ease"])
        pointer("pointermove", document.body, 66)
        await flush(root)
        expect(first.classList.contains("dragging")).toBe(true)
        expect(offsets()).toEqual(["translateY(48px)", "translateY(-40px)", ""])
        // The row follows the pointer but stays within the list.
        pointer("pointermove", document.body, 500)
        await flush(root)
        expect(offsets()).toEqual(["translateY(80px)", "translateY(-40px)", "translateY(-40px)"])
        pointer("pointermove", document.body, 66)
        pointer("pointerup", first, 66)
        item(first).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }))
        await flush(root)
        // Released, the row eases into its slot before the order changes.
        expect(offsets()).toEqual(["translateY(40px)", "translateY(-40px)", ""])
        expect(transitions()).toEqual(["transform 150ms ease", "transform 150ms ease", "transform 150ms ease"])
        expect(order()).toEqual(["alpha", "beta", "gamma"])
        await settle()
        expect(order()).toEqual(["beta", "alpha", "gamma"])
        // Transitions clear with the offsets, so the committed order does not animate.
        expect(offsets()).toEqual(["", "", ""])
        expect(transitions()).toEqual(["", "", ""])
        expect(rows()[1]).toBe(first)
        expect(first.classList.contains("dragging")).toBe(false)
        expect(saved.repositories.map(repository => repository.id)).toEqual([beta.id, alpha.id, gamma.id])
        expect(selected).toEqual([])

        // Escape returns the row to where it started.
        for (const [index, row] of rows().entries())
            row.getBoundingClientRect = () => ({ top: index * 40, height: 36 }) as DOMRect
        pointer("pointerdown", item(third), 98)
        pointer("pointermove", document.body, 10)
        await flush(root)
        expect(offsets()).toEqual(["translateY(40px)", "translateY(40px)", "translateY(-80px)"])
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
        await flush(root)
        expect(offsets()).toEqual(["", "", ""])
        await settle()
        expect(order()).toEqual(["beta", "alpha", "gamma"])

        // A press without movement is an ordinary click.
        pointer("pointerdown", item(third), 98)
        pointer("pointerup", item(third), 98)
        item(third).dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true }))
        await flush(root)
        expect(selected).toEqual([gamma.id])
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
        const api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: saved }),
            readBranchGraph: async () => ({ ok: true, graph }),
            updateWorkspace: async workspace => saved = structuredClone(workspace) as typeof saved,
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(container.querySelector(".status-bar")).toBeNull()
        const masthead = container.querySelector(".masthead")!
        expect(masthead.textContent).toContain("Stashes")
        expect(masthead.querySelector('[aria-label="Undo last operation"]')).not.toBeNull()
        expect(masthead.querySelector('[aria-label="Redo operation"]')).not.toBeNull()
        expect(container.querySelector(".graph-toolbar")?.textContent).not.toContain("Stashes")
        expect(container.querySelector('.graph-toolbar [aria-label="Undo last operation"]')).toBeNull()
        const columnHeaders = [...container.querySelectorAll(".branch-column > header")].map(header => header.textContent).join(" ")
        expect(columnHeaders).not.toContain("refs/heads/")
        expect(columnHeaders).not.toContain(main.tip.slice(0, 8))
        const mainColumn = container.querySelector<HTMLElement>(`[data-column-id='${main.id}']`)!
        mainColumn.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: ">", ctrlKey: true, shiftKey: true, bubbles: true }))
        await flush(root)
        expect(saved.repositories[0].columns.map(column => column.id)).toEqual([feature.id, main.id])
        expect(document.activeElement?.getAttribute("data-column-id")).toBe(main.id)

        const divider = container.querySelector<HTMLElement>(`[data-column-id='${main.id}'] + [role='separator']`)!
        divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
        await flush(root)
        expect(saved.repositories[0].columns.find(column => column.id == main.id)?.width).toBe(390)
        dispose()
    })
})

test("Pull latest freezes open-column scope, streams progress with Cancel, and summarizes outcomes by stack", async () => {
    const repository = repositoryInfo("D:\Source\pull-graph")
    const graph = branchGraph(repository.id)
    const main = graph.branches[0]
    const feature = graph.branches[1]
    const saved = {
        repositories: [{
            status: "available" as const,
            id: repository.id,
            path: repository.mainWorktree,
            info: repository,
            layoutInitialized: true,
            focusedColumnId: feature.id,
            columns: [main, feature].map(branch => ({
                kind: "branch" as const,
                id: branch.id,
                ref: branch.preferredRef,
                lastSeenObjectId: branch.tip,
                width: 380,
                collapsed: branch == main,
            })),
        }],
        activeRepositoryId: repository.id,
    }
    let requested: unknown
    let progress: ((value: { repositoryId: string; message: string; completed: number; total: number }) => void) | undefined
    let finish: ((value: Awaited<ReturnType<Window["laneway"]["pullLatest"]>>) => void) | undefined
    let cancelled = 0
    let graphReads = 0
    const api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: saved }),
        readBranchGraph: async () => {
            graphReads++
            return { ok: true, graph }
        },
        onPullProgress: listener => {
            progress = listener
            return () => progress = undefined
        },
        pullLatest: (_id, request) => {
            requested = request
            return new Promise(resolve => finish = resolve)
        },
        cancelPull: async () => {
            cancelled++
            return true
        },
    })
    const { container, root, dispose } = render(api)
    await flush(root)
    const readsBefore = graphReads
    const pull = button(container, "Pull latest")
    expect(pull.disabled).toBe(false)
    expect(pull.getAttribute("title")).toBe("Fetch and synchronize open stacks")
    click(pull)
    await flush(root)
    expect(requested).toEqual({ branches: [main.preferredRef, feature.preferredRef], remote: "origin" })
    expect(container.querySelector(".masthead .pull-latest")).toBeNull()
    expect(container.querySelector(".masthead .pull-progress")?.textContent).toContain("Fetching…")
    expect(container.querySelector<HTMLButtonElement>('.masthead [aria-label="Undo last operation"]')?.disabled).toBe(true)
    progress!({ repositoryId: repository.id, message: "Updating feature/laneway…", completed: 1, total: 2 })
    await flush(root)
    expect(container.querySelector(".masthead .pull-progress")?.textContent).toContain("Updating feature/laneway…")
    click(button(container, "Cancel pull"))
    await flush(root)
    expect(cancelled).toBe(1)
    expect(container.querySelector(".masthead .pull-progress")?.textContent).toContain("Cancelling")
    finish!({
        ok: true,
        result: {
            type: "result",
            command: "pull",
            status: "updated",
            message: "Pull complete: 1 updated, 1 need resolution.",
            fetches: [{ remote: "origin", status: "fetched" }],
            stacks: [{ id: "a", branches: ["main"], status: "updated", message: undefined }, {
                id: "b",
                branches: ["main", "feature/laneway"],
                status: "needs-resolution",
                message: "1 commit conflict deferred for inline resolution.",
                conflicts: 1,
            }],
            operation: { id: "op", timestamp: "2026-09-20T00:00:00Z", kind: "pull.latest", summary: "Pull latest", affectedRefs: [], affectedWorktrees: [] },
        },
    })
    await flush(root)
    expect(graphReads).toBeGreaterThan(readsBefore)
    const outcome = container.querySelector(".pull-outcome")!
    expect(outcome.querySelector(".pull-summary")?.textContent).toBe("Pull complete: 1 updated, 1 need resolution.")
    expect(outcome.querySelector(".pull-counts")?.textContent).toBe("1 updated · 1 needs resolution")
    const stacks = [...outcome.querySelectorAll<HTMLDetailsElement>(".pull-stack")]
    expect(stacks.map(stack => stack.querySelector(".pull-status")?.textContent)).toEqual(["Updated", "Needs resolution"])
    expect(stacks[1].open).toBe(true)
    expect(stacks[1].textContent).toContain("1 commit conflict deferred")
    expect(container.querySelector(".masthead .pull-latest")).not.toBeNull()
    click(button(outcome as HTMLElement, "Resolve in feature/laneway"))
    await flush(root)
    expect(container.querySelector(".pull-outcome")).toBeNull()
    expect(document.activeElement?.getAttribute("data-column-id")).toBe(feature.id)
    dispose()
})

test("an uneventful Pull latest confirms in passing without a dialog", async () => {
    const repository = repositoryInfo("D:\Source\quiet-pull")
    const graph = branchGraph(repository.id)
    const api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
        pullLatest: async () => ({
            ok: true,
            result: {
                type: "result",
                command: "pull",
                status: "updated",
                message: "Pull complete: 1 updated, 1 already current.",
                fetches: [{ remote: "origin", status: "fetched" }],
                stacks: [{ id: "a", branches: ["main"], status: "updated" }, { id: "b", branches: ["main", "feature/laneway"], status: "current" }],
            },
        }),
    })
    const { container, root, dispose } = render(api)
    await flush(root)
    click(button(container, "Pull latest"))
    await flush(root)
    expect(container.querySelector(".pull-outcome")).toBeNull()
    expect(container.querySelector(".notice:not([hidden])")?.textContent).toContain("Pull complete: 1 updated, 1 already current.")
    dispose()
})

test("confirmation notices close themselves, but not while hovered", async () => {
    // Capture only the notice countdown so the test controls when it elapses.
    const countdowns = new Map<number, () => void>()
    let nextCountdown = 0
    const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = browserWindow
    Object.assign(browserWindow, {
        setTimeout(handler: () => void, delay?: number) {
            if (delay != 5_000)
                return realSetTimeout.call(browserWindow, handler, delay)
            countdowns.set(++nextCountdown, handler)
            return nextCountdown
        },
        clearTimeout(id: number) {
            if (!countdowns.delete(id))
                realClearTimeout.call(browserWindow, id as never)
        },
    })
    const repository = repositoryInfo("D:\Source\quiet-pull")
    const graph = branchGraph(repository.id)
    const api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
        pullLatest: async () => ({
            ok: true,
            result: { type: "result", command: "pull", status: "fetched", message: "Pull complete: 1 already current.", fetches: [], stacks: [] },
        }),
    })
    const { container, root, dispose } = render(api)
    try {
        await flush(root)
        click(button(container, "Pull latest"))
        await flush(root)
        const notice = container.querySelector<HTMLElement>(".notice:not([hidden])")!
        expect(notice.textContent).toContain("Pull complete")
        expect(countdowns.size).toBe(1)
        notice.dispatchEvent(new Event("pointerenter"))
        expect(countdowns.size).toBe(0)
        notice.dispatchEvent(new Event("pointerleave"))
        expect(countdowns.size).toBe(1)
        for (const elapse of countdowns.values())
            elapse()
        await flush(root)
        expect(container.querySelector(".notice:not([hidden])")).toBeNull()
    } finally {
        Object.assign(browserWindow, { setTimeout: realSetTimeout, clearTimeout: realClearTimeout })
        dispose()
    }
})

test("Branch Graph settings apply patterns on Enter, close on Escape, and skip a single-remote choice", async () => {
    const repository = repositoryInfo("D:\Source\graph-settings")
    const graph = branchGraph(repository.id)
    const applied: unknown[] = []
    const api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
        setRepositoryGraphSettings: async (_id, settings) => {
            applied.push(settings)
            return settings
        },
    })
    const { container, root, dispose } = render(api)
    await flush(root)
    const toggle = container.querySelector<HTMLButtonElement>("[aria-label='Branch Graph settings']")!
    click(toggle)
    await flush(root)
    const dialog = container.querySelector<HTMLElement>(".graph-settings")!
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(dialog.querySelector("h2")?.textContent).toBe("Branch Graph settings")
    expect(dialog.querySelector("input[type='radio']")).toBeNull()
    const patterns = dialog.querySelector<HTMLInputElement>("#remote-patterns")!
    input(patterns, "origin/release/**, upstream/topic/*")
    patterns.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush(root)
    expect(applied).toEqual([{ selectedRemote: "origin", remotePatterns: ["origin/release/**", "upstream/topic/*"] }])
    expect(container.querySelector(".graph-settings")).toBeNull()
    click(toggle)
    await flush(root)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    await flush(root)
    expect(container.querySelector(".graph-settings")).toBeNull()
    dispose()
})

test("Pull latest is disabled without remotes and explains why", async () => {
    const repository = repositoryInfo("D:\Source\no-remotes")
    const graph = { ...branchGraph(repository.id), availableRemotes: [], selectedRemote: undefined }
    const api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
    })
    const { container, root, dispose } = render(api)
    await flush(root)
    const pull = button(container, "Pull latest")
    expect(pull.disabled).toBe(true)
    expect(pull.getAttribute("title")).toBe("Add a remote to pull.")
    dispose()
})

test("double-clicking a column header toggles maximizing it, but not on its controls", async () => {
    const scenario = inspectionScenario()
    const initial = await scenario.api.getState()
    const graphResult = await scenario.api.readBranchGraph(initial.workspace.activeRepositoryId!, false)
    if (!graphResult.ok)
        throw new Error("Missing graph")
    const main = graphResult.graph.branches[0]
    main.checkedOut = [{ path: "D:/other", name: "other", head: main.tip, main: false }]
    const view = render(scenario.api)
    await flush(view.root)
    const columnIds = () => [...view.container.querySelectorAll("[data-column-id]")].map(node => node.getAttribute("data-column-id"))
    const opened = columnIds()
    expect(opened.length).toBeGreaterThan(1)
    const header = () => view.container.querySelector<HTMLElement>(`[data-column-id="${opened[1]}"] header`)!
    header().querySelector("button")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(columnIds()).toEqual(opened)
    header().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(columnIds()).toEqual([opened[1]])
    header().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(columnIds()).toEqual(opened)
    view.dispose()
})

test("a diff column opens beside its source column, before the next column, and maximizes it", async () => {
    const scenario = inspectionScenario()
    const initial = await scenario.api.getState()
    const graphResult = await scenario.api.readBranchGraph(initial.workspace.activeRepositoryId!, false)
    if (!graphResult.ok)
        throw new Error("Missing graph")
    const main = graphResult.graph.branches[0]
    main.checkedOut = [{ path: "D:/other", name: "other", head: main.tip, main: false }]
    const view = render(scenario.api)
    await flush(view.root)
    const [source, next] = view.container.querySelectorAll<HTMLElement>(".branch-column")
    const order = () => [...view.container.querySelector(".branch-columns")!.children].map(node => node.classList[0])
    click(source.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
    await flush(view.root)
    for (let opening = 0; opening < 2; opening++) {
        click(source.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!)
        await flush(view.root)
        const children = [...view.container.querySelector(".branch-columns")!.children]
        expect(order()).toEqual(["branch-column", "column-divider", "inspection-breakout", "branch-column", "column-divider"])
        expect([children[0], children[3]]).toEqual([source, next])
        click(view.container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(view.root)
        expect(order()).toEqual(["branch-column", "column-divider", "branch-column", "column-divider"])
    }
    // A diff column's header button or a double-click on its header maximizes its source column, split with the diff.
    click(source.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!)
    await flush(view.root)
    const split = ["branch-column", "column-divider", "inspection-breakout"]
    const header = () => view.container.querySelector<HTMLElement>(".inspection-breakout header")!
    click(header().querySelector<HTMLButtonElement>("[aria-label='Maximize column']")!)
    await flush(view.root)
    expect(order()).toEqual(split)
    expect(view.container.querySelector(".branch-column")).toBe(source)
    expect(source.querySelector("[aria-label='Restore columns']")).not.toBeNull()
    click(header().querySelector<HTMLButtonElement>("[aria-label='Restore columns']")!)
    await flush(view.root)
    expect(order()).toEqual(["branch-column", "column-divider", "inspection-breakout", "branch-column", "column-divider"])
    header().querySelector("button")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(order()).toHaveLength(5)
    header().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(order()).toEqual(split)
    // Closing the diff column leaves its source column maximized on its own.
    click(view.container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
    await flush(view.root)
    expect(order()).toEqual(["branch-column"])
    view.dispose()
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
    const divider = column.nextElementSibling as HTMLElement
    expect(divider.getAttribute("aria-label")).toBe("Resize branch column")
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
    restored.nextElementSibling!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(restored.style.width).toBe("380px")
    expect((await scenario.api.getState()).workspace.repositories[0].columns[0]).toMatchObject({ width: 380 })
    // The Branch Graph starts hidden.
    expect(view.container.querySelector(".graph-layout")?.classList.contains("graph-collapsed")).toBe(true)
    click(view.container.querySelector<HTMLButtonElement>('[aria-label="Show Branch Graph"]')!)
    await flush(view.root)
    expect(view.container.querySelector(".graph-layout")?.classList.contains("graph-collapsed")).toBe(false)
    click(view.container.querySelector<HTMLButtonElement>('[aria-label="Hide Branch Graph"]')!)
    await flush(view.root)
    expect(view.container.querySelector(".graph-layout")?.classList.contains("graph-collapsed")).toBe(true)
    expect(view.container.querySelector('[aria-label="Show Branch Graph"]')).not.toBeNull()
    click(view.container.querySelector<HTMLButtonElement>('[aria-label="Show Branch Graph"]')!)
    await flush(view.root)
    expect(view.container.querySelector('[aria-label="Show Branch Graph"]')).toBeNull()
    // Choosing the repository that is already active toggles its Branch Graph.
    const activeRepository = view.container.querySelector<HTMLButtonElement>(".repository-item.active")!
    expect(activeRepository.getAttribute("aria-expanded")).toBe("true")
    click(activeRepository)
    await flush(view.root)
    expect(view.container.querySelector(".graph-layout")?.classList.contains("graph-collapsed")).toBe(true)
    expect(activeRepository.getAttribute("aria-expanded")).toBe("false")
    click(activeRepository)
    await flush(view.root)
    expect(view.container.querySelector(".graph-layout")?.classList.contains("graph-collapsed")).toBe(false)
    main.checkedOut = []
    refreshGraph()
    await flush(view.root)
    expect((await scenario.api.getState()).workspace.repositories[0].columns.map(column => column.id)).toEqual([branch.id])
    view.dispose()
})

test("hidden Branch Graph still shows the first read's progress and failure", async () => {
    const scenario = inspectionScenario()
    const readGraph = scenario.api.readBranchGraph
    let finish = () => {}
    let fail = false
    scenario.api.readBranchGraph = async (...args) => {
        await new Promise<void>(resolve => finish = resolve)
        return fail ? { ok: false, error: { code: "git.command-failed" as const, message: "Repository is locked" } } : readGraph(...args)
    }
    let view = render(scenario.api)
    await flush(view.root)
    expect(view.container.querySelector(".graph-layout")?.classList.contains("graph-collapsed")).toBe(true)
    expect(view.container.querySelector('[role="progressbar"][aria-label="Loading repository"]')).not.toBeNull()
    finish()
    await flush(view.root)
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull()
    expect(view.container.querySelector("[data-column-id]")).not.toBeNull()
    view.dispose()

    fail = true
    view = render(scenario.api)
    await flush(view.root)
    finish()
    await flush(view.root)
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull()
    expect(view.container.querySelector(".graph-error")?.textContent).toContain("Repository is locked")
    fail = false
    click(view.container.querySelector<HTMLButtonElement>(".graph-error button")!)
    await flush(view.root)
    finish()
    await flush(view.root)
    expect(view.container.querySelector(".graph-error")).toBeNull()
    expect(view.container.querySelector("[data-column-id]")).not.toBeNull()
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
            api: fakeLaneway({
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
            readChanges: async (...args: Parameters<Window["laneway"]["readChanges"]>): Promise<ChangesResult> => {
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
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
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
        expect(comparison.previousElementSibling?.previousElementSibling?.classList.contains("branch-column")).toBe(true)
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
        click(comparison.querySelector<HTMLButtonElement>(".change-file button[aria-expanded]")!)
        await flush(root)
        expect(patches).toBe(1)
        expect(comparison.querySelector(".pierre-diff")).not.toBeNull()
        expect(scenario.saved().repositories[0].columns).toHaveLength(1)
        main.tip = "a".repeat(40)
        refreshGraph()
        await flush(root)
        expect(inventories).toBe(3)
        expect(patches).toBe(2)
        expect(comparison.querySelector("header strong")?.getAttribute("title")).toContain("aaaaaaaa")
        graph.branches = graph.branches.filter(branch => branch != main)
        refreshGraph()
        await flush(root)
        expect(comparison.textContent).toContain("Showing the last comparison")
        graph.branches = [...graph.branches.filter(branch => branch != feature), main]
        refreshGraph()
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
    test("marks column commits and branches their remote already has as remote", async () => {
        const scenario = inspectionScenario()
        const branch = scenario.graph.branches[1]
        const local = "4".repeat(40)
        branch.upstreamRef = "refs/remotes/origin/feature/laneway"
        branch.remoteRefs = [branch.upstreamRef]
        branch.upstreamTip = branch.tip
        branch.tip = local
        branch.ahead = 1
        branch.checkedOut[0].head = local
        // A remote branch reaches main's tip, so its card is remote even though it is a local branch.
        const main = scenario.graph.branches[0]
        main.published = true
        scenario.graph.remoteTips = [branch.upstreamTip, "5".repeat(40)]
        const requests: Parameters<Window["laneway"]["readBranchHistory"]>[1][] = []
        scenario.api.readBranchHistory = async (_repositoryId, request) => {
            requests.push(request)
            return {
                ok: true,
                page: {
                    branchRef: request.branchRef,
                    tip: request.tip,
                    baseTips: request.baseTips,
                    commits: [local, branch.upstreamTip!].map((objectId, index) => ({
                        objectId,
                        parentIds: [index == 0 ? branch.upstreamTip! : scenario.graph.branches[0].tip],
                        subject: index == 0 ? "Unpublished" : "Published",
                        authorName: "Test",
                        authorEmail: "test@example.test",
                        authoredAt: 1788566400,
                        remote: index == 1,
                    })),
                },
            }
        }

        const { container, root, dispose } = render(scenario.api)
        try {
            await flush(root)
            expect(requests[0]).toMatchObject({ tip: local, remoteTips: scenario.graph.remoteTips })
            const commits = [...container.querySelectorAll<HTMLElement>(".inspect-commit")]
            expect(commits.map(commit => [commit.textContent, commit.dataset.remote])).toEqual([["Unpublished", "false"], ["Published", "true"]])
            expect([...container.querySelectorAll(".stack-branch")].map(card => card.classList.contains("remote"))).toEqual([false, true])
        } finally {
            dispose()
        }
    })

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
        const requests: Parameters<Window["laneway"]["readBranchHistory"]>[1][] = []
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
        expect(container.querySelector("[aria-label='Branch after feature/laneway']")).toBeNull()
        click(button(container, "Load more"))
        await flush(root)
        const continuation = container.querySelector<HTMLSelectElement>("[aria-label='Branch after feature/laneway']")!
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
        expect([...column.querySelectorAll(".working-changes mark")].map(mark => mark.textContent).join("")).toBe("src/fisrc/fi")
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
    test("arrow keys move between commits and files, expand and collapse them, and drive the diff column", async () => {
        const scenario = inspectionScenario()
        const { container, root, dispose } = render(scenario.api)
        await flush(root)
        const column = container.querySelector<HTMLElement>(".branch-column")!
        const press = (element: HTMLElement, key: string) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
        // Compared by identity: printing a mismatched Happy DOM element on failure is prohibitively slow.
        const focused = (element: Element | null | undefined) => expect(document.activeElement == element).toBe(true)
        const heading = column.querySelector<HTMLElement>(".commit-heading")!
        heading.focus()
        // Right expands a collapsed commit, and Down then reaches its first file.
        press(heading, "ArrowRight")
        await flush(root)
        expect(heading.getAttribute("aria-expanded")).toBe("true")
        press(heading, "ArrowDown")
        const first = column.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!
        focused(first)
        // Right opens a file's diff beneath it, Left closes it, and Left again returns to the commit.
        press(first, "ArrowRight")
        await flush(root)
        expect(first.closest(".file-inspection")!.querySelector(".diff-inspector")).not.toBeNull()
        press(first, "ArrowLeft")
        await flush(root)
        expect(first.closest(".file-inspection")!.querySelector(".diff-inspector")).toBeNull()
        focused(first)
        press(first, "ArrowLeft")
        focused(heading)
        // Up from the commit reaches the last Working Changes row.
        press(heading, "ArrowUp")
        const working = [...column.querySelectorAll<HTMLElement>(".working-changes .change-file > button")]
        expect(working.length).toBeGreaterThan(0)
        focused(working.at(-1))
        // Down past the last file reaches the base branch's heading, where the sequence ends.
        const last = column.querySelector<HTMLButtonElement>(".inspect-commit [title='other.txt']")!
        last.focus()
        press(last, "ArrowDown")
        const base = column.querySelector<HTMLElement>(".stack-heading")!
        focused(base)
        press(base, "ArrowDown")
        focused(base)
        // Left collapses the commit, which takes its files out of the sequence.
        heading.focus()
        press(heading, "ArrowLeft")
        await flush(root)
        expect(heading.getAttribute("aria-expanded")).toBe("false")
        press(heading, "ArrowDown")
        focused(base)
        press(heading, "ArrowRight")
        await flush(root)
        // With the diff column open, choosing a file keeps focus in the column, and Up and Down select and scroll to files.
        click(container.querySelector<HTMLButtonElement>("[aria-label='Show full diff for commit Inspect changes']")!)
        await flush(root)
        const breakout = container.querySelector<HTMLElement>(".inspection-breakout")!
        focused(breakout)
        breakout.querySelector("header")!.getBoundingClientRect = () => ({ top: 0, bottom: 46 } as DOMRect)
        for (const [index, section] of breakout.querySelectorAll<HTMLElement>("[data-diff-path]").entries())
            section.getBoundingClientRect = () => ({ top: 46 + index * 300 - breakout.scrollTop } as DOMRect)
        const reopened = column.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!
        click(button(breakout, "Collapse all"))
        await flush(root)
        expect(breakout.querySelectorAll(".pierre-diff")).toHaveLength(0)
        reopened.focus()
        click(reopened)
        await flush(root)
        focused(reopened)
        expect(breakout.scrollTop).toBe(0)
        expect(breakout.querySelectorAll(".pierre-diff")).toHaveLength(1)
        expect(breakout.querySelector("[aria-label='Collapse src/file.txt']")).not.toBeNull()
        press(reopened, "ArrowDown")
        await flush(root)
        const second = column.querySelector<HTMLButtonElement>(".inspect-commit [title='other.txt']")!
        focused(second)
        expect(second.parentElement!.classList.contains("active")).toBe(true)
        expect(breakout.scrollTop).toBe(300)
        expect(breakout.querySelector("[aria-label='Collapse other.txt']")).not.toBeNull()
        press(second, "ArrowUp")
        await flush(root)
        focused(reopened)
        expect(reopened.parentElement!.classList.contains("active")).toBe(true)
        expect(breakout.scrollTop).toBe(0)
        // Left on a file shown in the diff column returns to its commit rather than collapsing anything.
        press(reopened, "ArrowLeft")
        focused(heading)
        expect(container.querySelector(".inspection-breakout")).toBe(breakout)
        dispose()
    })
    test("activates on mousedown, except on draggable rows which wait for the click", async () => {
        const scenario = inspectionScenario()
        const { container, root, dispose } = render(scenario.api)
        await flush(root)
        const down = (element: HTMLElement, button = 0) => {
            const event = new MouseEvent("mousedown", { button, detail: 1, bubbles: true, cancelable: true, composed: true })
            element.dispatchEvent(event)
            return event
        }
        const release = (element: HTMLElement) => {
            element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }))
            element.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true, composed: true }))
        }
        // The whole file row drags, and a prevented mousedown would stop the native drag before it starts.
        const file = container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!
        expect(file.closest(".change-file")?.getAttribute("draggable")).toBe("true")
        expect(down(file).defaultPrevented).toBe(false)
        await flush(root)
        expect(file.getAttribute("aria-expanded")).toBe("false")
        release(file)
        await flush(root)
        expect(file.getAttribute("aria-expanded")).toBe("true")
        expect(Boolean(container.querySelector("[aria-label='Select file src/file.txt']"))).toBe(true)
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
        // Commit rows drag too, so the heading toggles on click alone.
        const commit = container.querySelector<HTMLButtonElement>(".commit-heading")!
        expect(commit.closest(".disclosure-heading")?.getAttribute("draggable")).toBe("true")
        expect(down(commit).defaultPrevented).toBe(false)
        await flush(root)
        expect(commit.getAttribute("aria-expanded")).toBe("false")
        release(commit)
        await flush(root)
        expect(commit.getAttribute("aria-expanded")).toBe("true")
        release(commit)
        await flush(root)
        expect(commit.getAttribute("aria-expanded")).toBe("false")
        // The checkbox sits on the draggable file row, so it also waits for the click.
        const checkbox = container.querySelector<HTMLInputElement>("[aria-label='Select file src/file.txt']")!
        down(checkbox)
        await flush(root)
        expect(checkbox.checked).toBe(false)
        release(checkbox)
        await flush(root)
        expect(checkbox.checked).toBe(true)
        checkbox.disabled = true
        down(checkbox)
        await flush(root)
        expect(checkbox.checked).toBe(true)
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
        click(file())
        await flush(root)
        click(file())
        await flush(root)
        expect(reads).toBe(1)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(0)
        click(file())
        await flush(root)
        version = "two"
        window.dispatchEvent(new Event("focus"))
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
            readChanges: async (...args: Parameters<Window["laneway"]["readChanges"]>) => {
                if (args[2].source.kind == "commit")
                    commitInventories++
                return scenario.api.readChanges(...args)
            },
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
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

    test("offers Create branch here from an expanded commit's overflow menu", async () => {
        const scenario = inspectionScenario()
        const { container, root, dispose } = render(scenario.api)
        await flush(root)
        const label = "[aria-label='More actions for commit Inspect changes']"
        expect(container.querySelector(label)).toBeNull()
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        expect(container.querySelector("[aria-label='Create branch at Inspect changes']")).toBeNull()
        expect(container.querySelector("[aria-label='Open commit Inspect changes in new worktree']")).toBeNull()
        click(container.querySelector<HTMLButtonElement>(label)!)
        await flush(root)
        const menu = container.querySelector<HTMLElement>(`dialog${label} [role='menu']`)!
        expect(menu.textContent).toContain("Create branch here…")
        click(button(menu, "Create branch here…"))
        await flush(root)
        expect(container.querySelector(`dialog${label}`)).toBeNull()
        const dialog = container.querySelector<HTMLDialogElement>("dialog[aria-label='Local Git operation']")!
        expect(dialog.querySelector("h2")!.textContent).toBe("Create branch")
        click(button(dialog, "Cancel"))
        await flush(root)
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
        const pending = new Map<string, { id: string; finish(result: FileDiffResult): void; request: Parameters<Window["laneway"]["readFileDiff"]>[2] }>()
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
        // The diff column shows the whole commit, marking the broken-out file in the source list.
        const breakout = container.querySelector<HTMLElement>(".inspection-breakout")!
        const breakoutPaths = () => [...breakout.querySelectorAll<HTMLElement>("[data-diff-path]")].map(element => element.dataset.diffPath)
        const marked = () => [firstRow, secondRow].map(row => row.querySelector(".change-file")!.classList.contains("active"))
        expect(breakoutPaths()).toEqual(["src/file.txt", "other.txt"])
        expect(breakout.querySelector("header")?.textContent).toContain("Commit · Inspect changes")
        expect(marked()).toEqual([false, true])
        const fileToggle = breakout.querySelector<HTMLButtonElement>("[aria-label='Collapse other.txt']")!
        click(fileToggle)
        await flush(root)
        expect(fileToggle.getAttribute("aria-expanded")).toBe("false")
        expect(breakout.querySelector("[data-diff-path='other.txt'] .pierre-diff")).toBeNull()
        expect(breakout.querySelectorAll(".pierre-diff")).toHaveLength(1)
        click(fileToggle)
        await flush(root)
        expect(fileToggle.getAttribute("aria-expanded")).toBe("true")
        expect(diffRoot(breakout.querySelector("[data-diff-path='other.txt']")!).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        click(button(breakout, "Collapse all"))
        await flush(root)
        expect(breakout.querySelectorAll(".pierre-diff")).toHaveLength(0)
        expect(breakout.querySelectorAll(".diff-toolbar [aria-expanded='false']")).toHaveLength(2)
        click(button(breakout, "Expand all"))
        await flush(root)
        expect(breakout.querySelectorAll(".pierre-diff")).toHaveLength(2)
        click(button(breakout, "Collapse all"))
        await flush(root)
        // Choosing another file keeps the column and scrolls it so that file's toolbar sits under the header.
        breakout.querySelector("header")!.getBoundingClientRect = () => ({ top: 0, bottom: 46 } as DOMRect)
        for (const [index, section] of breakout.querySelectorAll<HTMLElement>("[data-diff-path]").entries())
            section.getBoundingClientRect = () => ({ top: 46 + index * 300 - breakout.scrollTop } as DOMRect)
        click(first)
        await flush(root)
        expect(container.querySelectorAll(".branch-column .diff-inspector")).toHaveLength(0)
        expect(container.querySelector(".inspection-breakout")).toBe(breakout)
        expect(breakoutPaths()).toEqual(["src/file.txt", "other.txt"])
        expect(marked()).toEqual([true, false])
        expect(breakout.querySelectorAll(".pierre-diff")).toHaveLength(1)
        expect(breakout.querySelector("[aria-label='Collapse src/file.txt']")).not.toBeNull()
        expect(breakout.scrollTop).toBe(0)
        click(secondRow.querySelector<HTMLButtonElement>("[title='other.txt']")!)
        await flush(root)
        expect(marked()).toEqual([false, true])
        expect(breakout.scrollTop).toBe(300)
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
        const views: string[] = []
        const api = {
            ...scenario.api,
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
                reads++
                views.push(args[2].view ?? "combined")
                return scenario.api.readFileDiff(...args)
            },
        }
        const { container, root, dispose } = render(api)
        await flush(root)
        expect(container.textContent).toContain("Working Changes")
        expect(container.querySelector(".staged-divider")?.textContent).toContain("Staged")
        expect(reads).toBe(0)
        // A partially staged file appears in both lists; each opens its own side without a view toggle.
        const rows = container.querySelectorAll<HTMLButtonElement>("[title='src/file.txt']")
        expect(rows).toHaveLength(2)
        click(rows[0])
        await flush(root)
        expect(reads).toBe(1)
        expect(views).toEqual(["staged"])
        expect(container.querySelector(".diff-views")).toBeNull()
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!)
        await flush(root)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        expect(diffRoot(container).querySelector(".diff-line.addition.selected")).toBeNull()
        click(rows[1])
        await flush(root)
        expect(views).toEqual(["staged", "unstaged"])
        expect(container.querySelectorAll(".diff-inspector")).toHaveLength(2)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(1)
        click(rows[1])
        await flush(root)
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select hunk']")!)
        await flush(root)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(2)
        click(button(container, "Side by side"))
        await flush(root)
        expect(scenario.saved().repositories[0].columns[0].diffLayout).toBe("split")
        click(button(container, "Break out diff"))
        await flush(root)
        expect(container.querySelector(".branch-column + .column-divider")?.nextElementSibling?.classList.contains("inspection-breakout")).toBe(true)
        const breakout = container.querySelector<HTMLElement>(".inspection-breakout")!
        expect(document.activeElement).toBe(breakout)
        expect(breakout.querySelector("header")?.textContent).toContain("Staged · ")
        expect(breakout.dataset.sourceColumnId).toBe(container.querySelector<HTMLElement>(".branch-column")!.dataset.columnId)
        expect(breakout.querySelector(".auxiliary-source")?.textContent).toContain("From ")
        const auxiliaryId = breakout.dataset.auxiliaryId
        click(button(breakout, "Collapse all"))
        await flush(root)
        expect(breakout.querySelectorAll(".pierre-diff")).toHaveLength(0)
        click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        expect(container.querySelector<HTMLElement>(".inspection-breakout")!.dataset.auxiliaryId).toBe(auxiliaryId)
        expect(breakout.querySelectorAll(".pierre-diff")).toHaveLength(1)
        expect(breakout.querySelector("[aria-label='Collapse src/file.txt']")).not.toBeNull()
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
            // A changed file changes the inventory version too; open diffs are only re-read once it does.
            readChanges: async (...args: Parameters<Window["laneway"]["readChanges"]>): Promise<ChangesResult> => {
                const result = await scenario.api.readChanges(...args)
                return result.ok ? { ...result, inventory: { ...result.inventory, version: `${result.inventory.version}:${version}` } } : result
            },
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
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
        window.dispatchEvent(new Event("focus"))
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
            readBranchHistory: async (...args: Parameters<Window["laneway"]["readBranchHistory"]>) => {
                historyReads++
                return scenario.api.readBranchHistory(...args)
            },
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
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

test("sparse File History fills a page of matching commits, stays lazy, and retains progress on refresh", async () => {
    const scenario = inspectionScenario()
    const cursors: Array<string | undefined> = []
    let releaseScan: (() => void) | undefined
    let releaseMore: (() => void) | undefined
    let cancellations = 0
    scenario.api.cancelInspection = async () => {
        cancellations++
        return true
    }
    let patches = 0
    const readDiff = scenario.api.readFileDiff
    scenario.api.readFileDiff = (...args) => {
        patches++
        return readDiff(...args)
    }
    scenario.api.readFileHistory = async (_repo, _id, request) => {
        cursors.push(request.cursor?.objectId)
        const offset = !request.cursor ? 0 : Number(request.cursor.objectId[0]) - 2
        if (offset == 1) {
            await new Promise<void>(resolve => {
                releaseScan = resolve
            })
        }
        if (offset == 3) {
            await new Promise<void>(resolve => {
                releaseMore = resolve
            })
        }
        return {
            ok: true,
            page: {
                tip: "2".repeat(40),
                entries: Array.from({ length: offset == 0 ? 1 : offset == 1 ? 0 : 39 }, (_, index) => ({
                    objectId: (index + offset + 10).toString(16).padStart(40, "0"),
                    parentIds: [],
                    authorName: "Test",
                    authorEmail: "test@example.test",
                    authoredAt: 1,
                    subject: `File commit ${index + offset}`,
                    status: "M",
                    path: request.path,
                })),
                cursor: { objectId: String(offset + 3).repeat(40), path: request.path },
            },
        }
    }
    const { container, root, dispose } = render(scenario.api)
    try {
        await flush(root)
        container.querySelector<HTMLElement>(".change-file")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
        await flush(root)
        click(button(container, "File history"))
        await flush(root)
        const history = container.querySelector<HTMLElement>(".file-history")!
        expect(history.querySelectorAll(".history-entry")).toHaveLength(1)
        expect(cursors).toEqual([undefined, "3".repeat(40)])
        releaseScan!()
        await flush(root)
        expect(history.querySelectorAll(".history-entry")).toHaveLength(40)
        expect(cursors).toEqual([undefined, "3".repeat(40), "4".repeat(40)])
        window.dispatchEvent(new Event("focus"))
        await flush(root)
        expect(cursors.at(-1)).toBeUndefined()
        expect(history.querySelectorAll(".history-entry")).toHaveLength(40)
        expect(patches).toBe(0)
        click(button(history, "Load more history"))
        await flush(root)
        expect(cursors.at(-1)).toBe("5".repeat(40))
        click(history.querySelector<HTMLButtonElement>("[aria-label='Close file history']")!)
        await flush(root)
        expect(cancellations).toBeGreaterThan(0)
        releaseMore!()
        await flush(root)
        expect(container.querySelector(".file-history")).toBeNull()
        expect(cursors.at(-1)).toBe("5".repeat(40))
    } finally {
        dispose()
    }
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
        expect(history.textContent).not.toContain("Following parent 1")
        expect(history.textContent).toContain("Working Changes")
        await menu()
        expect(container.querySelectorAll(".file-history")).toHaveLength(1)
        expect(reads).toBe(1)
        click(button(history, "History commit"))
        await flush(root)
        expect(history.querySelector(".pierre-diff")).not.toBeNull()
        expect(history.querySelector("input[type='checkbox']")).not.toBeNull()
        const commitRow = history.querySelector<HTMLElement>(".history-entry .change-file")!
        expect(history.querySelectorAll(".change-file")).toHaveLength(1)
        for (const label of ["Unified", "Side by side", "Show whitespace"]) {
            const control = commitRow.querySelector<HTMLButtonElement>(`[aria-label='${label}']`)!
            expect(control).not.toBeNull()
            click(control)
            await flush(root)
            expect(control.getAttribute("aria-pressed")).toBe("true")
            expect(button(history, "History commit").getAttribute("aria-expanded")).toBe("true")
        }
        click(button(history, "History commit"))
        await flush(root)
        expect(history.querySelector(".pierre-diff")).toBeNull()
        click(button(history, "History commit"))
        await flush(root)
        expect(history.querySelector(".pierre-diff")).not.toBeNull()
        const historyMenu = async () => {
            commitRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
            await flush(root)
        }
        await historyMenu()
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
        await historyMenu()
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

test("commit composer reveals staging controls, retains cancelled drafts, and commits the staged snapshot", async () => {
    const scenario = inspectionScenario()
    let staged = false, committed = false, version = 0
    let draft = { title: "", message: "", branch: "" }
    const mutations: string[] = []
    const api: Window["laneway"] = {
        ...scenario.api,
        readCommitDraft: async () => ({ ...draft }),
        saveCommitDraft: async (_id, _path, value) => {
            draft = { ...value }
        },
        readChanges: async (...args) => {
            const result = await scenario.api.readChanges(...args)
            if (!result.ok)
                return result
            return {
                ok: true,
                inventory: {
                    ...result.inventory,
                    version: String(version),
                    files: committed ? [] : result.inventory.files.map((file, index) => ({ ...file, staged: staged && index == 0, unstaged: true })),
                },
            }
        },
        localOperation: async (_id, request, token) => {
            if (token) {
                mutations.push(request.action)
                if (request.action == "stage") {
                    expect(request.files).toEqual(["src/file.txt"])
                    staged = !request.unstage
                }
                if (request.action == "commit") {
                    expect(staged).toBe(true)
                    expect(request.title).toBe("Keep snapshot")
                    committed = true
                }
                version++
                return { ok: true, result: { type: "result", command: "local", status: "performed" } }
            }
            return {
                ok: true,
                result: {
                    type: "result",
                    command: "local-preview",
                    status: "preview",
                    preview: {
                        token: String(version),
                        affected: [],
                        uniqueCommits: false,
                        branch: "feature/laneway",
                        unborn: false,
                        suggestedBranch: "feature/laneway",
                        staged,
                        files: [],
                        stashes: [],
                        worktrees: [],
                    },
                },
            }
        },
    }
    const view = render(api)
    try {
        await flush(view.root)
        expect(view.container.querySelector(".staged-divider")).toBeNull()
        expect(view.container.querySelector('[aria-label="Staged files"]')).toBeNull()
        const header = view.container.querySelector(".commit-header")!
        expect(header.textContent).toContain("Working Changes")
        expect(header.textContent).toContain("Commit…")
        expect(header.querySelector('[aria-label="More commit actions"] svg')).not.toBeNull()
        click(button(view.container, "Commit…"))
        await flush(view.root)
        expect(
            view.container.querySelector('[aria-label="Commit title"]')!.compareDocumentPosition(view.container.querySelector(".staged-divider")!)
                & Node.DOCUMENT_POSITION_FOLLOWING,
        ).not.toBe(0)
        expect(view.container.querySelector(".staged-divider")).not.toBeNull()
        expect(view.container.querySelectorAll(".working-changes .change-file")).toHaveLength(2)
        expect(view.container.querySelector('[aria-label^="Stage "]')).toBeNull()
        expect(header.querySelector<HTMLElement>(".commit-split")!.hidden).toBe(true)
        expect(view.container.querySelector('[aria-label="Staged files"]')!.textContent).toContain("Drop files here to stage them")
        expect(button(view.container, "Commit all changes (2)").disabled).toBe(true)
        const title = view.container.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!
        title.value = "Keep snapshot"
        title.dispatchEvent(new Event("input", { bubbles: true }))
        await flush(view.root)
        // Staging is a move between the lists: choose the file, then land it on the staged list.
        click(view.container.querySelector<HTMLButtonElement>('[aria-label="Move or copy src/file.txt"]')!)
        await flush(view.root)
        click(view.container.querySelector<HTMLElement>('[aria-label="Staged files"]')!)
        await flush(view.root)
        expect(view.container.querySelector('[aria-label="Staged files"]')!.textContent).toContain("src/file.txt")
        expect(view.container.querySelector('[aria-label="Staged files"]')!.textContent).not.toContain("other.txt")
        click(button(view.container, "Cancel"))
        await flush(view.root)
        expect(view.container.querySelector('[aria-label="Commit title"]')).toBeNull()
        expect(header.querySelector<HTMLElement>(".commit-split")!.hidden).toBe(false)
        expect(view.container.querySelector('[aria-label="Staged files"]')!.textContent).toContain("src/file.txt")
        expect(view.container.querySelector(".staged-divider")).not.toBeNull()
        expect(draft.title).toBe("Keep snapshot")
        click(button(view.container, "Commit…"))
        await flush(view.root)
        click(button(view.container, "Commit staged (1)"))
        await flush(view.root)
        expect(mutations).toEqual(["stage", "commit"])
        expect(draft.title).toBe("")
        expect(view.container.querySelector('[aria-label="Commit title"]')).toBeNull()
    } finally {
        view.dispose()
    }
})

test("a detached worktree lists its proposed branch below Working Changes with an editable name", async () => {
    const scenario = inspectionScenario()
    const repository = repositoryInfo("D:\Source\inspection")
    const head = "2".repeat(40)
    scenario.graph.branches[1].checkedOut = []
    scenario.graph.virtualBranches = [{
        kind: "virtual",
        id: `virtual:${repository.root}`,
        name: "inspection",
        objectId: head,
        worktree: { path: repository.root, name: "inspection", head, main: true },
        tooltip: "detached at 22222222",
    }]
    let draft = { title: "", message: "", branch: "" }
    const requests: Parameters<Window["laneway"]["localOperation"]>[1][] = []
    const opened = openedWorkspace(repository)
    const api: Window["laneway"] = {
        ...scenario.api,
        getState: async () => ({ ...appState(), workspace: { ...opened, repositories: [{ ...opened.repositories[0], layoutInitialized: true }] } }),
        readCommitDraft: async () => ({ ...draft }),
        saveCommitDraft: async (_id, _path, value) => {
            draft = { ...value }
        },
        localOperation: async (_id, request, token) => {
            if (token) {
                requests.push(request)
                return { ok: true, result: { type: "result", command: "local", status: "performed" } }
            }
            return {
                ok: true,
                result: {
                    type: "result",
                    command: "local-preview",
                    status: "preview",
                    preview: {
                        token: "detached",
                        affected: [],
                        uniqueCommits: false,
                        unborn: false,
                        suggestedBranch: "inspection",
                        staged: false,
                        files: [],
                        stashes: [],
                        worktrees: [],
                    },
                },
            }
        },
    }
    const view = render(api)
    try {
        await flush(view.root)
        expect(view.container.querySelector('[aria-label="New branch name"]')).toBeNull()
        const card = view.container.querySelector<HTMLElement>(".working-changes .virtual-branch")!
        expect(card).not.toBeNull()
        // The proposed branch reads like the branch cards below a real branch's Working Changes.
        expect(view.container.querySelector(".commit-card")!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
        expect(card.querySelector(".virtual-branch-heading svg")).not.toBeNull()
        expect(button(card, "Rename new branch").textContent).toBe("inspection")
        click(button(card, "Rename new branch"))
        await flush(view.root)
        const field = card.querySelector<HTMLInputElement>('[aria-label="New name for new branch"]')!
        input(field, "feature/detached")
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await flush(view.root)
        expect(draft.branch).toBe("feature/detached")
        expect(card.querySelector('[aria-label="New name for new branch"]')).toBeNull()
        expect(button(card, "Rename new branch").textContent).toBe("feature/detached")
        // The commit creates that branch first.
        click(button(view.container, "Commit…"))
        await flush(view.root)
        input(view.container.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!, "First on branch")
        await flush(view.root)
        click(button(view.container, "Commit staged (2)"))
        await flush(view.root)
        expect(requests.map(request => request.action)).toEqual(["branch-create", "commit"])
        expect(requests[0]).toMatchObject({ action: "branch-create", name: "feature/detached", path: repository.root })
    } finally {
        view.dispose()
    }
})

test("a detached worktree proposes its branch before the engine preview answers, and disk changes refresh the graph", async () => {
    const scenario = inspectionScenario()
    const repository = repositoryInfo("D:\\Source\\inspection")
    const head = "2".repeat(40)
    scenario.graph.branches[1].checkedOut = []
    scenario.graph.virtualBranches = [{
        kind: "virtual",
        id: `virtual:${repository.root}`,
        name: "inspection",
        objectId: head,
        worktree: { path: repository.root, name: "inspection", head, main: true },
        tooltip: "detached at 22222222",
    }]
    let releasePreview: (() => void) | undefined
    const released = new Promise<void>(resolve => releasePreview = resolve)
    let graphReads = 0
    let notifyChange: ((change: { repositoryId: string }) => void) | undefined
    const opened = openedWorkspace(repository)
    const api: Window["laneway"] = {
        ...scenario.api,
        getState: async () => ({ ...appState(), workspace: { ...opened, repositories: [{ ...opened.repositories[0], layoutInitialized: true }] } }),
        readBranchGraph: async () => {
            graphReads++
            return { ok: true, graph: scenario.graph }
        },
        onRepositoryChanged: listener => {
            notifyChange = listener
            return () => notifyChange = undefined
        },
        localOperation: async () => {
            await released
            return {
                ok: true,
                result: {
                    type: "result",
                    command: "local-preview",
                    status: "preview",
                    preview: {
                        token: "detached",
                        affected: [],
                        uniqueCommits: false,
                        unborn: false,
                        suggestedBranch: "inspection-2",
                        staged: false,
                        files: [],
                        stashes: [],
                        worktrees: [],
                    },
                },
            }
        },
    }
    const view = render(api)
    try {
        await flush(view.root)
        // The Branch Graph already says the worktree is detached; the engine's slower preview only refines the name.
        const card = () => view.container.querySelector<HTMLElement>(".working-changes .virtual-branch")!
        expect(card()).not.toBeNull()
        expect(button(card(), "Rename new branch").textContent).toBe("worktree/inspection")
        releasePreview!()
        await flush(view.root)
        expect(button(card(), "Rename new branch").textContent).toBe("inspection-2")
        // A change noticed on disk refreshes the active repository without waiting for the next poll.
        const before = graphReads
        notifyChange!({ repositoryId: repository.id })
        await flush(view.root)
        expect(graphReads).toBe(before + 1)
        notifyChange!({ repositoryId: "another repository" })
        await flush(view.root)
        expect(graphReads).toBe(before + 1)
    } finally {
        view.dispose()
    }
})

test("deleting a branch from its column reuses the reviewed preview instead of previewing again", async () => {
    const scenario = inspectionScenario()
    const calls: Array<{ action: string; token?: string }> = []
    const api: Window["laneway"] = {
        ...scenario.api,
        localOperation: async (_id, request, token) => {
            calls.push({ action: request.action, token })
            if (token)
                return { ok: true, result: { type: "result", command: "local", status: "performed" } }
            return {
                ok: true,
                result: {
                    type: "result",
                    command: "local-preview",
                    status: "preview",
                    preview: {
                        token: "reviewed",
                        affected: [],
                        uniqueCommits: false,
                        unborn: false,
                        suggestedBranch: "",
                        staged: false,
                        files: [],
                        stashes: [],
                        worktrees: [],
                    },
                },
            }
        },
    }
    const view = render(api)
    try {
        await flush(view.root)
        const column = view.container.querySelector<HTMLElement>('[data-column-id="branch:refs/heads/feature/laneway"]')!
        column.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }))
        await flush(view.root)
        click(button(view.container, "Delete"))
        await flush(view.root)
        expect(calls.filter(call => call.action == "branch-delete")).toEqual([{ action: "branch-delete", token: undefined }, {
            action: "branch-delete",
            token: "reviewed",
        }])
    } finally {
        view.dispose()
    }
})

test("the column branch renames in place from its heading", async () => {
    const scenario = inspectionScenario()
    const branch = scenario.graph.branches[1]
    const requests: Parameters<Window["laneway"]["localOperation"]>[1][] = []
    const api: Window["laneway"] = {
        ...scenario.api,
        localOperation: async (id, request, token) => {
            if (!token)
                return scenario.api.localOperation(id, request)
            requests.push(request)
            if (request.action != "branch-rename")
                throw new Error(`Unexpected ${request.action}`)
            if (request.newName == "main")
                return { ok: false, error: { message: "Choose an unused local branch name." } }
            Object.assign(branch, {
                id: `branch:refs/heads/${request.newName}`,
                name: request.newName,
                preferredRef: `refs/heads/${request.newName}`,
                refs: [`refs/heads/${request.newName}`],
                aliases: [request.newName],
                localRefs: [`refs/heads/${request.newName}`],
            })
            return { ok: true, result: { type: "result", command: "local", status: "performed" } }
        },
    }
    const view = render(api)
    try {
        await flush(view.root)
        const heading = view.container.querySelector<HTMLElement>(".composition-branch-target")!
        const name = button(heading, "Rename branch feature/laneway")
        expect(name.textContent).toBe("feature/laneway")
        // F2 on the name edits in place instead of opening the rename dialog.
        name.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }))
        await flush(view.root)
        expect(view.container.querySelector('dialog[aria-label="Local Git operation"]')).toBeNull()
        let field = heading.querySelector<HTMLInputElement>('[aria-label="New name for branch feature/laneway"]')!
        input(field, "feature/abandoned")
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await flush(view.root)
        expect(heading.querySelector("input")).toBeNull()
        expect(requests).toHaveLength(0)
        click(button(heading, "Rename branch feature/laneway"))
        await flush(view.root)
        field = heading.querySelector<HTMLInputElement>('[aria-label="New name for branch feature/laneway"]')!
        input(field, "main")
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await flush(view.root)
        // A refused rename keeps the editor open with the reason beside it.
        expect(heading.querySelector('[role="alert"]')!.textContent).toBe("Choose an unused local branch name.")
        field = heading.querySelector<HTMLInputElement>('[aria-label="New name for branch feature/laneway"]')!
        input(field, "feature/renamed")
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await flush(view.root)
        expect(requests).toEqual([{ action: "branch-rename", name: "feature/laneway", newName: "main" }, {
            action: "branch-rename",
            name: "feature/laneway",
            newName: "feature/renamed",
        }])
        const renamed = view.container.querySelector<HTMLElement>(".composition-branch-target")!
        expect(button(renamed, "Rename branch feature/renamed").textContent).toBe("feature/renamed")
        expect(renamed.querySelector("input")).toBeNull()
    } finally {
        view.dispose()
    }
})

function render(api: Window["laneway"]) {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    root.render(createElement(LanewayApp, { api }))
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

// The Branch Graph re-reads whenever the window regains focus.
function refreshGraph() {
    window.dispatchEvent(new Event("focus"))
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

test("Branch Graph settings keep a typed pattern draft across quiet refreshes", async () => {
    const repository = repositoryInfo("D:\Source\graph-settings-draft")
    let graph: BranchGraph = branchGraph(repository.id)
    const api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
        setRepositoryGraphSettings: async (_id, settings) => {
            graph = { ...graph, remotePatterns: settings.remotePatterns }
            return settings
        },
    })
    const { container, root, dispose } = render(api)
    await flush(root)
    click(container.querySelector<HTMLButtonElement>("[aria-label='Branch Graph settings']")!)
    await flush(root)
    const patterns = container.querySelector<HTMLInputElement>("#remote-patterns")!
    input(patterns, "origin/releases/**")
    await flush(root)
    expect(patterns.value).toBe("origin/releases/**")
    refreshGraph()
    await flush(root)
    expect(container.querySelector<HTMLInputElement>("#remote-patterns")!.value).toBe("origin/releases/**")
    patterns.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush(root)
    click(container.querySelector<HTMLButtonElement>("[aria-label='Branch Graph settings']")!)
    await flush(root)
    expect(container.querySelector<HTMLInputElement>("#remote-patterns")!.value).toBe("origin/releases/**")
    dispose()
})

describe("Branch Graph rebase", () => {
    const upstreamTip = "4".repeat(40)
    function scenario(configure: (graph: BranchGraph) => void = () => {}) {
        const repository = repositoryInfo("D:\\Source\\rebase-graph")
        const graph = branchGraph(repository.id)
        const feature = graph.branches[1]
        graph.branches[2].involvement = "involved"
        graph.branches.push({
            ...feature,
            id: "branch:refs/heads/child",
            name: "child",
            preferredRef: "refs/heads/child",
            refs: ["refs/heads/child"],
            aliases: ["child"],
            localRefs: ["refs/heads/child"],
            tip: "5".repeat(40),
            base: { status: "known", branchId: feature.id, name: feature.name, ref: feature.preferredRef, tip: feature.tip },
        })
        graph.history.unshift({ objectId: "5".repeat(40), lineId: "branch:refs/heads/child", parentIds: [feature.tip] })
        configure(graph)
        const calls: Array<{ request: CompositionRequest; token?: string }> = []
        let review: Partial<CompositionPreview> = {}
        const api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
            localOperation: async (_id, request, token) => {
                calls.push({ request: request as CompositionRequest, token })
                if (token)
                    return { ok: true, result: { type: "result", command: "local", status: "performed" } }
                const composition: CompositionPreview = {
                    branches: ["feature/laneway", "child"],
                    removed: [],
                    conflicts: [],
                    published: [],
                    skipped: [],
                    noop: false,
                    commits: [{ objectId: feature.tip, subject: "Laneway work" }],
                    ...review,
                }
                return {
                    ok: true,
                    result: {
                        type: "result",
                        command: "local-preview",
                        status: "preview",
                        preview: {
                            token: `reviewed-${calls.length}`,
                            affected: [],
                            uniqueCommits: false,
                            unborn: false,
                            suggestedBranch: "",
                            staged: false,
                            files: [],
                            stashes: [],
                            worktrees: [],
                            composition,
                        },
                    },
                }
            },
        })
        return { api, calls, review: (value: Partial<CompositionPreview>) => review = value }
    }
    function drag(container: HTMLElement, from: string, to: string) {
        const transfer = new (window as unknown as { DataTransfer: new() => DataTransfer }).DataTransfer()
        const event = (type: string) => {
            const value = new MouseEvent(type, { bubbles: true, cancelable: true })
            Object.defineProperty(value, "dataTransfer", { value: transfer })
            return value
        }
        const source = container.querySelector<HTMLElement>(`[data-node-id="branch:refs/heads/${from}"]`)!
        const target = container.querySelector<HTMLElement>(`[data-node-id="branch:refs/heads/${to}"]`)!
        source.dispatchEvent(event("dragstart"))
        const over = event("dragover")
        target.dispatchEvent(over)
        const highlighted = target.classList.contains("rebase-target")
        if (over.defaultPrevented)
            target.dispatchEvent(event("drop"))
        source.dispatchEvent(event("dragend"))
        return { accepted: over.defaultPrevented, highlighted }
    }
    const notice = (container: HTMLElement) => container.querySelector(".notice:not([hidden])")?.textContent ?? ""
    const dialog = (container: HTMLElement) => container.querySelector<HTMLElement>("dialog.branch-rebase")
    const row = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-node-id="branch:refs/heads/${name}"]`)!
    const feature = { kind: "branch" as const, branch: "refs/heads/feature/laneway", tip: "2".repeat(40) }
    const team = { kind: "branch" as const, branch: "refs/heads/other/team", tip: "3".repeat(40) }

    test("rebases a dropped branch with its dependents straight away when nothing needs deciding", async () => {
        const { api, calls } = scenario()
        const view = render(api)
        try {
            await flush(view.root)
            // The Primary Branch has no Base to bound its commits, and a branch can't land on one stacked on it.
            expect(drag(view.container, "main", "feature/laneway").accepted).toBe(false)
            expect(drag(view.container, "feature/laneway", "child").accepted).toBe(false)
            expect(calls).toEqual([])
            expect(drag(view.container, "feature/laneway", "other/team")).toEqual({ accepted: true, highlighted: true })
            await flush(view.root)
            expect(row(view.container, "other/team").classList.contains("rebase-target")).toBe(false)
            expect(dialog(view.container)).toBeNull()
            expect(calls.map(call => [call.request.source, call.request.target, call.request.descendants, call.token])).toEqual([[
                feature,
                team,
                true,
                undefined,
            ], [feature, team, true, "reviewed-1"]])
            expect(notice(view.container)).toContain("Rebased feature/laneway and child onto other/team.")
        } finally {
            view.dispose()
        }
    })

    test("asks which tip to rebase onto when the destination's local tip lags its upstream", async () => {
        const { api, calls } = scenario(graph => {
            Object.assign(graph.branches[0], { upstreamRef: "refs/remotes/origin/main", upstreamTip, behind: 2, remoteRefs: ["refs/remotes/origin/main"] })
        })
        const view = render(api)
        try {
            await flush(view.root)
            drag(view.container, "feature/laneway", "main")
            await flush(view.root)
            const shown = dialog(view.container)!
            expect(shown.textContent).toContain("Local tip, 2 commits behind origin/main")
            expect(shown.textContent).toContain("1 commit since main")
            expect(shown.textContent).toContain("Laneway work")
            expect(calls.map(call => call.request.target)).toEqual([{ kind: "branch", branch: "refs/heads/main", tip: "1".repeat(40) }])
            const upstream = [...shown.querySelectorAll<HTMLInputElement>("input[type=radio]")][1]
            upstream.checked = true
            upstream.dispatchEvent(new Event("change", { bubbles: true }))
            await flush(view.root)
            expect(calls.at(-1)?.request.target).toEqual({ kind: "branch", branch: "refs/remotes/origin/main", tip: upstreamTip })
            click(button(dialog(view.container)!, "Rebase"))
            await flush(view.root)
            expect(calls.at(-1)).toMatchObject({ token: "reviewed-2", request: { target: { branch: "refs/remotes/origin/main" } } })
            expect(dialog(view.container)).toBeNull()
            expect(notice(view.container)).toContain("onto origin/main.")
        } finally {
            view.dispose()
        }
    })

    test("confirms published rewrites, can leave dependents behind, and opens conflicts to resolve now", async () => {
        const { api, calls, review } = scenario()
        const view = render(api)
        try {
            await flush(view.root)
            review({ published: ["feature/laneway"] })
            drag(view.container, "feature/laneway", "other/team")
            await flush(view.root)
            expect(dialog(view.container)!.textContent).toContain("Rewrites history already published on feature/laneway")
            const dependents = dialog(view.container)!.querySelector<HTMLInputElement>("input[type=checkbox]")!
            expect(dependents.parentElement?.textContent).toContain("Move dependent branches too: child")
            review({ published: ["feature/laneway"], branches: ["feature/laneway"] })
            dependents.checked = false
            dependents.dispatchEvent(new Event("change", { bubbles: true }))
            await flush(view.root)
            expect(calls.at(-1)?.request.descendants).toBe(false)
            // The dependents stay on offer after a review that leaves them out.
            expect(dialog(view.container)!.textContent).toContain("Move dependent branches too: child")
            click(button(dialog(view.container)!, "Rebase"))
            await flush(view.root)
            expect(calls.at(-1)).toMatchObject({ token: "reviewed-2", request: { descendants: false, allowConflicts: false } })
            expect(notice(view.container)).toContain("Rebased feature/laneway onto other/team.")

            review({ conflicts: [{ subject: "commit 22222222", files: ["src/file.txt"] }] })
            drag(view.container, "feature/laneway", "other/team")
            await flush(view.root)
            expect(dialog(view.container)!.textContent).toContain("Conflicts in commit 22222222: src/file.txt")
            click(button(dialog(view.container)!, "Continue and resolve now"))
            await flush(view.root)
            expect(calls.at(-1)).toMatchObject({ token: "reviewed-4", request: { allowConflicts: true } })
            expect(view.container.querySelector("[data-column-id='branch:refs/heads/feature/laneway']")).not.toBeNull()
        } finally {
            view.dispose()
        }
    })

    test("chooses a destination by keyboard or from the context menu", async () => {
        const { api, calls } = scenario()
        const view = render(api)
        try {
            await flush(view.root)
            const rows = view.container.querySelector<HTMLElement>(".graph-rows")!
            click(row(view.container, "feature/laneway"))
            await flush(view.root)
            rows.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }))
            await flush(view.root)
            expect(row(view.container, "feature/laneway").classList.contains("rebase-source")).toBe(true)
            expect(notice(view.container)).toContain("Rebase feature/laneway · Choose a destination branch")
            // Enter on the source itself only explains what to choose.
            rows.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
            await flush(view.root)
            expect(calls).toEqual([])
            expect(notice(view.container)).toContain("Choose a branch other than feature/laneway")
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
            await flush(view.root)
            expect(row(view.container, "feature/laneway").classList.contains("rebase-source")).toBe(false)

            row(view.container, "feature/laneway").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
            await flush(view.root)
            click(button(view.container, "Rebase onto…"))
            await flush(view.root)
            expect(row(view.container, "feature/laneway").classList.contains("rebase-source")).toBe(true)
            click(row(view.container, "other/team"))
            await flush(view.root)
            expect(calls.map(call => call.request.target)).toEqual([team, team])
            expect(row(view.container, "feature/laneway").classList.contains("rebase-source")).toBe(false)
        } finally {
            view.dispose()
        }
    })
})
