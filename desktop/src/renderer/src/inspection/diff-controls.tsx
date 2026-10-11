import type { DiffLayout } from "@laneway/shared"
import { css, type Handle, on } from "remix/ui"
import { fileActionButton } from "./file-list"

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
        breakout?(): void
    }>,
) {
    return () => {
        let props = handle.props
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
