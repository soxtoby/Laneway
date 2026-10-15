import type { DiffLayout } from "@laneway/shared"
import { css, type Handle, on } from "remix/ui"
import { fileActionButton } from "./file-list"
import { type ImageDiffMode, imageModes } from "./image-diff"

let diffToolbarDiv = css({
    marginLeft: "auto",
    display: "flex",
    gap: "4px",
    flex: "0 0 auto",
})

export function DiffControls(
    handle: Handle<{
        layout: DiffLayout
        showWhitespace: boolean
        showEntireFiles: boolean
        setLayout(layout: DiffLayout): void
        toggleWhitespace(): void
        toggleEntireFiles?(): void
        /** Pictures swap the text layout controls for their comparison modes. */
        image?: ImageControls
        breakout?(): void
    }>,
) {
    return () => {
        let props = handle.props
        if (props.image)
            return renderImageControls(props.image, props.breakout)
        return (
            <div class="diff-controls" mix={diffToolbarDiv}>
                <div class="diff-layout-toggle" role="group" aria-label="Diff layout" mix={diffLayoutToggle}>
                    {(["unified", "split"] as const).map(layout => (
                        <button
                            type="button"
                            aria-label={layout == "unified" ? "Unified" : "Side by side"}
                            title={layout == "unified" ? "Unified" : "Side by side"}
                            aria-pressed={props.layout == layout}
                            mix={[fileActionButton, on("click", () => props.setLayout(layout))]}
                        >
                            {diffIcon(layout)}
                        </button>
                    ))}
                </div>
                {props.toggleEntireFiles && (
                    <button
                        type="button"
                        aria-label="Show entire files"
                        title="Show entire files"
                        aria-pressed={props.showEntireFiles}
                        mix={[fileActionButton, on("click", props.toggleEntireFiles)]}
                    >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">
                            <path d="M9 1.5H3v13h10v-9L9 1.5ZM9 1.5v4h4M5 8h6M5 11h6" />
                        </svg>
                    </button>
                )}
                <button
                    type="button"
                    aria-label="Show whitespace"
                    title="Show whitespace"
                    aria-pressed={props.showWhitespace}
                    mix={[fileActionButton, on("click", props.toggleWhitespace)]}
                >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <path d="M13 2H6a3.5 3.5 0 0 0 0 7h2M8 2v12M11 2v12" />
                    </svg>
                </button>
                {props.breakout && (
                    <button type="button" aria-label="Break out diff" title="Break out diff" mix={[fileActionButton, on("click", props.breakout)]}>
                        {diffIcon("breakout")}
                    </button>
                )}
            </div>
        )
    }
}

export interface ImageControls {
    mode: ImageDiffMode
    /** Added and deleted pictures have nothing to compare, so they offer no modes. */
    comparable: boolean
    setMode(mode: ImageDiffMode): void
}

function renderImageControls(image: ImageControls, breakout?: () => void) {
    return (
        <div class="diff-controls" mix={diffToolbarDiv}>
            {image.comparable && (
                <div class="image-mode-toggle" role="group" aria-label="Image comparison mode" mix={diffLayoutToggle}>
                    {imageModes.map(choice => (
                        <button
                            type="button"
                            aria-label={choice.label}
                            title={choice.label}
                            aria-pressed={image.mode == choice.mode}
                            mix={[fileActionButton, on("click", () => image.setMode(choice.mode))]}
                        >
                            {imageModeIcon(choice.mode)}
                        </button>
                    ))}
                </div>
            )}
            {breakout && (
                <button type="button" aria-label="Break out diff" title="Break out diff" mix={[fileActionButton, on("click", breakout)]}>
                    {diffIcon("breakout")}
                </button>
            )}
        </div>
    )
}

// Solid and outlined shapes stay distinct at toolbar size where thin frames blur together.
function imageModeIcon(mode: ImageDiffMode) {
    let shapes = {
        // A solid picture beside an outlined one.
        "side-by-side": (
            <>
                <path d="M1.5 3h5.5v10H1.5z" fill="currentColor" stroke="none" />
                <path d="M9 3h5.5v10H9z" />
            </>
        ),
        // A picture half revealed by a divider that stretches past its frame.
        swipe: (
            <>
                <path d="M2 3h6v10H2z" fill="currentColor" stroke="none" />
                <path d="M2 3h12v10H2zM8 1v14" />
            </>
        ),
        // An outlined picture laid over a solid one.
        onion: (
            <>
                <path d="M2 2h8v8H2z" fill="currentColor" stroke="none" />
                <path d="M6 6h8v8H6z" />
            </>
        ),
        // Two discs with their overlap picked out.
        difference: (
            <>
                <path d="M8 4.54A4 4 0 0 1 8 11.46A4 4 0 0 1 8 4.54z" fill="currentColor" stroke="none" />
                <path d="M2 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0M6 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0" />
            </>
        ),
    }
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            {shapes[mode]}
        </svg>
    )
}

function diffIcon(kind: "unified" | "split" | "breakout") {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">
            {kind == "breakout"
                ? <path d="M9 2h5v5M14 2 7 9M7 3H2v11h11V9" />
                : (
                    <>
                        <rect x="2" y="2" width="12" height="12" rx="1" />
                        <path d={kind == "split" ? "M8 2v12M4 5h2M10 5h2M4 8h2M10 8h2" : "M4 5h8M4 8h8M4 11h8"} />
                    </>
                )}
        </svg>
    )
}

let diffLayoutToggle = css({
    display: "inline-flex",
    flexShrink: "0",
    "& > button": { position: "relative", borderRadius: "0" },
    "& > button:first-child": { borderRadius: "4px 0 0 4px" },
    "& > button:last-child": { marginLeft: "-1px", borderRadius: "0 4px 4px 0" },
    '& > button[aria-pressed="true"]': { zIndex: "1" },
    "& > button:focus-visible": { zIndex: "2" },
})
