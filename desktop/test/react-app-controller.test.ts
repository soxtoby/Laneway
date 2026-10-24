import type { Workspace } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import { type AppSnapshot, createAppController } from "../src/renderer/react/app-controller"
import type { Notice } from "../src/renderer/react/notice"
import { appState, fakeLaneway, inspectionScenario, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

describe("app controller", () => {
    test("a failed start shows the error, and retrying loads the workspace", async () => {
        let attempts = 0
        let controller = createAppController(fakeLaneway({
            getState: async () => {
                if (attempts++ == 0)
                    throw new Error("Settings are unreadable.")
                return { ...appState(), appearance: "dark" }
            },
        }))

        await controller.start()
        expect(controller.snapshot()).toEqual({ status: "failed", error: "Settings are unreadable." })

        await controller.start()
        expect(controller.snapshot()).toMatchObject({ status: "ready", appearance: "dark", workspace: { repositories: [] } })
    })

    test("a partially restored workspace says so once started", async () => {
        let controller = createAppController(fakeLaneway({
            getState: async () => ({
                ...appState(),
                workspace: { repositories: [], persistenceError: { code: "workspace.partial", message: "One repository could not be restored." } },
            }),
        }))

        await controller.start()

        expect(ready(controller.snapshot()).notice).toMatchObject({ code: "workspace.partial", message: "One repository could not be restored." })
    })

    test("a new notice replaces the shown one and closes it, and the old one's withdrawal leaves the new one", async () => {
        let controller = await started(fakeLaneway())
        let closed: string[] = []
        let first: Notice = { code: "first", message: "First", closed: () => closed.push("first") }
        let second: Notice = { code: "second", message: "Second", closed: () => closed.push("second") }

        let withdrawFirst = controller.notify(first)
        controller.notify(second)
        withdrawFirst()
        expect(ready(controller.snapshot()).notice).toBe(second)
        expect(closed).toEqual(["first"])

        controller.dismissNotice(second)
        controller.dismissNotice(second)
        expect(ready(controller.snapshot()).notice).toBeUndefined()
        expect(closed).toEqual(["first", "second"])
    })

    test("toggling appearance shows the saved setting, and a failed save keeps the current one with a notice", async () => {
        let fail = false
        let controller = await started(fakeLaneway({
            setAppearance: async appearance => {
                if (fail)
                    throw new Error("Settings are read-only.")
                return appearance
            },
        }))

        await controller.toggleAppearance()
        expect(ready(controller.snapshot()).appearance).toBe("dark")

        fail = true
        await controller.toggleAppearance()
        expect(ready(controller.snapshot())).toMatchObject({
            appearance: "dark",
            notice: { code: "settings.appearance.failed", message: "Settings are read-only." },
        })
    })

    test("reordering shows the new order while the workspace saves, then the saved workspace", async () => {
        let workspace = twoRepositories()
        let save = Promise.withResolvers<Workspace>()
        let controller = await started(fakeLaneway({
            getState: async () => ({ ...appState(), workspace }),
            updateWorkspace: () => save.promise,
        }))
        let [first, second] = workspace.repositories.map(repository => repository.id)

        let reordering = controller.reorderRepositories([second!, first!])
        expect(ids(controller.snapshot())).toEqual([second, first])

        save.resolve({ ...workspace, repositories: [workspace.repositories[1]!], activeRepositoryId: second })
        await reordering
        expect(ids(controller.snapshot())).toEqual([second])
    })

    test("columns read for a repository the user has left are dropped", async () => {
        let scenario = inspectionScenario()
        let workspace = twoRepositories()
        let [first, second] = workspace.repositories.map(repository => repository.id)
        let firstGraph = Promise.withResolvers<Awaited<ReturnType<Window["laneway"]["readBranchGraph"]>>>()
        let controller = await started(fakeLaneway({
            ...scenario.api,
            getState: async () => ({ ...appState(), workspace }),
            selectRepository: async id => workspace = { ...workspace, activeRepositoryId: id },
            readBranchGraph: id =>
                id == first ? firstGraph.promise : Promise.resolve({ ok: false, error: { code: "git.command-failed", message: "Second has no graph." } }),
        }))

        await controller.selectRepository(second!)
        await settle()
        firstGraph.resolve({ ok: true, graph: scenario.graph })
        await settle()

        expect(controller.columns.snapshot()).toMatchObject({ repositoryId: second, error: "Second has no graph.", columns: [] })
    })

    test("a change to the active repository refreshes its columns, keeping the current ones until the new ones arrive", async () => {
        let scenario = inspectionScenario()
        let changed: ((change: { repositoryId: string }) => void) | undefined
        let refresh: { promise: Promise<void>; resolve(): void } | undefined
        let controller = await started(fakeLaneway({
            ...scenario.api,
            onRepositoryChanged: listener => {
                changed = listener
                return () => changed = undefined
            },
            readBranchGraph: async id => {
                await refresh?.promise
                return structuredClone(await scenario.api.readBranchGraph(id))
            },
        }))
        await settle()
        let shown = controller.columns.snapshot()
        scenario.graph.branches[1]!.ahead = 2

        refresh = Promise.withResolvers()
        changed!({ repositoryId: scenario.saved().activeRepositoryId! })
        await settle()
        expect(controller.columns.snapshot()).toBe(shown)

        refresh.resolve()
        await settle()
        expect(columnNames(controller)).toEqual(["inspection"])
        expect(controller.columns.snapshot()).not.toBe(shown)
    })

    test("a publish's confirmation leaves a pending discard's Undo notice showing, unsettled, and shows once it closes", async () => {
        let scenario = inspectionScenario()
        let settled: string[] = []
        let controller = await started(fakeLaneway({
            ...scenario.api,
            discardChanges: async () => ({ ok: true, id: "discard-1", undoable: true }),
            settleDiscard: async (_id, id) => void settled.push(id),
            publish: async (_id, request) =>
                request.action == "plans"
                    ? {
                        ok: true,
                        result: {
                            type: "result",
                            command: "publish",
                            status: "planned",
                            message: "Planned two.",
                            plans: [{ branch: "refs/heads/two", message: "Publish two.", plan: { stack: ["main", "two"], updates: [], token: "reviewed" } }],
                        },
                    }
                    : { ok: true, result: { type: "result", command: "publish", status: "published", message: "Published two." } },
        }))
        await settle()
        let repositoryId = scenario.saved().activeRepositoryId!
        let [column] = controller.columns.snapshot().columns
        await controller.publish.review(repositoryId, ["refs/heads/two"])
        await controller.inspection.discard(column!.id, "working-unstaged", scenario.page.file)
        let discarded = ready(controller.snapshot()).notice

        await controller.publish.publish(repositoryId, "refs/heads/two")

        expect(discarded?.message).toBe("Discarded src/file.txt")
        expect(ready(controller.snapshot()).notice == discarded).toBe(true)
        expect(settled).toEqual([])

        controller.dismissNotice(discarded!)
        expect(ready(controller.snapshot()).notice?.message).toBe("Published two.")
    })

    test("cancelling the open dialog leaves no notice, and an opened repository is confirmed", async () => {
        let opened = openedWorkspace(repositoryInfo("D:\\Source\\opened"))
        let cancel = true
        let controller = await started(fakeLaneway({
            openRepository: async () => cancel ? { ok: false, error: { code: "git.cancelled", message: "Cancelled" } } : { ok: true, workspace: opened },
        }))

        await controller.openRepository()
        expect(ready(controller.snapshot()).notice).toBeUndefined()

        cancel = false
        await controller.openRepository()
        expect(ready(controller.snapshot())).toMatchObject({
            workspace: opened,
            notice: { code: "repository.opened", message: "Repository opened.", transient: true },
        })
    })
})

async function started(api: Window["laneway"]) {
    let controller = createAppController(api)
    await controller.start()
    return controller
}

function ready(snapshot: AppSnapshot) {
    if (snapshot.status != "ready")
        throw new Error(`Expected a started app, got ${snapshot.status}.`)
    return snapshot
}

function ids(snapshot: AppSnapshot) {
    return ready(snapshot).workspace.repositories.map(repository => repository.id)
}

function columnNames(controller: ReturnType<typeof createAppController>) {
    return controller.columns.snapshot().columns.map(column => column.name)
}

function twoRepositories(): Workspace {
    let first = openedWorkspace(repositoryInfo("D:\\Source\\first"))
    let second = openedWorkspace(repositoryInfo("D:\\Source\\second"))
    return { repositories: [...first.repositories, ...second.repositories], activeRepositoryId: first.activeRepositoryId }
}

// Lets the controller's background reads run to their next await.
async function settle() {
    for (let turn = 0; turn < 10; turn++)
        await Promise.resolve()
}
