import type { FileDiffPage, FileImagePage, ImageContent } from "@laneway/shared"
import { css, type Handle, on } from "remix/ui"

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

let modes: { mode: ImageDiffMode; label: string }[] = [{ mode: "side-by-side", label: "Side by side" }, { mode: "swipe", label: "Swipe" }, {
    mode: "onion",
    label: "Onion skin",
}, { mode: "difference", label: "Difference" }]

// Remembered for the session so every changed image opens in the last chosen mode.
let preferredMode: ImageDiffMode = "side-by-side"

// Git's notices about binary content and LFS filters only say that text tools do not apply, which the pictures make obvious.
let binaryNotices = new Set([
    "Binary content changed.",
    "Binary or custom-filter file. Text conversion and external diff programs are disabled.",
    "Git filters or encoding conversion apply. Line composition is unavailable.",
])

/** Files shown as pictures instead of text lines. SVG keeps its text diff. */
export function isImagePath(path: string) {
    return extension(path) in mimeTypes
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

interface Side {
    content?: ImageContent
    url?: string
    width?: number
    height?: number
    failed?: boolean
}

export function ImageDiff(
    handle: Handle<{
        page: FileDiffPage
        read(page: FileDiffPage, signal: AbortSignal, fetchLfs?: boolean): Promise<FileImagePage>
    }>,
) {
    let loaded: string | undefined
    let reading: AbortController | undefined
    let image: FileImagePage | undefined
    let error: string | undefined
    let sides = { old: {} as Side, new: {} as Side }
    let mode = preferredMode
    let position = 0.5
    let opacity = 0.5
    handle.signal.addEventListener("abort", () => {
        reading?.abort()
        release()
    })

    return () => {
        let { page } = handle.props
        let key = JSON.stringify([page.source, page.file.path, page.view, page.version])
        if (loaded != key) {
            loaded = key
            handle.queueTask(() => load(page))
        }

        let comparable = image?.old && image.new && [sides.old, sides.new].every(side => side.url && !side.failed)
        let shown = comparable ? mode : "side-by-side"
        return (
            <div class="image-diff" mix={imageDiff}>
                {error && <p role="alert" mix={notice}>{error}</p>}
                {!image && !error && <p role="status" mix={notice}>Reading images…</p>}
                {comparable && (
                    <div class="image-modes" role="group" aria-label="Image comparison" mix={modeBar}>
                        {modes.map(choice => (
                            <button
                                type="button"
                                aria-pressed={mode == choice.mode}
                                mix={[
                                    modeButton,
                                    on("click", () => {
                                        mode = preferredMode = choice.mode
                                        handle.update()
                                    }),
                                ]}
                            >
                                {choice.label}
                            </button>
                        ))}
                        {shown == "swipe" && (
                            <button
                                type="button"
                                aria-label={position > 0.5 ? "Show new image" : "Show old image"}
                                mix={[
                                    modeButton,
                                    on("click", () => {
                                        position = position > 0.5 ? 0 : 1
                                        handle.update()
                                    }),
                                ]}
                            >
                                {position > 0.5 ? "Show new" : "Show old"}
                            </button>
                        )}
                        {shown == "onion" && (
                            <label mix={sliderLabel}>
                                Fade
                                <input
                                    type="range"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                    value={String(opacity)}
                                    aria-label="New image opacity"
                                    mix={on("input", event => {
                                        opacity = Number(event.currentTarget.value)
                                        handle.update()
                                    })}
                                />
                            </label>
                        )}
                    </div>
                )}
                {image && (shown == "side-by-side" ? renderSideBySide(image) : renderStacked(shown))}
            </div>
        )
    }

    function renderSideBySide(page: FileImagePage) {
        let both = page.old && page.new
        return (
            <div class="image-sides" style={{ gridTemplateColumns: both ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)" }} mix={sideBySide}>
                {page.old && renderFigure(sides.old, both ? "Old" : undefined)}
                {page.new && renderFigure(sides.new, both ? "New" : undefined)}
            </div>
        )
    }

    function renderFigure(side: Side, title?: string) {
        return (
            <figure mix={figure}>
                {renderImage(side, title ?? "Image")}
                <figcaption mix={caption}>{title ? `${title} · ${describe(side)}` : describe(side)}</figcaption>
            </figure>
        )
    }

    function renderImage(side: Side, alt: string) {
        let content = side.content
        if (content?.state == "unavailable")
            return <div class="image-unavailable" mix={unavailable}>{content.reason}</div>
        else if (content?.state == "lfs")
            return <div class="image-downloading" role="status" mix={unavailable}>Downloading from Git LFS…</div>
        else if (side.failed)
            return <div class="image-unavailable" mix={unavailable}>Could not display this image.</div>
        else
            return <img src={side.url} alt={alt} mix={picture} />
    }

    function renderStacked(shown: Exclude<ImageDiffMode, "side-by-side">) {
        let known = [sides.old, sides.new].every(side => side.width && side.height)
        let widest = Math.max(sides.old.width ?? 0, sides.new.width ?? 0)
        let tallest = Math.max(sides.old.height ?? 0, sides.new.height ?? 0)
        let span = (side: Side) => known ? `${side.width! / widest * 100}%` : "100%"
        let overlay = shown == "swipe"
            ? { clipPath: `inset(0 0 0 ${position * 100}%)` }
            : shown == "onion"
            ? { opacity: String(opacity) }
            : { mixBlendMode: "difference" }

        return (
            <div class="image-stacked" mix={stacked}>
                <div
                    class={`image-stage ${shown}`}
                    tabIndex={shown == "swipe" ? 0 : undefined}
                    aria-label={shown == "swipe" ? "Swipe between old and new image" : undefined}
                    style={known ? { width: `${widest}px`, aspectRatio: `${widest} / ${tallest}` } : {}}
                    mix={[
                        stage,
                        on("pointerdown", event => {
                            if (shown == "swipe") {
                                event.currentTarget.setPointerCapture(event.pointerId)
                                swipeTo(event)
                            }
                        }),
                        on("pointermove", event => {
                            if (shown == "swipe" && event.buttons & 1)
                                swipeTo(event)
                        }),
                        on("keydown", event => {
                            let step = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 }[event.key]
                            if (shown == "swipe" && step != undefined) {
                                event.preventDefault()
                                position = Math.min(1, Math.max(0, position + step))
                                handle.update()
                            }
                        }),
                    ]}
                >
                    <img src={sides.old.url} alt="Old image" style={known ? { width: span(sides.old) } : { position: "static" }} mix={layer} />
                    <img src={sides.new.url} alt="New image" style={{ width: span(sides.new), ...overlay }} mix={layer} />
                    {shown == "swipe" && <div class="image-divider" style={{ left: `${position * 100}%` }} mix={divider} />}
                </div>
                <p mix={caption}>Old · {describe(sides.old)} → New · {describe(sides.new)}</p>
            </div>
        )
    }

    function swipeTo(event: PointerEvent & { currentTarget: HTMLElement }) {
        let bounds = event.currentTarget.getBoundingClientRect()
        position = bounds.width ? Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)) : position
        handle.update()
    }

    function load(page: FileDiffPage) {
        reading?.abort()
        release()
        let controller = reading = new AbortController()
        image = undefined
        error = undefined
        void show(page, controller.signal, false)
    }

    // The first read stays offline. Pointers whose objects are not local show a download placeholder while a
    // second read fetches them through Git LFS.
    async function show(page: FileDiffPage, signal: AbortSignal, fetchLfs: boolean) {
        try {
            let result = await handle.props.read(page, signal, fetchLfs)
            if (!signal.aborted) {
                image = result
                release()
                sides = {
                    old: objectSide(result.old, page.file.oldPath ?? page.file.path),
                    new: objectSide(result.new, page.file.path),
                }
                handle.update()
                await Promise.all([measure(sides.old), measure(sides.new)])
                handle.update()
                if (!fetchLfs && [result.old, result.new].some(side => side?.state == "lfs"))
                    await show(page, signal, true)
            }
        } catch (failure) {
            if (!signal.aborted) {
                let message = failure instanceof Error ? failure.message : String(failure)
                if (fetchLfs) {
                    for (let side of [sides.old, sides.new]) {
                        if (side.content?.state == "lfs")
                            side.content = { state: "unavailable", reason: message }
                    }
                } else {
                    error = message
                }
                handle.update()
            }
        }
    }

    function release() {
        for (let side of [sides.old, sides.new]) {
            if (side.url)
                URL.revokeObjectURL(side.url)
        }
        sides = { old: {}, new: {} }
    }
}

