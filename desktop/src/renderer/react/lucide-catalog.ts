import type { IconNode } from "./icon-nodes"

/** Every Lucide icon by its kebab-case name, with the search tags Lucide publishes for each. */
export interface LucideCatalog {
    nodes: Record<string, IconNode>
    tags: Record<string, string[]>
}

let catalog: LucideCatalog | undefined
let loading: Promise<LucideCatalog> | undefined

/**
 * The whole icon set, loaded once on first use so the application bundle stays small. `loaded` fires
 * after a pending load finishes, so a caller rendering before then can re-render with the result.
 */
export function lucideCatalog(loaded?: () => void): LucideCatalog | undefined {
    if (catalog)
        return catalog
    loading ??= Promise.all([import("lucide-static/icon-nodes.json"), import("lucide-static/tags.json")]).then(([nodes, tags]) => {
        catalog = { nodes: nodes.default, tags: tags.default }
        return catalog
    })
    if (loaded)
        void loading.then(loaded, loaded)
    return undefined
}

/** The node for a saved icon name, or nothing while the catalog loads or when the name is unknown. */
export function lucideNode(name: string, loaded?: () => void) {
    return lucideCatalog(loaded)?.nodes[name]
}

// Shown before any search, in rough order of how often a repository is one of these things.
export let popularIcons = [
    "folder-code",
    "folder-git-2",
    "code-xml",
    "terminal",
    "globe",
    "server",
    "database",
    "bot",
    "sparkles",
    "smartphone",
    "monitor",
    "cloud-cog",
    "package",
    "book-open",
    "flask-conical",
    "shield-check",
    "rocket",
    "gamepad-2",
    "image",
    "shopping-bag",
    "git-branch",
    "workflow",
    "wrench",
    "layers",
    "cpu",
    "braces",
    "brain",
    "chart-line",
    "component",
    "puzzle",
    "palette",
    "pen-tool",
    "blocks",
    "atom",
    "zap",
    "flame",
    "leaf",
    "heart",
    "star",
    "bug",
    "test-tube",
    "lock",
    "key",
    "mail",
    "message-square",
    "calendar",
    "map",
    "camera",
    "headphones",
    "radio",
    "lightbulb",
    "compass",
    "plane",
    "car",
    "coffee",
    "cat",
    "dog",
    "bird",
    "fish",
    "tree-pine",
    "mountain",
    "briefcase",
    "store",
    "landmark",
    "graduation-cap",
    "newspaper",
    "notebook",
    "library",
    "trophy",
    "gift",
    "ghost",
    "swords",
    "crown",
    "gem",
    "coins",
    "wallet",
    "chart-pie",
    "table",
    "layout-dashboard",
    "kanban",
    "hexagon",
    "infinity",
    "hash",
    "binary",
    "network",
    "rss",
    "film",
    "tv",
    "dumbbell",
    "telescope",
    "microscope",
    "dna",
    "orbit",
    "satellite",
]

export let iconSearchLimit = 96

/** Icon names matching a query by name or Lucide tag; the popular set when the query is empty. */
export function searchLucide(catalog: LucideCatalog, query: string): string[] {
    let needle = query.trim().toLocaleLowerCase().replace(/\s+/g, "-")
    if (!needle)
        return popularIcons.filter(name => name in catalog.nodes)

    let names = Object.keys(catalog.nodes)
    let byName = names.filter(name => name.includes(needle))
    let words = needle.split("-").filter(Boolean)
    let byTag = names.filter(name => !name.includes(needle) && (catalog.tags[name] ?? []).some(tag => words.every(word => tag.includes(word))))
    return [...byName.sort((left, right) => left.indexOf(needle) - right.indexOf(needle) || left.length - right.length), ...byTag].slice(0, iconSearchLimit)
}

/** "folder-git-2" as "Folder git 2", for labels and tooltips. */
export function iconLabel(name: string) {
    let words = name.split("-")
    return words[0].charAt(0).toLocaleUpperCase() + words[0].slice(1) + words.slice(1).map(word => ` ${word}`).join("")
}
