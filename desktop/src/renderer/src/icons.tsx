import { createElement, type Handle } from "remix/ui"
import { customIconPaths, type IconName, type IconNode, iconNodes, isCustomIcon } from "./icon-nodes"

export type { IconName }

// Lucide draws at 2 on a 24-unit grid; this keeps the 1.5px line weight the chrome was tuned for at 16px.
let lucideStrokeWidth = 2.25

/** Inline SVG keeps the strict CSP intact; icons are stroke drawings in the current text colour. */
export function Icon(handle: Handle<{ name: IconName; size?: number }>) {
    return () => {
        let size = handle.props.size ?? 16
        let name = handle.props.name
        return isCustomIcon(name)
            ? (
                <svg
                    aria-hidden="true"
                    width={size}
                    height={size}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d={customIconPaths[name]} />
                </svg>
            )
            : <LucideIcon node={iconNodes[name]} size={size} />
    }
}

/** Any Lucide icon node, including ones chosen by name for a Repository Icon. */
export function LucideIcon(handle: Handle<{ node: IconNode; size: number; strokeWidth?: number }>) {
    return () => (
        <svg
            aria-hidden="true"
            width={handle.props.size}
            height={handle.props.size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width={handle.props.strokeWidth ?? lucideStrokeWidth}
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            {handle.props.node.map(([tag, attributes]) => createElement(tag, attributes))}
        </svg>
    )
}

// The Hidden L mark from assets/brand/laneway-icon.svg, fitted to its 48-unit canvas.
let brandPath =
    "M20 8H24V48H44A4 4 0 0 0 44 40H34A2 2 0 0 1 32 38V12A4 4 0 0 1 36 8H44A12 12 0 0 1 56 20V44A12 12 0 0 1 44 56H20A12 12 0 0 1 8 44V20A12 12 0 0 1 20 8Z"

export function BrandMark(handle: Handle<{ size: number }>) {
    return () => (
        <svg aria-hidden="true" width={handle.props.size} height={handle.props.size} viewBox="8 8 48 48" fill="none">
            <path fill="var(--accent)" d={brandPath} />
        </svg>
    )
}
