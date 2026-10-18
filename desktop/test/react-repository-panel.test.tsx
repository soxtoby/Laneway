/** @jsxImportSource react */
import type { Workspace } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, field, installReactDom, press, startReactApp, stopReactApps, type } from "./react-dom"
import { appState, branchGraph, fakeLaneway, inspectionScenario, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React repository panel", () => {
    test("customizing a repository shows its name and icon at once and saves once changes pause", async () => {
        let scenario = inspectionScenario()
        let saves: Workspace[] = []
        let app = await startReactApp(fakeLaneway({
            ...scenario.api,
            updateWorkspace: async workspace => {
                saves.push(structuredClone(workspace))
                return workspace
            },
        }))
        expect(repositoryNames()).toEqual(["inspection"])
        expect(tile()).toEqual({ kind: "initials", text: "IN" })

        await app.act(() => openMenu(repositoryRow()))
        expect(menuItems()).toEqual(["Customize…", "Close repository"])
        await app.act(() => press(menuItem("Customize…")))
        let editor = document.querySelector("[role=dialog]")!
        expect(editor.querySelector("h2")?.textContent).toBe("inspection")
        // Without a favicon the default is initials, so the editor opens on Monogram showing them.
        expect(checkedIconType(editor)).toBe("Monogram")
        expect(monogramLetters(editor).value).toBe("IN")

        await app.act(() => type(field(editor, "Name"), "Inspection desk"))
        expect(repositoryNames()).toEqual(["Inspection desk"])
        expect(tile()).toEqual({ kind: "initials", text: "ID" })
        expect(saves.at(-1)?.repositories[0]?.label).toBeUndefined()
        await app.act(() => pause(250))
        expect(saves.at(-1)?.repositories[0]).toMatchObject({ label: "Inspection desk" })
        expect(saves.at(-1)?.repositories[0]?.icon).toBeUndefined()

        // Untouched initials follow the new name; choosing a colour makes them an explicit monogram.
        expect(monogramLetters(editor).value).toBe("ID")
        await app.act(() => press(option(editor, "Violet")))
        expect(tile()).toEqual({ kind: "monogram", text: "ID", tone: "violet" })
        // Letters that aren't valid keep the previous tile.
        await app.act(() => type(monogramLetters(editor), "too long"))
        expect(tile()).toEqual({ kind: "monogram", text: "ID", tone: "violet" })
        await app.act(() => type(monogramLetters(editor), "t3"))
        await app.act(() => pause(250))
        expect(saves.at(-1)?.repositories[0]).toMatchObject({ label: "Inspection desk", icon: { kind: "monogram", text: "T3", color: "violet" } })

        await app.act(() => press(iconType(editor, "Emoji")))
        await app.act(() => press(option(editor, "Rocket")))
        expect(tile()).toEqual({ kind: "emoji", text: "🚀" })

        await app.act(() => press(button(editor, "Reset")))
        await app.act(() => pause(250))
        expect(repositoryNames()).toEqual(["inspection"])
        expect(tile()).toEqual({ kind: "initials", text: "IN" })
        expect(checkedIconType(editor)).toBe("Monogram")
        expect(saves.at(-1)?.repositories[0]?.label).toBeUndefined()
        expect(saves.at(-1)?.repositories[0]?.icon).toBeUndefined()

        await app.act(() => press(button(editor, "Done")))
        expect(document.querySelector("[role=dialog]")).toBeNull()
    })

    test("a repository's favicon shows until another of its images is chosen", async () => {
        let repository = repositoryInfo("D:\\Source\\branded")
        let favicon = "D:\\Source\\branded\\public\\favicon.svg"
        let logo = "D:\\Source\\branded\\src\\assets\\logo.svg"
        let workspace: Workspace = { ...openedWorkspace(repository), repositories: [{ ...openedWorkspace(repository).repositories[0]!, favicon }] }
        let reads: string[] = []
        let saves: Workspace[] = []
        let app = await startReactApp(fakeLaneway({
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
        }))
        await app.act(() => pause(0))
        expect(reads).toEqual([favicon])
        expect(tile().kind).toBe("image")

        // The editor opens on Image, naming the favicon it found and listing the repository's images.
        await app.act(() => openMenu(repositoryRow()))
        await app.act(() => press(menuItem("Customize…")))
        let editor = document.querySelector("[role=dialog]")!
        expect(iconTypes(editor)).toEqual(["Icon", "Emoji", "Monogram", "Image"])
        expect(checkedIconType(editor)).toBe("Image")
        expect(editor.textContent).toContain("Using the favicon favicon.svg found in the repository")
        expect(images(editor)).toEqual(["public/favicon.svg", "src/assets/logo.svg", "docs/screenshot.png"])
        expect(selectedImages(editor)).toEqual(["public/favicon.svg"])

        // Searching narrows by any part of the path; the arrows highlight a file and Enter chooses it.
        let search = editor.querySelector<HTMLInputElement>("input[aria-label='Search images in the repository']")!
        await app.act(() => search.focus())
        await app.act(() => type(search, "assets"))
        expect(images(editor)).toEqual(["src/assets/logo.svg"])
        await app.act(() => key(search, "ArrowDown"))
        await app.act(() => key(search, "Enter"))
        await app.act(() => pause(0))
        expect(reads).toContain(logo)
        expect(editor.textContent).toContain(`Using ${logo}`)
        await app.act(() => pause(250))
        expect(saves.at(-1)?.repositories[0]?.icon).toEqual({ kind: "image", path: logo })
    })

    test("a repository moves by keyboard drag or Ctrl+Shift+< and >, and choosing one is a separate press", async () => {
        let infos = ["alpha", "beta", "gamma"].map(name => repositoryInfo(`D:\\Source\\${name}`))
        let saved: Workspace = { repositories: infos.flatMap(info => openedWorkspace(info).repositories), activeRepositoryId: infos[0]!.id }
        let selected: string[] = []
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: saved }),
            readBranchGraph: async () => ({ ok: true, graph: branchGraph(infos[0]!.id) }),
            selectRepository: async id => {
                selected.push(id)
                return saved
            },
            updateWorkspace: async next => saved = structuredClone(next),
        }))
        let savedNames = () => saved.repositories.map(repository => repository.path.split("\\").pop())

        // The drag handle starts a keyboard drag; the arrows move between gaps and Enter drops.
        await app.act(() => dragHandle("alpha").focus())
        await app.act(() => key(dragHandle("alpha"), "Enter"))
        await app.act(() => key(document.activeElement!, "ArrowDown"))
        await app.act(() => key(document.activeElement!, "ArrowDown"))
        await app.act(() => key(document.activeElement!, "Enter"))
        expect(repositoryNames()).toEqual(["beta", "gamma", "alpha"])
        expect(savedNames()).toEqual(["beta", "gamma", "alpha"])

        // Escape returns a keyboard drag to where it started.
        await app.act(() => dragHandle("gamma").focus())
        await app.act(() => key(dragHandle("gamma"), "Enter"))
        await app.act(() => key(document.activeElement!, "ArrowUp"))
        await app.act(() => key(document.activeElement!, "Escape"))
        expect(repositoryNames()).toEqual(["beta", "gamma", "alpha"])

        await app.act(() => repositoryRow("alpha").focus())
        await app.act(() => key(repositoryRow("alpha"), "<", { ctrlKey: true, shiftKey: true }))
        expect(repositoryNames()).toEqual(["beta", "alpha", "gamma"])
        expect(savedNames()).toEqual(["beta", "alpha", "gamma"])
        expect(selected).toEqual([])

        await app.act(() => press(repositoryRow("gamma")))
        expect(selected).toEqual([infos[2]!.id])
    })

    test("a missing repository explains itself and can be located", async () => {
        let repository = repositoryInfo("D:\\Source\\moved")
        let missing: Workspace = {
            repositories: [{
                status: "missing",
                id: repository.id,
                path: repository.root,
                name: "moved",
                columns: [],
                layoutInitialized: false,
                error: { code: "git.invalid-root", message: "The repository folder no longer exists." },
            }],
            activeRepositoryId: repository.id,
        }
        let located: string[] = []
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: missing }),
            readBranchGraph: async () => ({ ok: true, graph: branchGraph(repository.id) }),
            locateRepository: async id => {
                located.push(id)
                return openedWorkspace(repository)
            },
        }))
        let unavailable = document.querySelector("[aria-labelledby='missing-repository-heading']")!
        expect(unavailable.textContent).toContain("moved")
        expect(unavailable.textContent).toContain("The repository folder no longer exists.")

        await app.act(() => press(button(unavailable, "Locate")))

        expect(located).toEqual([repository.id])
        expect(document.querySelector("[aria-labelledby='missing-repository-heading']")).toBeNull()
    })
})

