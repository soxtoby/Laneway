import type { EntryProgress, EntryResult, FileDiffResult } from "@git-workbench/shared"
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

describe("Working Changes inspection", () => {
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
        click(container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(root)
        expect(container.querySelectorAll(".diff-inspector")).toHaveLength(0)
        dispose()
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
        expect(container.textContent).not.toContain("Focus diff")
        click(container.querySelector<HTMLButtonElement>("[aria-label='Close diff column']")!)
        await flush(root)
        expect(container.querySelector(".inspection-breakout")).toBeNull()
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
        expect(container.querySelector(".stack-heading")?.getAttribute("aria-expanded")).toBe("true")
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
        click(container.querySelector<HTMLButtonElement>(".stack-heading")!)
        await flush(root)
        expect(container.querySelector(".diff-inspector")).toBeNull()
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
