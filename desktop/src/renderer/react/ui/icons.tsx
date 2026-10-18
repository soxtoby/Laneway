import { Check as CheckNode, ChevronDown as ChevronDownNode, ChevronRight as ChevronRightNode, Dot as DotNode, GripVertical as GripVerticalNode, type IconNode, Search as SearchNode, X as XNode } from "lucide"
import { createElement, type SVGProps } from "react"

export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string }

/**
 * Draws Lucide's node data the way `lucide-react` does, including its `lucide-<name>` classes that
 * the starter CSS targets, so the kit keeps its icon props without a second copy of the icon set.
 */
export function lucideIcon(node: IconNode, name: string) {
    function Icon({ size = 24, strokeWidth = 2, className, ...props }: IconProps) {
        return (
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width={size}
                height={size}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className={["lucide", `lucide-${name}`, className].filter(Boolean).join(" ")}
                {...props}
            >
                {node.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
            </svg>
        )
    }
    Icon.displayName = name
    return Icon
}

export let Check = lucideIcon(CheckNode, "check")
export let ChevronDown = lucideIcon(ChevronDownNode, "chevron-down")
export let ChevronRight = lucideIcon(ChevronRightNode, "chevron-right")
export let Dot = lucideIcon(DotNode, "dot")
export let GripVertical = lucideIcon(GripVerticalNode, "grip-vertical")
export let Search = lucideIcon(SearchNode, "search")
export let X = lucideIcon(XNode, "x")
