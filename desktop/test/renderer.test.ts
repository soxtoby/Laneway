import type { EntryProgress, EntryResult } from "@git-workbench/shared"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Window as HappyWindow } from "happy-dom"
import type { createElement as createRemixElement, createRoot as createRemixRoot, VirtualRoot } from "remix/ui"
import type { WorkbenchApp as WorkbenchAppComponent } from "../src/renderer/src/app"

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
        "EventTarget",
        "MouseEvent",
        "KeyboardEvent",
        "SubmitEvent",
    ]
    browserGlobal.window = browserWindow
    browserGlobal.document = browserWindow.document
    for (const name of globals)
        Object.defineProperty(globalThis, name, { configurable: true, value: browserGlobal[name] })
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

        click(button(container, "Show all"))
        root.flush()
        expect(container.textContent).toContain("other/team")

        const feature = container.querySelector<HTMLElement>("[data-node-id='branch:refs/heads/feature/workbench']")!
        click(feature)
        root.flush()
        expect(feature.classList.contains("selected")).toBe(true)
        expect(container.querySelector(".branch-column")).toBeNull()

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
        const api = fakeWorkbench({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        expect(container.querySelectorAll(".graph-row").length).toBeLessThan(30)
        expect(container.querySelector(".graph-spacer")).not.toBeNull()
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
    const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent?.trim() == label)
    if (!result)
        throw new Error(`Button not found: ${label}. Rendered: ${container.textContent}`)
    return result
}

function appState() {
    return {
        workspace: { repositories: [] },
        settings: {
            path: "C:\\Users\\developer\\settings.json",
            git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.51.1" },
            authorIdentities: { secondary: [] },
        },
        engine: { state: "ready" as const, path: "D:\\GitWorkbench\\cli\\bin\\workbench-engine.exe", name: "workbench-engine" as const, version: "0.1.0" },
        appearance: "light" as const,
        defaultCloneParent: "C:\\Users\\developer\\Documents",
    }
}

function repositoryInfo(path: string) {
    return {
        id: `${path}\\.git`,
        root: path,
        mainWorktree: path,
        selectedWorktree: path,
        commonDirectory: `${path}\\.git`,
        gitDirectory: `${path}\\.git`,
        objectFormat: "sha1" as const,
        shallow: false,
        partial: false,
        sparse: false,
        git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.51.1" },
    }
}

function openedWorkspace(info: ReturnType<typeof repositoryInfo>) {
    return {
        repositories: [{ status: "available" as const, id: info.id, path: info.mainWorktree, info, columns: [], layoutInitialized: false }],
        activeRepositoryId: info.id,
    }
}

function branchGraph(repositoryId: string) {
    const main = {
        kind: "branch" as const,
        id: "branch:refs/heads/main",
        name: "main",
        preferredRef: "refs/heads/main",
        refs: ["refs/heads/main"],
        aliases: ["main"],
        localRefs: ["refs/heads/main"],
        remoteRefs: [],
        tip: "1".repeat(40),
        ahead: 0,
        behind: 0,
        base: { status: "unknown" as const, candidates: [] },
        involvement: "uninvolved" as const,
        checkedOut: [],
        markers: [],
        tags: [],
        primary: true,
        remoteOnly: false,
    }
    const branch = (name: string, involvement: "involved" | "uninvolved") => ({
        ...main,
        id: `branch:refs/heads/${name}`,
        name,
        preferredRef: `refs/heads/${name}`,
        refs: [`refs/heads/${name}`],
        aliases: [name],
        localRefs: [`refs/heads/${name}`],
        tip: involvement == "involved" ? "2".repeat(40) : "3".repeat(40),
        base: { status: "known" as const, branchId: main.id, name: "main", ref: main.preferredRef, tip: main.tip },
        involvement,
        primary: false,
    })
    return {
        repositoryId,
        primaryBranch: { status: "known" as const, remote: "origin", ref: main.preferredRef },
        availableRemotes: ["origin"],
        selectedRemote: "origin",
        remotePatterns: [],
        authorIdentities: { primary: "developer@example.test", secondary: [] },
        effectiveAuthorEmail: "developer@example.test",
        branches: [main, branch("feature/workbench", "involved"), branch("other/team", "uninvolved")],
        tags: [],
        virtualBranches: [],
        unassignedStashes: [],
        limited: [],
    }
}

function fakeWorkbench(overrides: Partial<Window["workbench"]> = {}): Window["workbench"] {
    return {
        getState: async () => appState(),
        openRepository: async () => ({ ok: false, error: { code: "git.cancelled", message: "Cancelled" } }),
        chooseDirectory: async defaultPath => defaultPath,
        suggestCloneDestination: async (_source, parent) => `${parent}\\project`,
        cloneRepository: async () => ({ ok: false, error: { code: "git.cancelled", message: "Cancelled" } }),
        initializeRepository: async () => ({ ok: false, error: { code: "git.cancelled", message: "Cancelled" } }),
        cancelEntry: async () => true,
        selectRepository: async () => ({ repositories: [] }),
        closeRepository: async () => ({ repositories: [] }),
        locateRepository: async () => ({ repositories: [] }),
        updateWorkspace: async workspace => workspace,
        resetWorkspace: async () => ({ repositories: [] }),
        chooseGit: async () => appState().settings,
        useGitFromPath: async () => appState().settings,
        resetSettings: async () => appState().settings,
        setAuthorIdentities: async authorIdentities => ({ ...appState().settings, authorIdentities }),
        openSettingsFile: async () => "",
        setAppearance: async appearance => appearance,
        readBranchGraph: async () => ({ ok: false, error: { code: "git.command-failed", message: "Graph unavailable" } }),
        cancelBranchGraph: async () => false,
        readBranchHistory: async () => ({ ok: false, error: { code: "git.command-failed", message: "History unavailable" } }),
        cancelBranchHistory: async () => false,
        setRepositoryGraphSettings: async (_repositoryId, settings) => settings,
        onEntryProgress: () => () => undefined,
        ...overrides,
    }
}
