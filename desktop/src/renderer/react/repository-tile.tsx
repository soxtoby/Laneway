import type { RepositoryIcon, RepositoryIconColor } from "@laneway/shared"
import { graphemeCount, repositoryInitials } from "@laneway/shared"
import { createElement, type ReactNode, useLayoutEffect, useReducer, useRef, useState } from "react"
import { catalogNode } from "./icon-catalog"
import { type IconImageApi, iconImageUrl } from "./repository-icon-images"

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
 * A Repository Icon on a 20-unit tile, sized by its class. Initials, monograms, emoji, Tabler icons,
 * and images all fit the same tile; images and the icon catalog show initials until they load.
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
        content = <text x={10} y={14.6} textAnchor="middle" fontSize={12}>{icon.emoji}</text>
    else if (icon?.kind == "monogram")
        content = <TileLetters text={icon.text} tone={icon.color} />
    else if (icon?.kind == "icon") {
        let node = catalogNode(icon.name, loaded)
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
    // Initials fill with the accent when active.
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
            {isInitials ? <TileLetters text={repositoryInitials(name)} isInverse={isActive} /> : content}
        </svg>
    )
}

// Segoe UI's capital height as a share of its size, to centre capitals on the tile.
let capHeight = 0.7
let lettersWidth = 14

/**
 * Initials or a monogram at their natural proportions, with their capitals centred and a lone letter
 * drawn larger. Letters too wide for the tile shrink to fit around its centre rather than overflow.
 */
function TileLetters({ text, tone, isInverse = false }: { text: string; tone?: RepositoryIconColor; isInverse?: boolean }) {
    let ref = useRef<SVGTextElement>(null)
    let [scale, setScale] = useState(1)
    // Only the drawn glyphs know their width; the element's own transform doesn't change it.
    useLayoutEffect(() => {
        let width = ref.current?.getComputedTextLength() ?? 0
        setScale(width > lettersWidth ? lettersWidth / width : 1)
    }, [text])
    let fontSize = graphemeCount(text) == 1 ? 11 : 9
    let offset = 10 - 10 * scale
    return (
        <text
            ref={ref}
            className="tile-text"
            data-tone={tone}
            data-inverse={isInverse || undefined}
            x={10}
            y={10 + capHeight * fontSize / 2}
            textAnchor="middle"
            fontSize={fontSize}
            fontWeight={600}
            transform={scale < 1 ? `matrix(${scale} 0 0 ${scale} ${offset} ${offset})` : undefined}
        >
            {text}
        </text>
    )
}
