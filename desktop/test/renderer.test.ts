import type { BranchGraph, ChangedFile, ChangesResult, CompositionPreview, CompositionRequest, DiffLine, DiffSource, EntryProgress, EntryResult, FileDiffResult, FileListView, LocalRequest, Workspace, WorktreeRequest } from "@laneway/shared"
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
    let browserGlobal = browserWindow as unknown as Record<string, unknown>
    let globals = [
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
        "navigator",
    ]
    browserGlobal.window = browserWindow
    browserGlobal.document = browserWindow.document
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browserWindow.requestAnimationFrame.bind(browserWindow) })
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browserWindow.cancelAnimationFrame.bind(browserWindow) })
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: browserWindow.getComputedStyle.bind(browserWindow) })
    for (let name of globals)
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

for (let action of ["restore", "remove"] as const) {
    test(`interrupted worktree removal has one recovery column and ${action} resolves it`, async () => {
        let scenario = inspectionScenario()
        let failedBranch = scenario.graph.branches[2]!
        let recovery = {
            operationId: "c290421f-295c-4e27-8934-eeb57e63369c",
            worktreeId: "failed",
            path: "D:/project.worktrees/failed",
            head: failedBranch.tip,
            branchRef: failedBranch.preferredRef,
            message: "Files remain in the worktree directory after its Git registration was removed.",
        }
        let recoveries = [recovery]
        let requests: unknown[] = []
        let previews = 0
        let saved = scenario.saved()
        saved.repositories[0]!.columns.push({
            kind: "branch",
            id: failedBranch.id,
            ref: failedBranch.preferredRef,
            lastSeenObjectId: failedBranch.tip,
            worktreePath: recovery.path,
            worktreeId: recovery.worktreeId,
            width: 420,
        })
        await scenario.api.updateWorkspace(saved)
        scenario.api.readBranchGraph = async () => ({ ok: true, graph: scenario.graph, worktreeRecoveries: recoveries })
        let preview = scenario.api.localOperation
        scenario.api.localOperation = async (...args) => {
            previews++
            return preview(...args)
        }
        scenario.api.recoverWorktree = async (_id, request) => {
            requests.push(request)
            recoveries = []
            if (request.action == "restore") {
                failedBranch.checkedOut = [{
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
        let view = render(scenario.api)
        try {
            await flush(view.root)
            let column = view.container.querySelector<HTMLElement>(`[data-column-id='recovery:${recovery.operationId}']`)!
            expect(column.style.width).toBe("420px")
            expect(view.container.querySelectorAll(".worktree-recovery")).toHaveLength(1)
            expect(column.textContent).toContain("Worktree removal interrupted")
            expect(column.textContent).toContain(recovery.path)
            expect(column.textContent).toContain("Remove deletes leftover files and keeps only the saved Git state for Undo.")
            expect(view.container.querySelector(".commit-notice")).toBeNull()
            expect(previews).toBe(0)
            click(column.querySelector<HTMLElement>("[aria-label='Maximize column']")!)
            await flush(view.root)
            click(button(column, action == "restore" ? "Recover" : "Remove"))
            await flush(view.root)
            expect(requests).toEqual([{ operationId: recovery.operationId, action }])
            expect(view.container.querySelector(".worktree-recovery")).toBeNull()
            expect(view.container.querySelector(".branch-column")).not.toBeNull()
            expect(previews).toBeGreaterThan(0)
            let restored = scenario.saved().repositories[0]!.columns.find(column => column.id == failedBranch.id)
            if (action == "restore")
                expect(restored).toMatchObject({ width: 420, worktreeId: recovery.worktreeId })
            else
                expect(restored).toBeUndefined()
        } finally {
            view.dispose()
        }
    })
}

test("failed recovery stays in its column across restart and reports its specific failure", async () => {
    let scenario = inspectionScenario()
    let recovery = {
        operationId: "c290421f-295c-4e27-8934-eeb57e63369c",
        worktreeId: "failed",
        path: "D:/project.worktrees/failed",
        head: scenario.graph.branches[2]!.tip,
        message: "Files remain in the directory.",
    }
    scenario.api.readBranchGraph = async () => ({ ok: true, graph: scenario.graph, worktreeRecoveries: [recovery] })
    scenario.api.recoverWorktree = async () => ({ ok: false, error: { message: "The directory is locked by another program." } })
    let view = render(scenario.api)
    try {
        await flush(view.root)
        click(button(view.container.querySelector(".worktree-recovery")!, "Recover"))
        await flush(view.root)
        expect(view.container.querySelector(".worktree-recovery [role='alert']")?.textContent).toBe("The directory is locked by another program.")
        expect(view.container.querySelectorAll(".worktree-recovery")).toHaveLength(1)
        expect(scenario.saved().repositories[0]!.columns.some(column => column.id == `recovery:${recovery.operationId}`)).toBe(true)
        view.dispose()
        view = render(scenario.api)
        await flush(view.root)
        expect(view.container.querySelectorAll(".worktree-recovery")).toHaveLength(1)
        expect(button(view.container.querySelector(".worktree-recovery")!, "Remove")).not.toBeNull()
    } finally {
        view.dispose()
    }
})

test("missing worktrees show column actions and keep available history readable", async () => {
    let scenario = inspectionScenario()
    let branch = scenario.graph.branches[2]!
    let worktree = { id: "missing", path: "D:/project.worktrees/missing", name: "missing", head: branch.tip, main: false, missing: true }
    branch.checkedOut = [worktree]
    let saved = scenario.saved()
    saved.repositories[0]!.columns.push({
        kind: "branch",
        id: branch.id,
        ref: branch.preferredRef,
        lastSeenObjectId: branch.tip,
        worktreePath: worktree.path,
        width: 380,
    })
    await scenario.api.updateWorkspace(saved)
    let workingReads: string[] = []
    let readChanges = scenario.api.readChanges
    scenario.api.readChanges = async (...args) => {
        if (args[2].source.kind == "working")
            workingReads.push(args[2].source.worktreePath)
        return readChanges(...args)
    }
    let previews: WorktreeRequest[] = []
    let chosenPaths: (string | undefined)[] = []
    scenario.api.chooseDirectory = async path => {
        chosenPaths.push(path)
        return "D:/relocated/missing"
    }
    scenario.api.previewWorktree = async (_id, request) => {
        previews.push(request)
        return {
            ok: true,
            preview: {
                request,
                worktrees: [],
                affected: [worktree.path],
                ignored: [],
                ignoredCount: 0,
                dirty: false,
                uniqueCommits: false,
                populatedSubmodules: false,
                token: "missing",
            },
        }
    }
    let view = render(scenario.api)
    try {
        await flush(view.root)
        let column = view.container.querySelector<HTMLElement>(`[data-column-id='${branch.id}']`)!
        expect(column.querySelector(".missing-worktree")?.textContent).toContain("Worktree directory missing")
        expect(column.querySelector(".stack-branch")?.textContent).toContain("Inspect changes")
        expect(column.querySelector(".working-changes")).toBeNull()
        expect(workingReads).not.toContain(worktree.path)
        expect(view.container.querySelector(".working-changes")).not.toBeNull()
        click(button(column, "Repair"))
        await flush(view.root)
        expect(chosenPaths).toEqual([worktree.path])
        expect(previews[0]).toEqual({ action: "repair", path: worktree.path, destination: "D:/relocated/missing" })
        click(button(view.container.querySelector<HTMLElement>("dialog")!, "Cancel"))
        await flush(view.root)
        click(button(column, "Remove"))
        await flush(view.root)
        expect(previews[1]).toMatchObject({ action: "remove", path: worktree.path, preserve: true })
        click(button(view.container.querySelector<HTMLElement>("dialog")!, "Cancel"))
        await flush(view.root)
        click(column.querySelector<HTMLElement>("[aria-label='Collapse other/team']")!)
        await flush(view.root)
        expect(column.textContent).toContain("Missing")
        expect(workingReads).not.toContain(worktree.path)
    } finally {
        view.dispose()
    }
})

test("a missing detached worktree resumes Working Changes after its directory returns", async () => {
    let scenario = inspectionScenario()
    let worktree = { id: "detached", path: "D:/project.worktrees/detached", name: "detached", head: "4".repeat(40), main: false, missing: true }
    scenario.graph.virtualBranches.push({
        kind: "virtual",
        id: "virtual:detached",
        name: "detached",
        objectId: worktree.head,
        worktree,
        tooltip: "Detached worktree",
    })
    let workingReads: string[] = []
    let readChanges = scenario.api.readChanges
    scenario.api.readChanges = async (...args) => {
        if (args[2].source.kind == "working")
            workingReads.push(args[2].source.worktreePath)
        return readChanges(...args)
    }
    let view = render(scenario.api)
    try {
        await flush(view.root)
        let column = view.container.querySelector<HTMLElement>("[data-column-id='virtual:detached']")!
        expect(button(column, "Repair").disabled).toBe(false)
        expect(button(column, "Remove").disabled).toBe(false)
        expect(column.querySelector(".working-changes")).toBeNull()
        expect(workingReads).not.toContain(worktree.path)
        worktree.missing = false
        refreshGraph()
        await flush(view.root)
        expect(column.querySelector(".working-changes")).not.toBeNull()
        expect(workingReads).toContain(worktree.path)
        click(column.querySelector<HTMLElement>("[aria-label='Collapse detached']")!)
        await flush(view.root)
        worktree.missing = true
        refreshGraph()
        await flush(view.root)
        expect(column.textContent).toContain("Missing")
        let count = workingReads.filter(path => path == worktree.path).length
        refreshGraph()
        await flush(view.root)
        expect(workingReads.filter(path => path == worktree.path)).toHaveLength(count)
        click(column.querySelector<HTMLElement>("[aria-label='Expand detached']")!)
        await flush(view.root)
        expect(column.querySelector(".missing-worktree")).not.toBeNull()
        expect(column.querySelector(".working-changes")).toBeNull()
    } finally {
        view.dispose()
    }
})

test("worktree creation previews the destination and mutates only after confirmation", async () => {
    let scenario = inspectionScenario()
    let executions = 0, previews = 0
    scenario.api.previewWorktree = async (_id, request) => {
        previews++
        return {
            ok: true,
            preview: {
                request,
                worktrees: [],
                destination: "D:/project.worktrees/feature",
                affected: ["D:/project.worktrees/feature"],
                ignored: [],
                ignoredCount: 0,
                dirty: false,
                uniqueCommits: false,
                populatedSubmodules: false,
                token: "current",
            },
        }
    }
    scenario.api.executeWorktree = async (_id, request, token) => {
        expect(request.action).toBe("create")
        expect(token).toBe("current")
        executions++
        return { ok: true }
    }
    let { container, root, dispose } = render(scenario.api)
    await flush(root)
    click(button(container.querySelector("[data-node-id='branch:refs/heads/main']")!, "Open"))
    await flush(root)
    click(container.querySelector<HTMLElement>(".column-worktree [aria-label='Check out branch']")!)
    await flush(root)
    click(button(container, "New worktree"))
    await flush(root)
    let dialog = container.querySelector<HTMLDialogElement>('dialog[aria-label="Worktree operation"]')!
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
    // Each dialog previews once; confirmation hands the reviewed token straight to the Engine.
    expect(previews).toBe(2)
    dispose()
})

test("worktree row renames inline and switches through branch search; removal stays in overflow", async () => {
    let scenario = inspectionScenario()
    let readGraph = scenario.api.readBranchGraph
    scenario.api.readBranchGraph = async (...args) => {
        let result = await readGraph(...args)
        if (result.ok)
            result.graph.branches[1]!.checkedOut[0]!.main = false
        return result
    }
    let requests: WorktreeRequest[] = []
    scenario.api.previewWorktree = async (_id, request) => {
        requests.push(request)
        return { ok: false, error: { message: "Preview requested" } }
    }
    let { container, root, dispose } = render(scenario.api)
    try {
        await flush(root)
        let row = container.querySelector<HTMLElement>(".column-worktree")!
        expect(row.querySelector("details, select, input")).toBeNull()
        expect(row.textContent).not.toContain("Remove")
        expect(row.textContent).not.toContain("commit")
        let rename = row.querySelector<HTMLButtonElement>("[aria-label='Rename worktree']")!
        click(rename)
        await flush(root)
        let name = row.querySelector<HTMLInputElement>("[aria-label='Worktree directory name']")!
        expect(name.value).toBe("inspection")
        input(name, "cancelled")
        name.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        await flush(root)
        expect(requests).toEqual([])
        expect(row.querySelector("input")).toBeNull()
        click(row.querySelector<HTMLButtonElement>("[aria-label='Rename worktree']")!)
        await flush(root)
        let nextName = row.querySelector<HTMLInputElement>("input")!
        input(nextName, "renamed")
        await flush(root)
        expect(nextName.value).toBe("renamed")
        nextName.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await flush(root)
        expect(requests).toEqual([{ action: "rename", path: "D:\\Source\\inspection", basename: "renamed" }])
        click(button(container.querySelector("dialog")!, "Cancel"))
        await flush(root)

        click(row.querySelector<HTMLButtonElement>("[aria-label='Worktree actions']")!)
        await flush(root)
        let switchBranch = row.querySelector<HTMLButtonElement>("[role='menu'] [aria-label='Switch worktree branch']")!
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
                    ignored: ["generated.bin"],
                    ignoredCount: 1,
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
        let removeDialog = container.querySelector<HTMLDialogElement>('dialog[aria-label="Worktree operation"]')!
        expect(removeDialog.textContent).toContain("Working Changes detected")
        expect(removeDialog.textContent).toContain("outside undo: generated.bin.")
        click(button(removeDialog, "Remove worktree"))
        await flush(root)
        expect(executed).toEqual({ action: "remove", path: "D:\\Source\\inspection", preserve: true, allowIgnoredLoss: true })
    } finally {
        dispose()
    }
})

describe("Remix repository entry renderer", () => {
    test("initializes a repository and opens the resulting workspace", async () => {
        let repository = repositoryInfo("D:\\Source\\new-project")
        let api = fakeLaneway({
            initializeRepository: async (parent, name, branch) => {
                expect(parent).toBe("D:\\Source")
                expect(name).toBe("new-project")
                expect(branch).toBe("trunk")
                return { ok: true, workspace: openedWorkspace(repository) }
            },
        })
        let { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelectorAll<HTMLElement>(".welcome .entry-card")[2]!)
        await flush(root)
        let dialog = container.querySelector<HTMLDialogElement>("dialog[aria-labelledby='init-heading']")!
        let parent = container.querySelector<HTMLInputElement>("#init-parent")!
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
        let api = fakeLaneway({
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
        let { container, root, dispose } = render(api)

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
        let cloneResult = new Promise<EntryResult>(resolve => finishClone = resolve)
        let api = fakeLaneway({
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
        let { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelectorAll<HTMLElement>(".welcome .entry-card")[1]!)
        await flush(root)

        let dialog = container.querySelector<HTMLDialogElement>("dialog[aria-labelledby='clone-heading']")!
        let source = container.querySelector<HTMLInputElement>("#clone-source")!
        let parent = container.querySelector<HTMLInputElement>("#clone-parent")!
        let name = container.querySelector<HTMLInputElement>("#clone-name")!
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
        let api = fakeLaneway({
            entryDefaults: async form => ({ parent: "D:\\Source", ...(form == "clone" ? { source: "https://host/team/project.git" } : {}) }),
        })
        let { container, root, dispose } = render(api)

        await flush(root)
        click(container.querySelectorAll<HTMLElement>(".welcome .entry-card")[1]!)
        await flush(root)

        expect(container.querySelector<HTMLInputElement>("#clone-source")!.value).toBe("https://host/team/project.git")
        expect(container.querySelector<HTMLInputElement>("#clone-parent")!.value).toBe("D:\\Source")
        expect(container.querySelector<HTMLInputElement>("#clone-name")!.value).toBe("project")
        dispose()
    })

    test("applies the saved appearance and persists a toggle", async () => {
        let saved: string[] = []
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), appearance: "dark" as const }),
            setAppearance: async appearance => {
                saved.push(appearance)
                return appearance
            },
        })
        let { container, root, dispose } = render(api)

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
        let api = fakeLaneway({
            getState: async () => {
                attempts++
                if (attempts == 1)
                    throw new Error("Preload unavailable")
                return appState()
            },
        })
        let { container, root, dispose } = render(api)

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
        let repository = repositoryInfo("D:\\Source\\graph-project")
        let graph = branchGraph(repository.id)
        // The Engine only adds someone else's remote-only branch when every branch is requested.
        let [main, , team] = graph.branches
        let remoteOnly = {
            ...team,
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
        let everything = {
            ...graph,
            branches: [...graph.branches, remoteOnly],
            history: [{ objectId: remoteOnly.tip, lineId: remoteOnly.id, parentIds: [main.tip] }, ...graph.history],
        }
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async (_repositoryId, _refreshRemote, allBranches) => ({ ok: true, graph: allBranches ? everything : graph }),
            selectRepository: async () => openedWorkspace(repository),
        })
        let { container, root, dispose } = render(api)

        await flush(root)
        expect(container.textContent).toContain("feature/laneway")
        // Local branches show by default, however uninvolved; unrelated remote branches wait for "Show all".
        expect(container.textContent).toContain("other/team")
        expect(container.textContent).not.toContain("origin/other/remote")
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
        await flush(root)
        expect(container.textContent).toContain("origin/other/remote")
        expect(button(container, "Show relevant").getAttribute("aria-pressed")).toBe("true")

        // Graph rows drag onto columns, so pressing one must leave the native drag free to start; the click selects.
        let feature = container.querySelector<HTMLElement>("[data-node-id='branch:refs/heads/feature/laneway']")!
        let press = new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true, cancelable: true })
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

        click(container.querySelector<HTMLElement>(`[data-node-id='${main.id}']`)!)
        container.querySelector(".graph-rows")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
        root.flush()
        expect(container.querySelector(`[data-node-id='${graph.branches[1].id}']`)).toBeNull()
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))
        root.flush()
        expect(container.querySelector(".command-lens")?.textContent).toContain("Search open repositories and branches.")
        input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, "laneway")
        root.flush()
        expect(container.querySelector(".lens-results")?.textContent).toContain("feature/laneway")
        click(container.querySelector<HTMLButtonElement>(".lens-results button")!)
        await flush(root)
        expect(container.querySelector(".graph-row.selected")?.getAttribute("data-node-id")).toBe(graph.branches[1].id)
        expect(container.querySelectorAll(".branch-column")).toHaveLength(1)
        dispose()
    })

    test("virtualizes large semantic Branch Graph row sets", async () => {
        let repository = repositoryInfo("D:\\Source\\large-graph")
        let graph = branchGraph(repository.id)
        let template = graph.branches[1]
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
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        })
        let { container, root, dispose } = render(api)

        await flush(root)
        expect(container.querySelectorAll(".graph-row").length).toBeLessThan(30)
        expect(container.querySelector(".graph-spacer")).not.toBeNull()
        let rows = container.querySelector<HTMLElement>(".graph-rows")!
        rows.scrollTop = 1600
        rows.dispatchEvent(new Event("scroll", { bubbles: true }))
        root.flush()
        expect(container.querySelectorAll(".graph-row").length).toBeLessThan(30)
        expect(container.querySelector(".graph-row svg path[d='M 13 0 V 40']")).not.toBeNull()
        click(button(container, "Command Lens"))
        await flush(root)
        input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, "feature/119")
        root.flush()
        click(container.querySelector<HTMLButtonElement>(".lens-results button")!)
        await flush(root)
        expect(container.querySelector(".graph-row.selected")?.getAttribute("data-node-id")).toBe("branch:refs/heads/feature/119")
        expect(rows.scrollTop).toBeGreaterThan(1600)
        expect(document.activeElement == rows).toBe(true)
        expect(button(container, "Show all").getAttribute("aria-pressed")).toBe("false")
        expect(container.querySelector(".branch-column")).toBeNull()

        click(button(container, "Command Lens"))
        await flush(root)
        input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, "feature/0")
        root.flush()
        click(container.querySelector<HTMLButtonElement>(".lens-results button")!)
        await flush(root)
        expect(container.querySelector(".graph-row.selected")?.getAttribute("data-node-id")).toBe("branch:refs/heads/feature/0")
        expect(rows.scrollTop).toBe(0)
        dispose()
    })

    for (let selectAnother of [false, true]) {
        test(`Command Lens finds a filtered branch in another repository and ${selectAnother ? "preserves a newer selection" : "reveals it"} after a pending read`, async () => {
            let first = repositoryInfo("D:\\Source\\first")
            let second = repositoryInfo("D:\\Source\\second")
            let graph = branchGraph(second.id)
            let [main, feature] = graph.branches
            let remote = {
                ...feature,
                id: "branch:refs/remotes/origin/hidden",
                name: "origin/hidden",
                preferredRef: "refs/remotes/origin/hidden",
                refs: ["refs/remotes/origin/hidden"],
                aliases: ["origin/hidden"],
                localRefs: [],
                remoteRefs: ["refs/remotes/origin/hidden"],
                tip: "4".repeat(40),
                remoteOnly: true,
                involvement: "uninvolved" as const,
            }
            let everything = {
                ...graph,
                branches: [...graph.branches, remote],
                history: [{ objectId: remote.tip, lineId: remote.id, parentIds: [main.tip] }, ...graph.history],
            }
            let workspace: Workspace = {
                ...openedWorkspace(first),
                repositories: [...openedWorkspace(first).repositories, ...openedWorkspace(second).repositories],
            }
            let finishRefresh: () => void = () => {}
            let refresh = new Promise<void>(resolve => finishRefresh = resolve)
            let waiting = false
            let api = fakeLaneway({
                getState: async () => ({ ...appState(), workspace }),
                updateWorkspace: async next => workspace = next,
                selectRepository: async id => workspace = { ...workspace, activeRepositoryId: id },
                readBranchGraph: async (repositoryId, refreshRemote, allBranches) => {
                    if (repositoryId == first.id)
                        return { ok: true, graph: branchGraph(first.id) }
                    if (refreshRemote) {
                        waiting = true
                        await refresh
                    }
                    return { ok: true, graph: allBranches ? everything : graph }
                },
            })
            let { container, root, dispose } = render(api)
            try {
                await flush(root)
                click(button(container, "Command Lens"))
                root.flush()
                input(container.querySelector<HTMLInputElement>("[aria-label='Command Lens search']")!, remote.name)
                await flush(root)
                expect(container.querySelector(".lens-results")?.textContent).toContain(remote.name)
                expect(button(container, "Show all").getAttribute("aria-pressed")).toBe("false")
                click(container.querySelector<HTMLButtonElement>(".lens-results button")!)
                await flush(root)
                expect(waiting).toBe(true)
                if (selectAnother) {
                    click(container.querySelector<HTMLElement>(`[data-node-id='${feature.id}']`)!)
                    root.flush()
                }
                finishRefresh()
                await flush(root)
                expect(workspace.activeRepositoryId).toBe(second.id)
                expect(button(container, "Show relevant").getAttribute("aria-pressed")).toBe("true")
                expect(container.querySelector(".graph-row.selected")?.getAttribute("data-node-id")).toBe(selectAnother ? feature.id : remote.id)
                expect(container.querySelector(".graph-sidebar")?.classList.contains("collapsed")).toBe(false)
                expect(container.querySelector(".branch-column")).toBeNull()
            } finally {
                finishRefresh()
                dispose()
            }
        })
    }

    test("background refreshes leave the Branch Graph header still", async () => {
        let repository = repositoryInfo("D:\\Source\\refresh-graph")
        let graph = branchGraph(repository.id)
        let calls = 0
        let finishRefresh: () => void = () => {}
        let refresh = new Promise<void>(resolve => finishRefresh = resolve)
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => {
                calls++
                if (calls > 2)
                    await refresh
                return { ok: true, graph }
            },
        })
        let { container, root, dispose } = render(api)

        await flush(root)
        let toolbar = container.querySelector<HTMLElement>(".graph-toolbar")!
        expect(toolbar.querySelector("h1")?.textContent).toBe("Branch Graph")
        let before = toolbar.innerHTML
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

    test("customizes a repository's name and icon from the rail's context menu", async () => {
        let scenario = inspectionScenario()
        let saves: Workspace[] = []
        let api = fakeLaneway({
            ...scenario.api,
            updateWorkspace: async workspace => {
                saves.push(structuredClone(workspace))
                return workspace
            },
        })
        let { container, root, dispose } = render(api)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Expand repository sidebar']")!)
        root.flush()
        let item = () => container.querySelector<HTMLButtonElement>(".repository-item")!
        expect(item().getAttribute("aria-label")).toBe("inspection")
        expect(container.querySelector(".repository-tile .initials")?.textContent).toBe("IN")

        container.querySelector(".repository-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
        root.flush()
        let menu = container.querySelector("dialog[aria-label='Actions for inspection']")!
        expect([...menu.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Customize…", "Close repository"])
        click(menu.querySelector("button")!)
        await flush(root)
        let editor = () => container.querySelector<HTMLElement>(".repository-identity")!
        expect(editor().querySelector("h2")?.textContent).toBe("inspection")
        // Without a favicon the default is initials, so the dialog opens on the Monogram tab showing them.
        expect(button(editor(), "Monogram").getAttribute("aria-pressed")).toBe("true")
        expect(editor().querySelector<HTMLInputElement>("[aria-label='Monogram letters']")?.value).toBe("IN")

        // The name applies as it is typed and saves once typing pauses.
        input(editor().querySelector<HTMLInputElement>("#repository-label")!, "Inspection desk")
        root.flush()
        expect(item().getAttribute("aria-label")).toBe("Inspection desk")
        expect(container.querySelector(".repository-tile .initials")?.textContent).toBe("ID")
        expect(saves.at(-1)?.repositories[0].label).toBeUndefined()
        await new Promise(resolve => setTimeout(resolve, 250))
        expect(saves.at(-1)?.repositories[0]).toMatchObject({ label: "Inspection desk" })
        expect(saves.at(-1)?.repositories[0].icon).toBeUndefined()
        // Untouched initials follow the new name; choosing a colour makes them an explicit monogram.
        expect(editor().querySelector<HTMLInputElement>("[aria-label='Monogram letters']")?.value).toBe("ID")
        click(button(editor(), "Violet"))
        root.flush()
        expect(container.querySelector(".repository-tile .monogram-tile")?.getAttribute("style")).toContain("--tone-violet")
        expect(container.querySelector(".repository-tile text")?.textContent).toBe("ID")
        input(editor().querySelector<HTMLInputElement>("[aria-label='Monogram letters']")!, "too long")
        root.flush()
        // Invalid letters keep the previous tile rather than showing a broken one.
        expect(container.querySelector(".repository-tile .initials")?.textContent).toBe("ID")
        input(editor().querySelector<HTMLInputElement>("[aria-label='Monogram letters']")!, "t3")
        await new Promise(resolve => setTimeout(resolve, 250))
        root.flush()
        expect(saves.at(-1)?.repositories[0]).toMatchObject({ label: "Inspection desk", icon: { kind: "monogram", text: "T3", color: "violet" } })

        click(button(editor(), "Emoji"))
        root.flush()
        click(button(editor(), "Rocket"))
        root.flush()
        expect(container.querySelector(".repository-tile .emoji")?.textContent).toBe("🚀")

        click(button(editor(), "Reset"))
        await new Promise(resolve => setTimeout(resolve, 250))
        root.flush()
        expect(item().getAttribute("aria-label")).toBe("inspection")
        expect(container.querySelector(".repository-tile .initials")?.textContent).toBe("IN")
        expect(button(editor(), "Monogram").getAttribute("aria-pressed")).toBe("true")
        expect(saves.at(-1)?.repositories[0].label).toBeUndefined()
        expect(saves.at(-1)?.repositories[0].icon).toBeUndefined()
        click(button(editor(), "Done"))
        root.flush()
        expect(container.querySelector(".repository-identity")).toBeNull()
        dispose()
    })

    test("shows a repository's inferred favicon until the user chooses an icon", async () => {
        let repository = repositoryInfo("D:\\Source\\branded")
        let favicon = "D:\\Source\\branded\\public\\favicon.svg"
        let workspace: Workspace = {
            ...openedWorkspace(repository),
            repositories: [{ ...openedWorkspace(repository).repositories[0], favicon }],
        }
        let reads: string[] = []
        let saves: Workspace[] = []
        let logo = "D:\\Source\\branded\\src\\assets\\logo.svg"
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace }),
            readBranchGraph: async () => ({ ok: true, graph: branchGraph(repository.id) }),
            readIconImage: async path => {
                reads.push(path)
                return { bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), mime: "image/svg+xml" }
            },
            listRepositoryImages: async () => [{ path: favicon, relative: "public/favicon.svg" }, { path: logo, relative: "src/assets/logo.svg" }, {
                path: "D:\\Source\\branded\\docs\\screenshot.png",
                relative: "docs/screenshot.png",
            }],
            updateWorkspace: async next => {
                saves.push(structuredClone(next))
                return next
            },
        })
        let { container, root, dispose } = render(api)
        await flush(root)
        expect(reads).toEqual([favicon])
        let image = container.querySelector<HTMLImageElement>(".repository-tile img")
        expect(image?.getAttribute("src")).toMatch(/^blob:/)
        expect(container.querySelector(".repository-tile .initials")).toBeNull()

        // The dialog opens on the Image tab, naming the favicon it found and listing the repository's images.
        container.querySelector(".repository-item")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
        root.flush()
        click(container.querySelector<HTMLButtonElement>("dialog[aria-label='Actions for branded'] button")!)
        await flush(root)
        let editor = () => container.querySelector<HTMLElement>(".repository-identity")!
        expect(button(editor(), "Image").getAttribute("aria-pressed")).toBe("true")
        expect(editor().textContent).toContain("Using the favicon favicon.svg found in the repository")
        expect([...editor().querySelectorAll("[aria-label='Icon type'] button")].map(button => button.textContent?.trim())).toEqual([
            "Icon",
            "Emoji",
            "Monogram",
            "Image",
        ])
        let rows = () => [...editor().querySelectorAll<HTMLButtonElement>("[role=option]")]
        expect(rows().map(row => row.querySelector(".image-name")?.textContent)).toEqual(["favicon.svg", "logo.svg", "screenshot.png"])
        expect(rows().map(row => row.querySelector(".image-path")?.textContent)).toEqual(["public/favicon.svg", "src/assets/logo.svg", "docs/screenshot.png"])
        expect(rows()[0].getAttribute("aria-pressed")).toBe("true")
        await flush(root)
        expect(rows().every(row => row.querySelector("img")?.getAttribute("src")?.startsWith("blob:"))).toBe(true)

        // Searching narrows by any part of the path; Enter chooses the highlighted file.
        let search = () => editor().querySelector<HTMLInputElement>("[aria-label='Search images in the repository']")!
        input(search(), "assets")
        root.flush()
        expect(rows().map(row => row.querySelector(".image-name")?.textContent)).toEqual(["logo.svg"])
        search().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
        await flush(root)
        expect(container.querySelector(".repository-tile img")?.getAttribute("src")).toMatch(/^blob:/)
        expect(reads).toContain(logo)
        expect(editor().textContent).toContain(`Using ${logo}`)
        await new Promise(resolve => setTimeout(resolve, 250))
        expect(saves.at(-1)?.repositories[0].icon).toEqual({ kind: "image", path: logo })
        dispose()
    })

    test("drags a repository along the rail while the others step aside, committing the order on release", async () => {
        let alpha = repositoryInfo("D:\\Source\\alpha")
        let beta = repositoryInfo("D:\\Source\\beta")
        let gamma = repositoryInfo("D:\\Source\\gamma")
        let saved = {
            repositories: [alpha, beta, gamma].flatMap(info => openedWorkspace(info).repositories),
            activeRepositoryId: alpha.id,
        }
        let selected: string[] = []
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: saved }),
            readBranchGraph: async () => ({ ok: true, graph: branchGraph(alpha.id) }),
            selectRepository: async id => {
                selected.push(id)
                return saved
            },
            updateWorkspace: async workspace => saved = structuredClone(workspace) as typeof saved,
        })
        let { container, root, dispose } = render(api)
        await flush(root)
        let rows = () => [...container.querySelectorAll<HTMLElement>(".repository-row")]
        let item = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(".repository-item")!
        let order = () => rows().map(row => item(row).getAttribute("aria-label"))
        let offsets = () => rows().map(row => row.style.transform)
        let transitions = () => rows().map(row => row.style.transition)
        let pointer = (type: string, target: EventTarget, clientY: number) =>
            target.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientY, bubbles: true, cancelable: true }))
        let settle = async () => {
            await new Promise(resolve => setTimeout(resolve, 200))
            await flush(root)
        }
        // Happy DOM has no layout: rows are 36px tall with a 4px gap.
        for (let [index, row] of rows().entries()) {
            row.getBoundingClientRect = () => ({ top: index * 40, height: 36 }) as DOMRect
            row.setPointerCapture = () => undefined
        }
        let [first, second, third] = rows()

        // Pressing to drag must not choose the repository.
        let mousedown = new MouseEvent("mousedown", { button: 0, detail: 1, bubbles: true, cancelable: true })
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
        for (let [index, row] of rows().entries())
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
        let repository = repositoryInfo("D:\\Source\\persisted-graph")
        let graph = branchGraph(repository.id)
        let main = graph.branches[0]
        let feature = graph.branches[1]
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
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: saved }),
            readBranchGraph: async () => ({ ok: true, graph }),
            updateWorkspace: async workspace => saved = structuredClone(workspace) as typeof saved,
        })
        let { container, root, dispose } = render(api)

        await flush(root)
        expect(container.querySelector(".status-bar")).toBeNull()
        let masthead = container.querySelector(".masthead")!
        expect(masthead.textContent).toContain("Stashes")
        expect(masthead.querySelector('[aria-label="Undo last operation"]')).not.toBeNull()
        expect(masthead.querySelector('[aria-label="Redo operation"]')).not.toBeNull()
        expect(container.querySelector(".graph-toolbar")?.textContent).not.toContain("Stashes")
        expect(container.querySelector('.graph-toolbar [aria-label="Undo last operation"]')).toBeNull()
        let columnHeaders = [...container.querySelectorAll(".branch-column > header")].map(header => header.textContent).join(" ")
        expect(columnHeaders).not.toContain("refs/heads/")
        expect(columnHeaders).not.toContain(main.tip.slice(0, 8))
        let mainColumn = container.querySelector<HTMLElement>(`[data-column-id='${main.id}']`)!
        mainColumn.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: ">", ctrlKey: true, shiftKey: true, bubbles: true }))
        await flush(root)
        expect(saved.repositories[0].columns.map(column => column.id)).toEqual([feature.id, main.id])
        expect(document.activeElement?.getAttribute("data-column-id")).toBe(main.id)

        let divider = container.querySelector<HTMLElement>(`[data-column-id='${main.id}'] + [role='separator']`)!
        divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
        await flush(root)
        expect(saved.repositories[0].columns.find(column => column.id == main.id)?.width).toBe(390)
        dispose()
    })
})

