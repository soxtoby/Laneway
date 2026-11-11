import type { ChangedFile, DiscardRequest, FileListView, LocalActionResult, LocalPreview, LocalRequest } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps, type } from "./react-dom"
import { appState, inspectionScenario, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React Working Changes", () => {
    test("one view menu lays out and groups every file list, saves the choice, and folders choose their files together", async () => {
        let scenario = inspectionScenario()
        let saved: FileListView[] = []
        let files: ChangedFile[] = [changedFile("src/file.txt"), changedFile("other.txt"), {
            ...changedFile("test/unit/file.test.ts"),
            status: "added",
            untracked: true,
        }]
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (_id, _requestId, request) => ({ ok: true, inventory: { source: request.source, files, version: "inventory", parents: [] } }),
            setFileListView: async view => {
                saved.push(view)
                return view
            },
        })
        let choose = async (item: string) => {
            await app.act(() => press(button(workingChanges(), "File list view for Working Changes")))
            await app.act(() => press(menuItem(item)))
        }
        expect(fileRows()).toHaveLength(3)

        await app.act(() => press(button(workingChanges(), "File list view for Working Changes")))
        expect([...document.querySelectorAll("[role=menu] [role=menuitemradio][aria-checked=true]")].map(item => item.textContent)).toEqual([
            "Flat list",
            "No grouping",
        ])
        await app.act(() => press(menuItem("Folders")))

        expect(saved).toEqual([{ layout: "tree", grouping: "none" }])
        // Folders holding only the next folder collapse into one row.
        expect(folderNames()).toEqual(["src", "test/unit"])
        expect(fileRows()).toHaveLength(3)

        await choose("Group by change")
        expect(saved.at(-1)).toEqual({ layout: "tree", grouping: "change" })
        expect(folderNames()).toEqual(["Added", "test/unit", "Changed", "src"])

        await choose("Flat list")
        await choose("Group by file kind")
        expect(saved.at(-1)).toEqual({ layout: "flat", grouping: "kind" })
        expect(folderNames()).toEqual(["Implementation", "Tests"])

        // Ctrl+click on a group chooses every file it holds; choosing them all again clears them.
        await app.act(() => press(row("Implementation"), { ctrlKey: true }))
        expect(selectionSummary()).toContain("2 of 3 selected")
        expect(chosen(row("src/file.txt"))).toBe(true)
        expect(chosen(row("Implementation"))).toBe(true)
        await app.act(() => press(row("other.txt"), { ctrlKey: true }))
        expect(chosen(row("Implementation"))).toBe(false)
        await app.act(() => press(row("Implementation"), { ctrlKey: true }))
        expect(selectionSummary()).toContain("2 of 3 selected")
        await app.act(() => press(row("Implementation"), { ctrlKey: true }))
        expect(selectionSummary()).toBeUndefined()

        // Choosing a group's files one by one leaves the group unmarked; choosing it then marks it without clearing them.
        await app.act(() => press(row("src/file.txt"), { ctrlKey: true }))
        await app.act(() => press(row("other.txt"), { ctrlKey: true }))
        expect(selectionSummary()).toContain("2 of 3 selected")
        expect(chosen(row("Implementation"))).toBe(false)
        await app.act(() => press(row("Implementation"), { ctrlKey: true }))
        expect(chosen(row("Implementation"))).toBe(true)
        expect(selectionSummary()).toContain("2 of 3 selected")
        // A click on a file chooses only it, unmarking the group.
        await app.act(() => press(row("src/file.txt")))
        expect(chosen(row("Implementation"))).toBe(false)
        // Shift+click marks the groups in its range.
        await app.act(() => press(row("test/unit/file.test.ts"), { shiftKey: true }))
        expect(chosen(row("Tests"))).toBe(true)
        expect(chosen(row("Implementation"))).toBe(false)
        expect(selectionSummary()).toContain("3 of 3 selected")
    })

    test("a click chooses only its file, Ctrl+click and Space add or take away files, and Shift+click adds the rows between", async () => {
        let scenario = inspectionScenario()
        let files = [changedFile("src/file.txt"), changedFile("other.txt"), changedFile("test/unit/file.test.ts")]
        let app = await startReactApp({
            ...scenario.api,
            readChanges: async (_id, _requestId, request) => ({ ok: true, inventory: { source: request.source, files, version: "inventory", parents: [] } }),
        })
        let [first, second, third] = rowNames(workingChanges())

        await app.act(() => press(row(first!), { ctrlKey: true }))
        await app.act(() => press(row(third!), { shiftKey: true }))
        let ranged = chosenNames()
        await app.act(() => press(row(second!)))
        let opened = document.querySelector(".diff-panel, .diff-column") != null
        let clicked = chosenNames()
        await app.act(() => row(third!).dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })))
        let spaced = chosenNames()
        await app.act(() => press(row(second!), { ctrlKey: true }))
        let toggled = chosenNames()

        expect(ranged).toEqual([first, second, third])
        // A click chooses without opening anything.
        expect(opened).toBe(false)
        expect(clicked).toEqual([second])
        expect(spaced).toEqual([second, third])
        expect(toggled).toEqual([third])
    })

    test("a clean worktree's Working Changes card has nothing to unfold or act on", async () => {
        let scenario = inspectionScenario()
        await startReactApp({
            ...scenario.api,
            readChanges: async (_id, _requestId, request) => ({
                ok: true,
                inventory: { source: request.source, files: [], version: "inventory", parents: [] },
            }),
        })

        let header = workingChanges().querySelector(".commit-header")!
        expect(header.textContent).toBe("No Working Changes")
        expect(header.querySelectorAll("button").length).toBe(0)
    })

    test("file rows copy their path from a hover button and from the context menu", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp(scenario.api)
        let row = fileRows()[0]!
        let copy = button(row, "Copy relative path of src/file.txt")

        await app.act(() => press(copy))
        expect(await navigator.clipboard.readText()).toBe("src/file.txt")
        expect(copy.hasAttribute("data-copied")).toBe(true)

        let copyFrom = async (label: string) => {
            await app.act(() => openContextMenu(row))
            expect(menuItems()).toEqual(["File history", "Discard all changes", "Copy full path", "Copy relative path", "Copy file name"])
            expect(document.querySelectorAll("[role=menu] [role=separator]")).toHaveLength(2)
            await app.act(() => press(menuItem(label)))
            return navigator.clipboard.readText()
        }
        expect(await copyFrom("Copy full path")).toBe("D:\\Source\\inspection\\src\\file.txt")
        expect(await copyFrom("Copy file name")).toBe("file.txt")
        expect(await copyFrom("Copy relative path")).toBe("src/file.txt")
    })

    test("working files discard from the context menu and the selection, with Undo while the notice shows", async () => {
        let scenario = inspectionScenario()
        let requests: DiscardRequest[] = [], undone: string[] = [], settled: string[] = [], reads = 0
        let app = await startReactApp({
            ...scenario.api,
            readChanges: (...args) => {
                reads++
                return scenario.api.readChanges(...args)
            },
            discardChanges: async (_id, request) => {
                requests.push(request)
                return { ok: true, id: `discard-${requests.length}`, undoable: true }
            },
            undoDiscard: async (_id, id) => {
                undone.push(id)
                return { ok: true, kept: [] }
            },
            settleDiscard: async (_id, id) => {
                settled.push(id)
            },
        })
        let discard = async (index: number, label: string) => {
            await app.act(() => openContextMenu(fileRows()[index]!))
            await app.act(() => press(menuItem(label)))
        }

        // The staged list sits above the unstaged list, and each row discards its own side.
        let before = reads
        await discard(0, "Discard all changes")
        expect(requests).toEqual([{
            kind: "files",
            worktreePath: "D:\\Source\\inspection",
            view: "staged",
            files: [{ path: "src/file.txt", oldPath: undefined, untracked: false }],
        }])
        expect(reads).toBeGreaterThan(before)
        expect(toast()?.textContent).toContain("Discarded src/file.txt")
        await app.act(() => press(button(toast()!, "Undo")))
        expect(undone).toEqual(["discard-1"])
        expect(settled).toEqual([])
        expect(toast()?.textContent).toContain("Discard undone.")

        // Discards made while the notice shows join it, and Ctrl+Z undoes them all.
        await discard(2, "Discard unstaged changes")
        await discard(3, "Discard unstaged changes")
        expect(requests.slice(1).map(request => request.kind == "files" && request.view)).toEqual(["unstaged", "unstaged"])
        expect(toast()?.textContent).toContain("Discarded 2 files")
        await app.act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })))
        expect(undone).toEqual(["discard-1", "discard-3", "discard-2"])

        // Closing the notice settles the discard for good.
        await discard(0, "Discard all changes")
        await app.act(() => press(button(toast()!, "Close")))
        expect(settled).toEqual(["discard-4"])
        expect(undone).toHaveLength(3)

        // A right-click on one of the chosen files discards them all.
        await app.act(() => press(row("src/file.txt", 1), { ctrlKey: true }))
        await app.act(() => press(row("other.txt", 1), { ctrlKey: true }))
        await discard(3, "Discard 2 selected files")
        expect(requests.at(-1)).toMatchObject({ kind: "files", view: "unstaged", files: [{ path: "src/file.txt" }, { path: "other.txt" }] })
    })

    test("the commit composer stages, keeps a cancelled draft, and commits the staged files", async () => {
        let scenario = inspectionScenario()
        let staged = false, committed = false, version = 0
        let draft = { title: "", message: "", branch: "" }
        let mutations: LocalRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            readCommitDraft: async () => ({ ...draft }),
            saveCommitDraft: async (_id, _path, value) => {
                draft = { ...value }
            },
            readChanges: async (...args) => {
                let result = await scenario.api.readChanges(...args)
                if (!result.ok)
                    return result
                let files = committed ? [] : result.inventory.files.map((file, index) => ({ ...file, staged: staged && index == 0, unstaged: true }))
                return { ok: true, inventory: { ...result.inventory, version: String(version), files } }
            },
            localOperation: async (_id, request, token) => {
                if (!token)
                    return previewResult({ token: String(version), staged })
                mutations.push(request)
                if (request.action == "stage")
                    staged = !request.unstage
                if (request.action == "commit")
                    committed = true
                version++
                return performed()
            },
        })
        let header = () => workingChanges().querySelector(".commit-header")!
        expect(document.querySelector(".staged-divider") == null).toBe(true)
        expect(header().textContent).toContain("Working Changes")
        expect(button(header(), "More commit actions").querySelector("svg")).not.toBeNull()

        await app.act(() => press(button(header(), "Commit…")))
        let title = input("Commit title")
        expect(title.compareDocumentPosition(document.querySelector(".staged-divider")!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
        expect(header().textContent).not.toContain("Commit…")
        expect(button(workingChanges(), "Commit all changes (2)").hasAttribute("disabled")).toBe(true)
        await app.act(() => type(title, "Keep snapshot"))
        expect(button(workingChanges(), "Commit all changes (2)").hasAttribute("disabled")).toBe(false)

        await app.act(() => press(button(workingChanges(), "Stage all")))
        expect(mutations[0]).toEqual({ action: "stage", path: "D:\\Source\\inspection", files: ["src/file.txt", "other.txt"], unstage: false })
        expect(rowNames(tree("Staged files"))).toContain("src/file.txt")
        expect(rowNames(tree("Staged files"))).not.toContain("other.txt")

        await app.act(() => press(button(workingChanges(), "Cancel")))
        expect(document.querySelector("[aria-label='Commit title']") == null).toBe(true)
        expect(header().textContent).toContain("Commit…")
        expect(rowNames(tree("Staged files"))).toContain("src/file.txt")
        expect(document.querySelector(".staged-divider")).not.toBeNull()
        expect(draft.title).toBe("Keep snapshot")

        await app.act(() => press(button(header(), "Commit…")))
        expect(input("Commit title").value).toBe("Keep snapshot")
        // A chosen file is counted beside its own list, and the commit that removes it clears the choice.
        await app.act(() => press(row("src/file.txt"), { ctrlKey: true }))
        expect(selectionSummary()).toContain("1 of 1 selected")
        await app.act(() => press(button(workingChanges(), "Commit staged (1)")))

        expect(mutations.map(request => request.action)).toEqual(["stage", "commit"])
        expect(mutations[1]).toMatchObject({ action: "commit", title: "Keep snapshot" })
        expect(draft.title).toBe("")
        expect(document.querySelector("[aria-label='Commit title']") == null).toBe(true)
        expect(selectionSummary()).toBeUndefined()
        expect(document.querySelector(".commit-notice") == null).toBe(true)
        expect(toast()?.textContent).toContain("Commit created.")
        expect(header().textContent).toContain("No Working Changes")
    })

    test("Amend last commit fills the form from that commit and amends it, leaving the saved draft alone", async () => {
        let scenario = inspectionScenario()
        let draft = { title: "Saved draft", message: "", branch: "" }
        let mutations: LocalRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            readCommitDraft: async () => ({ ...draft }),
            saveCommitDraft: async (_id, _path, value) => {
                draft = { ...value }
            },
            localOperation: async (_id, request, token) => {
                if (!token)
                    return previewResult({ lastCommit: { objectId: "4".repeat(40), title: "Last subject", message: "Last body" } })
                mutations.push(request)
                return performed()
            },
        })
        await app.act(() => press(button(workingChanges(), "More commit actions")))
        await app.act(() => press(menuItem("Amend last commit…")))
        expect(input("Commit title").value).toBe("Last subject")
        expect(workingChanges().querySelector<HTMLTextAreaElement>("[aria-label='Commit message']")!.value).toBe("Last body")

        await app.act(() => type(input("Commit title"), "Amended subject"))
        await app.act(() => press(button(workingChanges(), "Amend with staged (2)")))

        expect(mutations).toEqual([{ action: "commit", path: "D:\\Source\\inspection", title: "Amended subject", message: "Last body", amend: true }])
        expect(draft.title).toBe("Saved draft")
        expect(toast()?.textContent).toContain("Commit amended.")

        await app.act(() => press(button(workingChanges(), "Commit…")))
        expect(input("Commit title").value).toBe("Saved draft")
    })

    test("a commit whose hooks change files waits for Continue, which accepts them", async () => {
        let scenario = inspectionScenario()
        let commits: LocalRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            localOperation: async (_id, request, token) => {
                if (!token)
                    return previewResult({})
                commits.push(request)
                return commits.length == 1
                    ? { ok: true, result: { type: "result", command: "local", status: "hook-review", changedFiles: ["src/file.txt"], hookToken: "hooks" } }
                    : performed()
            },
        })
        await app.act(() => press(button(workingChanges(), "Commit…")))
        await app.act(() => type(input("Commit title"), "Formatted"))

        await app.act(() => press(button(workingChanges(), "Commit staged (2)")))
        let review = workingChanges().querySelector<HTMLElement>("[role=alert]")!
        expect(review.textContent).toContain("Hook changed files")
        expect(review.textContent).toContain("src/file.txt")
        expect(button(workingChanges(), "Commit staged (2)").hasAttribute("disabled")).toBe(true)
        await app.act(() => press(button(review, "Continue commit")))

        expect(commits.map(request => request.action == "commit" && request.acceptHooks)).toEqual([undefined, "hooks"])
        expect(toast()?.textContent).toContain("Commit created.")
    })

    test("stashes list above Working Changes, show their files, and stash, apply, and drop", async () => {
        let scenario = inspectionScenario()
        let stash = { id: "stash-0", kind: "stash" as const, label: "stash@{0}", objectId: "3".repeat(40), tooltip: "On feature/laneway: Parked work" }
        scenario.graph.branches[1]!.markers = [stash]
        let operations: LocalRequest[] = [], graphReads = 0
        let app = await startReactApp({
            ...scenario.api,
            readBranchGraph: async () => {
                graphReads++
                return { ok: true, graph: scenario.graph }
            },
            readChanges: async (_id, _requestId, request) => ({
                ok: true,
                inventory: {
                    source: request.source,
                    files: [changedFile(request.source.kind == "commit" ? "stashed.txt" : "src/file.txt")],
                    version: "inventory",
                    parents: [],
                },
            }),
            localOperation: async (_id, request, token) => {
                if (!token)
                    return previewResult({})
                operations.push(request)
                return performed()
            },
        })
        let toggle = button(workingChanges(), "Stash stash@{0}: Parked work")
        expect(toggle.compareDocumentPosition(workingChanges().querySelector(".commit-card")!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

        await app.act(() => press(toggle))
        expect(toggle.getAttribute("aria-expanded")).toBe("true")
        expect(tree("Files in stash stash@{0}").textContent).toContain("stashed.txt")

        let before = graphReads
        await app.act(() => press(button(workingChanges(), "Apply stash stash@{0}")))
        await app.act(() => press(button(workingChanges(), "Drop stash stash@{0}")))
        await app.act(() => press(button(workingChanges(), "More commit actions")))
        await app.act(() => press(menuItem("Stash Working Changes…")))
        await app.act(() => type(input("Stash label"), "Parked again"))
        await app.act(() => press(button(workingChanges(), "Stash all changes")))

        expect(operations).toEqual([{ action: "stash-apply", path: "D:\\Source\\inspection", objectId: stash.objectId }, {
            action: "stash-drop",
            objectId: stash.objectId,
        }, { action: "stash-create", path: "D:\\Source\\inspection", label: "Parked again" }])
        // Stashes change what the Branch Graph shows, so each one reads it again.
        expect(graphReads).toBe(before + 3)
        expect(document.querySelector("[aria-label='Stash label']") == null).toBe(true)
    })

    test("a detached worktree lists its proposed branch below Working Changes with an editable name, which its commit creates", async () => {
        let { api, root } = detachedScenario()
        let draft = { title: "", message: "", branch: "" }
        let requests: LocalRequest[] = []
        let app = await startReactApp({
            ...api,
            readCommitDraft: async () => ({ ...draft }),
            saveCommitDraft: async (_id, _path, value) => {
                draft = { ...value }
            },
            localOperation: async (_id, request, token) => {
                if (!token)
                    return previewResult({ token: "detached", branch: undefined, suggestedBranch: "inspection" })
                requests.push(request)
                return performed()
            },
        })
        let card = workingChanges().querySelector<HTMLElement>(".virtual-branch")!
        expect(workingChanges().querySelector(".commit-card")!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
        expect(card.querySelector("svg")).not.toBeNull()
        expect(button(card, "Rename new branch").textContent).toBe("inspection")

        await app.act(() => press(button(card, "Rename new branch")))
        let name = input("New name for new branch")
        await app.act(() => type(name, "feature/detached"))
        await app.act(() => name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
        expect(draft.branch).toBe("feature/detached")
        expect(document.querySelector("[aria-label='New name for new branch']") == null).toBe(true)
        expect(button(card, "Rename new branch").textContent).toBe("feature/detached")

        await app.act(() => press(button(workingChanges(), "Commit…")))
        await app.act(() => type(input("Commit title"), "First on branch"))
        await app.act(() => press(button(workingChanges(), "Commit staged (2)")))
        expect(requests.map(request => request.action)).toEqual(["branch-create", "commit"])
        expect(requests[0]).toMatchObject({ action: "branch-create", name: "feature/detached", path: root })
    })

    test("a detached worktree proposes its branch before the engine's preview answers", async () => {
        let { api } = detachedScenario()
        let release!: () => void
        let released = new Promise<void>(resolve => release = resolve)
        let app = await startReactApp({
            ...api,
            localOperation: async () => {
                await released
                return previewResult({ branch: undefined, suggestedBranch: "inspection-2" })
            },
        })
        let name = () => button(workingChanges().querySelector(".virtual-branch")!, "Rename new branch").textContent

        expect(name()).toBe("worktree/inspection")
        await app.act(() => release())
        expect(name()).toBe("inspection-2")
    })
})

function changedFile(path: string): ChangedFile {
    return { path, status: "modified", staged: false, unstaged: true, untracked: false, ignored: false, conflicted: false }
}

function detachedScenario() {
    let scenario = inspectionScenario()
    let repository = repositoryInfo("D:\\Source\\inspection")
    let head = "2".repeat(40)
    scenario.graph.branches[1]!.checkedOut = []
    scenario.graph.virtualBranches = [{
        kind: "virtual",
        id: `virtual:${repository.root}`,
        name: "inspection",
        objectId: head,
        worktree: { path: repository.root, name: "inspection", head, main: true },
        tooltip: "detached at 22222222",
    }]
    let opened = openedWorkspace(repository)
    let api: Window["laneway"] = {
        ...scenario.api,
        getState: async () => ({ ...appState(), workspace: { ...opened, repositories: [{ ...opened.repositories[0]!, layoutInitialized: true }] } }),
    }
    return { api, root: repository.root }
}

function previewResult(change: Partial<LocalPreview>): LocalActionResult {
    return {
        ok: true,
        result: {
            type: "result",
            command: "local-preview",
            status: "preview",
            preview: {
                token: "fixture",
                affected: [],
                uniqueCommits: false,
                branch: "feature/laneway",
                unborn: false,
                suggestedBranch: "feature/laneway",
                staged: true,
                files: [],
                stashes: [],
                worktrees: [],
                ...change,
            },
        },
    }
}

function performed(): LocalActionResult {
    return { ok: true, result: { type: "result", command: "local", status: "performed" } }
}

function workingChanges() {
    return document.querySelector<HTMLElement>("[aria-label='Working Changes']")!
}

function fileRows() {
    return [...workingChanges().querySelectorAll<HTMLElement>(".file-row")]
}

function folderNames() {
    return [...workingChanges().querySelectorAll(".folder-name")].map(name => name.textContent)
}

/** The paths of a list's file rows, which they are named by; a row's text leads with the file's name. */
function rowNames(list: Element) {
    return [...list.querySelectorAll(".file-row")].map(row => row.getAttribute("aria-label"))
}

function tree(label: string) {
    return document.querySelector<HTMLElement>(`[role=treegrid][aria-label='${label}']`)!
}

/** A file's row by its path, or a folder's or group's by its label; `index` picks among lists showing it. */
function row(label: string, index = 0) {
    return [...workingChanges().querySelectorAll<HTMLElement>(`[data-row-key][aria-label='${label}']`)][index]!
}

function chosen(element: Element) {
    return element.hasAttribute("data-chosen")
}

function chosenNames() {
    return [...workingChanges().querySelectorAll(".file-row[data-chosen]")].map(element => element.getAttribute("aria-label"))
}

function input(label: string) {
    return document.querySelector<HTMLInputElement>(`[aria-label='${label}']`)!
}

function selectionSummary() {
    return workingChanges().querySelector(".selection-summary")?.textContent ?? undefined
}

function toast() {
    return document.querySelector<HTMLElement>("[role=alertdialog]")
}

function openContextMenu(row: HTMLElement) {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 50 }))
}

function menuItems() {
    return [...document.querySelectorAll("[role=menu] [role=menuitem]")].map(item => item.textContent)
}

function menuItem(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] :is([role=menuitem], [role=menuitemradio])")].find(item => item.textContent == label)
    if (!item)
        throw new Error(`No ${label} menu item in: ${menuItems().join(", ")}`)
    return item
}
