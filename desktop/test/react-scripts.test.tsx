import type { RepositoryScript, ScriptRunResult } from "@laneway/shared"
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

describe("React repository scripts", () => {
    test("a worktree column's script button opens the folder until a script runs, then repeats that script", async () => {
        let scenario = inspectionScenario()
        let runs: string[][] = []
        let app = await startReactApp({
            ...scenario.api,
            runScript: async (...run) => {
                runs.push(run)
                return { ok: true }
            },
        })
        let repositoryId = scenario.graph.repositoryId

        await app.act(() => press(button(header(), "Open in File Explorer")))
        expect(runs).toEqual([[repositoryId, worktreePath, "open-folder"]])

        await app.act(() => press(button(header(), "Scripts")))
        expect(menuNames()).toEqual(["Open in File Explorer", "New script…"])
        await app.act(() => press(menuItem("New script…")))
        await app.act(() => type(field(dialog(), "Name"), "Build app"))
        await app.act(() => type(field(dialog(), "Command"), "bun run build"))
        await app.act(() => submit(dialog().querySelector("form")!))
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        let [script] = scenario.saved().repositories[0]!.scripts!
        expect(script).toEqual({ id: script!.id, name: "Build app", command: "bun run build" })
        // Saving a script doesn't run it, so the button still opens the folder.
        expect(scenario.saved().repositories[0]!.lastScriptId).toBeUndefined()

        await app.act(() => press(button(header(), "Scripts")))
        expect(menuNames()).toEqual(["Open in File Explorer", "Build app", "Configure Build app", "New script…"])
        await app.act(() => press(menuItem("Build app")))
        expect(runs.at(-1)).toEqual([repositoryId, worktreePath, script!.id])
        expect(scenario.saved().repositories[0]!.lastScriptId).toBe(script!.id)

        expect(runIcon()).toEqual({ kind: "initials", text: "BA" })
        await app.act(() => press(button(header(), "Run Build app")))
        expect(runs.at(-1)).toEqual([repositoryId, worktreePath, script!.id])
    })

    test("a script that fails shows what it printed in the notice", async () => {
        let scenario = await withScripts([{ id: "test", name: "Test", command: "bun test" }], "test")
        let app = await startReactApp({
            ...scenario.api,
            runScript: async (): Promise<ScriptRunResult> => ({ ok: false, message: "It exited with code 1.", output: "1 fail\nexpected 2" }),
        })

        await app.act(() => press(button(header(), "Run Test")))

        let toast = document.querySelector<HTMLElement>("[role=alertdialog]")!
        expect(toast.textContent).toContain("Test failed. It exited with code 1.")
        expect(toast.querySelector("[slot=description]")?.textContent).toBe("1 fail\nexpected 2")
    })

    test("a script's gear changes it, and deletes it at once with Undo in the notice", async () => {
        let scenario = await withScripts([{ id: "serve", name: "Serve", command: "bun dev" }, { id: "test", name: "Test", command: "bun test" }], "serve")
        let app = await startReactApp(scenario.api)

        await app.act(() => press(button(header(), "Scripts")))
        await app.act(() => press(menuItem("Configure Serve")))
        expect(dialog().querySelector("h2")?.textContent).toBe("Configure Serve")
        expect(field(dialog(), "Command").value).toBe("bun dev")
        await app.act(() => type(field(dialog(), "Command"), "bun run dev"))
        await app.act(() => press(checkbox("Open in a terminal")))
        await app.act(() => press(iconType("Emoji")))
        await app.act(() => press(option("Rocket")))
        await app.act(() => submit(dialog().querySelector("form")!))
        let changed = { id: "serve", name: "Serve", command: "bun run dev", terminal: true, icon: { kind: "emoji" as const, emoji: "🚀" } }
        expect(scenario.saved().repositories[0]!.scripts).toEqual([changed, { id: "test", name: "Test", command: "bun test" }])
        expect(runIcon()).toEqual({ kind: "emoji", text: "🚀" })

        await app.act(() => press(button(header(), "Scripts")))
        await app.act(() => press(menuItem("Configure Serve")))
        await app.act(() => press(button(dialog(), "Delete")))
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        expect(scenario.saved().repositories[0]!.scripts).toEqual([{ id: "test", name: "Test", command: "bun test" }])
        expect(scenario.saved().repositories[0]!.lastScriptId).toBeUndefined()
        expect(button(header(), "Open in File Explorer") != null).toBe(true)

        let toast = document.querySelector<HTMLElement>("[role=alertdialog]")!
        expect(toast.textContent).toContain("Deleted script Serve.")
        await app.act(() => press(button(toast, "Undo")))
        expect(scenario.saved().repositories[0]!.scripts).toEqual([changed, { id: "test", name: "Test", command: "bun test" }])
        expect(scenario.saved().repositories[0]!.lastScriptId).toBe("serve")
        expect(button(header(), "Run Serve") != null).toBe(true)
    })

    test("a script made available in every repository saves for them all, lists before the repository's own, and repeats once run", async () => {
        let scenario = await withScripts([{ id: "test", name: "Test", command: "bun test" }], "test")
        let runs: string[][] = []
        let app = await startReactApp({
            ...scenario.api,
            runScript: async (...run) => {
                runs.push(run)
                return { ok: true }
            },
        })

        await app.act(() => press(button(header(), "Scripts")))
        await app.act(() => press(menuItem("New script…")))
        await app.act(() => type(field(dialog(), "Name"), "Editor"))
        await app.act(() => type(field(dialog(), "Command"), "code ."))
        await app.act(() => press(checkbox("Available in every repository")))
        await app.act(() => submit(dialog().querySelector("form")!))

        let [editor] = scenario.saved().scripts!
        expect(editor).toEqual({ id: editor!.id, name: "Editor", command: "code ." })
        expect(scenario.saved().repositories[0]!.scripts).toEqual([{ id: "test", name: "Test", command: "bun test" }])
        await app.act(() => press(button(header(), "Scripts")))
        expect(menuNames()).toEqual(["Open in File Explorer", "Editor", "Configure Editor", "Test", "Configure Test", "New script…"])
        // A line parts the scripts every repository has from the repository's own, and another parts those from creating one.
        expect(menuSeparators()).toBe(2)
        await app.act(() => press(menuItem("Editor")))
        expect(runs).toEqual([[scenario.graph.repositoryId, worktreePath, editor!.id]])
        expect(scenario.saved().repositories[0]!.lastScriptId).toBe(editor!.id)
        expect(button(header(), "Run Editor") != null).toBe(true)
    })

    test("a script every repository has shows that in its dialog, where it returns to the one repository or deletes with Undo", async () => {
        let editor = { id: "editor", name: "Editor", command: "code ." }
        let scenario = await withScripts([{ id: "test", name: "Test", command: "bun test" }], "editor", [editor])
        let app = await startReactApp(scenario.api)

        await app.act(() => press(button(header(), "Scripts")))
        await app.act(() => press(menuItem("Configure Editor")))
        expect(checkbox("Available in every repository").checked).toBe(true)
        await app.act(() => press(checkbox("Available in every repository")))
        await app.act(() => submit(dialog().querySelector("form")!))

        expect(scenario.saved().scripts).toBeUndefined()
        expect(scenario.saved().repositories[0]!.scripts).toMatchObject([{ id: "test" }, { name: "Editor", command: "code ." }])
        expect(button(header(), "Run Editor") != null).toBe(true)

        await app.act(() => press(button(header(), "Scripts")))
        expect(menuNames()).toEqual(["Open in File Explorer", "Test", "Configure Test", "Editor", "Configure Editor", "New script…"])
        expect(menuSeparators()).toBe(1)
        await app.act(() => press(menuItem("Configure Editor")))
        expect(checkbox("Available in every repository").checked).toBe(false)
        await app.act(() => press(checkbox("Available in every repository")))
        await app.act(() => submit(dialog().querySelector("form")!))
        await app.act(() => press(button(header(), "Scripts")))
        await app.act(() => press(menuItem("Configure Editor")))
        await app.act(() => press(button(dialog(), "Delete")))

        expect(scenario.saved().scripts).toBeUndefined()
        expect(button(header(), "Open in File Explorer") != null).toBe(true)
        await app.act(() => press(button(document.querySelector<HTMLElement>("[role=alertdialog]")!, "Undo")))
        expect(scenario.saved().scripts).toMatchObject([{ name: "Editor", command: "code ." }])
        expect(button(header(), "Run Editor") != null).toBe(true)
    })
})

