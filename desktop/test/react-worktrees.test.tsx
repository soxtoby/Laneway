import type { LocalActionResult, LocalPreview, LocalRequest, TrackingBranch, WorktreePreview, WorktreeRequest } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps, type } from "./react-dom"
import { inspectionScenario } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React worktree actions", () => {
    test("a missing worktree's column offers Repair and Remove, reads no Working Changes, and keeps its history readable", async () => {
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
        let previews: WorktreeRequest[] = []
        let executions: WorktreeRequest[] = []
        let chosenPaths: (string | undefined)[] = []
        let app = await startReactApp({
            ...scenario.api,
            readChanges: (...args) => {
                if (args[2].source.kind == "working")
                    workingReads.push(args[2].source.worktreePath)
                return scenario.api.readChanges(...args)
            },
            chooseDirectory: async path => {
                chosenPaths.push(path)
                return "D:/relocated/missing"
            },
            previewWorktree: async (_id, request) => {
                previews.push(request)
                return { ok: true, preview: worktreePreview(request, { affected: [worktree.path], token: "missing" }) }
            },
            executeWorktree: async (_id, request) => {
                executions.push(request)
                return { ok: true }
            },
        })
        let column = columnElement(branch.id)

        expect(column.querySelector("[aria-label='Missing worktree']")?.textContent).toContain("Worktree directory missing")
        expect(column.querySelector(".state-chip")?.textContent).toBe("Missing")
        expect(column.querySelector(".commit-trail")?.textContent).toContain("Inspect changes")
        expect(column.querySelector("[aria-label='Working Changes']") == null).toBe(true)
        expect(workingReads).not.toContain(worktree.path)

        await app.act(() => press(button(column, "Repair")))
        expect(chosenPaths).toEqual([worktree.path])
        expect(previews[0]).toEqual({ action: "repair", path: worktree.path, destination: "D:/relocated/missing" })
        await app.act(() => press(button(dialog(), "Cancel")))
        await app.act(() => press(button(column, "Remove")))
        expect(previews[1]).toEqual({ action: "remove", path: worktree.path, preserve: true })
        expect(executions).toEqual([{ action: "remove", path: worktree.path, preserve: true }])
        expect(document.querySelector("[role=dialog]") == null).toBe(true)

        await app.act(() => press(button(column, "Collapse missing")))
        expect(column.textContent).toContain("Missing")
        expect(workingReads).not.toContain(worktree.path)
    })

    test("a missing detached worktree resumes Working Changes once its directory returns", async () => {
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
        let app = await startReactApp({
            ...scenario.api,
            readBranchGraph: async () => ({ ok: true, graph: structuredClone(scenario.graph) }),
            readChanges: (...args) => {
                if (args[2].source.kind == "working")
                    workingReads.push(args[2].source.worktreePath)
                return scenario.api.readChanges(...args)
            },
        })
        let column = () => columnElement("virtual:detached")
        let refresh = () => app.act(() => app.controller.columns.refresh(false))
        expect(button(column(), "Repair").hasAttribute("disabled")).toBe(false)
        expect(column().querySelector("[aria-label='Working Changes']") == null).toBe(true)

        worktree.missing = false
        await refresh()
        expect(column().querySelector("[aria-label='Working Changes']")).not.toBeNull()
        expect(workingReads).toContain(worktree.path)

        await app.act(() => press(button(column(), "Collapse detached")))
        worktree.missing = true
        await refresh()
        expect(column().textContent).toContain("Missing")
        let reads = workingReads.filter(path => path == worktree.path).length
        await refresh()
        expect(workingReads.filter(path => path == worktree.path)).toHaveLength(reads)
        await app.act(() => press(button(column(), "Expand detached")))
        expect(column().querySelector("[aria-label='Missing worktree']")).not.toBeNull()
        expect(column().querySelector("[aria-label='Working Changes']") == null).toBe(true)
    })

    test("a branch column checks its branch out in a new worktree at once, with Undo in the notice", async () => {
        let scenario = inspectionScenario()
        let main = scenario.graph.branches[0]!
        let saved = scenario.saved()
        saved.repositories[0]!.columns.push({ kind: "branch", id: main.id, ref: main.preferredRef, lastSeenObjectId: main.tip, width: 380 })
        await scenario.api.updateWorkspace(saved)
        let executions: { request: WorktreeRequest; token?: string }[] = []
        let previews = 0
        let transitions: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            previewWorktree: async (_id, request) => {
                previews++
                return { ok: true, preview: worktreePreview(request) }
            },
            executeWorktree: async (_id, request, token) => {
                executions.push({ request, token })
                return { ok: true }
            },
            transitionOperation: async (_id, action) => {
                transitions.push(action)
                return { ok: true }
            },
        })

        await app.act(() => press(button(columnElement(main.id), "Check out branch")))
        expect(menuLabels()).toEqual(["inspection · feature/laneway", "New worktree", "Copy branch name"])
        await app.act(() => press(menuItem("New worktree")))

        // The engine reviews a checkout as it runs it, so nothing is previewed or confirmed first.
        expect(executions).toEqual([{ request: { action: "create", branch: "refs/heads/main", move: true }, token: undefined }])
        expect(previews).toBe(0)
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        let toast = document.querySelector<HTMLElement>("[role=alertdialog]")!
        expect(toast.textContent).toContain("Checked out main in a new worktree.")
        await app.act(() => press(button(toast, "Undo")))
        expect(transitions).toEqual(["undo"])
    })

    test("a remote branch's column checks it out at once as a local branch tracking it, when no local branch has its name", async () => {
        let scenario = inspectionScenario()
        let { remote, saved } = openRemoteBranch(scenario, "origin/sox/remote")
        await scenario.api.updateWorkspace(saved)
        let executions: WorktreeRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            previewWorktree: async (_id, request) => ({ ok: true, preview: worktreePreview(request, { tracking: tracking(remote.preferredRef, false) }) }),
            executeWorktree: async (_id, request) => {
                executions.push(request)
                return { ok: true }
            },
        })

        await app.act(() => press(button(columnElement(remote.id), "Check out branch")))
        await app.act(() => press(menuItem("New worktree")))

        expect(executions).toEqual([{ action: "create", branch: "refs/remotes/origin/sox/remote", move: true }])
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Checked out sox/remote in a new worktree.")
    })

    test("a remote branch whose name a local branch has asks to reset that branch or create the next name, and its column becomes the new branch's", async () => {
        let scenario = inspectionScenario()
        let { remote, saved } = openRemoteBranch(scenario, "origin/sox/remote")
        await scenario.api.updateWorkspace(saved)
        let executions: WorktreeRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            previewWorktree: async (_id, request) => ({ ok: true, preview: worktreePreview(request, { tracking: tracking(remote.preferredRef, true) }) }),
            executeWorktree: async (_id, request) => {
                executions.push(request)
                // The new branch tracks the remote branch at its tip, so the two share one Branch Node.
                let ref = "refs/heads/sox/remote-2"
                let worktree = { path: "D:/Source/inspection.worktrees/sox-remote-2", name: "sox-remote-2", head: remote.tip, branchRef: ref, main: false }
                scenario.graph.branches = scenario.graph.branches.map(branch =>
                    branch == remote
                        ? {
                            ...remote,
                            id: `branch:${ref}`,
                            name: "sox/remote-2",
                            preferredRef: ref,
                            localRefs: [ref],
                            remoteOnly: false,
                            checkedOut: [worktree],
                        }
                        : branch
                )
                return { ok: true }
            },
        })
        let columnIds = () => [...document.querySelectorAll("[data-column-id]")].map(column => column.getAttribute("data-column-id"))
        let before = columnIds()

        await app.act(() => press(button(columnElement(remote.id), "Check out branch")))
        await app.act(() => press(menuItem("New worktree")))

        expect(executions).toEqual([])
        expect(dialog().textContent).toContain("A local branch named sox/remote already exists.")

        await app.act(() => press(button(dialog(), "Create sox/remote-2")))

        expect(executions).toEqual([{ action: "create", branch: "refs/remotes/origin/sox/remote", move: true, local: "new" }])
        expect(columnIds()).toEqual(before.map(id => id == remote.id ? "branch:refs/heads/sox/remote-2" : id))
        expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Checked out sox/remote-2 in a new worktree.")
    })

    test("a worktree column's actions copy its branch name and its worktree's path", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        let header = columnElement("branch:refs/heads/feature/laneway").querySelector<HTMLElement>("header")!
        let copyFrom = async (label: string) => {
            await app.act(() => press(button(header, "Worktree actions")))
            await app.act(() => press(menuItem(label)))
            return navigator.clipboard.readText()
        }

        expect(await copyFrom("Copy branch name")).toBe("feature/laneway")
        expect(await copyFrom("Copy worktree path")).toBe("D:\\Source\\inspection")
    })

    test("a worktree without Working Changes is removed at once, keeping commits only it holds, with Undo in the notice", async () => {
        let scenario = inspectionScenario()
        scenario.graph.branches[1]!.checkedOut[0]!.main = false
        let executions: { request: WorktreeRequest; token?: string }[] = []
        let transitions: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            previewWorktree: async (_id, request) => ({ ok: true, preview: worktreePreview(request, { uniqueCommits: true, token: "clean" }) }),
            executeWorktree: async (_id, request, token) => {
                executions.push({ request, token })
                return { ok: true }
            },
            transitionOperation: async (_id, action) => {
                transitions.push(action)
                return { ok: true }
            },
        })
        let header = columnElement("branch:refs/heads/feature/laneway").querySelector<HTMLElement>("header")!

        await app.act(() => press(button(header, "Worktree actions")))
        await app.act(() => press(menuItem("Remove worktree")))

        expect(executions).toEqual([{
            request: { action: "remove", path: "D:\\Source\\inspection", preserve: true },
            token: "clean",
        }])
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        let toast = document.querySelector<HTMLElement>("[role=alertdialog]")!
        expect(toast.textContent).toContain("Removed worktree inspection.")
        await app.act(() => press(button(toast, "Undo")))
        expect(transitions).toEqual(["undo"])
    })

    test("a worktree renames in place, switches branch by search at once, and asks before removing its Working Changes", async () => {
        let scenario = inspectionScenario()
        scenario.graph.branches[1]!.checkedOut[0]!.main = false
        let requests: WorktreeRequest[] = []
        let preview: (request: WorktreeRequest) => WorktreePreview | undefined = () => undefined
        let executed: WorktreeRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            previewWorktree: async (_id, request) => {
                requests.push(request)
                let reviewed = preview(request)
                return reviewed ? { ok: true, preview: reviewed } : { ok: false, error: { message: "Preview requested" } }
            },
            executeWorktree: async (_id, request) => {
                executed.push(request)
                return { ok: true }
            },
        })
        let header = () => columnElement("branch:refs/heads/feature/laneway").querySelector<HTMLElement>("header")!
        let field = () => header().querySelector<HTMLInputElement>("input")!

        await app.act(() => press(button(header(), "Rename worktree")))
        expect(field().getAttribute("aria-label")).toBe("New name for worktree")
        expect(field().value).toBe("inspection")
        await app.act(() => type(field(), "cancelled"))
        await app.act(() => key(field(), "Escape"))
        expect(requests).toEqual([])
        expect(header().querySelector("input") == null).toBe(true)
        await app.act(() => press(button(header(), "Rename worktree")))
        await app.act(() => type(field(), "renamed"))
        await app.act(() => key(field(), "Enter"))
        expect(requests).toEqual([{ action: "rename", path: "D:\\Source\\inspection", basename: "renamed" }])
        expect(dialog().querySelector("[role=alert]")?.textContent).toBe("Preview requested")
        await app.act(() => press(button(dialog(), "Cancel")))

        await app.act(() => press(button(header(), "Worktree actions")))
        await app.act(() => press(menuItem("Switch branch…")))
        let chooser = dialog()
        expect(chooser.textContent).toContain("Switch inspection to branch")
        expect(menuItems()).not.toContain("feature/laneway")
        await app.act(() => type(chooser.querySelector<HTMLInputElement>("input")!, "mai"))
        expect(menuItems()).toEqual(["main"])
        await app.act(() => press(menuItem("main")))
        expect(executed).toEqual([{ action: "switch", path: "D:\\Source\\inspection", branch: "refs/heads/main", move: true }])
        expect(requests).toHaveLength(1)
        expect(document.querySelector("[role=dialog]") == null).toBe(true)

        preview = request => worktreePreview(request, { affected: ["D:\\Source\\inspection"], ignored: ["generated.bin"], ignoredCount: 1, dirty: true })
        await app.act(() => press(button(header(), "Worktree actions")))
        expect(menuItems()).not.toContain("New worktree")
        await app.act(() => press(menuItem("Remove worktree")))
        expect(requests[1]).toEqual({ action: "remove", path: "D:\\Source\\inspection", preserve: true })
        expect(dialog().textContent).toContain("Working Changes detected")
        expect(dialog().textContent).toContain("outside undo: generated.bin.")
        await app.act(() => press(button(dialog(), "Remove worktree")))

        expect(executed.at(-1)).toEqual({ action: "remove", path: "D:\\Source\\inspection", preserve: true })
    })

    test("undo and redo run from the header and the keyboard, and an undo into a taken directory asks for another name", async () => {
        let scenario = inspectionScenario()
        let transitions: [string, string | undefined][] = []
        let occupied = false, graphReads = 0
        let app = await startReactApp({
            ...scenario.api,
            readBranchGraph: async (...args) => {
                graphReads++
                return scenario.api.readBranchGraph(...args)
            },
            transitionOperation: async (_id, action, basename) => {
                transitions.push([action, basename])
                return occupied && !basename ? { ok: false, error: { message: "The worktree directory is occupied." } } : { ok: true }
            },
        })
        let shortcut = (key: string, shiftKey = false) =>
            app.act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey, bubbles: true, cancelable: true })))

        let reads = graphReads
        await app.act(() => press(button(document.body, "Undo last operation")))
        await app.act(() => press(button(document.body, "Redo operation")))
        await shortcut("z")
        await shortcut("Z", true)
        await shortcut("y")
        expect(transitions).toEqual([["undo", undefined], ["redo", undefined], ["undo", undefined], ["redo", undefined], ["redo", undefined]])
        expect(graphReads).toBeGreaterThan(reads)

        occupied = true
        await shortcut("z")
        expect(dialog().querySelector("[role=alert]")?.textContent).toContain("occupied")
        await app.act(() => type(dialog().querySelector<HTMLInputElement>("input")!, "inspection-restored"))
        await app.act(() => press(button(dialog(), "Restore worktree")))
        expect(transitions.at(-1)).toEqual(["undo", "inspection-restored"])
    })

    test("the Stashes dialog applies a stash to a chosen worktree and drops another", async () => {
        let scenario = inspectionScenario()
        let requests: { request: LocalRequest; token?: string }[] = []
        let stashes: LocalPreview["stashes"] = [{ objectId: "a".repeat(40), label: "stash@{0}", branch: "feature/laneway" }, {
            objectId: "b".repeat(40),
            label: "stash@{1}",
            branch: null,
        }]
        let worktrees = [{ path: "D:\\Source\\inspection", name: "inspection", branch: "feature/laneway" }, { path: "D:\\Source\\other", name: "other" }]
        let app = await startReactApp({
            ...scenario.api,
            localOperation: async (id, request, token) => {
                if (token) {
                    requests.push({ request, token })
                    return { ok: true, result: { type: "result", command: "local", status: "performed" } }
                }
                let preview = (await scenario.api.localOperation(id, request)) as Extract<LocalActionResult, { ok: true }>
                return { ok: true, result: { ...preview.result, preview: { ...preview.result.preview!, token: "stashes", stashes, worktrees } } }
            },
        })

        await app.act(() => press(button(document.body, "Stashes")))
        let entries = () => [...dialog().querySelectorAll<HTMLElement>(".stash-entry")]
        expect(entries().map(entry => entry.querySelector(".stash-entry-label")?.textContent)).toEqual(["stash@{0}feature/laneway", "stash@{1}Unassigned"])
        await app.act(() => press(button(entries()[0]!, "Apply…")))
        await app.act(() => press(dialog().querySelector<HTMLElement>(".react-aria-Select button")!))
        await app.act(() => press(option("other · detached")))
        await app.act(() => press(button(dialog(), "Apply stash")))
        await app.act(() => press(button(entries()[1]!, "Drop")))

        expect(requests).toEqual([{ request: { action: "stash-apply", path: "D:\\Source\\other", objectId: "a".repeat(40) }, token: "stashes" }, {
            request: { action: "stash-drop", objectId: "b".repeat(40) },
            token: "stashes",
        }])
        await app.act(() => press(button(dialog(), "Close")))
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
    })
})