test("Pull latest freezes open-column scope, streams progress with Cancel, and summarizes outcomes by stack", async () => {
    let repository = repositoryInfo("D:\Source\pull-graph")
    let graph = branchGraph(repository.id)
    let main = graph.branches[0]
    let feature = graph.branches[1]
    let saved = {
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
    let api = fakeLaneway({
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
    let { container, root, dispose } = render(api)
    await flush(root)
    let readsBefore = graphReads
    let pull = button(container, "Pull latest")
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
    let outcome = container.querySelector(".pull-outcome")!
    expect(outcome.querySelector(".pull-summary")?.textContent).toBe("Pull complete: 1 updated, 1 need resolution.")
    expect(outcome.querySelector(".pull-counts")?.textContent).toBe("1 updated · 1 needs resolution")
    let stacks = [...outcome.querySelectorAll<HTMLDetailsElement>(".pull-stack")]
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
    let repository = repositoryInfo("D:\Source\quiet-pull")
    let graph = branchGraph(repository.id)
    let api = fakeLaneway({
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
    let { container, root, dispose } = render(api)
    await flush(root)
    click(button(container, "Pull latest"))
    await flush(root)
    expect(container.querySelector(".pull-outcome")).toBeNull()
    expect(container.querySelector(".notice:not([hidden])")?.textContent).toContain("Pull complete: 1 updated, 1 already current.")
    dispose()
})

test("confirmation notices close themselves, but not while hovered", async () => {
    // Capture only the notice countdown so the test controls when it elapses.
    let countdowns = new Map<number, () => void>()
    let nextCountdown = 0
    let { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = browserWindow
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
    let repository = repositoryInfo("D:\Source\quiet-pull")
    let graph = branchGraph(repository.id)
    let api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
        pullLatest: async () => ({
            ok: true,
            result: { type: "result", command: "pull", status: "fetched", message: "Pull complete: 1 already current.", fetches: [], stacks: [] },
        }),
    })
    let { container, root, dispose } = render(api)
    try {
        await flush(root)
        click(button(container, "Pull latest"))
        await flush(root)
        let notice = container.querySelector<HTMLElement>(".notice:not([hidden])")!
        expect(notice.textContent).toContain("Pull complete")
        expect(countdowns.size).toBe(1)
        notice.dispatchEvent(new Event("pointerenter"))
        expect(countdowns.size).toBe(0)
        notice.dispatchEvent(new Event("pointerleave"))
        expect(countdowns.size).toBe(1)
        for (let elapse of countdowns.values())
            elapse()
        await flush(root)
        expect(container.querySelector(".notice:not([hidden])")).toBeNull()
    } finally {
        Object.assign(browserWindow, { setTimeout: realSetTimeout, clearTimeout: realClearTimeout })
        dispose()
    }
})

test("Branch Graph settings apply patterns on Enter, close on Escape, and skip a single-remote choice", async () => {
    let repository = repositoryInfo("D:\Source\graph-settings")
    let graph = branchGraph(repository.id)
    let applied: unknown[] = []
    let api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
        setRepositoryGraphSettings: async (_id, settings) => {
            applied.push(settings)
            return settings
        },
    })
    let { container, root, dispose } = render(api)
    await flush(root)
    let toggle = container.querySelector<HTMLButtonElement>("[aria-label='Branch Graph settings']")!
    click(toggle)
    await flush(root)
    let dialog = container.querySelector<HTMLElement>(".graph-settings")!
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(dialog.querySelector("h2")?.textContent).toBe("Branch Graph settings")
    expect(dialog.querySelector("input[type='radio']")).toBeNull()
    let patterns = dialog.querySelector<HTMLInputElement>("#remote-patterns")!
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
    let repository = repositoryInfo("D:\Source\no-remotes")
    let graph = { ...branchGraph(repository.id), availableRemotes: [], selectedRemote: undefined }
    let api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
    })
    let { container, root, dispose } = render(api)
    await flush(root)
    let pull = button(container, "Pull latest")
    expect(pull.disabled).toBe(true)
    expect(pull.getAttribute("title")).toBe("Add a remote to pull.")
    dispose()
})

