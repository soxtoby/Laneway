import type { DiffLayout } from "@git-workbench/shared"
import { css, type Handle, on } from "remix/ui"
import { fileActionButton } from "./file-list"

export function DiffControls(
    handle: Handle<{
        layout: DiffLayout
        showWhitespace: boolean
        setLayout(layout: DiffLayout): void
        toggleWhitespace(): void
        breakout?(): void
    }>,
) {
    return () => {
        const props = handle.props
        return (
            <div class="diff-controls" mix={diffToolbarDiv}>
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

const diffToolbarDiv = css({
    marginLeft: "auto",
    display: "flex",
    gap: "4px",
    flex: "0 0 auto",
})
