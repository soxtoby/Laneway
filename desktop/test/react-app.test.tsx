import type { EntryProgress, EntryResult } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, field, installReactDom, press, startReactApp as startApp, stopReactApps, submit, type } from "./react-dom"
import { appState, fakeLaneway, inspectionScenario, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React app", () => {
    test("a failed start shows the error in an alert, and Retry opens the workspace", async () => {
        let attempts = 0
        let app = await startApp(fakeLaneway({
            getState: async () => {
                if (attempts++ == 0)
                    throw new Error("Preload unavailable")
                return appState()
            },
        }))
        let alert = document.querySelector("[role=alert]")
        expect(alert?.textContent).toContain("Laneway could not start.")
        expect(alert?.textContent).toContain("Preload unavailable")

        await app.act(() => press(button(document.body, "Retry")))

        expect(document.querySelector("[role=alert]") == null).toBe(true)
        expect(document.body.textContent).toContain("No repository open")
        expect(attempts).toBe(2)
    })

    test("a notice shows as a toast of its message alone, whose action runs once and closes it", async () => {
        let app = await startApp(fakeLaneway())
        let undone = 0
        let closed = 0

        await app.act(() =>
            app.controller.notify({
                code: "discard.applied",
                message: "Discarded changes.",
                action: { label: "Undo", run: () => undone++ },
                closed: () => closed++,
            })
        )
        let toast = document.querySelector("[role=alertdialog]")
        expect(toast?.querySelector(".react-aria-ToastContent")?.textContent).toBe("Discarded changes.")

        await app.act(() => press(button(toast!, "Undo")))

        expect(undone).toBe(1)
        expect(closed).toBe(1)
        expect(app.controller.snapshot()).toMatchObject({ notice: undefined })
    })

    test("a repository's context menu opens from its row and closes the repository", async () => {
        let scenario = inspectionScenario()
        let closedIds: string[] = []
        let app = await startApp(fakeLaneway({
            ...scenario.api,
            closeRepository: async id => {
                closedIds.push(id)
                return { repositories: [] }
            },
        }))
        let row = document.querySelector<HTMLElement>("[aria-label='Open repositories'] [role=row]")!

        await app.act(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 60 })))
        let menu = document.querySelector("[role=menu]")
        expect(menu?.getAttribute("aria-label")).toBe("Actions for inspection")

        await app.act(() => press([...menu!.querySelectorAll<HTMLElement>("[role=menuitem]")].find(item => item.textContent == "Close repository")!))

        expect(closedIds).toEqual([scenario.saved().activeRepositoryId!])
        expect(document.querySelector("[aria-label='Open repositories'] [role=row]") == null).toBe(true)
    })

    test("the saved appearance shows in the header, and toggling it saves the other one", async () => {
        let saved: string[] = []
        let app = await startApp(fakeLaneway({
            getState: async () => ({ ...appState(), appearance: "dark" as const }),
            setAppearance: async appearance => {
                saved.push(appearance)
                return appearance
            },
        }))

        await app.act(() => press(button(document.body, "Switch to light appearance")))

        expect(saved).toEqual(["light"])
        expect(button(document.body, "Switch to dark appearance")).toBeDefined()
    })

    test("a downloaded update offers a restart in the header, which installs it", async () => {
        let ready: ((update: { version: string }) => void) | undefined
        let installs = 0
        let app = await startApp(fakeLaneway({
            onUpdateReady: listener => {
                ready = listener
                return () => ready = undefined
            },
            installUpdate: async () => {
                installs++
            },
        }))
        expect(document.querySelector("header")?.textContent).not.toContain("Restart to update")

        await app.act(() => ready!({ version: "0.2.0" }))
        await app.act(() => press(button(document.body, "Restart to update")))

        expect(installs).toBe(1)
    })

    test("an unreadable Workspace State offers a reset, which clears the warning", async () => {
        let resets = 0
        let app = await startApp(fakeLaneway({
            getState: async () => ({
                ...appState(),
                workspace: { repositories: [], persistenceError: { code: "workspace.corrupt", message: "workspace.json is not valid JSON." } },
            }),
            resetWorkspace: async () => {
                resets++
                return { repositories: [] }
            },
        }))
        let warning = document.querySelector(".workspace-recovery")
        expect(warning?.textContent).toContain("workspace.json is not valid JSON.")

        await app.act(() => press(button(warning!, "Reset workspace")))

        expect(resets).toBe(1)
        expect(document.body.textContent).not.toContain("Workspace State needs attention")
    })
})

