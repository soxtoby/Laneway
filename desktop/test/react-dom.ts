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
