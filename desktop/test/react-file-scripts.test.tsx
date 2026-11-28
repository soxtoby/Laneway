import type { ChangedFile, DiffLine, RepositoryScript } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, field, installReactDom, press, startReactApp, stopReactApps, submit, type } from "./react-dom"
import { inspectionScenario } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

let worktreePath = "D:\\Source\\inspection"
let path = "src/file.txt"

describe("React File Scripts", () => {
    test("a diff's toolbar copies its file's path until a File Script runs on the file, and then repeats that, while a file's row goes on copying", async () => {
        let scenario = inspectionScenario()
        let runs: unknown[][] = []
        let app = await startReactApp({
            ...scenario.api,
            runScript: async (...run) => {
                runs.push(run)
                return { ok: true }
            },
        })
        await app.act(() => press(openButton(row(path))))

        await app.act(() => press(button(toolbar(), `Copy relative path of ${path}`)))
        expect(await navigator.clipboard.readText()).toBe(path)
        await app.act(() => press(button(toolbar(), `File scripts for ${path}`)))
        expect(menuNames()).toEqual(["Copy relative path", "New file script…"])

        await app.act(() => press(menuItem("New file script…")))
        expect(dialog().querySelector("h2")?.textContent).toBe("New file script")
        // An editor is wanted in every repository, so that is where a new one starts.
        expect(checkbox("Available in every repository").checked).toBe(true)
        await app.act(() => type(field(dialog(), "Name"), "Editor"))
        await app.act(() => type(field(dialog(), "Command"), "code --goto {file}[:{line}]"))
        await app.act(() => submit(dialog().querySelector("form")!))
        let [editor] = scenario.saved().scripts!
        expect(editor).toEqual({ id: editor!.id, name: "Editor", command: "code --goto {file}[:{line}]", target: "file" })

        await app.act(() => press(button(toolbar(), `File scripts for ${path}`)))
        expect(menuNames()).toEqual(["Copy relative path", "Editor", "Configure Editor", "New file script…"])
        await app.act(() => press(menuItem("Editor")))
        expect(runs).toEqual([[scenario.graph.repositoryId, worktreePath, editor!.id, { path }]])
        expect(scenario.saved().repositories[0]!.lastFileScriptId).toBe(editor!.id)

        await app.act(() => press(button(toolbar(), `Run Editor on ${path}`)))
        expect(runs.slice(1)).toEqual([[scenario.graph.repositoryId, worktreePath, editor!.id, { path }]])
        // A file's row keeps the button that copies its path, whatever ran last.
        await app.act(() => press(button(row("other.txt"), "Copy relative path of other.txt")))
        expect(await navigator.clipboard.readText()).toBe("other.txt")
        expect(runs).toHaveLength(2)
        // It runs on files, so the worktree's own script menu leaves it out.
        await app.act(() => press(button(document.querySelector<HTMLElement>(".column header")!, "Scripts")))
        expect(menuNames()).toEqual(["Open in File Explorer", "New script…"])
    })

    test("a right-click on a diff's line runs a File Script on the file at that line, or copies the path with it", async () => {
        let scenario = await withFileScripts([{ id: "editor", name: "Editor", command: "code --goto {file}:{line}", target: "file" }])
        let runs: unknown[][] = []
        let app = await startReactApp({
            ...scenario.api,
            runScript: async (...run) => {
                runs.push(run)
                return { ok: true }
            },
        })
        await app.act(() => press(openButton(row(path))))
        await settle(app)

        await app.act(() => rightClick(line("addition")))
        // As in the file's own script menu, copying comes first, and each script shows its icon.
        expect(menuNames()).toEqual(["Copy path and line", "Editor"])
        expect(menuItem("Editor").querySelector("svg.script-tile") != null).toBe(true)
        await app.act(() => press(menuItem("Editor")))
        expect(runs).toEqual([[scenario.graph.repositoryId, worktreePath, "editor", { path, line: 1 }]])

        // A deleted line is gone from the file, so it stands for the line that took its place.
        await app.act(() => rightClick(line("deletion")))
        await app.act(() => press(menuItem("Copy path and line")))
        expect(await navigator.clipboard.readText()).toBe(`${path}:1`)
        // Copying a line's path leaves the file buttons repeating the script that ran.
        expect(scenario.saved().repositories[0]!.lastFileScriptId).toBe("editor")
    })

    test("a deleted file's lines copy by the numbers its diff shows, there being no file left to have others", async () => {
        let scenario = await withFileScripts([{ id: "editor", name: "Editor", command: "code {file}", target: "file" }])
        let deletions = ["one", "two", "three"].map((text, index): DiffLine => ({ id: index + 1, kind: "deletion", text, oldLine: index + 1, hunk: 0 }))
        let lines: DiffLine[] = [{ id: 0, kind: "hunk", text: "@@ -1,3 +0,0 @@", hunk: 0 }, ...deletions]
        let app = await startReactApp(changed(scenario, { status: "deleted" }, lines))
        await app.act(() => press(openButton(row(path))))
        await settle(app)

        let copied: string[] = []
        for (let drawn of shown().querySelector(".pierre-diff")!.shadowRoot!.querySelectorAll<HTMLElement>("[data-line]")) {
            await app.act(() => rightClick(drawn))
            await app.act(() => press(menuItem("Copy path and line")))
            copied.push(await navigator.clipboard.readText())
        }

        expect(copied).toEqual([`${path}:1`, `${path}:2`, `${path}:3`])
    })

    test("a submodule's row lists no File Scripts, for it is a folder", async () => {
        let scenario = await withFileScripts([{ id: "editor", name: "Editor", command: "code {file}", target: "file" }])
        let app = await startReactApp(changed(scenario, { submodule: "S..." }))

        await app.act(() => row(path).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 50 })))

        expect(menuNames()).toContain("Copy relative path")
        expect(menuNames()).not.toContain("Editor")
    })

    test("a file's menu runs each File Script on it, shown with its icon, above the ways to copy where it is", async () => {
        let scenario = await withFileScripts([{ id: "editor", name: "Editor", command: "code {file}", target: "file" }])
        let runs: unknown[][] = []
        let app = await startReactApp({
            ...scenario.api,
            runScript: async (...run) => {
                runs.push(run)
                return { ok: true }
            },
        })

        await app.act(() => row(path).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 50 })))
        let names = menuNames()
        let icon = menuItem("Editor").querySelector("svg.script-tile") != null
        await app.act(() => press(menuItem("Editor")))

        expect(names.slice(names.indexOf("Editor"))).toEqual(["Editor", "Copy full path", "Copy relative path", "Copy file name"])
        expect(icon).toBe(true)
        expect(runs).toEqual([[scenario.graph.repositoryId, worktreePath, "editor", { path }]])
    })
})

