import type { Data, Nodes, Parent, PhrasingContent } from "mdast"

/** How a block, or a piece of one, differs between the two versions. */
export type DiffChange = "unchanged" | "added" | "removed" | "changed"

/** Inserted inline content. */
export interface DiffInsert extends Parent {
    type: "diffInsert"
    children: PhrasingContent[]
}

/** Deleted inline content. */
export interface DiffDelete extends Parent {
    type: "diffDelete"
    children: PhrasingContent[]
}

/** Inline content whose words are unchanged but whose formatting differs, carrying the formatting it had. */
export interface DiffModified extends Parent {
    type: "diffModified"
    /** The other version's formatting, as `markKey`s; absent on the old side. */
    before?: string[]
    children: PhrasingContent[]
}

/** A code block's lines, each marked with how it differs. */
export interface DiffCode {
    type: "diffCode"
    lang?: string | null
    lines: { text: string; change: DiffChange }[]
    data?: Data
}

declare module "mdast" {
    interface PhrasingContentMap {
        diffInsert: DiffInsert
        diffDelete: DiffDelete
        diffModified: DiffModified
    }

    interface RootContentMap {
        diffInsert: DiffInsert
        diffDelete: DiffDelete
        diffModified: DiffModified
        diffCode: DiffCode
    }
}

/** Formatting that wraps words: emphasis, strong, strikethrough, and links. */
export type Mark = Extract<PhrasingContent, { type: "emphasis" | "strong" | "delete" | "link" | "linkReference" }>

export function isMark(node: PhrasingContent): node is Mark {
    return node.type == "emphasis" || node.type == "strong" || node.type == "delete" || node.type == "link" || node.type == "linkReference"
}

/** What a mark looks like: two marks with the same key format their words the same way. */
export function markKey(mark: Mark) {
    if (mark.type == "link")
        return `link=${encodeURI(mark.url)}`
    if (mark.type == "linkReference")
        return `linkReference=${encodeURI(mark.identifier)}`
    return mark.type
}

/**
 * A node's rendered identity, ignoring source positions and the line breaks and runs of spaces that render as one
 * space. Blocks with the same key render the same.
 */
export function canonical(node: Nodes) {
    return JSON.stringify(node, function(this: { type?: string }, key, value) {
        // Loose and tight lists differ only in spacing.
        if (key == "position" || key == "data" || key == "spread")
            return undefined
        if (key == "value" && this.type == "text")
            return (value as string).replace(/\s+/g, " ")
        return value
    })
}

/** Marks a block with how it differs, which its rendered element carries as `data-diff`. */
export function marked<T extends Nodes | DiffCode>(node: T, change: DiffChange): T {
    return { ...node, data: { ...node.data, hProperties: { ...node.data?.hProperties, dataDiff: change } } }
}
