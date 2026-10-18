// Mounts the React image diff with its mode toggle under the production CSP; react-image-diff-electron.test.ts reads the result.
import "../../src/renderer/react/ui/theme.css"
import "../../src/renderer/react/ui/utilities.css"
import "../../src/renderer/react/theme.css"
import "../../src/renderer/react/page.css"
import "../../src/renderer/react/laneway.css"
import type { FileDiffPage, FileImagePage } from "@laneway/shared"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ImageModeToggle } from "../../src/renderer/react/diff-panel"
import { ImageDiff, imageKey } from "../../src/renderer/react/image-diff"
import type { ImageDiffMode } from "../../src/renderer/react/image-files"

interface Images {
    old?: string
    new?: string
}

let page: FileDiffPage = {
    source: { kind: "commit", objectId: "a".repeat(40) },
    file: { path: "art/logo.png", status: "modified", staged: false, unstaged: false, untracked: false, ignored: false, conflicted: false },
    view: "combined",
    version: "0",
    lines: [],
    summary: ["Binary content changed."],
    selectable: false,
}
let root = createRoot(document.getElementById("app")!)
let read: () => Promise<FileImagePage>
let mode: ImageDiffMode = "side-by-side"
Object.assign(window, { mountImageDiff: mount, imageDiffMode: chooseMode, imageDiffChecks: checks, imageViewerChecks: viewerChecks })

function mount(images: Images) {
    let bytes = (encoded?: string) => {
        let decoded = encoded ? Uint8Array.from(atob(encoded), char => char.charCodeAt(0)) : undefined
        return decoded ? { state: "ready" as const, bytes: decoded, size: decoded.length } : undefined
    }
    // Each mount is a new version of the file, so the pictures are read again.
    page = { ...page, version: String(Number(page.version) + 1) }
    read = async () => ({ source: page.source, file: page.file, view: page.view, version: page.version, old: bytes(images.old), new: bytes(images.new) })
    mode = "side-by-side"
    render()
    return settled()
}

// The file's row chooses the mode, as it does in the app.
function render() {
    flushSync(() =>
        root.render(
            <>
                <ImageModeToggle
                    mode={mode}
                    onChange={chosen => {
                        mode = chosen
                        render()
                    }}
                />
                <ImageDiff key={imageKey(page)} page={page} mode={mode} read={read} />
            </>,
        )
    )
}

async function chooseMode(chosen: ImageDiffMode) {
    let label = { "side-by-side": "Side by side", swipe: "Swipe", onion: "Onion skin", difference: "Difference" }[chosen]
    let button = document.querySelector<HTMLButtonElement>(`[aria-label='Image comparison mode'] [aria-label='${label}']`)
    if (!button)
        throw new Error(`Mode not offered: ${label}. Rendered: ${document.body.innerHTML}`)
    button.click()
    await settled()
}

let viewerDialog = () => document.querySelector<HTMLElement>(".image-viewer")

// Opens the new picture enlarged, measuring it at fit and 1:1 against the window.
async function viewerChecks() {
    document.querySelector<HTMLButtonElement>("[aria-label='Enlarge new']")!.click()
    await settled()
    let dialog = viewerDialog()!
    let picture = () => dialog.querySelector<HTMLImageElement>(".image-viewer-body > img")!
    let fit = { open: dialog != null, width: picture().getBoundingClientRect().width, height: picture().getBoundingClientRect().height }
    let button = (label: string) =>
        dialog.querySelector<HTMLButtonElement>(`[aria-label='${label}']`)
            ?? [...dialog.querySelectorAll("button")].find(candidate => candidate.textContent == label)!
    button("Actual size").click()
    await settled()
    let actual = { width: picture().getBoundingClientRect().width, height: picture().getBoundingClientRect().height }
    button("Old").click()
    await settled()
    let old = { width: picture().getBoundingClientRect().width, caption: dialog.querySelector("header")!.textContent }
    button("Close").click()
    await settled()
    let closed = !viewerDialog()

    await chooseMode("onion")
    document.querySelector<HTMLElement>(".image-stage")!.click()
    await settled()
    dialog = viewerDialog()!
    let stage = () => dialog.querySelector<HTMLElement>(".image-viewer-body .image-stage")!
    let kept = stage().getBoundingClientRect().width
    button("Fit to window").click()
    await settled()
    let stacked = { open: dialog != null, kept, width: stage().getBoundingClientRect().width, layers: stage().querySelectorAll("img").length }
    button("Close").click()
    await settled()
    await chooseMode("side-by-side")

    return { window: { width: window.innerWidth, height: window.innerHeight }, fit, actual, old, closed, stacked }
}

async function checks() {
    let pictures = () => [...document.querySelectorAll<HTMLImageElement>(".image-diff img")]
    let decoded = pictures().every(picture => picture.complete && picture.naturalWidth > 0)
    let captions = document.body.innerText

    await chooseMode("swipe")
    let stage = document.querySelector<HTMLElement>(".image-stage")!
    let [old, current] = pictures().map(picture => picture.getBoundingClientRect())
    let swipe = {
        stageWidth: stage.getBoundingClientRect().width,
        oldWidth: old!.width,
        newWidth: current!.width,
        clip: getComputedStyle(pictures()[1]!).clipPath,
        divider: Boolean(document.querySelector(".image-divider")),
    }

    await chooseMode("difference")
    let difference = getComputedStyle(pictures()[1]!).mixBlendMode
    await chooseMode("onion")
    let onion = getComputedStyle(pictures()[1]!).opacity

    return { decoded, captions, swipe, difference, onion }
}

// The kit's dialogs animate, so measurements wait for them to settle.
async function settled() {
    for (let round = 0; round < 10; round++)
        await new Promise(resolve => setTimeout(resolve, 30))
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))
}
