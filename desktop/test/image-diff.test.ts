import type { FileDiffPage, FileImagePage } from "@laneway/shared"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window as HappyWindow } from "happy-dom"
import type { createElement as createRemixElement, createRoot as createRemixRoot, VirtualRoot } from "remix/ui"
import type { ImageDiff as ImageDiffComponent, ImageDiffMode } from "../src/renderer/src/inspection/image-diff"
import { inspectionScenario } from "./renderer-fixtures"

let browserWindow: HappyWindow
let createElement: typeof createRemixElement
let createRoot: typeof createRemixRoot
let ImageDiff: typeof ImageDiffComponent
// Happy DOM cannot decode pictures, so natural sizes come from the bytes each blob URL was created for.
let dimensions = new Map<string, { width: number; height: number }>()

beforeAll(async () => {
    browserWindow = new HappyWindow({ url: "file:///renderer/index.html" })
    let browserGlobal = browserWindow as unknown as Record<string, unknown>
    for (
        let name of [
            "window",
            "document",
            "Node",
            "Element",
            "HTMLElement",
            "HTMLInputElement",
            "Comment",
            "Text",
            "Event",
            "CustomEvent",
            "CSSStyleSheet",
            "EventTarget",
            "MouseEvent",
            "PointerEvent",
            "KeyboardEvent",
            "customElements",
            "MutationObserver",
            "SVGElement",
        ]
    ) {
        Object.defineProperty(globalThis, name, { configurable: true, value: browserGlobal[name] })
    }
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browserWindow.requestAnimationFrame.bind(browserWindow) })
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browserWindow.cancelAnimationFrame.bind(browserWindow) })
    Object.defineProperty(globalThis, "CSSStyleSheet", {
        configurable: true,
        value: class extends browserWindow.CSSStyleSheet {
            override insertRule(_cssText: string, index = 0) {
                return super.insertRule(":root {}", index)
            }
        },
    })
    URL.createObjectURL = (blob: Blob) => {
        let url = `blob:test/${dimensions.size}`
        dimensions.set(url, { width: blob.size * 10, height: blob.size * 5 })
        return url
    }
    URL.revokeObjectURL = () => {}
    Object.defineProperty(globalThis, "Image", {
        configurable: true,
        value: class {
            src = ""
            get naturalWidth() {
                return dimensions.get(this.src)?.width ?? 0
            }
            get naturalHeight() {
                return dimensions.get(this.src)?.height ?? 0
            }
            decode() {
                return Promise.resolve()
            }
        },
    })
    ;({ createElement, createRoot } = await import("remix/ui"))
    ;({ ImageDiff } = await import("../src/renderer/src/inspection/image-diff"))
})

afterAll(() => browserWindow.close())

let bytes = (length: number) => new Uint8Array(length).fill(7)
let ready = (length: number) => ({ state: "ready" as const, bytes: bytes(length), size: length })

test("a changed image compares both versions in the chosen mode, scaled together", async () => {
    let page = imagePage("icon.png")
    let reads: FileDiffPage[] = []
    let read = async (requested: FileDiffPage) => {
        reads.push(requested)
        return { ...page, old: ready(10), new: ready(20) }
    }
    let view = render(page, read)
    try {
        await flush(view.root)
        expect(view.container.querySelectorAll("img")).toHaveLength(2)
        expect(view.container.textContent).toContain("Old · 100 × 50 · 10 B")
        expect(view.container.textContent).toContain("New · 200 × 100 · 20 B")
        expect(view.container.querySelector(".image-tools")).toBeNull()

        view.mode("swipe")
        await flush(view.root)
        let stage = view.container.querySelector<HTMLElement>(".image-stage")!
        expect(stage.style.width).toBe("200px")
        expect(stage.style.aspectRatio).toBe("200 / 100")
        let [old, current] = [...stage.querySelectorAll<HTMLImageElement>("img")]
        expect(old.style.width).toBe("50%")
        expect(current.style.width).toBe("100%")
        expect(current.style.clipPath).toBe("inset(0 0 0 50%)")
        click(button(view.container, "Show old"))
        await flush(view.root)
        expect(stage.querySelectorAll("img")[1].style.clipPath).toBe("inset(0 0 0 100%)")
        expect(view.container.querySelector<HTMLElement>(".image-divider")!.style.left).toBe("100%")
        click(button(view.container, "Show new"))
        await flush(view.root)
        expect(stage.querySelectorAll("img")[1].style.clipPath).toBe("inset(0 0 0 0%)")

        view.mode("difference")
        await flush(view.root)
        expect(view.container.querySelector<HTMLElement>(".image-stage img:last-of-type")!.style.mixBlendMode).toBe("difference")

        view.root.render(createElement(ImageDiff, { page: { ...page, version: "two" }, mode: "difference", read }))
        await flush(view.root)
        expect(reads.map(requested => requested.version)).toEqual(["one", "two"])
    } finally {
        view.dispose()
    }
})

