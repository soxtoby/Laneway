import { useSyncExternalStore } from "react"

/** A Tabler icon's shapes, drawn on its 24-unit grid. */
export type CatalogNode = [tag: string, attributes: Record<string, string>][]

/** Every Tabler outline icon by its kebab-case name, with the search tags Tabler publishes for each. */
export interface IconCatalog {
    nodes: Record<string, CatalogNode>
    tags: Record<string, string[]>
}

let catalog: IconCatalog | undefined
let loading: Promise<IconCatalog> | undefined

/** The whole icon set, loaded once on first use so the application bundle stays small. */
export function loadIconCatalog(): Promise<IconCatalog> {
    loading ??= Promise.all([import("@tabler/icons/tabler-nodes-outline.json"), import("@tabler/icons/icons.json")]).then(([nodes, icons]) => {
        // A few of Tabler's tags are numbers.
        let tags = Object.fromEntries(Object.entries(icons.default).map(([name, icon]) => [name, icon.tags.map(String)]))
        catalog = { nodes: nodes.default, tags }
        return catalog
    })
    return loading
}

/**
 * The icon set once it has loaded. A view that `needs` it starts the load and renders again when it finishes; one that
 * doesn't leaves it unloaded.
 */
export function useIconCatalog(needs = true): IconCatalog | undefined {
    return useSyncExternalStore(needs ? watchCatalog : ignore, () => catalog)
}

function watchCatalog(changed: () => void) {
    let watching = true
    void loadIconCatalog().then(() => watching && changed())
    return () => watching = false
}

function ignore() {
    return () => {}
}

// Shown before any search, in rough order of how often a repository is one of these things.
export let popularIcons = [
    "folder-code",
    "git-fork",
    "code",
    "terminal",
    "world",
    "server",
    "database",
    "robot",
    "sparkles",
    "device-mobile",
    "device-desktop",
    "cloud-cog",
    "package",
    "book",
    "flask",
    "shield-check",
    "rocket",
    "device-gamepad-2",
    "photo",
    "shopping-bag",
    "git-branch",
    "sitemap",
    "tool",
    "stack-2",
    "cpu",
    "braces",
    "brain",
    "chart-line",
    "components",
    "puzzle",
    "palette",
    "vector-bezier",
    "box-multiple",
    "atom",
    "bolt",
    "flame",
    "leaf",
    "heart",
    "star",
    "bug",
    "test-pipe",
    "lock",
    "key",
    "mail",
    "message",
    "calendar",
    "map",
    "camera",
    "headphones",
    "radio",
    "bulb",
    "compass",
    "plane",
    "car",
    "coffee",
    "cat",
    "dog",
    "feather",
    "fish",
    "tree",
    "mountain",
    "briefcase",
    "building-store",
    "building-bank",
    "school",
    "news",
    "notebook",
    "books",
    "trophy",
    "gift",
    "ghost",
    "swords",
    "crown",
    "diamond",
    "coins",
    "wallet",
    "chart-pie",
    "table",
    "layout-dashboard",
    "layout-kanban",
    "hexagon",
    "infinity",
    "hash",
    "binary",
    "network",
    "rss",
    "movie",
    "device-tv",
    "barbell",
    "telescope",
    "microscope",
    "dna",
    "planet",
    "satellite",
]

export let iconSearchLimit = 96

/** Icon names matching a query by name or Tabler tag; the popular set when the query is empty. */
export function searchIcons(catalog: IconCatalog, query: string): string[] {
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