function objectSide(content: ImageContent | undefined, path: string): Side {
    return content?.state == "ready"
        ? { content, url: URL.createObjectURL(new Blob([content.bytes as BlobPart], { type: mimeTypes[extension(path)] })) }
        : { content }
}

// Natural sizes decide how the stacked modes scale both images together. A picture that cannot decode is reported
// in place rather than left as a broken image.
async function measure(side: Side) {
    if (side.url) {
        let probe = new Image()
        probe.src = side.url
        try {
            await probe.decode()
            side.width = probe.naturalWidth
            side.height = probe.naturalHeight
        } catch {
            side.failed = true
        }
    }
}

function describe(side: Side) {
    let content = side.content
    if (content?.state == "lfs")
        return `downloading · ${formatBytes(content.size)}`
    if (content?.state != "ready")
        return "unavailable"

    let size = formatBytes(content.size)
    return side.width && side.height ? `${side.width} × ${side.height} · ${size}` : size
}

function formatBytes(bytes: number) {
    if (bytes < 1024)
        return `${bytes} B`
    else if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`
    else
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extension(path: string) {
    let dot = path.lastIndexOf(".")
    return dot < 0 ? "" : path.slice(dot + 1).toLowerCase()
}

let checkerboard = {
    backgroundColor: "var(--panel)",
    backgroundImage: "linear-gradient(45deg, var(--line) 25%, transparent 25%, transparent 75%, var(--line) 75%),"
        + " linear-gradient(45deg, var(--line) 25%, transparent 25%, transparent 75%, var(--line) 75%)",
    backgroundSize: "16px 16px",
    backgroundPosition: "0 0, 8px 8px",
}

let imageDiff = css({ padding: "4px 10px 10px" })

let notice = css({ margin: 0, padding: "4px 0", color: "var(--muted)", fontSize: "12px" })

let modeBar = css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px", padding: "4px 0 8px" })

let modeButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    fontSize: "11px",
    '&[aria-pressed="true"]': { background: "var(--accent-wash-strong)", borderColor: "var(--accent-edge)" },
    "&:hover": { background: "var(--control-hover)" },
})

let sliderLabel = css({ display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "4px", fontSize: "11px", color: "var(--muted)" })

// A two-row grid keeps both captions on one line even when the pictures differ in height.
let sideBySide = css({ display: "grid", gridAutoFlow: "column", gridTemplateRows: "auto auto", gap: "0 10px", alignItems: "end" })

let figure = css({ display: "contents" })

let picture = css({ ...checkerboard, display: "block", maxWidth: "100%", height: "auto", border: "1px solid var(--line)" })

let unavailable = css({
    alignSelf: "stretch",
    padding: "16px",
    border: "1px dashed var(--line-strong)",
    borderRadius: "4px",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
})

let caption = css({ margin: 0, padding: "4px 0 0", color: "var(--muted)", fontSize: "11px", overflowWrap: "anywhere" })

let stacked = css({ maxWidth: "100%" })

let stage = css({
    ...checkerboard,
    position: "relative",
    // The stage is sized from the pictures' natural dimensions, which its border must not eat into.
    boxSizing: "content-box",
    maxWidth: "100%",
    border: "1px solid var(--line)",
    overflow: "hidden",
    "&.swipe": { cursor: "col-resize", touchAction: "none" },
    "&.difference": { backgroundImage: "none", backgroundColor: "#000" },
    "&:focus-visible": { outline: "2px solid var(--focus)" },
})

let layer = css({ position: "absolute", top: 0, left: 0, display: "block", height: "auto", maxWidth: "100%", pointerEvents: "none", userSelect: "none" })

let divider = css({
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "2px",
    marginLeft: "-1px",
    background: "var(--accent)",
    boxShadow: "0 0 0 1px rgb(0 0 0 / 40%)",
    pointerEvents: "none",
})
