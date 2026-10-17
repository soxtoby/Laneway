import type { OpenRepository, RepositoryIcon, RepositoryIconColor } from "@laneway/shared"
import { graphemeCount, repositoryIconColors, repositoryInitials } from "@laneway/shared"
import { css, type Handle } from "remix/ui"
import { LucideIcon } from "./icons"
import { lucideNode } from "./lucide-catalog"
import { type IconImageApi, iconImageUrl } from "./repository-icon-images"

/** Tailwind's 500 shades: the swatches stay the same in both appearances, while drawn tones follow the theme. */
export let iconColorSwatches: Record<RepositoryIconColor, string> = {
    gray: "#6b7280",
    red: "#ef4444",
    orange: "#f97316",
    amber: "#f59e0b",
    yellow: "#eab308",
    lime: "#84cc16",
    green: "#22c55e",
    emerald: "#10b981",
    teal: "#14b8a6",
    cyan: "#06b6d4",
    sky: "#0ea5e9",
    blue: "#3b82f6",
    indigo: "#6366f1",
    violet: "#8b5cf6",
    purple: "#a855f7",
    fuchsia: "#d946ef",
    pink: "#ec4899",
    rose: "#f43f5e",
}

export let iconColorOptions = repositoryIconColors.map(value => ({ value, label: value.charAt(0).toLocaleUpperCase() + value.slice(1) }))

/** The CSS colour for a palette entry; `--tone-*` is defined per appearance and for the always-dark rail. */
export function iconTone(color: RepositoryIconColor) {
    return `var(--tone-${color})`
}

/** The folder name of a repository's Main Worktree, which labels it until the user chooses otherwise. */
export function repositoryFolderName(repository: OpenRepository) {
    return repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name
}

/** The name shown for a repository everywhere in Laneway: its label when set, otherwise its folder name. */
export function repositoryName(repository: OpenRepository) {
    return repository.label ?? repositoryFolderName(repository)
}

export function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}

/** What a repository would show without an override: its favicon when it has exactly one, else initials. */
export function automaticIcon(repository: OpenRepository): Extract<RepositoryIcon, { kind: "image" }> | undefined {
    return repository.status == "available" && repository.favicon ? { kind: "image", path: repository.favicon } : undefined
}

let content = css({
    display: "grid",
    placeItems: "center",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    lineHeight: "1",
    "&.emoji": { fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif' },
    "& img": { width: "100%", height: "100%", objectFit: "contain" },
    "& .monogram": { width: "100%", height: "100%", fontFamily: "var(--mono)", fontWeight: "700" },
})

/**
 * The picture inside a repository tile: an override, the inferred favicon, or two initials. Tiles that
 * depend on an image or the icon catalogue show initials until those load, then re-render.
 */
export function RepositoryIconContent(
    handle: Handle<{ icon?: RepositoryIcon; name: string; size: number; api: IconImageApi; initialsClass?: string }>,
) {
    let refresh = () => void handle.update()
    return () => {
        let { icon, name, size } = handle.props
        let initials = () => <span class={`initials ${handle.props.initialsClass ?? ""}`} mix={content}>{repositoryInitials(name)}</span>
        if (!icon)
            return initials()
        else if (icon.kind == "image") {
            let url = iconImageUrl(handle.props.api, icon.path, refresh)
            return url
                ? (
                    <span class="image" mix={content}>
                        <img src={url} alt="" draggable={false} />
                    </span>
                )
                : initials()
        } else if (icon.kind == "emoji")
            return <span class="emoji" style={{ fontSize: `${Math.round(size * 0.58)}px` }} mix={content}>{icon.emoji}</span>
        else if (icon.kind == "monogram") {
            return (
                <span class="monogram-tile" style={{ color: iconTone(icon.color) }} mix={content}>
                    <Monogram text={icon.text} />
                </span>
            )
        } else {
            let node = lucideNode(icon.name, refresh)
            return node
                ? (
                    <span class="lucide" style={{ color: iconTone(icon.color) }} mix={content}>
                        <LucideIcon node={node} size={Math.round(size * 0.6)} />
                    </span>
                )
                : initials()
        }
    }
}

/** One or two characters fitted to the tile, drawn as SVG text so wide glyphs never overflow. */
export function Monogram(handle: Handle<{ text: string }>) {
    return () => (
        <svg class="monogram" aria-hidden="true" viewBox="0 0 16 16">
            <text
                x="8"
                y="10.9"
                text-anchor="middle"
                fill="currentColor"
                font-size="8.5"
                font-weight="700"
                textLength={graphemeCount(handle.props.text) == 1 ? 6 : 12}
                lengthAdjust="spacingAndGlyphs"
            >
                {handle.props.text}
            </text>
        </svg>
    )
}
