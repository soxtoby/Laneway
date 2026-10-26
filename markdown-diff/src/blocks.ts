import { diffArrays } from "diff"
import type { Code, Parent, RootContent, Table, TableCell, TableRow, Yaml } from "mdast"
import { visit } from "unist-util-visit"
import { diffPhrasing, wordsOf } from "./inline"
import { canonical, type DiffChange, type DiffCode, marked } from "./nodes"

/** One aligned block: its old version, its new version, and both in one. */
export interface BlockRow {
    change: DiffChange
    old?: RootContent
    new?: RootContent
    unified: RootContent[]
}

// Blocks whose words overlap this much pair up as one changed block; less alike, they show as removed and added.
let pairingThreshold = 0.5
// A paired paragraph or heading keeping less of its text than this shows as replaced rather than edited.
let rewriteThreshold = 0.3
// Blocks without words, such as a lone image, pair with a like block when nothing more alike is near.
let wordlessResemblance = 0.6
// Hunks of more removed × added blocks than this skip pairing, which compares every combination.
let pairingLimit = 40_000
// Blocks whose own parts compare, so they always pair with a like block however much changed inside them.
let structural = new Set<string>(["list", "table", "blockquote", "footnoteDefinition", "code", "yaml"])

/**
 * Aligns two block sequences: identical blocks anchor the alignment, and between anchors, removed and added blocks
 * pair in order by how alike their words are. With `split`, a paired paragraph too rewritten to read as an edit
 * shows as a removal and an addition; inside list items and table cells it stays one edited block.
 */
export function diffBlocks(oldBlocks: RootContent[], newBlocks: RootContent[], split: boolean): BlockRow[] {
    let rows: BlockRow[] = []
    let removed: RootContent[] = []
    let added: RootContent[] = []
    let oldIndex = 0
    let newIndex = 0
    for (let change of diffArrays(oldBlocks.map(canonical), newBlocks.map(canonical))) {
        // Long documents have more blocks than a spread can pass as arguments, so runs join by concatenation.
        if (change.removed) {
            removed = removed.concat(oldBlocks.slice(oldIndex, oldIndex + change.count))
            oldIndex += change.count
        } else if (change.added) {
            added = added.concat(newBlocks.slice(newIndex, newIndex + change.count))
            newIndex += change.count
        } else {
            let unchanged = oldBlocks.slice(oldIndex, oldIndex + change.count).map((block, offset) => unchangedRow(block, newBlocks[newIndex + offset]!))
            rows = rows.concat(pair(removed, added, split), unchanged)
            removed = []
            added = []
            oldIndex += change.count
            newIndex += change.count
        }
    }
    return rows.concat(pair(removed, added, split))
}

/** Pairs removed and added blocks in order, keeping the pairing whose blocks are most alike in total. */
function pair(removed: RootContent[], added: RootContent[], split: boolean): BlockRow[] {
    if (removed.length == 0 || added.length == 0 || removed.length * added.length > pairingLimit)
        return [...removed.map(removedRow), ...added.map(addedRow)]

    let oldWords = removed.map(wordCounts)
    let newWords = added.map(wordCounts)
    let scores = removed.map((block, i) =>
        added.map((other, j) =>
            comparable(block, other) ? Math.max(resemblance(oldWords[i]!, newWords[j]!), structural.has(block.type) ? pairingThreshold : 0) : 0
        )
    )
    // best[i][j] is the most resemblance pairing removed[i…] with added[j…] can keep; choices[i][j] the step there.
    let best = Array.from({ length: removed.length + 1 }, () => new Array<number>(added.length + 1).fill(0))
    let choices = removed.map(() => new Array<"pair" | "remove" | "add">(added.length))
    for (let i = removed.length - 1; i >= 0; i--) {
        for (let j = added.length - 1; j >= 0; j--) {
            let score = scores[i]![j]!
            let pairing = score >= pairingThreshold ? score + best[i + 1]![j + 1]! : -1
            let skipOld = best[i + 1]![j]!
            let skipNew = best[i]![j + 1]!
            let choice: "pair" | "remove" | "add" = pairing >= skipOld && pairing >= skipNew ? "pair" : skipOld >= skipNew ? "remove" : "add"
            choices[i]![j] = choice
            best[i]![j] = choice == "pair" ? pairing : Math.max(skipOld, skipNew)
        }
    }

    let rows: BlockRow[] = []
    let i = 0
    let j = 0
    while (i < removed.length || j < added.length) {
        let choice = i == removed.length ? "add" : j == added.length ? "remove" : choices[i]![j]
        if (choice == "pair")
            rows.push(...changedRows(removed[i++]!, added[j++]!, split))
        else if (choice == "remove")
            rows.push(removedRow(removed[i++]!))
        else
            rows.push(addedRow(added[j++]!))
    }
    return rows
}

function comparable(old: RootContent, current: RootContent) {
    if (old.type != current.type)
        return false
    if (old.type == "table")
        return old.children[0]?.children.length == (current as Table).children[0]?.children.length
    if (old.type == "tableRow")
        return old.children.length == (current as TableRow).children.length
    return true
}

