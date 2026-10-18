import type { ChangedFile, FileDiffPage, FileImagePage } from "@laneway/shared"

// Pure helpers from the Remix renderer's `inspection/image-diff.tsx`, which can't be imported here because it
// styles itself through Remix as it loads.

export type ImageDiffMode = "side-by-side" | "swipe" | "onion" | "difference"

// Every raster format Chromium can decode. TIFF, HEIC, and JPEG XL are not among them.
let mimeTypes: Record<string, string> = {
    png: "image/png",
    apng: "image/apng",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    jfif: "image/jpeg",
    pjpeg: "image/jpeg",
    pjp: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    dib: "image/bmp",
    ico: "image/x-icon",
    cur: "image/x-icon",
    avif: "image/avif",
}

export let imageModes: { mode: ImageDiffMode; label: string }[] = [{ mode: "side-by-side", label: "Side by side" }, { mode: "swipe", label: "Swipe" }, {
    mode: "onion",
    label: "Onion skin",
}, { mode: "difference", label: "Difference" }]

// Remembered for the session, so every changed picture opens in the last chosen mode.
let preferredMode: ImageDiffMode = "side-by-side"

export function preferredImageMode() {
    return preferredMode
}

export function rememberImageMode(mode: ImageDiffMode) {
    preferredMode = mode
}

// Git's notices about binary content and LFS filters only say that text tools don't apply, which the pictures make obvious.
let binaryNotices = new Set([
    "Binary content changed.",
    "Binary or custom-filter file. Text conversion and external diff programs are disabled.",
    "Git filters or encoding conversion apply. Line composition is unavailable.",
])

/** Files shown as pictures instead of text lines. SVG keeps its text diff. */
export function isImagePath(path: string) {
    return extension(path) in mimeTypes
}

export function imageMimeType(path: string) {
    return mimeTypes[extension(path)]
}

/** Whether a changed picture has an old and a new version to compare, as far as its status can tell. */
export function isComparableImage(file: Pick<ChangedFile, "path" | "status">) {
    return isImagePath(file.path) && file.status != "added" && file.status != "deleted"
}

/** The diff notices still worth showing above a file's pictures, such as renames and mode changes. */
export function visibleSummary(page: FileDiffPage) {
    return isImagePath(page.file.path) ? page.summary.filter(text => !binaryNotices.has(text)) : page.summary
}

export async function readDiffImage(
    api: Pick<Window["laneway"], "readFileImage" | "cancelInspection">,
    repositoryId: string,
    page: FileDiffPage,
    signal: AbortSignal,
    fetchLfs = false,
): Promise<FileImagePage> {
    let requestId = `diff-image:${crypto.randomUUID()}`
    let cancel = () => void api.cancelInspection(repositoryId, requestId)
    signal.addEventListener("abort", cancel, { once: true })
    try {
        signal.throwIfAborted()
        let result = await api.readFileImage(repositoryId, requestId, { source: page.source, path: page.file.path, view: page.view, fetchLfs })
        signal.throwIfAborted()
        if (!result.ok)
            throw new Error(result.error.message)
        return result.page
    } finally {
        signal.removeEventListener("abort", cancel)
    }
}

function extension(path: string) {
    let dot = path.lastIndexOf(".")
    return dot < 0 ? "" : path.slice(dot + 1).toLowerCase()
}