test("double-clicking a column header toggles maximizing it, but not on its controls", async () => {
    let scenario = inspectionScenario()
    let initial = await scenario.api.getState()
    let graphResult = await scenario.api.readBranchGraph(initial.workspace.activeRepositoryId!, false)
    if (!graphResult.ok)
        throw new Error("Missing graph")
    let main = graphResult.graph.branches[0]
    main.checkedOut = [{ path: "D:/other", name: "other", head: main.tip, main: false }]
    let view = render(scenario.api)
    await flush(view.root)
    let columnIds = () => [...view.container.querySelectorAll("[data-column-id]")].map(node => node.getAttribute("data-column-id"))
    let opened = columnIds()
    expect(opened.length).toBeGreaterThan(1)
    let header = () => view.container.querySelector<HTMLElement>(`[data-column-id="${opened[1]}"] header`)!
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
    let scenario = inspectionScenario()
    let initial = await scenario.api.getState()
    let graphResult = await scenario.api.readBranchGraph(initial.workspace.activeRepositoryId!, false)
    if (!graphResult.ok)
        throw new Error("Missing graph")
    let main = graphResult.graph.branches[0]
    main.checkedOut = [{ path: "D:/other", name: "other", head: main.tip, main: false }]
    let view = render(scenario.api)
    await flush(view.root)
    let [source, next] = view.container.querySelectorAll<HTMLElement>(".branch-column")
    let order = () => [...view.container.querySelector(".branch-columns")!.children].map(node => node.classList[0])
    click(source.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
    await flush(view.root)
    for (let opening = 0; opening < 2; opening++) {
        click(source.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!)
        await flush(view.root)
        let children = [...view.container.querySelector(".branch-columns")!.children]
        expect(order()).toEqual(["branch-column", "column-divider", "inspection-breakout", "column-divider", "branch-column", "column-divider"])
        expect([children[0], children[4]]).toEqual([source, next])
        click(view.container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(view.root)
        expect(order()).toEqual(["branch-column", "column-divider", "branch-column", "column-divider"])
    }
    // A diff column's header button or a double-click on its header maximizes its source column, split with the diff.
    click(source.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!)
    await flush(view.root)
    let split = ["branch-column", "column-divider", "inspection-breakout"]
    let header = () => view.container.querySelector<HTMLElement>(".inspection-breakout header")!
    click(header().querySelector<HTMLButtonElement>("[aria-label='Maximize column']")!)
    await flush(view.root)
    expect(order()).toEqual(split)
    expect(view.container.querySelector(".branch-column")).toBe(source)
    expect(source.querySelector("[aria-label='Restore columns']")).not.toBeNull()
    click(header().querySelector<HTMLButtonElement>("[aria-label='Restore columns']")!)
    await flush(view.root)
    expect(order()).toEqual(["branch-column", "column-divider", "inspection-breakout", "column-divider", "branch-column", "column-divider"])
    header().querySelector("button")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(order()).toHaveLength(6)
    header().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(order()).toEqual(split)
    // Closing the diff column leaves its source column maximized on its own.
    click(view.container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
    await flush(view.root)
    expect(order()).toEqual(["branch-column"])
    view.dispose()
})

test("a diff column resizes from its own divider and keeps its width for the session", async () => {
    let scenario = inspectionScenario()
    let view = render(scenario.api)
    await flush(view.root)
    let source = view.container.querySelector<HTMLElement>(".branch-column")!
    click(source.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
    await flush(view.root)
    click(source.querySelector<HTMLButtonElement>("[aria-label='Break out diff']")!)
    await flush(view.root)
    let breakout = () => view.container.querySelector<HTMLElement>(".inspection-breakout")!
    let divider = () => breakout().nextElementSibling as HTMLElement
    expect(breakout().style.width).toBe("620px")
    expect(divider().getAttribute("aria-label")).toBe("Resize auxiliary column")
    expect(divider().classList.contains("attached")).toBe(false)
    divider().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }))
    await flush(view.root)
    expect(breakout().style.width).toBe("670px")
    expect(divider().getAttribute("aria-valuenow")).toBe("670")
    // The diff column keeps its width when it moves to another file's group, but not past the session.
    click(source.querySelector<HTMLButtonElement>(".commit-heading")!)
    await flush(view.root)
    click(view.container.querySelector<HTMLButtonElement>("[aria-label='Show full diff for commit Inspect changes']")!)
    await flush(view.root)
    expect(breakout().style.width).toBe("670px")
    divider().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    await flush(view.root)
    expect(breakout().style.width).toBe("380px")
    divider().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    await flush(view.root)
    expect(breakout().style.width).toBe("620px")
    expect((await scenario.api.getState()).workspace.repositories[0].columns.map(column => column.width)).toEqual([380])
    view.dispose()
})

test("retains worktree columns and restores collapse in place across restart", async () => {
    let scenario = inspectionScenario()
    let initial = await scenario.api.getState()
    let graphResult = await scenario.api.readBranchGraph(initial.workspace.activeRepositoryId!, false)
    if (!graphResult.ok)
        throw new Error("Missing graph")
    let graph = graphResult.graph
    let branch = graph.branches[1]
    let main = graph.branches[0]
    main.checkedOut = [{ path: "D:/other", name: "other", head: main.tip, main: false }]
    let view = render(scenario.api)
    await flush(view.root)
    expect([...view.container.querySelectorAll("[data-column-id]")].map(node => node.getAttribute("data-column-id"))).toEqual([branch.id, main.id])
    let column = view.container.querySelector<HTMLElement>(".branch-column")!
    expect(column.querySelector('[title="Close column"]')).toBeNull()
    let divider = column.nextElementSibling as HTMLElement
    expect(divider.getAttribute("aria-label")).toBe("Resize branch column")
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    await flush(view.root)
    click(column.querySelector<HTMLButtonElement>('[title="Collapse column"]')!)
    await flush(view.root)
    expect(column.classList.contains("collapsed")).toBe(true)
    expect(column.textContent).toContain("2 changed files")
    let saved = (await scenario.api.getState()).workspace.repositories[0].columns
    expect(saved.map(column => column.id)).toEqual([branch.id, main.id])
    expect(saved[0]).toMatchObject({ collapsed: true, width: 390 })
    view.dispose()
    view = render(scenario.api)
    await flush(view.root)
    let restored = view.container.querySelector<HTMLElement>(".branch-column")!
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
    let activeRepository = view.container.querySelector<HTMLButtonElement>(".repository-item.active")!
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
    let scenario = inspectionScenario()
    let readGraph = scenario.api.readBranchGraph
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
    test("opens a column beside its source, reads diffs lazily, breaks them out, follows moved tips and persists", async () => {
        let scenario = inspectionScenario()
        let [main, feature] = scenario.graph.branches
        let inventories = 0, patches = 0
        let requested: Extract<DiffSource, { kind: "refs" }>[] = []
        let readChanges = scenario.api.readChanges
        scenario.api.readChanges = async (...args) => {
            let request = args[2]
            if (request.source.kind != "refs")
                return readChanges(...args)
            inventories++
            requested.push(request.source)
            return {
                ok: true,
                inventory: {
                    source: { kind: "comparison", fromObjectId: main.tip, toObjectId: feature.tip },
                    version: `${main.tip}:${feature.tip}`,
                    parents: [],
                    files: [{ ...scenario.page.file, path: "src/file.txt" }],
                },
            }
        }
        let readFileDiff = scenario.api.readFileDiff
        scenario.api.readFileDiff = async (...args) => {
            let request = args[2]
            if (request.source.kind != "comparison")
                return readFileDiff(...args)
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
        }
        let { container, root, dispose } = render(scenario.api)
        await flush(root)
        let source = container.querySelector<HTMLElement>(`[data-column-id='${feature.id}']`)!
        let compare = source.querySelector<HTMLButtonElement>(".branch-compare")!
        let comparison = () => container.querySelector<HTMLElement>("[data-column-id^='comparison:']")!
        click(compare)
        await flush(root)
        let column = comparison()
        expect(column).not.toBeNull()
        expect(column.previousElementSibling?.previousElementSibling).toBe(source)
        expect(column.querySelector("h2")?.textContent).toBe(`${main.name} → ${feature.name}`)
        expect(column.querySelector("h2")?.getAttribute("title")).toBe(`${main.name} → ${feature.name}`)
        expect(document.activeElement).toBe(column)
        expect(requested).toEqual([{
            kind: "refs",
            from: { kind: "merge-base", ref: main.preferredRef, withRef: feature.preferredRef },
            to: { kind: "branch", ref: feature.preferredRef },
        }])
        expect(patches).toBe(0)
        expect(column.querySelectorAll(".branch-comparison .change-file")).toHaveLength(1)
        // Comparisons are read-only, so files offer no whole-file selection.
        expect(column.querySelector("input[type='checkbox']")).toBeNull()
        click(column.querySelector<HTMLButtonElement>(".change-file button[aria-expanded]")!)
        await flush(root)
        expect(patches).toBe(1)
        expect(column.querySelector(".pierre-diff")).not.toBeNull()
        let openDiffColumn = column.querySelector<HTMLButtonElement>("header [aria-label='Open diff column']")!
        expect(openDiffColumn.disabled).toBe(false)
        // Both the header control and a file's own control open the column's whole diff.
        for (let opener of ["header [aria-label='Open diff column']", "[aria-label='Break out diff']"]) {
            click(column.querySelector<HTMLButtonElement>(opener)!)
            await flush(root)
            expect(column.nextElementSibling?.nextElementSibling?.classList.contains("inspection-breakout")).toBe(true)
            expect(container.querySelector(".inspection-breakout header span")?.textContent).toContain(`${main.name} → ${feature.name}`)
            expect(openDiffColumn.getAttribute("aria-pressed")).toBe("true")
            click(container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
            await flush(root)
            expect(container.querySelector(".inspection-breakout")).toBeNull()
        }
        let saved = scenario.saved().repositories[0].columns
        expect(saved.map(column => column.kind)).toEqual(["branch", "comparison"])
        expect(saved[1]).toMatchObject({ id: column.dataset.columnId, from: requested[0].from, to: requested[0].to })
        click(compare)
        await flush(root)
        expect(container.querySelectorAll("[data-column-id^='comparison:']")).toHaveLength(1)
        expect(inventories).toBe(1)
        main.tip = "a".repeat(40)
        refreshGraph()
        await flush(root)
        expect(inventories).toBe(2)
        expect(patches).toBe(2)
        click(comparison().querySelector<HTMLButtonElement>("[aria-label='Close column']")!)
        await flush(root)
        expect(container.querySelector("[data-column-id^='comparison:']")).toBeNull()
        expect(scenario.saved().repositories[0].columns).toHaveLength(1)
        dispose()
    })

    test("compares a column branch with its base from its heading, but offers nothing for the base itself", async () => {
        let scenario = inspectionScenario()
        let [main, feature] = scenario.graph.branches
        let { container, root, dispose } = render(scenario.api)
        await flush(root)
        let column = container.querySelector<HTMLElement>(".branch-column")!
        let compare = column.querySelectorAll<HTMLButtonElement>(".branch-compare")
        expect([...compare].map(control => control.getAttribute("aria-label"))).toEqual([`Compare ${feature.name} with ${main.name}`])
        expect(compare[0].closest(".composition-branch-target")).not.toBeNull()
        expect(column.querySelector(".stack-heading")?.parentElement?.querySelector(".branch-compare")).toBeNull()
        click(compare[0])
        await flush(root)
        let comparison = container.querySelector<HTMLElement>("[data-column-id^='comparison:']")!
        expect(comparison).not.toBeNull()
        expect(comparison.querySelector(".column-kind")?.getAttribute("title")).toBe(`Changes on ${feature.name} since it left ${main.name}`)
        expect(comparison.querySelector("[aria-label='Filter files']")).not.toBeNull()
        expect(comparison.querySelector("[aria-label='Maximize column']")).not.toBeNull()
        expect(comparison.querySelector(".column-worktree")).toBeNull()
        dispose()
    })
})

describe("Working Changes inspection", () => {
    test("marks column commits and branches their remote already has as remote", async () => {
        let scenario = inspectionScenario()
        let branch = scenario.graph.branches[1]
        let local = "4".repeat(40)
        branch.upstreamRef = "refs/remotes/origin/feature/laneway"
        branch.remoteRefs = [branch.upstreamRef]
        branch.upstreamTip = branch.tip
        branch.tip = local
        branch.ahead = 1
        branch.checkedOut[0].head = local
        // A remote branch reaches main's tip, so its card is remote even though it is a local branch.
        let main = scenario.graph.branches[0]
        main.published = true
        scenario.graph.remoteTips = [branch.upstreamTip, "5".repeat(40)]
        let requests: Parameters<Window["laneway"]["readBranchHistory"]>[1][] = []
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

        let { container, root, dispose } = render(scenario.api)
        try {
            await flush(root)
            expect(requests[0]).toMatchObject({ tip: local, remoteTips: scenario.graph.remoteTips })
            let commits = [...container.querySelectorAll<HTMLElement>(".inspect-commit")]
            expect(commits.map(commit => [commit.textContent, commit.dataset.remote])).toEqual([["Unpublished", "false"], ["Published", "true"]])
            expect([...container.querySelectorAll(".stack-branch")].map(card => card.classList.contains("remote"))).toEqual([false, true])
        } finally {
            dispose()
        }
    })

    test("opens an ambiguous branch from the graph and chooses its base after paging commits", async () => {
        let scenario = inspectionScenario()
        let graphResult = await scenario.api.readBranchGraph((await scenario.api.getState()).workspace.activeRepositoryId!, false)
        if (!graphResult.ok)
            throw new Error("Missing graph")
        let graph = graphResult.graph
        let branch = graph.branches[1]
        let candidates = [graph.branches[0], graph.branches[2]]
        branch.base = {
            status: "ambiguous",
            candidates: candidates.map(candidate => ({
                branchId: candidate.id,
                name: candidate.name,
                ref: candidate.preferredRef,
                tip: candidate.tip,
            })),
        }
        branch.checkedOut = []
        let saved = scenario.saved()
        saved.repositories[0].columns = []
        await scenario.api.updateWorkspace(saved)
        let requests: Parameters<Window["laneway"]["readBranchHistory"]>[1][] = []
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

        let { container, root, dispose } = render(scenario.api)
        try {
            await flush(root)
            click(button(container, "Show Branch Graph"))
            await flush(root)
            let row = container.querySelector<HTMLElement>(`[data-node-id='${branch.id}']`)!
            expect(row.textContent).toContain("Choose base")
            click(button(row, "Open"))
            await flush(root)
            let column = container.querySelector<HTMLElement>(`[data-column-id='${branch.id}']`)!
            expect(requests[0]).toMatchObject({ limit: 50, baseTips: candidates.map(candidate => candidate.tip) })
            expect(column.querySelector("[aria-label='Base branch for feature/laneway']")).toBeNull()
            click(button(column, "Load more"))
            await flush(root)
            let continuation = column.querySelector<HTMLSelectElement>("[aria-label='Base branch for feature/laneway']")!
            expect(continuation).not.toBeNull()
            expect([...continuation.options].map(option => option.textContent)).toEqual(["Choose base…", "main", "other/team"])
            expect(continuation.value).toBe("")
            continuation.value = candidates[1].id
            continuation.dispatchEvent(new Event("change", { bubbles: true }))
            await flush(root)
            expect([...column.querySelectorAll(".stack-heading")].map(heading => heading.textContent)).toEqual(["other/team", "main"])
            continuation.value = candidates[0].id
            continuation.dispatchEvent(new Event("change", { bubbles: true }))
            await flush(root)
            expect([...column.querySelectorAll(".stack-heading")].map(heading => heading.textContent)).toEqual(["main"])
        } finally {
            dispose()
        }
    })

    test("opens column filtering on demand and clears it with Escape", async () => {
        let { container, root, dispose } = render(inspectionScenario().api)
        await flush(root)
        let column = container.querySelector<HTMLElement>(".branch-column")!
        let search = column.querySelector<HTMLButtonElement>('[aria-label="Filter files"]')!
        expect(column.querySelector(".inspection-filters")).toBeNull()
        click(search)
        await flush(root)
        let input = column.querySelector<HTMLInputElement>('[aria-label="Filter changed files"]')!
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
        let scenario = inspectionScenario()
        let { container, root, dispose } = render(scenario.api)
        await flush(root)
        let column = container.querySelector<HTMLElement>(".branch-column")!
        let press = (element: HTMLElement, key: string) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
        // Compared by identity: printing a mismatched Happy DOM element on failure is prohibitively slow.
        let focused = (element: Element | null | undefined) => expect(document.activeElement == element).toBe(true)
        let heading = column.querySelector<HTMLElement>(".commit-heading")!
        expect(heading.title).toBe("Inspect changes\n\nInspect every change.")
        expect(heading.querySelector("[aria-label='Has message body']")).not.toBeNull()
        expect(column.querySelector(".commit-message-body")).toBeNull()
        heading.focus()
        // Right expands a collapsed commit, and Down then reaches its first file.
        press(heading, "ArrowRight")
        await flush(root)
        expect(heading.getAttribute("aria-expanded")).toBe("true")
        expect(heading.querySelector("[aria-label='Has message body']")).toBeNull()
        expect(column.querySelector(".commit-message-body")?.textContent).toBe("Inspect every change.")
        let description = column.querySelector<HTMLParagraphElement>(".commit-message-body")!
        let descriptionToggle = column.querySelector<HTMLButtonElement>(".commit-message-toggle")!
        expect(description.hidden).toBe(false)
        expect(descriptionToggle.getAttribute("aria-expanded")).toBe("true")
        expect(column.querySelector(".commit-message-preview")).toBeNull()
        click(descriptionToggle)
        await flush(root)
        expect(description.hidden).toBe(true)
        expect(descriptionToggle.getAttribute("aria-expanded")).toBe("false")
        expect(column.querySelector(".commit-message-preview")?.textContent).toBe("Inspect every change.")
        click(descriptionToggle)
        await flush(root)
        expect(description.hidden).toBe(false)
        press(heading, "ArrowDown")
        let first = column.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!
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
        let working = [...column.querySelectorAll<HTMLElement>(".working-changes .change-file > button[aria-expanded]")]
        expect(working.length).toBeGreaterThan(0)
        focused(working.at(-1))
        // Down past the last file reaches the base branch's heading, where the sequence ends.
        let last = column.querySelector<HTMLButtonElement>(".inspect-commit [title='other.txt']")!
        last.focus()
        press(last, "ArrowDown")
        let base = column.querySelector<HTMLElement>(".stack-heading")!
        focused(base)
        press(base, "ArrowDown")
        focused(base)
        // Left collapses the commit, which takes its files out of the sequence.
        heading.focus()
        press(heading, "ArrowLeft")
        await flush(root)
        expect(heading.getAttribute("aria-expanded")).toBe("false")
        expect(heading.querySelector("[aria-label='Has message body']")).not.toBeNull()
        expect(column.querySelector(".commit-message-body")).toBeNull()
        press(heading, "ArrowDown")
        focused(base)
        press(heading, "ArrowRight")
        await flush(root)
        // With the diff column open, choosing a file keeps focus in the column, and Up and Down select and scroll to files.
        click(container.querySelector<HTMLButtonElement>("[aria-label='Show full diff for commit Inspect changes']")!)
        await flush(root)
        let breakout = container.querySelector<HTMLElement>(".inspection-breakout")!
        focused(breakout)
        breakout.querySelector("header")!.getBoundingClientRect = () => ({ top: 0, bottom: 46 } as DOMRect)
        for (let [index, section] of breakout.querySelectorAll<HTMLElement>("[data-diff-path]").entries())
            section.getBoundingClientRect = () => ({ top: 46 + index * 300 - breakout.scrollTop } as DOMRect)
        let reopened = column.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!
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
        let second = column.querySelector<HTMLButtonElement>(".inspect-commit [title='other.txt']")!
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
        let scenario = inspectionScenario()
        let { container, root, dispose } = render(scenario.api)
        await flush(root)
        let down = (element: HTMLElement, button = 0) => {
            let event = new MouseEvent("mousedown", { button, detail: 1, bubbles: true, cancelable: true, composed: true })
            element.dispatchEvent(event)
            return event
        }
        let release = (element: HTMLElement) => {
            element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, composed: true }))
            element.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true, cancelable: true, composed: true }))
        }
        // The whole file row drags, and a prevented mousedown would stop the native drag before it starts.
        let file = container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!
        expect(file.closest(".change-file")?.getAttribute("draggable")).toBe("true")
        expect(down(file).defaultPrevented).toBe(false)
        await flush(root)
        expect(file.getAttribute("aria-expanded")).toBe("false")
        release(file)
        await flush(root)
        expect(file.getAttribute("aria-expanded")).toBe("true")
        expect(Boolean(container.querySelector("[aria-label='Select file src/file.txt']"))).toBe(true)
        let line = diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!
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
        let commit = container.querySelector<HTMLButtonElement>(".commit-heading")!
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
        let checkbox = container.querySelector<HTMLInputElement>("[aria-label='Select file src/file.txt']")!
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
        let scenario = inspectionScenario()
        let reads = 0
        let version = "one"
        let { container, root, dispose } = render({
            ...scenario.api,
            readChanges: async (...args) => {
                let result = await scenario.api.readChanges(...args)
                return result.ok ? { ...result, inventory: { ...result.inventory, version } } : result
            },
            readFileDiff: async (...args) => {
                reads++
                expect(args[2].inventoryVersion).toBe(version)
                return scenario.api.readFileDiff(...args)
            },
        })
        await flush(root)
        let file = () => container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!
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
        let scenario = inspectionScenario()
        let reads = 0
        let { container, root, dispose } = render({
            ...scenario.api,
            readFileDiff: async (...args) => {
                reads++
                return scenario.api.readFileDiff(...args)
            },
        })
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        let file = () => container.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!
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
        let scenario = inspectionScenario()
        let commitInventories = 0
        let commitDiffs = 0
        let api = {
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
        let { container, root, dispose } = render(api)
        await flush(root)
        let commit = container.querySelector<HTMLButtonElement>(".commit-heading")!
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
        let auxiliaryId = container.querySelector<HTMLElement>(".inspection-breakout")!.dataset.auxiliaryId
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
        let scenario = inspectionScenario()
        let { container, root, dispose } = render(scenario.api)
        await flush(root)
        let label = "[aria-label='More actions for commit Inspect changes']"
        expect(container.querySelector(label)).toBeNull()
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        expect(container.querySelector("[aria-label='Create branch at Inspect changes']")).toBeNull()
        expect(container.querySelector("[aria-label='Open commit Inspect changes in new worktree']")).toBeNull()
        click(container.querySelector<HTMLButtonElement>(label)!)
        await flush(root)
        let menu = container.querySelector<HTMLElement>(`dialog${label} [role='menu']`)!
        expect(menu.textContent).toContain("Create branch here…")
        click(button(menu, "Create branch here…"))
        await flush(root)
        expect(container.querySelector(`dialog${label}`)).toBeNull()
        let dialog = container.querySelector<HTMLDialogElement>("dialog[aria-label='Local Git operation']")!
        expect(dialog.querySelector("h2")!.textContent).toBe("Create branch")
        let name = dialog.querySelector<HTMLInputElement>("[aria-label='Branch name']")!
        input(name, "alias")
        await flush(root)
        expect(dialog.querySelector<HTMLInputElement>("[aria-label='Branch name']")!.value).toBe("alias")
        expect(button(dialog, "Create branch").disabled).toBe(false)
        click(button(dialog, "Cancel"))
        await flush(root)
        dispose()
    })

    test("rewords an expanded commit from its overflow menu and confirms published rewrites first", async () => {
        let scenario = inspectionScenario()
        let branch = scenario.graph.branches[1]
        let rewords: Array<{ request: LocalRequest; token?: string }> = []
        let graphReads = 0
        let published: string[] = []
        let api: Window["laneway"] = {
            ...scenario.api,
            readBranchGraph: async (...args) => {
                graphReads++
                return scenario.api.readBranchGraph(...args)
            },
            localOperation: async (id, request, token) => {
                if (request.action != "reword")
                    return scenario.api.localOperation(id, request, token)
                rewords.push({ request, token })
                if (token || !published.length)
                    return { ok: true, result: { type: "result", command: "local", status: "performed", message: "Commit reworded." } }
                return {
                    ok: true,
                    result: {
                        type: "result",
                        command: "local-preview",
                        status: "preview",
                        preview: {
                            token: "reword",
                            affected: [],
                            uniqueCommits: false,
                            unborn: false,
                            suggestedBranch: "",
                            staged: false,
                            files: [],
                            stashes: [],
                            worktrees: [],
                            composition: { branches: ["feature/laneway"], removed: [], conflicts: [], published, skipped: [], noop: false },
                        },
                    },
                }
            },
        }
        let { container, root, dispose } = render(api)
        try {
            await flush(root)
            let label = "[aria-label='More actions for commit Inspect changes']"
            let formLabel = "[aria-label='Reword commit Inspect changes']"
            let openForm = async () => {
                click(container.querySelector<HTMLButtonElement>(label)!)
                await flush(root)
                click(button(container.querySelector<HTMLElement>(`dialog${label} [role='menu']`)!, "Reword commit…"))
                await flush(root)
                return container.querySelector<HTMLElement>(formLabel)!
            }
            click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
            await flush(root)
            let form = await openForm()
            let title = form.querySelector<HTMLInputElement>("[aria-label='Commit title']")!
            expect(title.value).toBe("Inspect changes")
            expect(form.querySelector<HTMLTextAreaElement>("[aria-label='Commit message']")!.value).toBe("Inspect every change.")
            expect(button(form, "Apply").disabled).toBe(true)
            input(title, "Inspect all changes")
            await flush(root)
            expect(button(form, "Apply").disabled).toBe(false)
            let reads = graphReads
            click(button(form, "Apply"))
            await flush(root)
            expect(rewords.map(call => call.token)).toEqual([undefined])
            expect(rewords[0].request).toEqual({
                action: "reword",
                objectId: branch.tip,
                branch: "refs/heads/feature/laneway",
                title: "Inspect all changes",
                message: "Inspect every change.",
                selectedRemote: "origin",
            })
            expect(container.querySelector(formLabel)).toBeNull()
            expect(graphReads).toBeGreaterThan(reads)

            // Published history waits for an explicit decision instead of rewriting at once.
            published = ["feature/laneway"]
            rewords.length = 0
            form = await openForm()
            input(form.querySelector<HTMLInputElement>("[aria-label='Commit title']")!, "Inspect published changes")
            await flush(root)
            click(button(form, "Apply"))
            await flush(root)
            expect(form.querySelector("[role='alert']")!.textContent).toContain("Rewrites history already published on feature/laneway")
            expect(rewords.map(call => call.token)).toEqual([undefined])
            click(button(form, "Rewrite history"))
            await flush(root)
            expect(rewords.map(call => call.token)).toEqual([undefined, "reword"])
            expect(container.querySelector(formLabel)).toBeNull()
        } finally {
            dispose()
        }
    })

    test("disposes pending commit breakout reads with its source and restores no auxiliary columns", async () => {
        let scenario = inspectionScenario()
        let pending = new Map<string, (result: FileDiffResult) => void>()
        let cancelled: string[] = []
        let api = {
            ...scenario.api,
            readFileDiff: async (_repositoryId: string, id: string) => new Promise<FileDiffResult>(resolve => pending.set(id, resolve)),
            cancelInspection: async (_repositoryId: string, id: string) => {
                cancelled.push(id)
                return true
            },
        }
        let { container, root, dispose } = render(api)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        click(container.querySelector<HTMLButtonElement>("[aria-label='Show full diff for commit Inspect changes']")!)
        await flush(root)
        expect(pending.size).toBe(2)
        dispose()
        for (let [id, finish] of pending) {
            expect(cancelled).toContain(id)
            finish({ ok: true, page: scenario.page })
        }
        let restarted = render(scenario.api)
        await flush(restarted.root)
        expect(restarted.container.querySelector(".inspection-breakout")).toBeNull()
        expect(restarted.container.querySelector(".diff-inspector")).toBeNull()
        restarted.dispose()
    })

    test("opens file diffs independently beneath their rows and isolates pending reads", async () => {
        let scenario = inspectionScenario()
        let pending = new Map<string, { id: string; finish(result: FileDiffResult): void; request: Parameters<Window["laneway"]["readFileDiff"]>[2] }>()
        let { container, root, dispose } = render({
            ...scenario.api,
            readFileDiff: async (_repositoryId, id, request) => new Promise<FileDiffResult>(finish => pending.set(request.path, { id, request, finish })),
        })
        await flush(root)
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        let first = container.querySelector<HTMLButtonElement>(".inspect-commit [title='src/file.txt']")!
        let second = container.querySelector<HTMLButtonElement>(".inspect-commit [title='other.txt']")!
        let firstRow = first.closest(".file-inspection")!
        let secondRow = second.closest(".file-inspection")!
        click(first)
        click(second)
        await flush(root)
        expect(pending.size).toBe(2)
        expect(pending.get("src/file.txt")!.id).not.toBe(pending.get("other.txt")!.id)
        expect(firstRow.nextElementSibling).toBe(secondRow)
        expect(firstRow.querySelector(".change-file")!.nextElementSibling?.classList.contains("diff-inspector")).toBe(true)
        expect(secondRow.querySelector(".diff-inspector")).not.toBeNull()
        let complete = async (path: string) => {
            let read = pending.get(path)!
            read.finish(await scenario.api.readFileDiff("repository", read.id, read.request))
            await flush(root)
        }
        await complete("other.txt")
        let secondViewer = secondRow.querySelector(".pierre-diff")!
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
        let breakout = container.querySelector<HTMLElement>(".inspection-breakout")!
        let breakoutPaths = () => [...breakout.querySelectorAll<HTMLElement>("[data-diff-path]")].map(element => element.dataset.diffPath)
        let marked = () => [firstRow, secondRow].map(row => row.querySelector(".change-file")!.classList.contains("active"))
        expect(breakoutPaths()).toEqual(["src/file.txt", "other.txt"])
        expect(breakout.querySelector("header")?.textContent).toContain("Commit · Inspect changes")
        expect(marked()).toEqual([false, true])
        let fileToggle = breakout.querySelector<HTMLButtonElement>("[aria-label='Collapse other.txt']")!
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
        for (let [index, section] of breakout.querySelectorAll<HTMLElement>("[data-diff-path]").entries())
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
        let scenario = inspectionScenario()
        let reads = 0
        let views: string[] = []
        let api = {
            ...scenario.api,
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
                reads++
                views.push(args[2].view ?? "combined")
                return scenario.api.readFileDiff(...args)
            },
        }
        let { container, root, dispose } = render(api)
        await flush(root)
        expect(container.textContent).toContain("Working Changes")
        expect(container.querySelector(".staged-divider")?.textContent).toContain("Staged")
        expect(reads).toBe(0)
        // A partially staged file appears in both lists; each opens its own side without a view toggle.
        let rows = container.querySelectorAll<HTMLButtonElement>("[title='src/file.txt']")
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
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select addition line 1']")!)
        await flush(root)
        expect(diffRoot(container).querySelectorAll(".diff-line.selected")).toHaveLength(2)
        click(button(container, "Side by side"))
        await flush(root)
        expect(scenario.saved().repositories[0].columns[0].diffLayout).toBe("split")
        click(button(container, "Open diff column"))
        await flush(root)
        expect(container.querySelector(".branch-column + .column-divider")?.nextElementSibling?.classList.contains("inspection-breakout")).toBe(true)
        let breakout = container.querySelector<HTMLElement>(".inspection-breakout")!
        expect(document.activeElement).toBe(breakout)
        expect(breakout.querySelector("header")?.textContent).toContain("Staged · ")
        expect(breakout.dataset.sourceColumnId).toBe(container.querySelector<HTMLElement>(".branch-column")!.dataset.columnId)
        expect(breakout.querySelector(".auxiliary-source")?.textContent).toContain("From ")
        let auxiliaryId = breakout.dataset.auxiliaryId
        click(button(container, "Open diff column"))
        await flush(root)
        expect(container.querySelectorAll(".inspection-breakout")).toHaveLength(1)
        expect(document.activeElement).toBe(breakout)
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
        let restarted = render(api)
        await flush(restarted.root)
        expect(restarted.container.querySelector(".diff-inspector")).toBeNull()
        click(button(restarted.container, "Open diff column"))
        await flush(restarted.root)
        expect(restarted.container.querySelector(".inspection-breakout [aria-label='Diff for src/file.txt']")).not.toBeNull()
        expect(restarted.container.querySelector(".diff-lines.split")).not.toBeNull()
        expect(diffRoot(restarted.container).querySelector(".diff-line.selected")).toBeNull()
        restarted.dispose()
    })

    test("hidden-line counts reveal individual gaps and preserve selection across layouts", async () => {
        let scenario = inspectionScenario()
        scenario.page.lines = [
            { id: 0, kind: "hunk", text: "@@ -4,3 +4,3 @@", hunk: 0 },
            { id: 1, kind: "context", text: "line 4", oldLine: 4, newLine: 4, hunk: 0 },
            { id: 2, kind: "deletion", text: "old 5", oldLine: 5, hunk: 0 },
            { id: 3, kind: "addition", text: "new 5", newLine: 5, hunk: 0 },
            { id: 4, kind: "context", text: "line 6", oldLine: 6, newLine: 6, hunk: 0 },
            { id: 5, kind: "hunk", text: "@@ -12,3 +12,3 @@", hunk: 1 },
            { id: 6, kind: "context", text: "line 12", oldLine: 12, newLine: 12, hunk: 1 },
            { id: 7, kind: "deletion", text: "old 13", oldLine: 13, hunk: 1 },
            { id: 8, kind: "addition", text: "new 13", newLine: 13, hunk: 1 },
            { id: 9, kind: "context", text: "line 14", oldLine: 14, newLine: 14, hunk: 1 },
        ]
        let fullLines: DiffLine[] = [
            { id: 0, kind: "hunk", text: "@@ -1,18 +1,18 @@", hunk: 0 },
            ...Array.from({ length: 18 }, (_, index) => index + 1).flatMap<DiffLine>(number =>
                [5, 13].includes(number)
                    ? [{ id: number * 2, kind: "deletion", text: `old ${number}`, oldLine: number, hunk: 0 }, {
                        id: number * 2 + 1,
                        kind: "addition",
                        text: `new ${number}`,
                        newLine: number,
                        hunk: 0,
                    }]
                    : [{ id: number * 2, kind: "context", text: `line ${number}`, oldLine: number, newLine: number, hunk: 0 }]
            ),
        ]
        let fullReads = 0
        let api: Window["laneway"] = {
            ...scenario.api,
            readFileDiff: async (...args) => {
                let result = await scenario.api.readFileDiff(...args)
                if (result.ok && args[2].entireFile) {
                    fullReads++
                    let offset = args[2].offset ?? 0
                    result.page = {
                        ...result.page,
                        entireFile: true,
                        version: "full",
                        lines: fullLines.slice(offset, offset ? undefined : 7),
                        nextOffset: offset ? undefined : 7,
                    }
                }
                return result
            },
        }
        let { container, root, dispose } = render(api)
        try {
            await flush(root)
            click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
            await flush(root)
            let show = (count: number) => diffRoot(container).querySelector<HTMLButtonElement>(`[aria-label='Show ${count} hidden lines']`)!
            expect(show(3).textContent).toBe("3 hidden lines")
            expect(show(5).textContent).toBe("5 hidden lines")
            expect(fullReads).toBe(0)
            click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select addition line 5']")!)
            await flush(root)
            click(show(3))
            await flush(root)
            expect(diffRoot(container).querySelector("[data-line='1']")?.textContent?.trimEnd()).toBe("line 1")
            expect(diffRoot(container).querySelector("[data-line='8']")).toBeNull()
            expect(diffRoot(container).querySelector(".addition.selected")?.textContent?.trimEnd()).toBe("new 5")
            click(button(container, "Side by side"))
            await flush(root)
            expect(show(5)).not.toBeNull()
            click(show(5))
            await flush(root)
            expect(diffRoot(container).querySelector("[data-line='8']")?.textContent?.trimEnd()).toBe("line 8")
            expect(diffRoot(container).querySelector("[data-line='16']")).toBeNull()
            click(show(4))
            await flush(root)
            expect(diffRoot(container).querySelector("[data-line='18']")?.textContent?.trimEnd()).toBe("line 18")
            expect(fullReads).toBe(2)
            expect(diffRoot(container).querySelector(".addition.selected")?.textContent?.trimEnd()).toBe("new 5")
        } finally {
            dispose()
        }
    })

    test("entire-file toolbar toggle reloads open diffs, separates cached views, and rejects superseded reads", async () => {
        let scenario = inspectionScenario()
        let requests: Parameters<Window["laneway"]["readFileDiff"]>[2][] = []
        let pending: (() => void)[] = []
        let api = {
            ...scenario.api,
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
                let request = args[2]
                requests.push(request)
                let result = await scenario.api.readFileDiff(...args)
                if (request.entireFile) {
                    await new Promise<void>(resolve => pending.push(resolve))
                    if (result.ok) {
                        result.page = {
                            ...result.page,
                            entireFile: true,
                            version: "entire",
                            lines: [...result.page.lines, { id: 3, kind: "context", text: "outside changes", oldLine: 2, newLine: 2, hunk: 0 }],
                        }
                    }
                }
                return result
            },
        }
        let { container, root, dispose } = render(api)
        try {
            await flush(root)
            click(container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
            await flush(root)
            click(button(container, "Break out diff"))
            await flush(root)
            let column = container.querySelector<HTMLElement>(".inspection-breakout")!
            let toggle = () => column.querySelector<HTMLButtonElement>("[aria-label='Show entire files']")!
            expect(toggle().getAttribute("aria-pressed")).toBe("false")
            click(toggle())
            await flush(root)
            expect(requests.at(-1)?.entireFile).toBe(true)
            expect(toggle().getAttribute("aria-pressed")).toBe("true")
            pending.splice(0).forEach(resolve => resolve())
            await flush(root)
            expect(diffRoot(column).textContent).toContain("outside changes")
            click(toggle())
            await flush(root)
            expect(diffRoot(column).textContent).not.toContain("outside changes")
            click(toggle())
            await flush(root)
            click(toggle())
            await flush(root)
            pending.splice(0).forEach(resolve => resolve())
            await flush(root)
            expect(toggle().getAttribute("aria-pressed")).toBe("false")
            expect(diffRoot(column).textContent).not.toContain("outside changes")
            click(button(column, "Close diff column"))
            await flush(root)
            let file = container.querySelector<HTMLButtonElement>("[title='src/file.txt']")!
            click(file)
            await flush(root)
            click(file)
            await flush(root)
            expect(diffRoot(container).textContent).not.toContain("outside changes")
        } finally {
            dispose()
        }
    })

    test("rejects superseded reads and clears stale or collapsed-file selections", async () => {
        let scenario = inspectionScenario()
        let finish: (page: FileDiffResult) => void = () => {}
        let first = true
        let version = "one"
        let api = {
            ...scenario.api,
            // A changed file changes the inventory version too; open diffs are only re-read once it does.
            readChanges: async (...args: Parameters<Window["laneway"]["readChanges"]>): Promise<ChangesResult> => {
                let result = await scenario.api.readChanges(...args)
                return result.ok ? { ...result, inventory: { ...result.inventory, version: `${result.inventory.version}:${version}` } } : result
            },
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
                if (first) {
                    first = false
                    return new Promise<FileDiffResult>(resolve => finish = resolve)
                }
                let result = await scenario.api.readFileDiff(...args)
                return result.ok ? { ...result, page: { ...result.page, version } } : result
            },
        }
        let { container, root, dispose } = render(api)
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
        let scenario = inspectionScenario()
        let historyReads = 0
        let api = {
            ...scenario.api,
            readBranchHistory: async (...args: Parameters<Window["laneway"]["readBranchHistory"]>) => {
                historyReads++
                return scenario.api.readBranchHistory(...args)
            },
            readFileDiff: async (...args: Parameters<Window["laneway"]["readFileDiff"]>) => {
                let result = await scenario.api.readFileDiff(...args)
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
        let { container, root, dispose } = render(api)
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

    test("one view menu folds and groups every file list, persists the choice, and folding closes open diffs", async () => {
        let scenario = inspectionScenario()
        let saved: FileListView[] = []
        let files: ChangedFile[] = [
            { path: "src/file.txt", status: "modified", staged: false, unstaged: true, untracked: false, ignored: false, conflicted: false },
            { path: "other.txt", status: "modified", staged: false, unstaged: true, untracked: false, ignored: false, conflicted: false },
            { path: "test/unit/file.test.ts", status: "added", staged: false, unstaged: true, untracked: true, ignored: false, conflicted: false },
        ]
        let api: Window["laneway"] = {
            ...scenario.api,
            readChanges: async (_id, _requestId, request) => ({
                ok: true,
                inventory: {
                    source: request.source,
                    files,
                    version: "inventory",
                    parents: request.source.kind == "commit" ? [scenario.graph.branches[0].tip] : [],
                },
            }),
            setFileListView: async view => {
                saved.push(view)
                return view
            },
        }
        let summaries = (scope: Element) => [...scope.querySelectorAll(".file-tree summary .folder-name")].map(name => name.textContent?.trim())
        let choose = async (label: string, item: string) => {
            click(container.querySelector<HTMLButtonElement>(label)!)
            await flush(root)
            let menu = container.querySelector<HTMLElement>(`dialog${label} [role='menu']`)!
            click(button(menu, item))
            await flush(root)
            expect(container.querySelector(`dialog${label}`)).toBeNull()
        }
        let { container, root, dispose } = render(api)
        await flush(root)
        let working = container.querySelector<HTMLElement>(".working-changes")!
        let workingLabel = "[aria-label='File list view for Working Changes']"
        expect(working.querySelector(".file-tree details")).toBeNull()
        expect(working.querySelectorAll(".change-file")).toHaveLength(3)

        click(container.querySelector<HTMLButtonElement>(workingLabel)!)
        await flush(root)
        let menu = container.querySelector<HTMLElement>(`dialog${workingLabel} [role='menu']`)!
        expect([...menu.querySelectorAll("[role='menuitemradio'][aria-checked='true']")].map(item => item.textContent?.trim())).toEqual([
            "Flat list",
            "No grouping",
        ])
        click(button(menu, "Folders"))
        await flush(root)
        expect(saved).toEqual([{ layout: "tree", grouping: "none" }])
        // Folders holding only the next folder collapse into one row.
        expect(summaries(working)).toEqual(["src", "test/unit"])
        expect(working.querySelector(".file-tree details .file-folder")).toBeNull()
        expect(working.querySelectorAll(".change-file")).toHaveLength(3)

        // An expanded commit shares the view and offers the same menu.
        let commitLabel = "[aria-label='File list view for commit Inspect changes']"
        expect(container.querySelector(commitLabel)).toBeNull()
        click(container.querySelector<HTMLButtonElement>(".commit-heading")!)
        await flush(root)
        let commit = container.querySelector<HTMLElement>(".inspect-commit")!
        expect(summaries(commit)).toEqual(["src", "test/unit"])
        await choose(commitLabel, "Group by change")
        expect(saved.at(-1)).toEqual({ layout: "tree", grouping: "change" })
        expect(summaries(working)).toEqual(["Added", "test/unit", "Changed", "src"])
        expect(summaries(commit)).toEqual(["Added", "test/unit", "Changed", "src"])

        await choose(workingLabel, "Flat list")
        await choose(workingLabel, "Group by file kind")
        expect(saved.at(-1)).toEqual({ layout: "flat", grouping: "kind" })
        expect(summaries(working)).toEqual(["Implementation", "Tests"])
        expect(working.querySelector(".file-tree details .file-folder")?.textContent).toBe("src/")

        // A group row selects and drags every file it holds; selecting them all again clears the selection.
        let groupCheck = working.querySelector<HTMLInputElement>("[aria-label='Select 2 files in Implementation']")!
        expect(working.querySelector("[aria-label='Move or copy 2 files in Implementation']")).not.toBeNull()
        click(groupCheck)
        await flush(root)
        expect(working.querySelector(".selection-summary")!.textContent).toContain("2 of 3 selected")
        expect(working.querySelector<HTMLInputElement>("[aria-label='Select file src/file.txt']")!.checked).toBe(true)
        expect(working.querySelector<HTMLInputElement>("[aria-label='Select 2 files in Implementation']")!.checked).toBe(true)
        click(working.querySelector<HTMLInputElement>("[aria-label='Select file other.txt']")!)
        await flush(root)
        expect(working.querySelector<HTMLInputElement>("[aria-label='Select 2 files in Implementation']")!.checked).toBe(false)
        click(working.querySelector<HTMLInputElement>("[aria-label='Select 2 files in Implementation']")!)
        await flush(root)
        expect(working.querySelector(".selection-summary")!.textContent).toContain("2 of 3 selected")
        click(working.querySelector<HTMLInputElement>("[aria-label='Select 2 files in Implementation']")!)
        await flush(root)
        expect(working.querySelector(".selection-summary")).toBeNull()

        // Folding a group closes the diffs it hides.
        click(working.querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        expect(working.querySelector(".diff-inspector")).not.toBeNull()
        let group = working.querySelector<HTMLDetailsElement>(".file-tree details")!
        group.removeAttribute("open")
        group.dispatchEvent(new Event("toggle"))
        await flush(root)
        expect(working.querySelector(".diff-inspector")).toBeNull()
        expect(working.querySelector<HTMLDetailsElement>(".file-tree details")!.hasAttribute("open")).toBe(false)
        dispose()
    })
})

test("sparse File History fills a page of matching commits, stays lazy, and retains progress on refresh", async () => {
    let scenario = inspectionScenario()
    let cursors: Array<string | undefined> = []
    let releaseScan: (() => void) | undefined
    let releaseMore: (() => void) | undefined
    let cancellations = 0
    scenario.api.cancelInspection = async () => {
        cancellations++
        return true
    }
    let patches = 0
    let readDiff = scenario.api.readFileDiff
    scenario.api.readFileDiff = (...args) => {
        patches++
        return readDiff(...args)
    }
    scenario.api.readFileHistory = async (_repo, _id, request) => {
        cursors.push(request.cursor?.objectId)
        let offset = !request.cursor ? 0 : Number(request.cursor.objectId[0]) - 2
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
    let { container, root, dispose } = render(scenario.api)
    try {
        await flush(root)
        container.querySelector<HTMLElement>(".change-file")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
        await flush(root)
        click(button(container, "File history"))
        await flush(root)
        let history = container.querySelector<HTMLElement>(".file-history")!
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

test("file rows copy their path from a hover button and from the context menu", async () => {
    let scenario = inspectionScenario()
    let { container, root, dispose } = render(scenario.api)
    try {
        await flush(root)
        let row = container.querySelector<HTMLElement>(".change-file")!
        let copy = row.querySelector<HTMLButtonElement>(".copy-path")!
        expect(copy.getAttribute("aria-label")).toBe("Copy relative path of src/file.txt")
        expect(row.querySelector("button[aria-expanded]")!.contains(copy)).toBe(false)
        click(copy)
        await flush(root)
        expect(await navigator.clipboard.readText()).toBe("src/file.txt")
        expect(copy.hasAttribute("data-copied")).toBe(true)
        expect(row.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("false")

        let menu = async (label: string) => {
            row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }))
            await flush(root)
            let dialog = container.querySelector<HTMLElement>("dialog[aria-label='File actions']")!
            expect([...dialog.querySelectorAll("button")].map(item => item.textContent?.trim())).toEqual([
                "File history",
                "Discard all changes",
                "Copy full path",
                "Copy relative path",
                "Copy file name",
            ])
            expect(dialog.querySelectorAll("hr")).toHaveLength(2)
            click(button(dialog, label))
            await flush(root)
            return navigator.clipboard.readText()
        }
        expect(await menu("Copy full path")).toBe("D:\\Source\\inspection\\src\\file.txt")
        expect(await menu("Copy file name")).toBe("file.txt")
        expect(await menu("Copy relative path")).toBe("src/file.txt")
    } finally {
        dispose()
    }
})

test("working files discard from the context menu and the selection, with Undo while the notice shows", async () => {
    let scenario = inspectionScenario()
    let requests: unknown[] = [], undone: string[] = [], settled: string[] = [], reads = 0
    let readChanges = scenario.api.readChanges
    scenario.api.readChanges = (...args) => {
        reads++
        return readChanges(...args)
    }
    scenario.api.discardChanges = async (_id, request) => {
        requests.push(request)
        return { ok: true, id: `discard-${requests.length}`, undoable: true }
    }
    scenario.api.undoDiscard = async (_id, id) => {
        undone.push(id)
        return { ok: true, kept: [] }
    }
    scenario.api.settleDiscard = async (_id, id) => {
        settled.push(id)
    }
    let { container, root, dispose } = render(scenario.api)
    try {
        await flush(root)
        let rows = container.querySelectorAll<HTMLElement>(".change-file")
        let discard = async (row: HTMLElement, label: string) => {
            row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }))
            await flush(root)
            click(button(container.querySelector<HTMLElement>("dialog[aria-label='File actions']")!, label))
            await flush(root)
        }
        let notice = () => container.querySelector<HTMLElement>(".notice:not([hidden])")

        // The staged list sits above the unstaged list, and each row discards its own side.
        let before = reads
        await discard(rows[0], "Discard all changes")
        expect(requests).toEqual([{
            kind: "files",
            worktreePath: "D:\\Source\\inspection",
            view: "staged",
            files: [{ path: "src/file.txt", oldPath: undefined, untracked: false }],
        }])
        expect(reads).toBeGreaterThan(before)
        expect(notice()?.textContent).toContain("Discarded src/file.txt")
        click(notice()!.querySelector<HTMLElement>(".notice-action")!)
        await flush(root)
        expect(undone).toEqual(["discard-1"])
        expect(settled).toEqual([])
        expect(notice()?.textContent).toContain("Discard undone.")

        // Discards made while the notice shows join it, and Ctrl+Z undoes them all before any Operation History undo.
        await discard(rows[2], "Discard unstaged changes")
        await discard(rows[3], "Discard unstaged changes")
        expect(requests.slice(1).map(request => (request as { view: string }).view)).toEqual(["unstaged", "unstaged"])
        expect(notice()?.textContent).toContain("Discarded 2 files")
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }))
        await flush(root)
        expect(undone).toEqual(["discard-1", "discard-3", "discard-2"])

        // Closing the notice settles the discard for good.
        await discard(rows[0], "Discard all changes")
        click(button(notice()!, "Dismiss"))
        await flush(root)
        expect(settled).toEqual(["discard-4"])
        expect(undone).toHaveLength(3)

        // Selected lines discard from the unstaged side only; the staged side offers no line discard.
        click(rows[0].querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        click(diffRoot(container).querySelector<HTMLButtonElement>("[aria-label='Select deletion line 1']")!)
        await flush(root)
        expect(container.querySelector(".discard-lines")).toBeNull()
        click(rows[2].querySelector<HTMLButtonElement>("[title='src/file.txt']")!)
        await flush(root)
        let unstaged = rows[2].closest<HTMLElement>(".file-inspection")!
        click(diffRoot(unstaged).querySelector<HTMLButtonElement>("[aria-label='Select addition line 1']")!)
        await flush(root)
        click(unstaged.querySelector<HTMLButtonElement>(".discard-lines")!)
        await flush(root)
        expect(requests.at(-1)).toMatchObject({ kind: "lines", worktreePath: "D:\\Source\\inspection", path: "src/file.txt", lineIds: [2] })
        expect((requests.at(-1) as { lines: unknown[] }).lines).toHaveLength(3)
        expect(notice()?.textContent).toContain("Discarded 1 line in src/file.txt")
    } finally {
        dispose()
    }
})

