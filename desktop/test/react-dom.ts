import { Window as HappyWindow } from "happy-dom"
import type { ReactNode } from "react"

// React DOM and React Aria reach the DOM through globals and check events and elements with
// `instanceof`, so Happy DOM's classes replace Bun's own where both exist.
let domClass =
    /^(HTML|SVG|DOM|CSS)|Event$|^(Node|NodeFilter|Element|Document|DocumentFragment|ShadowRoot|Text|Comment|EventTarget|MutationObserver|ResizeObserver|IntersectionObserver)$/
let windowFunctions = ["getComputedStyle", "matchMedia", "requestAnimationFrame", "cancelAnimationFrame", "getSelection"]

/**
 * Renders React into Happy DOM for tests of React views. Call `installReactDom` before importing React DOM
 * or view modules; they read browser globals as they load. The page's stylesheets are not applied,
 * so layout and colours are checked in Electron instead (react-renderer-styles.test.ts).
 */
export function installReactDom() {
    let browserWindow = new HappyWindow({ url: "file:///renderer/index.html" })
    let browserGlobal = browserWindow as unknown as Record<string, unknown>
    let names = new Set<string>()
    for (let object: object | null = browserWindow; object && object != Object.prototype; object = Object.getPrototypeOf(object)) {
        for (let name of Object.getOwnPropertyNames(object))
            names.add(name)
    }
    let define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    for (let name of names) {
        if (domClass.test(name))
            define(name, browserGlobal[name])
    }
    for (let name of windowFunctions)
        define(name, (browserGlobal[name] as (...args: unknown[]) => unknown).bind(browserWindow))
    define("window", browserWindow)
    define("document", browserWindow.document)
    define("navigator", browserWindow.navigator)
    // Pierre registers its diff containers as custom elements when it loads.
    define("customElements", browserWindow.customElements)
    // Happy DOM runs no animations; React Aria's selection indicator asks for an element's.
    let elementPrototype = browserWindow.Element.prototype as unknown as { getAnimations?(): unknown[] }
    elementPrototype.getAnimations ??= () => []
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    return browserWindow
}

let running: { unmount(): Promise<void>; dispose(): void }[] = []

/** Renders and starts the React app on a fake API; `stopReactApps` takes it down after the test. */
export async function startReactApp(api: Window["laneway"]) {
    let [{ createElement }, { App }, { createAppController }] = await Promise.all([
        import("react"),
        import("../src/renderer/react/app"),
        import("../src/renderer/react/app-controller"),
    ])
    let controller = createAppController(api)
    let view = await renderReact(createElement(App, { api, controller }))
    running.push({ unmount: view.unmount, dispose: controller.dispose })
    await view.act(() => controller.start())
    return { ...view, controller }
}

export async function stopReactApps() {
    for (let app of running.splice(0)) {
        await app.unmount()
        app.dispose()
    }
}

export async function renderReact(node: ReactNode) {
    let [{ act }, { createRoot }] = await Promise.all([import("react"), import("react-dom/client")])
    let container = document.createElement("div")
    document.body.append(container)
    let root = createRoot(container)
    await act(async () => root.render(node))
    return {
        container,
        /** Runs an interaction and lets React and the controller's reads settle before returning. */
        async act(action: () => unknown) {
            await act(async () => {
                await action()
            })
        },
        async unmount() {
            await act(async () => root.unmount())
            container.remove()
        },
    }
}

/** Finds a button by its visible text or its label; dialogs and menus render outside the view's container. */
export function button(container: Element, label: string) {
    let found = [...container.querySelectorAll<HTMLElement>("button")].find(element =>
        element.getAttribute("aria-label") == label || element.textContent?.trim() == label
    )
    if (!found)
        throw new Error(`No ${label} button in: ${container.textContent}`)
    return found
}

/** Finds a text field's input by its label. */
export function field(container: Element, label: string) {
    let found = [...container.querySelectorAll("label")].find(element => element.textContent?.trim() == label)
    let input = found && document.getElementById(found.htmlFor)
    if (!(input instanceof HTMLInputElement))
        throw new Error(`No ${label} field in: ${container.textContent}`)
    return input
}

// React Aria acts on pointer presses, which a bare click event doesn't make. `keys` holds modifiers, such as Ctrl.
export function press(element: HTMLElement, keys: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
    let options = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, width: 1, height: 1, ...keys }
    element.dispatchEvent(new PointerEvent("pointerdown", options))
    element.dispatchEvent(new PointerEvent("pointerup", options))
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...keys }))
}

// The pointer moves, which tells React Aria a mouse is in use, and leaves where it was as it arrives: React
// reads entering and leaving from pointerout and pointerover.
export function hover(element: Element, from?: Element) {
    let options = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", width: 1, height: 1 }
    ;(from ?? document.body).dispatchEvent(new PointerEvent("pointermove", options))
    from?.dispatchEvent(new PointerEvent("pointerout", { ...options, relatedTarget: element }))
    element.dispatchEvent(new PointerEvent("pointerover", { ...options, relatedTarget: from ?? null }))
}

// React tracks an input's value to tell user input from its own updates, so the value goes through
// the element's own setter, as typing would.
export function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    let prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
}

export function submit(form: HTMLFormElement) {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))
}
