import type { FileDiffPage, FileImagePage, ImageContent } from "@laneway/shared"
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useEffectEvent, useState } from "react"
import { Button as AriaButton, ToggleButton } from "react-aria-components"
import { CloseIcon, MaximizeIcon } from "./icons"
import { type ImageDiffMode, imageMimeType } from "./image-files"
import { Dialog } from "./ui/Dialog"
import { Modal } from "./ui/Modal"

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

interface ImageDiffProps {
    page: FileDiffPage
    mode: ImageDiffMode
    read(page: FileDiffPage, signal: AbortSignal, fetchLfs?: boolean): Promise<FileImagePage>
}

/** Which pictures a page shows; a page read again at the same version keeps them. */
export function imageKey(page: FileDiffPage) {
    return JSON.stringify([page.source, page.file.path, page.view, page.version])
}

/**
 * A changed picture's old and new versions: side by side, or stacked to swipe between, fade, or show their
 * difference. Either version, or the comparison, enlarges to fill the window. Key it by `imageKey`, so another
 * page's pictures start afresh.
 */
export function ImageDiff({ page, mode, read }: ImageDiffProps) {
    let [loaded, setLoaded] = useState<{ image?: FileImagePage; sides: { old: Side; new: Side }; error?: string }>({ sides: { old: {}, new: {} } })
    let [position, setPosition] = useState(0.5)
    let [opacity, setOpacity] = useState(0.5)
    let [viewer, setViewer] = useState<Viewer>()
    let [zoom, setZoom] = useState<Zoom>("fit")
    let current = useEffectEvent(() => ({ page, read }))

    // The first read stays offline. Pointers whose objects aren't local show a download placeholder while a second
    // read fetches them through Git LFS.
    useEffect(() => {
        let controller = new AbortController()
        let urls: string[] = []
        let { page, read } = current()
        let show = async (fetchLfs: boolean) => {
            try {
                let result = await read(page, controller.signal, fetchLfs)
                if (controller.signal.aborted)
                    return
                let sides = { old: objectSide(result.old, page.file.oldPath ?? page.file.path), new: objectSide(result.new, page.file.path) }
                urls.push(...[sides.old.url, sides.new.url].filter(url => url != undefined))
                setLoaded({ image: result, sides })
                await Promise.all([measure(sides.old), measure(sides.new)])
                if (controller.signal.aborted)
                    return
                setLoaded({ image: result, sides: { old: { ...sides.old }, new: { ...sides.new } } })
                if (!fetchLfs && [result.old, result.new].some(side => side?.state == "lfs"))
                    await show(true)
            } catch (failure) {
                if (controller.signal.aborted)
                    return
                let message = failure instanceof Error ? failure.message : String(failure)
                setLoaded(current =>
                    fetchLfs
                        ? { ...current, sides: { old: unfetched(current.sides.old, message), new: unfetched(current.sides.new, message) } }
                        : { ...current, error: message }
                )
            }
        }
        void show(false)
        return () => {
            controller.abort()
            for (let url of urls)
                URL.revokeObjectURL(url)
        }
    }, [])

    let { image, sides, error } = loaded
    let comparable = image?.old && image.new && [sides.old, sides.new].every(side => side.url && !side.failed)
    let shown = comparable ? mode : "side-by-side"

    let renderImage = (side: Side, alt: string, enlarge: () => void) => {
        let content = side.content
        if (content?.state == "unavailable")
            return <div className="image-unavailable">{content.reason}</div>
        if (content?.state == "lfs")
            return <div className="image-unavailable" role="status">Downloading from Git LFS…</div>
        if (side.failed)
            return <div className="image-unavailable">Could not display this image.</div>
        return (
            <AriaButton className="image-enlarge" aria-label={`Enlarge ${alt.toLowerCase()}`} onPress={enlarge}>
                <img className="image-picture" src={side.url} alt={alt} />
            </AriaButton>
        )
    }

    let renderFigure = (which: "old" | "new", title?: string) => (
        <figure key={which} className="image-figure">
            {renderImage(sides[which], title ?? "Image", () => setViewer({ kind: "single", side: which }))}
            <figcaption className="image-caption">{title ? `${title} · ${describe(sides[which])}` : describe(sides[which])}</figcaption>
        </figure>
    )

    // The stage is sized from the pictures' natural dimensions so both layers scale together. Enlarged, it either
    // fits the window or shows every pixel and scrolls.
    let renderStage = (stacked: Exclude<ImageDiffMode, "side-by-side">, enlarged?: Zoom) => {
        let known = [sides.old, sides.new].every(side => side.width && side.height)
        let widest = Math.max(sides.old.width ?? 0, sides.new.width ?? 0)
        let tallest = Math.max(sides.old.height ?? 0, sides.new.height ?? 0)
        let span = (side: Side) => known ? `${side.width! / widest * 100}%` : "100%"
        let overlay: CSSProperties = stacked == "swipe"
            ? { clipPath: `inset(0 0 0 ${position * 100}%)` }
            : stacked == "onion"
            ? { opacity }
            : { mixBlendMode: "difference" }
        let width = enlarged == "fit" ? `min(${widest}px, calc(100% - 2px), calc(var(--viewer-height) * ${widest / tallest}))` : `${widest}px`
        let size: CSSProperties = known ? { width, aspectRatio: `${widest} / ${tallest}`, ...(enlarged == "actual" ? { maxWidth: "none" } : {}) } : {}
        let clickable = stacked != "swipe" && !enlarged
        let swipeTo = (event: PointerEvent<HTMLDivElement>) => {
            let bounds = event.currentTarget.getBoundingClientRect()
            if (bounds.width)
                setPosition(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)))
        }
        return (
            <div
                className={`image-stage ${stacked}`}
                tabIndex={stacked == "swipe" || clickable ? 0 : undefined}
                role={clickable ? "button" : undefined}
                aria-label={stacked == "swipe" ? "Swipe between old and new image" : clickable ? "Enlarge comparison" : undefined}
                title={clickable ? "Enlarge" : undefined}
                style={size}
                onPointerDown={event => {
                    if (stacked == "swipe") {
                        event.currentTarget.setPointerCapture(event.pointerId)
                        swipeTo(event)
                    }
                }}
                onPointerMove={event => {
                    if (stacked == "swipe" && event.buttons & 1)
                        swipeTo(event)
                }}
                onClick={() => {
                    if (clickable)
                        setViewer({ kind: "stacked" })
                }}
                onKeyDown={(event: KeyboardEvent) => {
                    let step = ({ ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 } as Record<string, number>)[event.key]
                    if (stacked == "swipe" && step != undefined) {
                        event.preventDefault()
                        setPosition(current => Math.min(1, Math.max(0, current + step)))
                    } else if (clickable && (event.key == "Enter" || event.key == " ")) {
                        event.preventDefault()
                        setViewer({ kind: "stacked" })
                    }
                }}
            >
                <img className="image-layer" src={sides.old.url} alt="Old image" style={known ? { width: span(sides.old) } : { position: "static" }} />
                <img className="image-layer" src={sides.new.url} alt="New image" style={{ width: span(sides.new), ...overlay }} />
                {stacked == "swipe" && <div className="image-divider" style={{ left: `${position * 100}%` }} />}
            </div>
        )
    }

    let both = image?.old && image.new
    let single = viewer?.kind == "single" ? viewer.side : undefined
    let viewed = single ? sides[single] : undefined
    let viewerTitle = single
        ? `${both ? `${single == "old" ? "Old" : "New"} · ` : ""}${describe(viewed!)}`
        : `Old · ${describe(sides.old)} → New · ${describe(sides.new)}`

    return (
        <div className="image-diff">
            {error && <p className="image-notice" role="alert">{error}</p>}
            {!image && !error && <p className="image-notice" role="status">Reading images…</p>}
            {comparable && shown != "side-by-side" && (
                <div className="image-tools" role="group" aria-label="Image comparison">
                    {shown == "swipe" && (
                        <AriaButton
                            className="image-tool"
                            aria-label={position > 0.5 ? "Show new image" : "Show old image"}
                            onPress={() => setPosition(position > 0.5 ? 0 : 1)}
                        >
                            {position > 0.5 ? "Show new" : "Show old"}
                        </AriaButton>
                    )}
                    {shown == "onion" && (
                        <label className="image-fade">
                            Fade
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={String(opacity)}
                                aria-label="New image opacity"
                                onChange={event => setOpacity(Number(event.currentTarget.value))}
                            />
                        </label>
                    )}
                    <AriaButton className="icon-button small" aria-label="Enlarge comparison" onPress={() => setViewer({ kind: "stacked" })}>
                        <MaximizeIcon />
                    </AriaButton>
                </div>
            )}
            {image && (shown == "side-by-side"
                ? (
                    // A two-row grid keeps both captions on one line even when the pictures differ in height.
                    <div className={both ? "image-sides both" : "image-sides"}>
                        {image.old && renderFigure("old", both ? "Old" : undefined)}
                        {image.new && renderFigure("new", both ? "New" : undefined)}
                    </div>
                )
                : (
                    <div className="image-stacked">
                        {renderStage(shown)}
                        <p className="image-caption">Old · {describe(sides.old)} → New · {describe(sides.new)}</p>
                    </div>
                ))}
            <Modal
                isOpen={viewer != undefined}
                isDismissable
                onOpenChange={open => open || setViewer(undefined)}
                className="react-aria-Modal image-viewer-modal"
            >
                <Dialog className="react-aria-Dialog image-viewer" aria-label={`${page.file.path} enlarged`}>
                    <header className="image-viewer-bar">
                        <span className="image-viewer-title" title={page.file.path}>{page.file.path}</span>
                        <span className="image-viewer-caption">{viewerTitle}</span>
                        {single && both && (
                            <div className="image-viewer-group" role="group" aria-label="Version">
                                {(["old", "new"] as const).map(which => (
                                    <ToggleButton
                                        key={which}
                                        className="image-tool"
                                        isSelected={single == which}
                                        onChange={() => setViewer({ kind: "single", side: which })}
                                    >
                                        {which == "old" ? "Old" : "New"}
                                    </ToggleButton>
                                ))}
                            </div>
                        )}
                        <div className="image-viewer-group" role="group" aria-label="Zoom">
                            {([["fit", "Fit to window"], ["actual", "Actual size"]] as const).map(([choice, label]) => (
                                <ToggleButton
                                    key={choice}
                                    className="icon-button small"
                                    aria-label={label}
                                    isSelected={zoom == choice}
                                    onChange={() => setZoom(choice)}
                                >
                                    <ZoomIcon zoom={choice} />
                                </ToggleButton>
                            ))}
                        </div>
                        <AriaButton className="icon-button small" aria-label="Close" slot="close">
                            <CloseIcon />
                        </AriaButton>
                    </header>
                    <div className="image-viewer-body">
                        {single
                            ? viewed?.url && !viewed.failed
                                ? <img className={`image-picture image-viewed ${zoom}`} src={viewed.url} alt={`${single == "old" ? "Old" : "New"} image`} />
                                : <div className="image-unavailable">Could not display this image.</div>
                            : shown == "side-by-side"
                            ? <div className="image-unavailable">Could not display this comparison.</div>
                            : renderStage(shown, zoom)}
                    </div>
                </Dialog>
            </Modal>
        </div>
    )
}

// Corner brackets closing in on a picture, and a 1:1 ratio for every pixel.
function ZoomIcon({ zoom }: { zoom: Zoom }) {
    return (
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
            <path d={zoom == "fit" ? "M5.5 2H2v3.5M10.5 2H14v3.5M2 10.5V14h3.5M14 10.5V14h-3.5M5 5.5h6v5H5z" : "M3 5l2-2v10M11 5l2-2v10M8 6.5v.01M8 9.5v.01"} />
        </svg>
    )
}

function objectSide(content: ImageContent | undefined, path: string): Side {
    return content?.state == "ready"
        ? { content, url: URL.createObjectURL(new Blob([content.bytes as BlobPart], { type: imageMimeType(path) })) }
        : { content }
}

function unfetched(side: Side, reason: string): Side {
    return side.content?.state == "lfs" ? { ...side, content: { state: "unavailable", reason } } : side
}

// Natural sizes decide how the stacked modes scale both pictures together. A picture that can't decode is reported
// in place rather than left as a broken image.
async function measure(side: Side) {
    if (!side.url)
        return
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
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