function worktreePreview(request: WorktreeRequest, change: Partial<WorktreePreview> = {}): WorktreePreview {
    return {
        request,
        worktrees: [],
        affected: [],
        ignored: [],
        ignoredCount: 0,
        dirty: false,
        uniqueCommits: false,
        populatedSubmodules: false,
        token: "preview",
        ...change,
    }
}

/** Adds a remote-only branch to the scenario's graph, and a column for it after the others to its saved workspace. */
function openRemoteBranch(scenario: ReturnType<typeof inspectionScenario>, name: string) {
    let main = scenario.graph.branches[0]!
    let ref = `refs/remotes/${name}`
    let remote = {
        ...main,
        id: `branch:${ref}`,
        name,
        preferredRef: ref,
        refs: [ref],
        aliases: [name],
        localRefs: [],
        remoteRefs: [ref],
        tip: "4".repeat(40),
        primary: false,
        remoteOnly: true,
    }
    scenario.graph.branches.push(remote)
    scenario.graph.history.unshift({ objectId: remote.tip, lineId: remote.id, parentIds: [main.tip] })
    let saved = scenario.saved()
    saved.repositories[0]!.columns.push({ kind: "branch", id: remote.id, ref, lastSeenObjectId: remote.tip, width: 380 })
    return { remote, saved }
}

function tracking(remoteRef: string, taken: boolean): TrackingBranch {
    return { remoteRef, name: "sox/remote", taken, alternative: "sox/remote-2" }
}

function columnElement(id: string) {
    return document.querySelector<HTMLElement>(`[data-column-id='${id}']`)!
}

function dialog() {
    return document.querySelector<HTMLElement>("[role=dialog]")!
}

function menuItems() {
    return [...document.querySelectorAll("[role=menu] [role=menuitem]")].map(item => item.textContent)
}

/** Each menu item's label, without its description. */
function menuLabels() {
    return [...document.querySelectorAll("[role=menu] [role=menuitem]")].map(item => (item.querySelector("[slot=label]") ?? item).textContent)
}

function menuItem(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(item => item.textContent == label)
    if (!item)
        throw new Error(`No ${label} menu item in: ${menuItems().join(", ")}`)
    return item
}

function option(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=listbox] [role=option]")].find(item => item.textContent == label)
    if (!item)
        throw new Error(`No ${label} option`)
    return item
}

function key(target: Element, key: string) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}
