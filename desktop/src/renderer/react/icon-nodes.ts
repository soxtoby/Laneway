import type { IconNode } from "@tabler/icons-react"
import type { CatalogNode } from "./icon-catalog"

/**
 * Tabler's selector, which `ExpandAllIcon` draws, repeated for the diff's expand control: Pierre owns
 * that part of the page, so it is built without React.
 */
export let expandAllNode: CatalogNode = [["path", { d: "M8 9l4 -4l4 4" }], ["path", { d: "M16 15l-4 4l-4 -4" }]]

/** The selector's chevrons turned to face each other, as Tabler draws no collapse-all. */
export let collapseAllNode: IconNode = [["path", { d: "M8 5l4 4l4 -4", key: "svg-0" }], ["path", { d: "M16 19l-4 -4l-4 4", key: "svg-1" }]]

/** Hand-drawn 16-unit strokes for concepts Tabler has no icon for. */
export let customIconPaths = {
    // A head with no branch line above it: the node and its history, cut off from any ref.
    detached: "M5.5 9a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8 11.5V15M8 1.5v1M8 4.5v1.5",
} as const
