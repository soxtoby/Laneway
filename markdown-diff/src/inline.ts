import { diffArrays } from "diff"
import type { PhrasingContent } from "mdast"
import { canonical, type DiffModified, isMark, type Mark, markKey } from "./nodes"

/** One version's words in a paragraph, heading, or table cell, compared word by word. */
export interface InlineDiff {
    old: PhrasingContent[]
    new: PhrasingContent[]
    /** Both versions in one: deleted words beside the words that replaced them. */
    unified: PhrasingContent[]
    /** How much of the text survives, from 0 for none to 1 for all of it. */
    similarity: number
}

/** A word, a run of spaces, a punctuation mark, or an atom such as inline code or an image, with its formatting. */
interface Token {
    key: string
    node: PhrasingContent
    marks: Mark[]
    /** How much text the token carries, for similarity; spaces carry none. */
    weight: number
}

type Segment = { kind: "equal"; old: Token[]; new: Token[] } | { kind: "change"; removed: Token[]; added: Token[] }

interface Item {
    token: Token
    change?: "added" | "removed" | "modified"
    /** The other version's formatting, for a modified token on the new side. */
    before?: string[]
}

// Words, with their apostrophes; each Chinese or Japanese character on its own, since those scripts don't space
// words; runs of whitespace; and any other character on its own.
let cjk = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}`
let wordPattern = new RegExp(String.raw`[${cjk}]|(?:(?![${cjk}])[\p{L}\p{N}\p{M}_])+(?:['’](?:(?![${cjk}])[\p{L}\p{N}\p{M}_])+)*|\s+|[^]`, "gu")

/** A text's words, lowercased, without its spaces and punctuation. */
export function wordsOf(text: string) {
    return [...text.toLowerCase().matchAll(wordPattern)].map(([word]) => word).filter(word => /[\p{L}\p{N}]/u.test(word))
}

export function diffPhrasing(oldNodes: PhrasingContent[], newNodes: PhrasingContent[]): InlineDiff {
    let oldTokens = tokenize(oldNodes, [])
    let newTokens = tokenize(newNodes, [])
    let changes = diffArrays(oldTokens, newTokens, { comparator: (left, right) => left.key == right.key })
    let segments = trimSharedSpaces(mergeTrivialEqualities(toSegments(changes, oldTokens, newTokens)))

    let oldItems: Item[] = []
    let newItems: Item[] = []
    let unifiedItems: Item[] = []
    for (let segment of segments) {
        if (segment.kind == "change") {
            let removed = segment.removed.map(token => ({ token, change: "removed" as const }))
            let added = segment.added.map(token => ({ token, change: "added" as const }))
            oldItems = oldItems.concat(removed)
            newItems = newItems.concat(added)
            unifiedItems = unifiedItems.concat(removed, added)
        } else {
            segment.new.forEach((token, index) => {
                let old = segment.old[index]!
                let reformatted = marksKey(old) != marksKey(token)
                let item: Item = reformatted ? { token, change: "modified", before: old.marks.map(markKey) } : { token }
                oldItems.push(reformatted ? { token: old, change: "modified" } : { token: old })
                newItems.push(item)
                unifiedItems.push(item)
            })
        }
    }

    return { old: build(oldItems, 0), new: build(newItems, 0), unified: build(unifiedItems, 0), similarity: similarity(segments) }
}

function tokenize(nodes: PhrasingContent[], marks: Mark[]): Token[] {
    return nodes.flatMap((node): Token[] => {
        if (node.type == "text")
            return [...node.value.matchAll(wordPattern)].map(([word]) => textToken(word, marks))
        if (isMark(node))
            return tokenize(node.children, [...marks, node])
        return [{ key: canonical(node), node, marks, weight: atomWeight(node) }]
    })
}

function textToken(word: string, marks: Mark[]): Token {
    let space = /^\s+$/.test(word)
    return { key: space ? " " : word, node: { type: "text", value: word }, marks, weight: space ? 0 : word.length }
}

function atomWeight(node: PhrasingContent) {
    if (node.type == "inlineCode")
        return node.value.length
    if (node.type == "image")
        return Math.max(node.alt?.length ?? 0, 1)
    return 1
}

function toSegments(changes: { added: boolean; removed: boolean; count: number }[], oldTokens: Token[], newTokens: Token[]) {
    let segments: Segment[] = []
    let oldIndex = 0
    let newIndex = 0
    for (let change of changes) {
        let last = segments.at(-1)
        let pending = last?.kind == "change" ? last : undefined
        if (!change.added && !change.removed) {
            segments.push({ kind: "equal", old: oldTokens.slice(oldIndex, oldIndex + change.count), new: newTokens.slice(newIndex, newIndex + change.count) })
            oldIndex += change.count
            newIndex += change.count
        } else {
            let segment = pending ?? { kind: "change", removed: [], added: [] }
            if (!pending)
                segments.push(segment)
            if (change.removed) {
                segment.removed = segment.removed.concat(oldTokens.slice(oldIndex, oldIndex + change.count))
                oldIndex += change.count
            } else {
                segment.added = segment.added.concat(newTokens.slice(newIndex, newIndex + change.count))
                newIndex += change.count
            }
        }
    }
    return segments
}

/**
 * Folds short unchanged stretches between edits into the edits, as diff-match-patch's semantic cleanup does: a
 * sentence rewritten around a surviving "the" or comma reads as one replacement, not a scatter of fragments.
 */
function mergeTrivialEqualities(segments: Segment[]) {
    let merged = segments
    let changed = true
    while (changed) {
        changed = false
        let next: Segment[] = []
        for (let index = 0; index < merged.length; index++) {
            let segment = merged[index]!
            let before = next.at(-1)
            let after = merged[index + 1]
            if (segment.kind == "equal" && before?.kind == "change" && after?.kind == "change" && isTrivial(segment, before, after)) {
                before.removed = before.removed.concat(segment.old, after.removed)
                before.added = before.added.concat(segment.new, after.added)
                index++
                changed = true
            } else {
                next.push(segment)
            }
        }
        merged = next
    }
    return merged
}

/** Moves spaces that open or close both sides of a replacement out of it, so highlights end at the words. */
function trimSharedSpaces(segments: Segment[]) {
    let trimmed: Segment[] = []
    for (let segment of segments) {
        if (segment.kind == "equal")
            trimmed.push(segment)
        else {
            let { removed, added } = segment
            let leading = 0
            while (leading < removed.length && leading < added.length && isSpace(removed[leading]!) && isSpace(added[leading]!))
                leading++
            let trailing = 0
            while (
                trailing < removed.length - leading && trailing < added.length - leading && isSpace(removed.at(-1 - trailing)!)
                && isSpace(added.at(-1 - trailing)!)
            ) {
                trailing++
            }
            if (leading)
                trimmed.push({ kind: "equal", old: removed.slice(0, leading), new: added.slice(0, leading) })
            trimmed.push({ kind: "change", removed: removed.slice(leading, removed.length - trailing), added: added.slice(leading, added.length - trailing) })
            if (trailing)
                trimmed.push({ kind: "equal", old: removed.slice(removed.length - trailing), new: added.slice(added.length - trailing) })
        }
    }
    return trimmed
}

function isSpace(token: Token) {
    return token.key == " "
}

function isTrivial(equal: Extract<Segment, { kind: "equal" }>, before: Extract<Segment, { kind: "change" }>, after: Extract<Segment, { kind: "change" }>) {
    let size = textLength(equal.new)
    let around = (change: typeof before) => Math.max(textLength(change.removed), textLength(change.added))
    return size <= around(before) && size <= around(after)
}

function textLength(tokens: Token[]) {
    let length = 0
    for (let token of tokens)
        length += token.node.type == "text" ? token.node.value.length : token.weight
    return length
}

function similarity(segments: Segment[]) {
    let kept = 0
    let total = 0
    for (let segment of segments) {
        if (segment.kind == "equal") {
            let weight = weightOf(segment.new)
            kept += 2 * weight
            total += weightOf(segment.old) + weight
        } else {
            total += weightOf(segment.removed) + weightOf(segment.added)
        }
    }
    return total == 0 ? 1 : kept / total
}

function weightOf(tokens: Token[]) {
    let weight = 0
    for (let token of tokens)
        weight += token.weight
    return weight
}

function marksKey(token: Token) {
    return token.marks.map(markKey).join(" ")
}

/**
 * Rebuilds formatted inline content from tokens. Neighbours sharing a mark share its element, and changed words are
 * wrapped innermost, so `**a b**` changing to `**a c**` stays one strong element around a deletion and an insertion.
 */
function build(items: Item[], depth: number): PhrasingContent[] {
    return runs(items, item => item.token.marks[depth] ? `mark:${markKey(item.token.marks[depth]!)}` : `leaf:${item.change ?? ""}`).flatMap(run => {
        let mark = run[0]!.token.marks[depth]
        if (mark)
            return [{ ...mark, children: build(run, depth + 1) } as PhrasingContent]
        return wrap(run)
    })
}

function wrap(run: Item[]): PhrasingContent[] {
    let children = joinText(run.map(item => item.token.node))
    let { change, before } = run[0]!
    if (change == "added")
        return [{ type: "diffInsert", children }]
    if (change == "removed")
        return [{ type: "diffDelete", children }]
    if (change == "modified")
        return [{ type: "diffModified", children, ...(before ? { before } : {}) } satisfies DiffModified]
    return children
}

function joinText(nodes: PhrasingContent[]) {
    let joined: PhrasingContent[] = []
    for (let node of nodes) {
        let last = joined.at(-1)
        if (node.type == "text" && last?.type == "text")
            joined[joined.length - 1] = { type: "text", value: last.value + node.value }
        else
            joined.push(node)
    }
    return joined
}

function runs<T>(items: T[], key: (item: T) => string) {
    let grouped: T[][] = []
    let lastKey: string | undefined
    for (let item of items) {
        let itemKey = key(item)
        if (itemKey == lastKey)
            grouped.at(-1)!.push(item)
        else
            grouped.push([item])
        lastKey = itemKey
    }
    return grouped
}