function wordCounts(block: RootContent) {
    let counts = new Map<string, number>()
    for (let word of wordsOf(textOf(block)))
        counts.set(word, (counts.get(word) ?? 0) + 1)
    return counts
}

// Unlike mdast-util-to-string, which runs table cells and list items together, keeps each piece of text apart.
function textOf(block: RootContent) {
    let texts: string[] = []
    visit(block, node => {
        if ("value" in node)
            texts.push(node.value)
        else if (node.type == "image")
            texts.push(node.alt ?? "")
    })
    return texts.join(" ")
}

/** The Dice coefficient of two blocks' words: twice the words they share over all their words. */
function resemblance(old: Map<string, number>, current: Map<string, number>) {
    let shared = 0
    let total = 0
    for (let [word, count] of old) {
        shared += Math.min(count, current.get(word) ?? 0)
        total += count
    }
    for (let count of current.values())
        total += count
    return total == 0 ? wordlessResemblance : 2 * shared / total
}

function changedRows(old: RootContent, current: RootContent, split: boolean): BlockRow[] {
    switch (old.type) {
        case "paragraph":
        case "heading":
        case "tableCell":
            return phrasingRows(old, current as typeof old, split)
        case "blockquote":
        case "footnoteDefinition":
            return [containerRow(old, current as typeof old, diffBlocks(old.children, (current as typeof old).children, split))]
        case "list":
        case "listItem":
            return [containerRow(old, current as typeof old, diffBlocks(old.children, (current as typeof old).children, false))]
        case "table":
            return [tableRow(old, current as Table)]
        case "tableRow":
            return [containerRow(old, current as TableRow, old.children.map((cell, index) => cellRow(cell, (current as TableRow).children[index]!)))]
        case "code":
        case "yaml":
            return [codeRow(old, current as typeof old)]
        default:
            return [removedRow(old), addedRow(current)]
    }
}

function phrasingRows<T extends Extract<RootContent, { type: "paragraph" | "heading" | "tableCell" }>>(old: T, current: T, split: boolean): BlockRow[] {
    let inline = diffPhrasing(old.children, current.children)
    if (split && inline.similarity < rewriteThreshold)
        return [removedRow(old), addedRow(current)]

    return [{
        change: "changed",
        old: marked({ ...old, children: inline.old }, "changed"),
        new: marked({ ...current, children: inline.new }, "changed"),
        unified: [marked({ ...current, children: inline.unified }, "changed")],
    }]
}

/** A container whose children changed: each version holds its own children, and the unified one holds all of them. */
function containerRow<T extends Parent & RootContent>(old: T, current: T, rows: BlockRow[]): BlockRow {
    return {
        change: "changed",
        old: marked({ ...old, children: rows.flatMap(row => row.old ? [row.old] : []) }, "changed"),
        new: marked({ ...current, children: rows.flatMap(row => row.new ? [row.new] : []) }, "changed"),
        unified: [marked({ ...current, children: rows.flatMap(row => row.unified) }, "changed")],
    }
}

// The header row always pairs with the other header, so the unified table keeps one header row.
function tableRow(old: Table, current: Table): BlockRow {
    let [oldHeader, ...oldBody] = old.children
    let [newHeader, ...newBody] = current.children
    let header = canonical(oldHeader!) == canonical(newHeader!) ? unchangedRow(oldHeader!, newHeader!) : changedRows(oldHeader!, newHeader!, false)[0]!
    return containerRow(old, current, [header, ...diffBlocks(oldBody, newBody, false)])
}

function cellRow(old: TableCell, current: TableCell) {
    return canonical(old) == canonical(current) ? unchangedRow(old, current) : phrasingRows(old, current, false)[0]!
}

function codeRow(old: Code | Yaml, current: Code | Yaml): BlockRow {
    let lines = diffArrays(old.value.split("\n"), current.value.split("\n")).flatMap(change => {
        let kind: DiffChange = change.added ? "added" : change.removed ? "removed" : "unchanged"
        return change.value.map(text => ({ text, change: kind }))
    })
    let code = (block: Code | Yaml, shown: (change: DiffChange) => boolean): DiffCode =>
        marked({ type: "diffCode", lang: block.type == "yaml" ? "yaml" : block.lang, lines: lines.filter(line => shown(line.change)) }, "changed")
    return {
        change: "changed",
        old: code(old, change => change != "added"),
        new: code(current, change => change != "removed"),
        unified: [code(current, () => true)],
    }
}

function unchangedRow(old: RootContent, current: RootContent): BlockRow {
    return { change: "unchanged", old, new: current, unified: [current] }
}

function removedRow(block: RootContent): BlockRow {
    let node = marked(block, "removed")
    return { change: "removed", old: node, unified: [node] }
}

function addedRow(block: RootContent): BlockRow {
    let node = marked(block, "added")
    return { change: "added", new: node, unified: [node] }
}
