import type { ElementContent } from "hast"
import { type BlockRow, diffBlocks } from "./blocks"
import { toHastContent } from "./hast"
import type { DiffChange } from "./nodes"
import { parseMarkdown } from "./parse"

export type { DiffChange } from "./nodes"

/**
 * One aligned block of a rendered Markdown diff, as hast. Changed elements carry `data-diff`: `added`, `removed`, or
 * `changed` on blocks, list items, table rows, and code lines; inserted words are `<ins data-diff="added">`, deleted
 * ones `<del data-diff="removed">`, and words whose formatting alone changed are `<span data-diff="modified">`, whose
 * `data-diff-before` lists the formatting they had: `strong`, `emphasis`, `delete`, `link=<url>`, or
 * `linkReference=<identifier>`, space-separated.
 */
export interface DiffRow {
    change: DiffChange
    /** The old version's block, marked with its deletions; absent for an added block. */
    old?: ElementContent[]
    /** The new version's block, marked with its insertions; absent for a removed block. */
    new?: ElementContent[]
    /** Both versions in one: a changed block shows its deletions beside its insertions. */
    unified: ElementContent[]
}

export interface MarkdownDiff {
    rows: DiffRow[]
}

/**
 * Compares two versions of a GitHub Flavored Markdown document as they render. Blocks align by content, a changed
 * paragraph, heading, or table cell compares word by word, lists, quotes, and tables compare their items, and code
 * compares line by line. A missing version compares as empty, so every block of the other is added or removed.
 * Embedded HTML is sanitized with GitHub's schema.
 */
export function diffMarkdown(oldSource: string | undefined, newSource: string | undefined): MarkdownDiff {
    let rows = diffBlocks(parse(oldSource), parse(newSource), true)
    return { rows: rows.map(toDiffRow) }
}

function parse(source: string | undefined) {
    return source == undefined ? [] : parseMarkdown(source)
}

function toDiffRow(row: BlockRow): DiffRow {
    let old = row.old && toHastContent(row.old)
    let current = row.new && toHastContent(row.new)
    let unified = row.change == "changed" ? row.unified.flatMap(toHastContent) : current ?? old ?? []
    return { change: row.change, ...old ? { old } : {}, ...current ? { new: current } : {}, unified }
}