test("clicking a picture or a stacked comparison enlarges it in a viewer that fits or shows every pixel", async () => {
    let page = imagePage("icon.png")
    let view = render(page, async () => ({ ...page, old: ready(10), new: ready(20) }))
    let shown = () => {
        let dialog = view.container.querySelector<HTMLDialogElement>("dialog.image-viewer")
        if (!dialog)
            throw new Error("Viewer not open")
        return {
            dialog,
            picture: dialog.querySelector<HTMLImageElement>(".image-viewer-body > img"),
            stage: dialog.querySelector<HTMLElement>(".image-viewer-body .image-stage"),
        }
    }
    try {
        await flush(view.root)
        expect(view.container.querySelector("dialog")).toBeNull()
        click(view.container.querySelector<HTMLButtonElement>("[aria-label='Enlarge new']")!)
        await flush(view.root)
        let viewer = shown()
        expect(viewer.dialog.open).toBe(true)
        expect(viewer.dialog.getAttribute("aria-label")).toBe("icon.png enlarged")
        expect(viewer.dialog.querySelector("header")?.textContent).toContain("New · 200 × 100 · 20 B")
        expect(viewer.picture?.getAttribute("alt")).toBe("New image")
        expect(viewer.picture?.classList.contains("fit")).toBe(true)
        expect(zoomButton(viewer.dialog, "Fit to window").getAttribute("aria-pressed")).toBe("true")

        click(zoomButton(viewer.dialog, "Actual size"))
        await flush(view.root)
        expect(shown().picture?.classList.contains("fit")).toBe(false)
        expect(zoomButton(shown().dialog, "Actual size").getAttribute("aria-pressed")).toBe("true")

        click(button(shown().dialog, "Old"))
        await flush(view.root)
        expect(shown().picture?.getAttribute("alt")).toBe("Old image")
        expect(shown().dialog.querySelector("header")?.textContent).toContain("Old · 100 × 50 · 10 B")

        click(shown().dialog.querySelector<HTMLButtonElement>("[aria-label='Close']")!)
        await flush(view.root)
        expect(view.container.querySelector("dialog")).toBeNull()

        view.mode("onion")
        await flush(view.root)
        let stage = view.container.querySelector<HTMLElement>(".image-stage")!
        expect(stage.getAttribute("role")).toBe("button")
        click(stage)
        await flush(view.root)
        viewer = shown()
        expect(viewer.picture).toBeNull()
        expect(viewer.stage?.querySelectorAll("img")).toHaveLength(2)
        expect(viewer.stage?.style.width).toBe("200px")
        expect(viewer.stage?.style.maxWidth).toBe("none")
        expect(viewer.stage?.getAttribute("role")).toBeNull()
        // Happy DOM drops the fitted min() width, so the Electron test measures that; here the pixel cap lifting shows the change.
        click(zoomButton(viewer.dialog, "Fit to window"))
        await flush(view.root)
        expect(shown().stage?.style.maxWidth).toBe("")
        expect(zoomButton(shown().dialog, "Fit to window").getAttribute("aria-pressed")).toBe("true")

        // Swiping needs the pointer, so its comparison enlarges from the tool bar instead.
        view.mode("swipe")
        await flush(view.root)
        expect(view.container.querySelector(".image-stage")?.getAttribute("role")).toBeNull()
        expect(view.container.querySelector(".image-tools [aria-label='Enlarge comparison']")).not.toBeNull()

        view.root.render(createElement(ImageDiff, { page: { ...page, version: "two" }, mode: "swipe", read: view.read }))
        await flush(view.root)
        expect(view.container.querySelector("dialog")).toBeNull()
    } finally {
        view.dispose()
    }
})