async function withScripts(scripts: RepositoryScript[], lastScriptId: string, everyRepository?: RepositoryScript[]) {
    let scenario = inspectionScenario()
    let saved = scenario.saved()
    saved.repositories[0] = { ...saved.repositories[0]!, scripts, lastScriptId }
    await scenario.api.updateWorkspace({ ...saved, ...everyRepository ? { scripts: everyRepository } : {} })
    return scenario
}

function header() {
    return document.querySelector<HTMLElement>("[data-column-id='branch:refs/heads/feature/laneway'] header")!
}

function runIcon() {
    let svg = header().querySelector<SVGElement>(".script-run svg.tile")!
    return { kind: svg.dataset.kind, text: svg.textContent }
}

function dialog() {
    return document.querySelector<HTMLElement>("[role=dialog]")!
}

/** Each menu item's name: its accessible label, or its visible one, which leaves out the script's tile. */
function menuNames() {
    return [...document.querySelectorAll("[role=menu] [role=menuitem]")].map(itemName)
}

function menuSeparators() {
    return document.querySelectorAll("[role=menu] [role=separator]").length
}

function itemName(item: Element) {
    return item.getAttribute("aria-label") ?? (item.querySelector("[slot=label]") ?? item).textContent
}

function menuItem(name: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(item => itemName(item) == name)
    if (!item)
        throw new Error(`No ${name} menu item in: ${menuNames().join(", ")}`)
    return item
}

// Happy DOM passes a press on the label to its input as well, which would toggle it twice.
function checkbox(label: string) {
    let found = [...dialog().querySelectorAll<HTMLElement>("label")].find(item => item.textContent?.startsWith(label))
    return found!.querySelector<HTMLInputElement>("input")!
}

function iconType(label: string) {
    return [...dialog().querySelectorAll<HTMLElement>("[aria-label='Icon type'] [role=radio]")].find(item => item.textContent?.trim() == label)!
}

function option(label: string) {
    return [...dialog().querySelectorAll<HTMLElement>("[role=option]")].find(item => item.getAttribute("aria-label") == label)!
}
