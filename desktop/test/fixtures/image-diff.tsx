import type { FileDiffPage, FileImagePage } from "@laneway/shared"
import { createRoot } from "remix/ui"
import { ImageDiff, type ImageDiffMode } from "../../src/renderer/src/inspection/image-diff"

interface Images {
    old?: string
    new?: string
}

let page: FileDiffPage = {
    source: { kind: "commit", objectId: "a".repeat(40) },
    file: { path: "art/logo.png", status: "modified", staged: false, unstaged: false, untracked: false, ignored: false, conflicted: false },
    view: "combined",
    version: "one",
    lines: [],
    summary: ["Binary content changed."],
    selectable: false,
}
let root = createRoot(document.getElementById("app")!)
Object.assign(window, { mountImageDiff: mount, imageDiffMode: chooseMode, imageDiffChecks: checks })

function mount(images: Images) {
    let bytes = (encoded?: string) => {
        let decoded = encoded ? Uint8Array.from(atob(encoded), char => char.charCodeAt(0)) : undefined
        return decoded ? { state: "ready" as const, bytes: decoded, size: decoded.length } : undefined
    }
    let read = async (): Promise<FileImagePage> => ({
        source: page.source,
        file: page.file,
        view: page.view,
        version: "one",
        old: bytes(images.old),
        new: bytes(images.new),
    })
    root.render(<ImageDiff page={page} read={read} />)
    return settled()
}

async function chooseMode(mode: ImageDiffMode) {
    let label = { "side-by-side": "Side by side", swipe: "Swipe", onion: "Onion skin", difference: "Difference" }[mode]
    let button = [...document.querySelectorAll("button")].find(candidate => candidate.textContent == label)
    if (!button)
        throw new Error(`Mode not offered: ${label}. Rendered: ${document.body.innerText}`)
    button.click()
    await settled()
}

async function checks() {
    let pictures = () => [...document.querySelectorAll("img")]
    let decoded = pictures().every(picture => picture.complete && picture.naturalWidth > 0)
    let captions = document.body.innerText

    await chooseMode("swipe")
    let stage = document.querySelector<HTMLElement>(".image-stage")!
    let [old, current] = pictures().map(picture => picture.getBoundingClientRect())
    let swipe = {
        stageWidth: stage.getBoundingClientRect().width,
        oldWidth: old.width,
        newWidth: current.width,
        clip: getComputedStyle(pictures()[1]).clipPath,
        divider: Boolean(document.querySelector(".image-divider")),
    }

    await chooseMode("difference")
    let difference = getComputedStyle(pictures()[1]).mixBlendMode
    await chooseMode("onion")
    let onion = getComputedStyle(pictures()[1]).opacity

    return { decoded, captions, swipe, difference, onion }
}

async function settled() {
    for (let round = 0; round < 10; round++) {
        await new Promise(resolve => setTimeout(resolve, 30))
        root.flush()
    }
}
