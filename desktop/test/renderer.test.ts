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
    test("initializes a repository and opens the resulting session", async () => {
        const repository = repositoryInfo("D:\\Source\\new-project")
        const api = fakeWorkbench({
            initializeRepository: async (path, branch) => {
                expect(path).toBe("D:\\Source\\new-project")
                expect(branch).toBe("trunk")
                return { ok: true, session: { repositories: [repository], activeRepositoryId: repository.id } }
            },
        })
        const { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelectorAll<HTMLElement>(".entry-card")[2]!)
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
        click(container.querySelectorAll<HTMLElement>(".entry-card")[1]!)
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
        expect(container.textContent).toContain("Put a line of work")
        expect(attempts).toBe(2)
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
        session: { repositories: [] },
        settings: {
            path: "C:\\Users\\developer\\settings.json",
            git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.51.1" },
        },
        engine: { state: "ready" as const, path: "D:\\GitWorkbench\\cli\\bin\\workbench-engine.exe", name: "workbench-engine" as const, version: "0.1.0" },
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
        chooseGit: async () => appState().settings,
        useGitFromPath: async () => appState().settings,
        resetSettings: async () => appState().settings,
        openSettingsFile: async () => "",
        onEntryProgress: () => () => undefined,
        ...overrides,
    }
}
