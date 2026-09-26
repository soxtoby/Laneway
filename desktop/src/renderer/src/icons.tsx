import { type Handle } from "remix/ui"

// 16-unit stroke icons shared across the renderer. Inline SVG keeps the strict CSP intact.
const paths = {
    search: "M2.5 7a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0-9 0M10.3 10.3 14 14",
    pull: "M8 2v9M4.5 7.5 8 11l3.5-3.5M3 14h10",
    stash: "M2 5.5h12V14H2zM2 5.5 3.5 2h9L14 5.5M6 9h4",
    "stash-add": "M2 5.5h12V14H2zM2 5.5 3.5 2h9L14 5.5M8 7.5v4M6 9.5h4",
    undo: "M6 4 2.5 7.5 6 11M2.5 7.5H10a3.25 3.25 0 0 1 0 6.5H8",
    redo: "M10 4l3.5 3.5L10 11M13.5 7.5H6a3.25 3.25 0 0 0 0 6.5h2",
    sun: "M5 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
    moon: "M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z",
    sliders: "M2 4.5h6.5M11.5 4.5H14M2 11.5h1.5M6.5 11.5H14M8.5 4.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3.5 11.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
    refresh: "M13.5 8A5.5 5.5 0 1 1 12 4.1M12.5 1.5v3h-3",
    plus: "M8 3v10M3 8h10",
    minus: "M3 8h10",
    close: "M4 4l8 8M12 4l-8 8",
    "chevron-right": "M6 3l5 5-5 5",
    "chevron-down": "M3 6l5 5 5-5",
    "collapse-left": "M7.5 3 2.5 8l5 5M13.5 3l-5 5 5 5",
    "collapse-right": "M8.5 3l5 5-5 5M2.5 3l5 5-5 5",
    maximize: "M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9",
    restore: "M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14",
    home: "M2 8l6-5.5L14 8M4 6.8v6.7h8V6.8",
    switch: "M2.5 5h10M10 2.5 12.5 5 10 7.5M13.5 11h-10M6 8.5 3.5 11 6 13.5",
    grip: "M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01",
    more:
        "M2.75 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0M6.75 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0M10.75 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0",
    graph: "M2 3a2 2 0 1 0 4 0a2 2 0 1 0-4 0M2 13a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4 5v6M6 9h2a4 4 0 0 0 4-2.2",
    branch: "M4 3v10M4 3a1.5 1.5 0 1 0 0-.01M4 13a1.5 1.5 0 1 0 0-.01M12 5a1.5 1.5 0 1 0 0-.01M12 6.5c0 3-8 2-8 5",
    external: "M7 3H3v10h10V9M9.5 2.5h4v4M13.5 2.5 7.5 8.5",
    tag: "M2 2.5h5.5L14 9l-5 5-6.5-6.5zM5 5.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0",
    fork: "M4 2v4a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3V2M8 9v5",
    document: "M3 2h7l3 3v9H3zM10 2v3h3M5 8h6M5 11h6",
} as const

export type IconName = keyof typeof paths

export function Icon(handle: Handle<{ name: IconName; size?: number }>) {
    return () => (
        <svg
            aria-hidden="true"
            width={handle.props.size ?? 16}
            height={handle.props.size ?? 16}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path d={paths[handle.props.name]} />
        </svg>
    )
}

// The Hidden L mark from assets/brand/laneway.svg, drawn on its 64-unit canvas.
const brandPath =
    "M20 8H24V48H44A4 4 0 0 0 44 40H34A2 2 0 0 1 32 38V12A4 4 0 0 1 36 8H44A12 12 0 0 1 56 20V44A12 12 0 0 1 44 56H20A12 12 0 0 1 8 44V20A12 12 0 0 1 20 8Z"

export function BrandMark(handle: Handle<{ size: number }>) {
    return () => (
        <svg aria-hidden="true" width={handle.props.size} height={handle.props.size} viewBox="0 0 64 64" fill="none">
            <rect width="64" height="64" rx="14" fill="var(--brand-block)" />
            <path transform="translate(8 8) scale(.75)" fill="var(--brand-mark)" d={brandPath} />
        </svg>
    )
}