function repositoryRows() {
    return [...document.querySelectorAll<HTMLElement>("[aria-label='Open repositories'] [role=row]")]
}

function repositoryNames() {
    return repositoryRows().map(row => row.getAttribute("aria-label"))
}

function repositoryRow(name?: string) {
    return repositoryRows().find(row => name == undefined || row.getAttribute("aria-label") == name)!
}

function dragHandle(name: string) {
    return button(repositoryRow(name), `Drag ${name}`)
}

function tile() {
    let svg = repositoryRow().querySelector<SVGElement>("svg.tile")!
    let tone = svg.querySelector("[data-tone]")?.getAttribute("data-tone")
    return { kind: svg.dataset.kind, text: svg.textContent, ...tone ? { tone } : {} }
}

function openMenu(row: HTMLElement) {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 30 }))
}

function menuItems() {
    return [...document.querySelectorAll("[role=menu] [role=menuitem]")].map(item => item.textContent)
}

function menuItem(label: string) {
    return [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(item => item.textContent == label)!
}

function iconType(editor: Element, label: string) {
    return [...editor.querySelectorAll<HTMLElement>("[aria-label='Icon type'] [role=radio]")].find(item => item.textContent?.trim() == label)!
}

function iconTypes(editor: Element) {
    return [...editor.querySelectorAll("[aria-label='Icon type'] [role=radio]")].map(item => item.textContent?.trim())
}

function checkedIconType(editor: Element) {
    return editor.querySelector("[aria-label='Icon type'] [role=radio][aria-checked=true]")?.textContent?.trim()
}

function option(editor: Element, label: string) {
    return [...editor.querySelectorAll<HTMLElement>("[role=option]")].find(item => item.getAttribute("aria-label") == label)!
}

function monogramLetters(editor: Element) {
    return editor.querySelector<HTMLInputElement>("input[aria-label='Monogram letters']")!
}

function images(editor: Element) {
    return [...editor.querySelectorAll("[aria-label='Images in the repository'] [role=option] .image-path")].map(path => path.textContent)
}

function selectedImages(editor: Element) {
    return [...editor.querySelectorAll("[aria-label='Images in the repository'] [role=option][aria-selected=true] .image-path")].map(path => path.textContent)
}

function key(target: Element, key: string, modifiers: KeyboardEventInit = {}) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }))
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...modifiers }))
}

function pause(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}