test("File History shares file inspection, opens blame origins, reuses inputs and closes descendants", async () => {
    let scenario = inspectionScenario()
    let oid = "2".repeat(40)
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
    let { container, root, dispose } = render(scenario.api)
    try {
        await flush(root)
        let row = container.querySelector<HTMLElement>(".change-file")!
        let menu = async () => {
            row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }))
            await flush(root)
            click(button(container, "File history"))
            await flush(root)
        }
        await menu()
        let history = container.querySelector<HTMLElement>(".file-history")!
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
        let commitRow = history.querySelector<HTMLElement>(".history-entry .change-file")!
        expect(history.querySelectorAll(".change-file")).toHaveLength(1)
        for (let label of ["Unified", "Side by side", "Show whitespace"]) {
            let control = commitRow.querySelector<HTMLButtonElement>(`[aria-label='${label}']`)!
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
        let historyMenu = async () => {
            commitRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
            await flush(root)
        }
        await historyMenu()
        click(button(history, "Complete commit diff"))
        await flush(root)
        let commit = container.querySelector<HTMLElement>(".trail-commit")!
        expect(commit.querySelectorAll(".change-file")).toHaveLength(2)
        let parent = commit.querySelector<HTMLSelectElement>("[aria-label='Commit diff parent']")!
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
    let scenario = inspectionScenario()
    let staged = false, committed = false, version = 0
    let draft = { title: "", message: "", branch: "" }
    let mutations: string[] = []
    let api: Window["laneway"] = {
        ...scenario.api,
        readCommitDraft: async () => ({ ...draft }),
        saveCommitDraft: async (_id, _path, value) => {
            draft = { ...value }
        },
        readChanges: async (...args) => {
            let result = await scenario.api.readChanges(...args)
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
    let view = render(api)
    try {
        await flush(view.root)
        expect(view.container.querySelector(".staged-divider")).toBeNull()
        expect(view.container.querySelector('[aria-label="Staged files"]')).toBeNull()
        let header = view.container.querySelector(".commit-header")!
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
        let title = view.container.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!
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
        // A checked file is summarized beside its own list, and the commit that removes it clears the selection.
        click(view.container.querySelector<HTMLInputElement>('[aria-label="Staged files"] [aria-label="Select file src/file.txt"]')!)
        await flush(view.root)
        expect(view.container.querySelector('[aria-label="Staged files"] .selection-summary')!.textContent).toContain("1 of 1 selected")
        click(button(view.container, "Commit staged (1)"))
        await flush(view.root)
        expect(mutations).toEqual(["stage", "commit"])
        expect(draft.title).toBe("")
        expect(view.container.querySelector('[aria-label="Commit title"]')).toBeNull()
        expect(view.container.querySelector(".selection-summary")).toBeNull()
        expect(view.container.querySelector(".commit-notice")).toBeNull()
        expect(view.container.querySelector(".notice:not([hidden])")!.textContent).toContain("Commit created.")
    } finally {
        view.dispose()
    }
})

test("a detached worktree lists its proposed branch below Working Changes with an editable name", async () => {
    let scenario = inspectionScenario()
    let repository = repositoryInfo("D:\Source\inspection")
    let head = "2".repeat(40)
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
    let requests: Parameters<Window["laneway"]["localOperation"]>[1][] = []
    let opened = openedWorkspace(repository)
    let api: Window["laneway"] = {
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
    let view = render(api)
    try {
        await flush(view.root)
        expect(view.container.querySelector('[aria-label="New branch name"]')).toBeNull()
        let card = view.container.querySelector<HTMLElement>(".working-changes .virtual-branch")!
        expect(card).not.toBeNull()
        // The proposed branch reads like the branch cards below a real branch's Working Changes.
        expect(view.container.querySelector(".commit-card")!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
        expect(card.querySelector(".virtual-branch-heading svg")).not.toBeNull()
        expect(button(card, "Rename new branch").textContent).toBe("inspection")
        click(button(card, "Rename new branch"))
        await flush(view.root)
        let field = card.querySelector<HTMLInputElement>('[aria-label="New name for new branch"]')!
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
    let scenario = inspectionScenario()
    let repository = repositoryInfo("D:\\Source\\inspection")
    let head = "2".repeat(40)
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
    let released = new Promise<void>(resolve => releasePreview = resolve)
    let graphReads = 0
    let notifyChange: ((change: { repositoryId: string }) => void) | undefined
    let opened = openedWorkspace(repository)
    let api: Window["laneway"] = {
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
    let view = render(api)
    try {
        await flush(view.root)
        // The Branch Graph already says the worktree is detached; the engine's slower preview only refines the name.
        let card = () => view.container.querySelector<HTMLElement>(".working-changes .virtual-branch")!
        expect(card()).not.toBeNull()
        expect(button(card(), "Rename new branch").textContent).toBe("worktree/inspection")
        releasePreview!()
        await flush(view.root)
        expect(button(card(), "Rename new branch").textContent).toBe("inspection-2")
        // A change noticed on disk refreshes the active repository without waiting for the next poll.
        let before = graphReads
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
    let scenario = inspectionScenario()
    let calls: Array<{ action: string; token?: string }> = []
    let api: Window["laneway"] = {
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
    let view = render(api)
    try {
        await flush(view.root)
        let column = view.container.querySelector<HTMLElement>('[data-column-id="branch:refs/heads/feature/laneway"]')!
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
    let scenario = inspectionScenario()
    let branch = scenario.graph.branches[1]
    let requests: Parameters<Window["laneway"]["localOperation"]>[1][] = []
    let api: Window["laneway"] = {
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
    let view = render(api)
    try {
        await flush(view.root)
        let heading = view.container.querySelector<HTMLElement>(".composition-branch-target")!
        let name = button(heading, "Rename branch feature/laneway")
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
        // Typed text has to survive the render that follows each keystroke, not just the one that submits it.
        await flush(view.root)
        expect(field.value).toBe("feature/renamed")
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await flush(view.root)
        expect(requests).toEqual([{ action: "branch-rename", name: "feature/laneway", newName: "main" }, {
            action: "branch-rename",
            name: "feature/laneway",
            newName: "feature/renamed",
        }])
        let renamed = view.container.querySelector<HTMLElement>(".composition-branch-target")!
        expect(button(renamed, "Rename branch feature/renamed").textContent).toBe("feature/renamed")
        expect(renamed.querySelector("input")).toBeNull()
    } finally {
        view.dispose()
    }
})

test("Branch Graph settings keep a typed pattern draft across quiet refreshes", async () => {
    let repository = repositoryInfo("D:\Source\graph-settings-draft")
    let graph: BranchGraph = branchGraph(repository.id)
    let api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
        setRepositoryGraphSettings: async (_id, settings) => {
            graph = { ...graph, remotePatterns: settings.remotePatterns }
            return settings
        },
    })
    let { container, root, dispose } = render(api)
    await flush(root)
    click(container.querySelector<HTMLButtonElement>("[aria-label='Branch Graph settings']")!)
    await flush(root)
    let patterns = container.querySelector<HTMLInputElement>("#remote-patterns")!
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
    let upstreamTip = "4".repeat(40)
    let notice = (container: HTMLElement) => container.querySelector(".notice:not([hidden])")?.textContent ?? ""
    let dialog = (container: HTMLElement) => container.querySelector<HTMLElement>("dialog.branch-rebase")
    let row = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-node-id="branch:refs/heads/${name}"]`)!
    let feature = { kind: "branch" as const, branch: "refs/heads/feature/laneway", tip: "2".repeat(40) }
    let team = { kind: "branch" as const, branch: "refs/heads/other/team", tip: "3".repeat(40) }

    test("rebases a dropped branch with its dependents straight away when nothing needs deciding", async () => {
        let { api, calls } = scenario()
        let view = render(api)
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
        let { api, calls } = scenario(graph => {
            Object.assign(graph.branches[0], { upstreamRef: "refs/remotes/origin/main", upstreamTip, behind: 2, remoteRefs: ["refs/remotes/origin/main"] })
        })
        let view = render(api)
        try {
            await flush(view.root)
            drag(view.container, "feature/laneway", "main")
            await flush(view.root)
            let shown = dialog(view.container)!
            expect(shown.textContent).toContain("Local tip, 2 commits behind origin/main")
            expect(shown.textContent).toContain("1 commit since main")
            expect(shown.textContent).toContain("Laneway work")
            expect(calls.map(call => call.request.target)).toEqual([{ kind: "branch", branch: "refs/heads/main", tip: "1".repeat(40) }])
            let upstream = [...shown.querySelectorAll<HTMLInputElement>("input[type=radio]")][1]
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
        let { api, calls, review } = scenario()
        let view = render(api)
        try {
            await flush(view.root)
            review({ published: ["feature/laneway"] })
            drag(view.container, "feature/laneway", "other/team")
            await flush(view.root)
            expect(dialog(view.container)!.textContent).toContain("Rewrites history already published on feature/laneway")
            let dependents = dialog(view.container)!.querySelector<HTMLInputElement>("input[type=checkbox]")!
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

    test("shows each branch sharing a tip as its own row to open, drag, and drop onto", async () => {
        let { api, calls } = scenario(graph => {
            Object.assign(graph.branches[1], {
                localRefs: ["refs/heads/feature/laneway", "refs/heads/feature/sibling"],
                refs: ["refs/heads/feature/laneway", "refs/heads/feature/sibling"],
                aliases: ["feature/laneway", "feature/sibling"],
            })
        })
        let sibling = { kind: "branch" as const, branch: "refs/heads/feature/sibling", tip: "2".repeat(40) }
        let view = render(api)
        try {
            await flush(view.root)
            let rows = [...view.container.querySelectorAll<HTMLElement>(".graph-row")].map(row => row.dataset.nodeId)
            expect(rows.indexOf("branch:refs/heads/feature/sibling")).toBe(rows.indexOf("branch:refs/heads/feature/laneway") + 1)
            // One commit's node spans both rows, so siblings don't read as a stack.
            expect(row(view.container, "feature/laneway").querySelector(".shared-commit")).not.toBeNull()
            expect(row(view.container, "feature/sibling").querySelector(".shared-commit")).not.toBeNull()
            expect(row(view.container, "other/team").querySelector(".shared-commit")).toBeNull()

            // Neither sibling lands on the other or on a branch stacked on their shared tip.
            expect(drag(view.container, "feature/sibling", "feature/laneway").accepted).toBe(false)
            expect(drag(view.container, "feature/laneway", "feature/sibling").accepted).toBe(false)
            expect(drag(view.container, "feature/sibling", "child").accepted).toBe(false)
            expect(drag(view.container, "other/team", "feature/sibling").accepted).toBe(true)
            await flush(view.root)
            expect(calls.at(-1)?.request.target).toEqual(sibling)
            expect(drag(view.container, "feature/sibling", "other/team").accepted).toBe(true)
            await flush(view.root)
            expect(calls.at(-1)?.request).toMatchObject({ source: sibling, target: team })

            click(row(view.container, "feature/sibling").querySelector<HTMLButtonElement>(".open-branch")!)
            await flush(view.root)
            expect(view.container.querySelector("[data-column-id='branch:refs/heads/feature/sibling']")).not.toBeNull()
            expect(view.container.querySelector("[data-column-id='branch:refs/heads/feature/laneway']")).toBeNull()

            // Keyboard actions on the selected row act on that identity, not the one leading its tip.
            view.container.querySelector<HTMLElement>(".graph-rows")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }))
            await flush(view.root)
            expect([...view.container.querySelectorAll<HTMLInputElement>("input")].some(input => input.value == "feature/sibling")).toBe(true)
        } finally {
            view.dispose()
        }
    })

    test("chooses a destination by keyboard or from the context menu", async () => {
        let { api, calls } = scenario()
        let view = render(api)
        try {
            await flush(view.root)
            let rows = view.container.querySelector<HTMLElement>(".graph-rows")!
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
    function scenario(configure: (graph: BranchGraph) => void = () => {}) {
        let repository = repositoryInfo("D:\\Source\\rebase-graph")
        let graph = branchGraph(repository.id)
        let feature = graph.branches[1]
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
        let calls: Array<{ request: CompositionRequest; token?: string }> = []
        let review: Partial<CompositionPreview> = {}
        let api = fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
            localOperation: async (_id, request, token) => {
                calls.push({ request: request as CompositionRequest, token })
                if (token)
                    return { ok: true, result: { type: "result", command: "local", status: "performed" } }
                let composition: CompositionPreview = {
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
        let transfer = new (window as unknown as { DataTransfer: new() => DataTransfer }).DataTransfer()
        let event = (type: string) => {
            let value = new MouseEvent(type, { bubbles: true, cancelable: true })
            Object.defineProperty(value, "dataTransfer", { value: transfer })
            return value
        }
        let source = container.querySelector<HTMLElement>(`[data-node-id="branch:refs/heads/${from}"]`)!
        let target = container.querySelector<HTMLElement>(`[data-node-id="branch:refs/heads/${to}"]`)!
        source.dispatchEvent(event("dragstart"))
        let over = event("dragover")
        target.dispatchEvent(over)
        let highlighted = target.classList.contains("rebase-target")
        if (over.defaultPrevented)
            target.dispatchEvent(event("drop"))
        source.dispatchEvent(event("dragend"))
        return { accepted: over.defaultPrevented, highlighted }
    }
})

function render(api: Window["laneway"]) {
    let container = document.createElement("div")
    document.body.append(container)
    let root = createRoot(container)
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
    let result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate =>
        candidate.getAttribute("aria-label") == label || candidate.textContent?.trim() == label
    )
    if (!result)
        throw new Error(`Button not found: ${label}. Rendered: ${container.textContent}`)
    return result
}

function diffRoot(container: Element): ShadowRoot | Element {
    return container.querySelector(".pierre-diff")?.shadowRoot ?? container
}