test("single versions and unavailable content show on their own whatever mode is chosen", async () => {
    let page = imagePage("added.png")
    let view = render(page, async () => ({ ...page, new: ready(4) }), "swipe")
    try {
        await flush(view.root)
        expect(view.container.querySelectorAll("img")).toHaveLength(1)
        expect(view.container.querySelector(".image-stage")).toBeNull()
        expect(view.container.textContent).toContain("40 × 20 · 4 B")
    } finally {
        view.dispose()
    }

    let downloaded!: () => void
    let download = new Promise<void>(resolve => downloaded = resolve)
    let requests: boolean[] = []
    let pointer = render(page, async (_page, _signal, fetchLfs) => {
        requests.push(fetchLfs == true)
        if (fetchLfs)
            await download
        return { ...page, old: ready(4), new: fetchLfs ? ready(6) : { state: "lfs" as const, size: 1234 } }
    }, "swipe")
    try {
        await flush(pointer.root)
        expect(pointer.container.querySelectorAll("img")).toHaveLength(1)
        expect(pointer.container.querySelector(".image-stage")).toBeNull()
        expect(pointer.container.querySelector("[role=status]")?.textContent).toContain("Downloading from Git LFS")
        expect(pointer.container.textContent).toContain("New · downloading · 1.2 KB")
        expect(requests).toEqual([false, true])
        downloaded()
        await flush(pointer.root)
        expect(pointer.container.querySelectorAll("img")).toHaveLength(2)
        expect(pointer.container.querySelector(".image-stage")).not.toBeNull()
    } finally {
        pointer.dispose()
    }

    let broken = render(page, async (_page, _signal, fetchLfs) => {
        if (fetchLfs)
            throw new Error("Git LFS could not download this image.")
        return { ...page, new: { state: "lfs" as const, size: 9 } }
    })
    try {
        await flush(broken.root)
        expect(broken.container.querySelector("[role=status]")).toBeNull()
        expect(broken.container.textContent).toContain("Git LFS could not download this image.")
    } finally {
        broken.dispose()
    }

    let failed = render(page, async () => {
        throw new Error("The source changed while reading.")
    })
    try {
        await flush(failed.root)
        expect(failed.container.querySelector("[role=alert]")?.textContent).toBe("The source changed while reading.")
    } finally {
        failed.dispose()
    }
})

test("picture files keep rename and mode notices but drop Git's binary and filter notices", async () => {
    let { isComparableImage, visibleSummary } = await import("../src/renderer/src/inspection/image-diff")
    expect(isComparableImage({ path: "icon.png", status: "modified" })).toBe(true)
    expect(isComparableImage({ path: "icon.png", status: "renamed" })).toBe(true)
    expect(isComparableImage({ path: "icon.png", status: "added" })).toBe(false)
    expect(isComparableImage({ path: "icon.png", status: "deleted" })).toBe(false)
    expect(isComparableImage({ path: "icon.svg", status: "modified" })).toBe(false)
    let notices = [
        "Renamed old.png → icon.png",
        "Binary content changed.",
        "Binary or custom-filter file. Text conversion and external diff programs are disabled.",
        "Git filters or encoding conversion apply. Line composition is unavailable.",
    ]
    expect(visibleSummary({ ...imagePage("icon.png"), summary: notices })).toEqual(["Renamed old.png → icon.png"])
    expect(visibleSummary({ ...imagePage("icon.svg"), summary: notices })).toEqual(notices)
})

function imagePage(path: string): FileDiffPage {
    let { page } = inspectionScenario()
    return { ...page, file: { ...page.file, path }, lines: [], summary: ["Binary content changed."], selectable: false }
}

function render(
    page: FileDiffPage,
    read: (page: FileDiffPage, signal: AbortSignal, fetchLfs?: boolean) => Promise<FileImagePage>,
    mode: ImageDiffMode = "side-by-side",
) {
    let container = document.createElement("div")
    document.body.append(container)
    let root = createRoot(container)
    root.render(createElement(ImageDiff, { page, mode, read }))
    root.flush()
    return {
        container,
        root,
        read,
        // The mode comes from the file's toolbar, so the test re-renders with it like the inspector does.
        mode(chosen: ImageDiffMode) {
            root.render(createElement(ImageDiff, { page, mode: chosen, read }))
        },
        dispose() {
            root.dispose()
            container.remove()
        },
    }
}

async function flush(root: VirtualRoot) {
    for (let index = 0; index < 4; index++) {
        await new Promise(resolve => setTimeout(resolve, 0))
        root.flush()
    }
}

function click(element: HTMLElement) {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

function zoomButton(dialog: HTMLElement, label: string) {
    let result = dialog.querySelector<HTMLButtonElement>(`[aria-label='${label}']`)
    if (!result)
        throw new Error(`Zoom button not found: ${label}`)
    return result
}

function button(container: HTMLElement, label: string) {
    let result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent?.trim() == label)
    if (!result)
        throw new Error(`Button not found: ${label}. Rendered: ${container.textContent}`)
    return result
}
