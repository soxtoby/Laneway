import type { PullActionResult, PullProgress } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps } from "./react-dom"
import { appState, branchGraph, fakeLaneway, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React Pull latest", () => {
    test("pulls a column's stack from its branch's heading, carrying the open columns, with progress and Cancel, and summarizes outcomes by stack", async () => {
        let repository = repositoryInfo("D:\\Source\\pull-graph")
        let graph = branchGraph(repository.id)
        let [main, feature] = graph.branches
        let workspace = withColumns(repository, [main!, feature!])
        let requested: unknown
        let progress: ((value: PullProgress) => void) | undefined
        let finish: (value: PullActionResult) => void = () => {}
        let cancelled = 0
        let graphReads = 0
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace }),
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
        }))
        let readsBefore = graphReads
        let header = () => document.querySelector<HTMLElement>(".header")!
        let column = (branch: { id: string }) => document.querySelector<HTMLElement>(`[data-column-id="${branch.id}"]`)!

        await app.act(() => press(button(column(feature!), "Pull latest for feature/laneway")))
        expect(requested).toEqual({ branches: [feature!.preferredRef], open: [main!.preferredRef, feature!.preferredRef], remote: "origin" })
        expect(column(feature!).querySelector(".pull-progress")?.textContent).toContain("Fetching…")
        expect(button(header(), "Undo last operation").hasAttribute("disabled")).toBe(true)
        // One pull runs at a time in a repository.
        expect(button(column(main!), "Pull latest for main").hasAttribute("disabled")).toBe(true)
        expect(column(main!).querySelector(".pull-slot")?.getAttribute("aria-description")).toBe("Another pull is running.")
        await app.act(() => progress!({ repositoryId: repository.id, message: "Updating feature/laneway…", completed: 1, total: 2 }))
        expect(column(feature!).querySelector(".pull-progress")?.textContent).toContain("Updating feature/laneway…")
        await app.act(() => press(button(column(feature!), "Cancel pull")))
        expect(cancelled).toBe(1)
        expect(column(feature!).querySelector(".pull-progress")?.textContent).toContain("Cancelling")

        await app.act(() =>
            finish({
                ok: true,
                result: {
                    type: "result",
                    command: "pull",
                    status: "updated",
                    message: "Pull complete: 1 updated, 1 need resolution.",
                    fetches: [{ remote: "origin", status: "fetched" }],
                    stacks: [{ id: "a", branches: ["main"], status: "updated" }, {
                        id: "b",
                        branches: ["main", "feature/laneway"],
                        status: "needs-resolution",
                        message: "1 commit conflict deferred for inline resolution.",
                        conflicts: 1,
                    }],
                    operation: {
                        id: "op",
                        timestamp: "2026-09-20T00:00:00Z",
                        kind: "pull.latest",
                        summary: "Pull latest",
                        affectedRefs: [],
                        affectedWorktrees: [],
                    },
                },
            })
        )
        expect(graphReads).toBeGreaterThan(readsBefore)
        let outcome = document.querySelector<HTMLElement>(".pull-outcome")!
        expect(outcome.querySelector(".pull-summary")?.textContent).toBe("Pull complete: 1 updated, 1 need resolution.")
        expect(outcome.querySelector(".pull-counts")?.textContent).toBe("1 updated · 1 needs resolution")
        let stacks = [...outcome.querySelectorAll<HTMLElement>(".pull-stack")]
        expect(stacks.map(stack => stack.querySelector(".pull-status")?.textContent)).toEqual(["Updated", "Needs resolution"])
        expect(stacks[1]!.hasAttribute("data-expanded")).toBe(true)
        expect(stacks[1]!.textContent).toContain("1 commit conflict deferred")
        expect(column(feature!).querySelector(".pull-progress") == null).toBe(true)

        // Resolving opens the stack's branch, focusing its column.
        await app.act(() => press(button(outcome, "Resolve in feature/laneway")))
        await app.act(() => new Promise(resolve => requestAnimationFrame(resolve)))
        expect(document.querySelector(".pull-outcome") == null).toBe(true)
        expect((document.activeElement as HTMLElement | null)?.dataset.columnId).toBe(feature!.id)
    })

    test("an uneventful pull confirms in passing without a dialog", async () => {
        let repository = repositoryInfo("D:\\Source\\quiet-pull")
        let graph = branchGraph(repository.id)
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: withColumns(repository, [graph.branches[1]!]) }),
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
        }))

        await app.act(() => press(button(document.querySelector<HTMLElement>(".columns")!, "Pull latest for feature/laneway")))
        expect(document.querySelector(".pull-outcome") == null).toBe(true)
        expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Pull complete: 1 updated, 1 already current.")
    })

    test("Pull latest and Fetch are unavailable without remotes, and say why", async () => {
        let repository = repositoryInfo("D:\\Source\\no-remotes")
        let graph = { ...branchGraph(repository.id), availableRemotes: [], selectedRemote: undefined }
        await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: withColumns(repository, [graph.branches[1]!]) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        }))
        let header = document.querySelector<HTMLElement>(".header")!
        let columns = document.querySelector<HTMLElement>(".columns")!

        expect(button(columns, "Pull latest for feature/laneway").hasAttribute("disabled")).toBe(true)
        expect(columns.querySelector(".pull-slot")?.getAttribute("aria-description")).toBe("Add a remote to pull.")
        expect(button(header, "Fetch").hasAttribute("disabled")).toBe(true)
        expect(header.querySelector(".fetch-slot")?.getAttribute("aria-description")).toBe("Add a remote to fetch.")
    })

    test("fetches the active repository in the background, leaving its open stacks alone, says why that failed, and fetches again on demand", async () => {
        let repository = repositoryInfo("D:\\Source\\background-fetch")
        let graph = branchGraph(repository.id)
        let requested: unknown[] = []
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
            fetchLatest: async (_id, request) => {
                requested.push(request)
                return {
                    ok: true,
                    result: {
                        type: "result",
                        command: "fetch",
                        status: "fetched",
                        message: "Fetching origin failed.",
                        fetches: [{ remote: "origin", status: "failed", message: "terminal prompts disabled" }],
                        fastForwarded: [],
                    },
                }
            },
        }))
        await app.act(() => Bun.sleep(0))
        let columns = app.controller.columns.snapshot().columns.flatMap(column => column.kind == "branch" ? [column.branch.preferredRef] : [])

        let header = document.querySelector<HTMLElement>(".header")!

        expect(requested).toEqual([{ branches: columns, remote: "origin" }])
        expect(header.querySelector(".fetch-slot")?.getAttribute("aria-description")).toBe("Fetching failed: origin: terminal prompts disabled")
        expect(button(header, "Fetch").hasAttribute("data-failed")).toBe(true)

        // Fetch doesn't wait out the minute a background fetch would.
        await app.act(() => press(button(header, "Fetch")))

        expect(requested).toHaveLength(2)
    })

    test("a column's Pull latest takes the accent colour only while the Branch Graph knows of commits waiting for its stack", async () => {
        let repository = repositoryInfo("D:\\Source\\incoming")
        let graph = branchGraph(repository.id)
        let [main, feature, other] = graph.branches
        let behind = { ...feature!, upstreamRef: "refs/remotes/origin/feature/laneway", behind: 2 }
        await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: withColumns(repository, [behind, other!]) }),
            readBranchGraph: async () => ({ ok: true, graph: { ...graph, branches: [main!, behind, other!] } }),
        }))
        let columns = document.querySelector<HTMLElement>(".columns")!

        expect(button(columns, "Pull latest for feature/laneway").hasAttribute("data-incoming")).toBe(true)
        expect(button(columns, "Pull latest for other/team").hasAttribute("data-incoming")).toBe(false)
    })

    test("a failed pull shows why in its dialog", async () => {
        let repository = repositoryInfo("D:\\Source\\failed-pull")
        let graph = branchGraph(repository.id)
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: withColumns(repository, [graph.branches[1]!]) }),
            readBranchGraph: async () => ({ ok: true, graph }),
            pullLatest: async () => ({ ok: false, error: { message: "Could not reach origin." } }),
        }))

        await app.act(() => press(button(document.querySelector<HTMLElement>(".columns")!, "Pull latest for feature/laneway")))
        expect(document.querySelector(".pull-outcome .pull-error")?.textContent).toBe("Could not reach origin.")
        await app.act(() => press(button(document.querySelector<HTMLElement>(".pull-outcome")!, "Close")))
        expect(document.querySelector(".pull-outcome") == null).toBe(true)
    })
})

function withColumns(repository: ReturnType<typeof repositoryInfo>, branches: Array<{ id: string; preferredRef: string; tip: string }>) {
    return {
        repositories: [{
            status: "available" as const,
            id: repository.id,
            path: repository.mainWorktree,
            info: repository,
            layoutInitialized: true,
            focusedColumnId: branches.at(-1)!.id,
            columns: branches.map(branch => ({
                kind: "branch" as const,
                id: branch.id,
                ref: branch.preferredRef,
                lastSeenObjectId: branch.tip,
                width: 380,
                collapsed: false,
            })),
        }],
        activeRepositoryId: repository.id,
    }
}
