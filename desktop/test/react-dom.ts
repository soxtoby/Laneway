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
    let browserWindow = new HappyWindow({ url: "file:///renderer/react.html" })
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
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    return browserWindow
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

// React Aria acts on pointer presses, which a bare click event doesn't make.
export function press(element: HTMLElement) {
    let options = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, width: 1, height: 1 }
    element.dispatchEvent(new PointerEvent("pointerdown", options))
    element.dispatchEvent(new PointerEvent("pointerup", options))
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }))
}

// React tracks an input's value to tell user input from its own updates, so the value goes through
// the element's own setter, as typing would.
export function type(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
}

export function submit(form: HTMLFormElement) {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))
}
