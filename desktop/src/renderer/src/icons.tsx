import { type Handle } from "remix/ui"

// 16-unit stroke icons shared across the renderer. Inline SVG keeps the strict CSP intact.
let paths = {
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
    warning: "M8 2 15 14H1zM8 6v4M8 12h.01",
    plus: "M8 3v10M3 8h10",
    minus: "M3 8h10",
    close: "M4 4l8 8M12 4l-8 8",
    "chevron-right": "M6 3l5 5-5 5",
    "chevron-down": "M3 6l5 5 5-5",
    "expand-all": "M3 5l5-3 5 3M3 11l5 3 5-3",
    "collapse-all": "M3 2l5 3 5-3M3 14l5-3 5 3",
    "collapse-left": "M7.5 3 2.5 8l5 5M13.5 3l-5 5 5 5",
    "collapse-right": "M8.5 3l5 5-5 5M2.5 3l5 5-5 5",
    maximize: "M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9",
    restore: "M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14",
    home: "M2 8l6-5.5L14 8M4 6.8v6.7h8V6.8",
    folder: "M1.75 4.25a1 1 0 0 1 1-1h3.5l1.5 1.5h5.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z",
    switch: "M2.5 5h10M10 2.5 12.5 5 10 7.5M13.5 11h-10M6 8.5 3.5 11 6 13.5",
    grip: "M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01",
    // Drawn as filled dots by Icon; strokes would render as hollow rings.
    more: "",
    graph: "M2 3a2 2 0 1 0 4 0a2 2 0 1 0-4 0M2 13a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 5a2 2 0 1 0 4 0a2 2 0 1 0-4 0M4 5v6M6 9h2a4 4 0 0 0 4-2.2",
    branch:
        "M2.5 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M2.5 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10.5 4.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M4 5v6M12 6c0 3.5-8 2.5-8 5",
    external: "M7 3H3v10h10V9M9.5 2.5h4v4M13.5 2.5 7.5 8.5",
    tag: "M2 2.5h5.5L14 9l-5 5-6.5-6.5zM5 5.5a.5.5 0 1 0 1 0a.5.5 0 1 0-1 0",
    fork: "M4 2v4a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3V2M8 9v5",
    document: "M3 2h7l3 3v9H3zM10 2v3h3M5 8h6M5 11h6",
    diff: "M8 2v5M5.5 4.5h5M5.5 12h5",
    // Two refs with the direction of the comparison between them.
    compare: "M3 2.5v11M13 2.5v11M5.5 8h5M8.5 5.5 11 8l-2.5 2.5",
    pencil: "M3 13l.5-3L11 2.5l2.5 2.5L6 12.5zM10.25 3.25l2.5 2.5",
    // A head with no branch line above it: the node and its history, cut off from any ref.
    detached: "M5.5 9a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8 11.5V15M8 1.5v1M8 4.5v1.5",
    copy: "M6 6h7.5v7.5H6zM10 6V2.5H2.5V10H6",
    check: "M3 8.5l3.5 3.5L13 4.5",
} as const

export type IconName = keyof typeof paths

export function iconPath(name: IconName) {
    return paths[name]
}

// The Hidden L mark from assets/brand/laneway-icon.svg, fitted to its 48-unit canvas.
let brandPath =
    "M20 8H24V48H44A4 4 0 0 0 44 40H34A2 2 0 0 1 32 38V12A4 4 0 0 1 36 8H44A12 12 0 0 1 56 20V44A12 12 0 0 1 44 56H20A12 12 0 0 1 8 44V20A12 12 0 0 1 20 8Z"

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
            {handle.props.name == "more"
                ? [3.5, 8, 12.5].map(x => <circle cx={x} cy="8" r="1.4" fill="currentColor" stroke="none" />)
                : <path d={paths[handle.props.name]} />}
        </svg>
    )
}

export function BrandMark(handle: Handle<{ size: number }>) {
    return () => (
        <svg aria-hidden="true" width={handle.props.size} height={handle.props.size} viewBox="8 8 48 48" fill="none">
            <path fill="var(--accent)" d={brandPath} />
        </svg>
    )
}