describe("React repository entry", () => {
    test("initializing a repository opens the resulting workspace", async () => {
        let requests: unknown[][] = []
        let app = await startApp(fakeLaneway({
            initializeRepository: async (...request) => {
                requests.push(request)
                return { ok: true, workspace: openedWorkspace(repositoryInfo("D:\\Source\\new-project")) }
            },
        }))

        await app.act(() => press(button(document.body, "Initialize")))
        let dialog = document.querySelector("[role=dialog]")!
        expect(field(dialog, "Parent directory").value).toBe("C:\\Users\\developer\\Documents")
        await app.act(() => {
            type(field(dialog, "Parent directory"), "D:\\Source")
            type(field(dialog, "Directory name"), "new-project")
            type(field(dialog, "Initial branch"), "trunk")
        })
        await app.act(() => submit(dialog.querySelector("form")!))

        expect(requests).toEqual([["D:\\Source", "new-project", "trunk"]])
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        expect(repositoryNames()).toEqual(["new-project"])
        expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("Repository initialized and opened.")
    })

    test("Git settings change the executable without starting a repository operation", async () => {
        let chooseCalls = 0
        let app = await startApp(fakeLaneway({
            chooseGit: async () => {
                chooseCalls++
                return {
                    path: "C:\\Users\\developer\\settings.json",
                    override: "D:\\Tools\\Git\\git.exe",
                    git: { path: "D:\\Tools\\Git\\git.exe", version: "2.52.0" },
                    authorIdentities: { secondary: [] },
                }
            },
        }))

        await app.act(() => press(button(document.body, "Git settings")))
        let dialog = document.querySelector("[role=dialog]")!
        await app.act(() => press(button(dialog, "Choose executable")))

        expect(chooseCalls).toBe(1)
        expect(dialog.textContent).toContain("D:\\Tools\\Git\\git.exe")
        expect(dialog.textContent).toContain("Application override")
        expect(button(document.body, "Clone").hasAttribute("disabled")).toBe(false)
    })

    test("a cancelled clone keeps its dialog and values", async () => {
        let progress: ((progress: EntryProgress) => void) | undefined
        let finishClone: (result: EntryResult) => void = () => undefined
        let cancelCalls = 0
        let requests: string[][] = []
        let app = await startApp(fakeLaneway({
            cloneRepository: (...request) => {
                requests.push(request)
                return new Promise<EntryResult>(resolve => finishClone = resolve)
            },
            cancelEntry: async () => {
                cancelCalls++
                return true
            },
            onEntryProgress: listener => {
                progress = listener
                return () => progress = undefined
            },
        }))

        await app.act(() => press(button(document.body, "Clone")))
        let dialog = document.querySelector("[role=dialog]")!
        expect(field(dialog, "Parent directory").value).toBe("C:\\Users\\developer\\Documents")
        await app.act(() => type(field(dialog, "Git source"), "https://host/team/project.git"))
        expect(field(dialog, "Directory name").value).toBe("project")
        await app.act(() => type(field(dialog, "Parent directory"), "D:\\Source"))
        await app.act(() => submit(dialog.querySelector("form")!))
        expect(requests).toEqual([["https://host/team/project.git", "D:\\Source", "project"]])

        await app.act(() => progress?.({ message: "Receiving objects: 61%" }))
        expect(dialog.textContent).toContain("Receiving objects: 61%")

        await app.act(() => press(button(dialog, "Cancel clone")))
        expect(cancelCalls).toBe(1)
        expect(button(dialog, "Stopping…")).toBeDefined()

        await app.act(() => finishClone({ ok: false, error: { code: "git.cancelled", message: "Clone cancelled." } }))
        expect(document.querySelector("[role=dialog]")).toBe(dialog)
        expect(field(dialog, "Git source").value).toBe("https://host/team/project.git")
        expect(field(dialog, "Parent directory").value).toBe("D:\\Source")
        expect(field(dialog, "Directory name").value).toBe("project")
        expect(dialog.textContent).not.toContain("Stopping Git")
        expect(dialog.textContent).not.toContain("Clone cancelled.")
    })

    test("a repository address on the clipboard fills in the clone source and its directory name", async () => {
        let app = await startApp(fakeLaneway({
            entryDefaults: async form => ({ parent: "D:\\Source", ...form == "clone" ? { source: "https://host/team/project.git" } : {} }),
        }))

        await app.act(() => press(button(document.body, "Clone")))

        let dialog = document.querySelector("[role=dialog]")!
        expect(field(dialog, "Git source").value).toBe("https://host/team/project.git")
        expect(field(dialog, "Parent directory").value).toBe("D:\\Source")
        expect(field(dialog, "Directory name").value).toBe("project")
    })
})

function repositoryNames() {
    return [...document.querySelectorAll("[aria-label='Open repositories'] [role=row]")].map(row => row.getAttribute("aria-label"))
}
