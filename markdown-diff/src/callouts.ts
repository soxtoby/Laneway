import type { BlockContent, Blockquote, DefinitionContent, Parent, PhrasingContent, RootContent } from "mdast"
import type { ContainerDirective } from "mdast-util-directive"
import { directive } from "micromark-extension-directive"
import type { Callout } from "./nodes"

// The kinds GitHub's alerts and Docusaurus' admonitions call out, and the titles they show unless given another.
let titles = new Map([["note", "Note"], ["tip", "Tip"], ["important", "Important"], ["warning", "Warning"], ["caution", "Caution"], ["info", "Info"], [
    "danger",
    "Danger",
]])

let kinds = [...titles.keys()].join("|")
// Docusaurus' older `:::note Title`, which directive syntax would read as a paragraph.
let legacyTitle = new RegExp(`^([ \\t]*(?:>[ \\t]?)*[ \\t]*:{3,}(?:${kinds}))[ \\t]+([^[\\]{\\s][^[\\]\\n]*?)[ \\t]*$`, "i")
let fenceStart = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/
let fenceEnd = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})[ \t]*$/
let alertMarker = /^\[!(\w+)\][ \t]*(?:\n|$)/

/**
 * Container directives (`:::name` … `:::`) alone. Text directives would read prose such as `at 10:30` or `e.g.:x`
 * as directives, and leaf ones aren't callouts.
 */
export function containerDirectives() {
    let [container] = [directive().flow![58]!].flat()
    return { flow: { 58: container! } }
}

/** Rewrites Docusaurus' older `:::note Title` as `:::note[Title]`, outside fenced code, as Docusaurus does. */
export function labelLegacyTitles(source: string) {
    let fence: string | undefined
    return source.split("\n").map(line => {
        if (fence) {
            let end = fenceEnd.exec(line)?.[1]
            if (end && end[0] == fence[0] && end.length >= fence.length)
                fence = undefined
            return line
        }
        fence = fenceStart.exec(line)?.[1]
        return fence ? line : line.replace(legacyTitle, "$1[$2]")
    }).join("\n")
}

/**
 * Turns container directives, and blockquotes that open with a GitHub alert's `[!KIND]` on its own line, into callouts.
 */
export function makeCallouts(parent: Parent) {
    parent.children = parent.children.flatMap((child): RootContent[] => {
        if ("children" in child)
            makeCallouts(child)
        if (child.type == "containerDirective")
            return [fromDirective(child)]
        if (child.type == "blockquote")
            return [fromAlert(child) ?? child]
        return [child]
    })
}

function fromDirective(node: ContainerDirective): Callout {
    let kind = node.name.toLowerCase()
    let [first, ...rest] = node.children
    return first?.type == "paragraph" && first.data?.directiveLabel
        ? callout(kind, first.children, rest, node.position)
        : callout(kind, [], node.children, node.position)
}

function fromAlert(quote: Blockquote): Callout | undefined {
    let [first, ...rest] = quote.children
    if (first?.type != "paragraph")
        return
    let [text, ...after] = first.children
    if (text?.type != "text")
        return
    let marker = alertMarker.exec(text.value)
    let kind = marker?.[1]!.toLowerCase()
    if (!marker || !kind || !titles.has(kind))
        return

    let remaining = text.value.slice(marker[0].length)
    let children = remaining ? [{ ...text, value: remaining }, ...after] : after
    // Spaces closing the marker's line break it.
    if (!remaining && children[0]?.type == "break")
        children = children.slice(1)
    return callout(kind, [], children.length ? [{ ...first, children }, ...rest] : rest, quote.position)
}

// A callout of a kind of its own, such as `:::details`, names its kind before any title it's given, since only the
// known kinds show what they are by their colour and icon.
function callout(kind: string, title: PhrasingContent[], body: (BlockContent | DefinitionContent)[], position: Blockquote["position"]): Callout {
    let known = titles.get(kind)
    let name = known ?? kind[0]!.toUpperCase() + kind.slice(1)
    let titleChildren: PhrasingContent[] = !title.length
        ? [{ type: "text", value: name }]
        : known
        ? title
        : [{ type: "text", value: `${name}: ` }, ...title]
    return { type: "callout", kind, children: [{ type: "calloutTitle", children: titleChildren }, ...body], ...position ? { position } : {} }
}