async function withFileScripts(scripts: RepositoryScript[]) {
    let scenario = inspectionScenario()
    await scenario.api.updateWorkspace({ ...scenario.saved(), scripts })
    return scenario
}

/** The scenario's API with the file reported as changed another way, and, given lines, with those as its diff. */
function changed(scenario: ReturnType<typeof inspectionScenario>, change: Partial<ChangedFile>, lines?: DiffLine[]): Window["laneway"] {
    let { readChanges, readFileDiff } = scenario.api
    return {
        ...scenario.api,
        readChanges: async (...request) => {
            let result = await readChanges(...request)
            if (result.ok)
                result.inventory.files = result.inventory.files.map(file => file.path == path ? { ...file, ...change } : file)
            return result
        },
        readFileDiff: async (...request) => {
            let result = await readFileDiff(...request)
            if (result.ok && result.page.file.path == path)
                result.page = { ...result.page, file: { ...result.page.file, ...change }, lines: lines ?? result.page.lines }
            return result
        },
    }
}

function row(file: string) {
    return [...document.querySelectorAll<HTMLElement>("[data-group='working-staged'] .file-row")].find(candidate =>
        candidate.getAttribute("aria-label") == file
    )!
}

function openButton(fileRow: HTMLElement) {
    return button(fileRow, `Open ${fileRow.getAttribute("aria-label")} in diff column`)
}

function shown() {
    return [...document.querySelectorAll<HTMLElement>(".diff-column [data-diff-path]")].find(element => element.dataset.diffPath == path)!
}

function toolbar() {
    return shown().querySelector<HTMLElement>(".diff-toolbar")!
}

/** A drawn line of the file's diff, in Pierre's shadow root. */
function line(kind: "addition" | "deletion") {
    return shown().querySelector(".pierre-diff")!.shadowRoot!.querySelector<HTMLElement>(`[data-line][data-line-type*='${kind}']`)!
}

function rightClick(element: HTMLElement) {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, button: 2, clientX: 50, clientY: 50 }))
}

// Pierre draws once its highlighter has loaded, which takes a moment the first time.
async function settle(app: { act(action: () => unknown): Promise<void> }) {
    for (let attempt = 0; attempt < 100; attempt++) {
        await app.act(() => new Promise(resolve => setTimeout(resolve, 10)))
        if ([...document.querySelectorAll(".pierre-diff")].every(host => host.shadowRoot?.querySelector("[data-code]")))
            return
    }
}

function dialog() {
    return document.querySelector<HTMLElement>("[role=dialog]")!
}

/** Each menu item's name: its accessible label, or its visible one, which leaves out a script's tile. */
function menuNames() {
    return [...document.querySelectorAll("[role=menu] [role=menuitem]")].map(itemName)
}

function itemName(item: Element) {
    return item.getAttribute("aria-label") ?? (item.querySelector("[slot=label]") ?? item).textContent
}

function menuItem(name: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(candidate => itemName(candidate) == name)
    if (!item)
        throw new Error(`No ${name} menu item in: ${menuNames().join(", ")}`)
    return item
}

// Happy DOM passes a press on the label to its input as well, which would toggle it twice.
function checkbox(label: string) {
    let found = [...dialog().querySelectorAll<HTMLElement>("label")].find(item => item.textContent?.startsWith(label))
    return found!.querySelector<HTMLInputElement>("input")!
}
