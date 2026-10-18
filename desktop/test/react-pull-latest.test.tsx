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
    test("pulls the open columns' stacks with progress and Cancel, and summarizes outcomes by stack", async () => {
        let repository = repositoryInfo("D:\\Source\\pull-graph")
        let graph = branchGraph(repository.id)
        let [main, feature] = graph.branches
        let workspace = {
            repositories: [{
                status: "available" as const,
                id: repository.id,
                path: repository.mainWorktree,
                info: repository,
                layoutInitialized: true,
                focusedColumnId: feature!.id,
                columns: [main!, feature!].map(branch => ({
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

        expect(header().querySelector(".pull-latest")?.getAttribute("title")).toBe("Fetch and synchronize open stacks")
        await app.act(() => press(button(header(), "Pull latest")))
        expect(requested).toEqual({ branches: [main!.preferredRef, feature!.preferredRef], remote: "origin" })
        expect(header().querySelector(".pull-latest") == null).toBe(true)
        expect(header().querySelector(".pull-progress")?.textContent).toContain("Fetching…")
        expect(button(header(), "Undo last operation").hasAttribute("disabled")).toBe(true)
        await app.act(() => progress!({ repositoryId: repository.id, message: "Updating feature/laneway…", completed: 1, total: 2 }))
        expect(header().querySelector(".pull-progress")?.textContent).toContain("Updating feature/laneway…")
        await app.act(() => press(button(header(), "Cancel pull")))
        expect(cancelled).toBe(1)
        expect(header().querySelector(".pull-progress")?.textContent).toContain("Cancelling")

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
        expect(header().querySelector(".pull-latest")).not.toBeNull()

        // Resolving opens the stack's branch, expanding its collapsed column.
        await app.act(() => press(button(outcome, "Resolve in feature/laneway")))
        await app.act(() => new Promise(resolve => requestAnimationFrame(resolve)))
        expect(document.querySelector(".pull-outcome") == null).toBe(true)
        expect((document.activeElement as HTMLElement | null)?.dataset.columnId).toBe(feature!.id)
    })

    test("an uneventful pull confirms in passing without a dialog", async () => {
        let repository = repositoryInfo("D:\\Source\\quiet-pull")
        let graph = branchGraph(repository.id)
        let app = await startReactApp(fakeLaneway({
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
        }))

        await app.act(() => press(button(document.querySelector<HTMLElement>(".header")!, "Pull latest")))
        expect(document.querySelector(".pull-outcome") == null).toBe(true)
        expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Pull complete: 1 updated, 1 already current.")
    })

    test("is unavailable without remotes, and says why", async () => {
        let repository = repositoryInfo("D:\\Source\\no-remotes")
        let graph = { ...branchGraph(repository.id), availableRemotes: [], selectedRemote: undefined }
        await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        }))
        let header = document.querySelector<HTMLElement>(".header")!

        expect(button(header, "Pull latest").hasAttribute("disabled")).toBe(true)
        expect(header.querySelector(".pull-latest")?.getAttribute("title")).toBe("Add a remote to pull.")
    })

    test("a failed pull shows why in its dialog", async () => {
        let repository = repositoryInfo("D:\\Source\\failed-pull")
        let graph = branchGraph(repository.id)
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
            pullLatest: async () => ({ ok: false, error: { message: "Could not reach origin." } }),
        }))

        await app.act(() => press(button(document.querySelector<HTMLElement>(".header")!, "Pull latest")))
        expect(document.querySelector(".pull-outcome .pull-error")?.textContent).toBe("Could not reach origin.")
        await app.act(() => press(button(document.querySelector<HTMLElement>(".pull-outcome")!, "Close")))
        expect(document.querySelector(".pull-outcome") == null).toBe(true)
    })
})
