/** @jsxImportSource react */
import type { RepositoryIcon } from "@laneway/shared"
import { graphemeCount, repositoryInitials } from "@laneway/shared"
import { createElement, type ReactNode, useReducer } from "react"
import { lucideNode } from "../src/lucide-catalog"
import { type IconImageApi, iconImageUrl } from "../src/repository-icon-images"

interface TileProps {
    icon?: RepositoryIcon
    /** The repository's name, whose initials show without an icon or while one loads. */
    name: string
    api: IconImageApi
    isActive?: boolean
    isMissing?: boolean
    className?: string
}

/**
 * A Repository Icon on a 20-unit tile, sized by its class. Initials, monograms, emoji, Lucide icons,
 * and images all fit the same tile; images and the Lucide catalog show initials until they load.
 * `data-kind` names what it shows.
 */
export function RepositoryTile({ icon, name, api, isActive = false, isMissing = false, className = "tile" }: TileProps) {
    let [, loaded] = useReducer((count: number) => count + 1, 0)
    let content: ReactNode
    if (icon?.kind == "image") {
        let url = iconImageUrl(api, icon.path, loaded)
        if (url)
            content = <image href={url} x={2} y={2} width={16} height={16} preserveAspectRatio="xMidYMid meet" />
    } else if (icon?.kind == "emoji")
        content = <text {...centredText} y={14.6} fontSize={12}>{icon.emoji}</text>
    else if (icon?.kind == "monogram") {
        // Fitted to the tile, so wide glyphs never overflow.
        content = (
            <text
                {...centredText}
                className="tile-text"
                data-tone={icon.color}
                textLength={graphemeCount(icon.text) == 1 ? 7.5 : 14}
                lengthAdjust="spacingAndGlyphs"
            >
                {icon.text}
            </text>
        )
    } else if (icon?.kind == "icon") {
        let node = lucideNode(icon.name, loaded)
        if (node) {
            content = (
                <g
                    data-tone={icon.color}
                    transform="translate(4 4) scale(0.5)"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    {node.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
                </g>
            )
        }
    }
    // Initials fill with the accent when active, as they do in the Remix rail.
    let isInitials = content == undefined
    return (
        <svg viewBox="0 0 20 20" className={className} data-kind={isInitials ? "initials" : icon!.kind} aria-hidden>
            <rect
                x={0.5}
                y={0.5}
                width={19}
                height={19}
                rx={4.5}
                className="tile-frame"
                data-filled={(isActive && isInitials) || undefined}
                data-missing={isMissing || undefined}
            />
            {isInitials ? <text {...centredText} className="tile-text" data-inverse={isActive || undefined}>{repositoryInitials(name)}</text> : content}
        </svg>
    )
}

let centredText = { x: 10, y: 13.4, textAnchor: "middle", fontSize: 8, fontWeight: 700 } as const
