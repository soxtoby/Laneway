import type { FileDiffPage, FileImagePage } from "@laneway/shared"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Window as HappyWindow } from "happy-dom"
import type { createElement as createRemixElement, createRoot as createRemixRoot, VirtualRoot } from "remix/ui"
import type { ImageDiff as ImageDiffComponent } from "../src/renderer/src/inspection/image-diff"
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

test("a changed image compares both versions in the chosen mode, scaled together, and the mode persists", async () => {
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

        click(button(view.container, "Swipe"))
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

        click(button(view.container, "Difference"))
        await flush(view.root)
        expect(view.container.querySelector<HTMLElement>(".image-stage img:last-of-type")!.style.mixBlendMode).toBe("difference")

        view.root.render(createElement(ImageDiff, { page: { ...page, version: "two" }, read }))
        await flush(view.root)
        expect(reads.map(requested => requested.version)).toEqual(["one", "two"])
    } finally {
        view.dispose()
    }

    let again = render(page, read)
    try {
        await flush(again.root)
        expect(button(again.container, "Difference").getAttribute("aria-pressed")).toBe("true")
        click(button(again.container, "Side by side"))
        await flush(again.root)
    } finally {
        again.dispose()
    }
})

test("single versions and unavailable content show without comparison modes", async () => {
    let page = imagePage("added.png")
    let view = render(page, async () => ({ ...page, new: ready(4) }))
    try {
        await flush(view.root)
        expect(view.container.querySelectorAll("img")).toHaveLength(1)
        expect(view.container.querySelector(".image-modes")).toBeNull()
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
    })
    try {
        await flush(pointer.root)
        expect(pointer.container.querySelectorAll("img")).toHaveLength(1)
        expect(pointer.container.querySelector(".image-modes")).toBeNull()
        expect(pointer.container.querySelector("[role=status]")?.textContent).toContain("Downloading from Git LFS")
        expect(pointer.container.textContent).toContain("New · downloading · 1.2 KB")
        expect(requests).toEqual([false, true])
        downloaded()
        await flush(pointer.root)
        expect(pointer.container.querySelectorAll("img")).toHaveLength(2)
        expect(pointer.container.querySelector(".image-modes")).not.toBeNull()
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
    let { visibleSummary } = await import("../src/renderer/src/inspection/image-diff")
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

function render(page: FileDiffPage, read: (page: FileDiffPage, signal: AbortSignal, fetchLfs?: boolean) => Promise<FileImagePage>) {
    let container = document.createElement("div")
    document.body.append(container)
    let root = createRoot(container)
    root.render(createElement(ImageDiff, { page, read }))
    root.flush()
    return {
        container,
        root,
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

function button(container: HTMLElement, label: string) {
    let result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent?.trim() == label)
    if (!result)
        throw new Error(`Button not found: ${label}. Rendered: ${container.textContent}`)
    return result
}
