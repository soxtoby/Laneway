/** @jsxImportSource react */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import type { App as AppComponent } from "../src/renderer/react/app"
import type { createAppController as createController } from "../src/renderer/react/app-controller"
import { installReactDom, renderReact } from "./react-dom"
import { appState, fakeLaneway, inspectionScenario } from "./renderer-fixtures"

let browserWindow: HappyWindow
let App: typeof AppComponent
let createAppController: typeof createController

beforeAll(async () => {
    browserWindow = installReactDom()
    ;({ App } = await import("../src/renderer/react/app"))
    ;({ createAppController } = await import("../src/renderer/react/app-controller"))
})

afterAll(() => browserWindow.close())

describe("React app", () => {
    test("a failed start shows the error in an alert, and Retry opens the workspace", async () => {
        let attempts = 0
        let api = fakeLaneway({
            getState: async () => {
                if (attempts++ == 0)
                    throw new Error("Settings are unreadable.")
                return appState()
            },
        })
        let controller = createAppController(api)
        let view = await renderReact(<App api={api} controller={controller} />)
        try {
            await view.act(() => controller.start())
            let alert = view.container.querySelector("[role=alert]")
            expect(alert?.textContent).toContain("Laneway could not start.")
            expect(alert?.textContent).toContain("Settings are unreadable.")

            await view.act(() => press(button(view.container, "Retry")))

            expect(view.container.querySelector("[role=alert]")).toBeNull()
            expect(view.container.querySelector("[aria-label='Open repositories']")).not.toBeNull()
        } finally {
            await view.unmount()
            controller.dispose()
        }
    })

    test("a notice shows as a toast whose action runs once and closes it", async () => {
        let api = fakeLaneway()
        let controller = createAppController(api)
        let view = await renderReact(<App api={api} controller={controller} />)
        try {
            await view.act(() => controller.start())
            let undone = 0
            let closed = 0

            await view.act(() =>
                controller.notify({
                    code: "discard.applied",
                    message: "Discarded changes.",
                    action: { label: "Undo", run: () => undone++ },
                    closed: () => closed++,
                })
            )
            let toast = document.querySelector("[role=alertdialog]")
            expect(toast?.textContent).toContain("Discarded changes.")

            await view.act(() => press(button(toast!, "Undo")))

            expect(undone).toBe(1)
            expect(closed).toBe(1)
            expect(controller.snapshot()).toMatchObject({ notice: undefined })
        } finally {
            await view.unmount()
            controller.dispose()
        }
    })

    test("a repository's context menu opens from its row and closes the repository", async () => {
        let scenario = inspectionScenario()
        let closedIds: string[] = []
        let api = fakeLaneway({
            ...scenario.api,
            closeRepository: async id => {
                closedIds.push(id)
                return { repositories: [] }
            },
        })
        let controller = createAppController(api)
        let view = await renderReact(<App api={api} controller={controller} />)
        try {
            await view.act(() => controller.start())
            let row = view.container.querySelector<HTMLElement>("[aria-label='Open repositories'] [role=row]")!

            await view.act(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 60 })))
            let menu = document.querySelector("[role=menu]")
            expect(menu?.getAttribute("aria-label")).toBe("Actions for inspection")

            await view.act(() => press([...menu!.querySelectorAll<HTMLElement>("[role=menuitem]")].find(item => item.textContent == "Close repository")!))

            expect(closedIds).toEqual([scenario.saved().activeRepositoryId!])
            expect(view.container.querySelector("[aria-label='Open repositories'] [role=row]")).toBeNull()
        } finally {
            await view.unmount()
            controller.dispose()
        }
    })
})

function button(container: Element, label: string) {
    let found = [...container.querySelectorAll<HTMLElement>("button")].find(element =>
        element.textContent?.trim() == label || element.getAttribute("aria-label") == label
    )
    if (!found)
        throw new Error(`No ${label} button.`)
    return found
}

// React Aria acts on pointer presses, which a bare click event doesn't make.
function press(element: HTMLElement) {
    let options = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, width: 1, height: 1 }
    element.dispatchEvent(new PointerEvent("pointerdown", options))
    element.dispatchEvent(new PointerEvent("pointerup", options))
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }))
}
