import type { ChangedFile, FileDiffPage, FileImagePage, ImageContent } from "@laneway/shared"
import { css, type Handle, on, ref } from "remix/ui"
import { Icon } from "../icons"

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

// Remembered for the session so every changed image opens in the last chosen mode.
let preferredMode: ImageDiffMode = "side-by-side"

export function preferredImageMode() {
    return preferredMode
}

export function rememberImageMode(mode: ImageDiffMode) {
    preferredMode = mode
}

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

interface Side {
    content?: ImageContent
    url?: string
    width?: number
    height?: number
    failed?: boolean
}

type Zoom = "fit" | "actual"

/** What the enlarged viewer shows: one version on its own, or the current stacked comparison. */
type Viewer = { kind: "single"; side: "old" | "new" } | { kind: "stacked" }

export function ImageDiff(
    handle: Handle<{
        page: FileDiffPage
        mode: ImageDiffMode
        read(page: FileDiffPage, signal: AbortSignal, fetchLfs?: boolean): Promise<FileImagePage>
    }>,
) {
    let loaded: string | undefined
    let reading: AbortController | undefined
    let image: FileImagePage | undefined
    let error: string | undefined
    let sides = { old: {} as Side, new: {} as Side }
    let position = 0.5
    let opacity = 0.5
    let viewer: Viewer | undefined
    let zoom: Zoom = "fit"
    handle.signal.addEventListener("abort", () => {
        reading?.abort()
        release()
    })

    return () => {
        let { page, mode } = handle.props
        let key = JSON.stringify([page.source, page.file.path, page.view, page.version])
        if (loaded != key) {
            loaded = key
            viewer = undefined
            handle.queueTask(() => load(page))
        }

        let comparable = image?.old && image.new && [sides.old, sides.new].every(side => side.url && !side.failed)
        let shown = comparable ? mode : "side-by-side"
        return (
            <div class="image-diff" mix={imageDiff}>
                {error && <p role="alert" mix={notice}>{error}</p>}
                {!image && !error && <p role="status" mix={notice}>Reading images…</p>}
                {comparable && shown != "side-by-side" && (
                    <div class="image-tools" role="group" aria-label="Image comparison" mix={toolBar}>
                        {shown == "swipe" && (
                            <button
                                type="button"
                                aria-label={position > 0.5 ? "Show new image" : "Show old image"}
                                mix={[
                                    toolButton,
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
                        <button type="button" aria-label="Enlarge comparison" title="Enlarge" mix={[toolButton, on("click", () => open({ kind: "stacked" }))]}>
                            <Icon name="maximize" size={13} />
                        </button>
                    </div>
                )}
                {image && (shown == "side-by-side" ? renderSideBySide(image) : renderStacked(shown))}
                {viewer && renderViewer(viewer, shown)}
            </div>
        )
    }

    function renderSideBySide(page: FileImagePage) {
        let both = page.old && page.new
        return (
            <div class="image-sides" style={{ gridTemplateColumns: both ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)" }} mix={sideBySide}>
                {page.old && renderFigure("old", both ? "Old" : undefined)}
                {page.new && renderFigure("new", both ? "New" : undefined)}
            </div>
        )
    }

    function renderFigure(which: "old" | "new", title?: string) {
        let side = sides[which]
        return (
            <figure mix={figure}>
                {renderImage(side, title ?? "Image", () => open({ kind: "single", side: which }))}
                <figcaption mix={caption}>{title ? `${title} · ${describe(side)}` : describe(side)}</figcaption>
            </figure>
        )
    }

    function renderImage(side: Side, alt: string, enlarge: () => void) {
        let content = side.content
        if (content?.state == "unavailable")
            return <div class="image-unavailable" mix={unavailable}>{content.reason}</div>
        else if (content?.state == "lfs")
            return <div class="image-downloading" role="status" mix={unavailable}>Downloading from Git LFS…</div>
        else if (side.failed)
            return <div class="image-unavailable" mix={unavailable}>Could not display this image.</div>
        else {
            return (
                <button type="button" aria-label={`Enlarge ${alt.toLowerCase()}`} title="Enlarge" mix={[enlargeButton, on("click", enlarge)]}>
                    <img src={side.url} alt={alt} mix={picture} />
                </button>
            )
        }
    }

    function renderStacked(shown: Exclude<ImageDiffMode, "side-by-side">) {
        return (
            <div class="image-stacked" mix={stacked}>
                {renderStage(shown)}
                <p mix={caption}>Old · {describe(sides.old)} → New · {describe(sides.new)}</p>
            </div>
        )
    }

    // The stage is sized from the pictures' natural dimensions so both layers scale together. Enlarged, it either
    // fits the window or shows every pixel and scrolls.
    function renderStage(shown: Exclude<ImageDiffMode, "side-by-side">, enlarged?: Zoom) {
        let known = [sides.old, sides.new].every(side => side.width && side.height)
        let widest = Math.max(sides.old.width ?? 0, sides.new.width ?? 0)
        let tallest = Math.max(sides.old.height ?? 0, sides.new.height ?? 0)
        let span = (side: Side) => known ? `${side.width! / widest * 100}%` : "100%"
        let overlay = shown == "swipe"
            ? { clipPath: `inset(0 0 0 ${position * 100}%)` }
            : shown == "onion"
            ? { opacity: String(opacity) }
            : { mixBlendMode: "difference" }
        let width = enlarged == "fit" ? `min(${widest}px, calc(100% - 2px), calc(var(--viewer-height) * ${widest / tallest}))` : `${widest}px`
        let size = known ? { width, aspectRatio: `${widest} / ${tallest}`, ...(enlarged == "actual" ? { maxWidth: "none" } : {}) } : {}
        let clickable = shown != "swipe" && !enlarged

        return (
            <div
                class={`image-stage ${shown}`}
                tabIndex={shown == "swipe" || clickable ? 0 : undefined}
                role={clickable ? "button" : undefined}
                aria-label={shown == "swipe" ? "Swipe between old and new image" : clickable ? "Enlarge comparison" : undefined}
                title={clickable ? "Enlarge" : undefined}
                style={size}
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
                    on("click", () => {
                        if (clickable)
                            open({ kind: "stacked" })
                    }),
                    on("keydown", event => {
                        let step = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 }[event.key]
                        if (shown == "swipe" && step != undefined) {
                            event.preventDefault()
                            position = Math.min(1, Math.max(0, position + step))
                            handle.update()
                        } else if (clickable && (event.key == "Enter" || event.key == " ")) {
                            event.preventDefault()
                            open({ kind: "stacked" })
                        }
                    }),
                ]}
            >
                <img src={sides.old.url} alt="Old image" style={known ? { width: span(sides.old) } : { position: "static" }} mix={layer} />
                <img src={sides.new.url} alt="New image" style={{ width: span(sides.new), ...overlay }} mix={layer} />
                {shown == "swipe" && <div class="image-divider" style={{ left: `${position * 100}%` }} mix={divider} />}
            </div>
        )
    }

    function renderViewer(target: Viewer, shown: ImageDiffMode) {
        let { page } = handle.props
        let both = image?.old && image.new
        let single = target.kind == "single" ? target.side : undefined
        let side = single ? sides[single] : undefined
        let title = single
            ? `${both ? `${single == "old" ? "Old" : "New"} · ` : ""}${describe(side!)}`
            : `Old · ${describe(sides.old)} → New · ${describe(sides.new)}`
        return (
            <dialog
                class="image-viewer"
                aria-label={`${page.file.path} enlarged`}
                mix={[
                    viewerDialog,
                    ref(element => element.showModal()),
                    on("close", () => {
                        viewer = undefined
                        handle.update()
                    }),
                ]}
            >
                <header mix={viewerBar}>
                    <span mix={viewerTitle} title={page.file.path}>{page.file.path}</span>
                    <span mix={viewerCaption}>{title}</span>
                    {single && both && (
                        <div role="group" aria-label="Version" mix={viewerGroup}>
                            {(["old", "new"] as const).map(which => (
                                <button
                                    type="button"
                                    aria-pressed={single == which}
                                    mix={[
                                        toolButton,
                                        on("click", () => {
                                            viewer = { kind: "single", side: which }
                                            handle.update()
                                        }),
                                    ]}
                                >
                                    {which == "old" ? "Old" : "New"}
                                </button>
                            ))}
                        </div>
                    )}
                    <div role="group" aria-label="Zoom" mix={viewerGroup}>
                        {([["fit", "Fit to window"], ["actual", "Actual size"]] as const).map(([choice, label]) => (
                            <button
                                type="button"
                                aria-label={label}
                                title={label}
                                aria-pressed={zoom == choice}
                                mix={[
                                    viewerIconButton,
                                    on("click", () => {
                                        zoom = choice
                                        handle.update()
                                    }),
                                ]}
                            >
                                {zoomIcon(choice)}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        aria-label="Close"
                        title="Close"
                        mix={[viewerIconButton, on("click", event => event.currentTarget.closest("dialog")?.close())]}
                    >
                        <Icon name="close" size={14} />
                    </button>
                </header>
                <div class="image-viewer-body" mix={viewerBody}>
                    {single
                        ? side?.url && !side.failed
                            ? <img src={side.url} alt={`${single == "old" ? "Old" : "New"} image`} class={zoom} mix={viewerPicture} />
                            : <div class="image-unavailable" mix={unavailable}>Could not display this image.</div>
                        : shown == "side-by-side"
                        ? <div class="image-unavailable" mix={unavailable}>Could not display this comparison.</div>
                        : renderStage(shown, zoom)}
                </div>
            </dialog>
        )
    }

    function open(target: Viewer) {
        viewer = target
        handle.update()
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

// Corner brackets closing in on a picture, and a 1:1 ratio for every pixel.
function zoomIcon(zoom: Zoom) {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            {zoom == "fit"
                ? <path d="M5.5 2H2v3.5M10.5 2H14v3.5M2 10.5V14h3.5M14 10.5V14h-3.5M5 5.5h6v5H5z" />
                : <path d="M3 5l2-2v10M11 5l2-2v10M8 6.5v.01M8 9.5v.01" />}
        </svg>
    )
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

let toolBar = css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px", padding: "4px 0 8px" })

let toolButton = css({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "22px",
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
    // The viewer's version toggle sits beside its icon buttons and highlights like them.
    ".image-viewer &": { minHeight: "28px", fontSize: "12px", padding: "3px 10px" },
    '.image-viewer &[aria-pressed="true"]': { color: "var(--focus)", background: "var(--focus-wash)", borderColor: "var(--focus-edge)" },
})

let sliderLabel = css({ display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "4px", fontSize: "11px", color: "var(--muted)" })

// A two-row grid keeps both captions on one line even when the pictures differ in height.
let sideBySide = css({ display: "grid", gridAutoFlow: "column", gridTemplateRows: "auto auto", gap: "0 10px", alignItems: "end" })

let figure = css({ display: "contents" })

let enlargeButton = css({
    display: "block",
    maxWidth: "100%",
    padding: 0,
    border: 0,
    background: "transparent",
    cursor: "zoom-in",
    "&:focus-visible": { outline: "2px solid var(--focus)", outlineOffset: "1px" },
})

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
    "&[role=button]": { cursor: "zoom-in" },
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

// The viewer fills the window below the title bar, clear of the window controls; the global dialog sizing is for forms.
let viewerDialog = css({
    "--viewer-bar": "44px",
    "--viewer-top": "calc(env(titlebar-area-height, 0px) + 24px)",
    "--viewer-height": "calc(100vh - var(--viewer-top) - 24px - 2px - var(--viewer-bar) - 32px)",
    width: "calc(100vw - 48px)",
    height: "calc(100vh - var(--viewer-top) - 24px)",
    maxWidth: "none",
    maxHeight: "none",
    boxSizing: "border-box",
    margin: "var(--viewer-top) auto 0",
    padding: 0,
    border: "1px solid var(--line-strong)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-dialog)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    background: "var(--panel-deep)",
    "&:not([open])": { display: "none" },
})

let viewerBar = css({
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "var(--viewer-bar)",
    boxSizing: "border-box",
    padding: "0 10px 0 14px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel)",
    fontSize: "11px",
})

let viewerTitle = css({ font: "600 15px var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 })

let viewerIconButton = css({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    padding: 0,
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    cursor: "pointer",
    '&[aria-pressed="true"]': { color: "var(--focus)", background: "var(--focus-wash)", borderColor: "var(--focus-edge)" },
    "&:hover": { background: "var(--control-hover)" },
})

let viewerCaption = css({ flex: 1, minWidth: 0, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })

let viewerGroup = css({
    display: "inline-flex",
    flexShrink: 0,
    "& > button": { borderRadius: 0 },
    "& > button:first-child": { borderRadius: "3px 0 0 3px" },
    "& > button:last-child": { marginLeft: "-1px", borderRadius: "0 3px 3px 0" },
    '& > button[aria-pressed="true"]': { zIndex: 1 },
    "& > button:focus-visible": { zIndex: 2 },
})

// Pictures centre when they fit and scroll from their top-left corner when they do not.
let viewerBody = css({
    flex: 1,
    minHeight: 0,
    display: "flex",
    overflow: "auto",
    padding: "16px",
    boxSizing: "border-box",
    "& > *": { margin: "auto", flexShrink: 0 },
})

let viewerPicture = css({
    ...checkerboard,
    display: "block",
    boxSizing: "border-box",
    border: "1px solid var(--line)",
    "&.fit": { maxWidth: "100%", maxHeight: "var(--viewer-height)", objectFit: "contain" },
})
