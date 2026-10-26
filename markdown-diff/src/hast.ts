import type { Element, ElementContent, Properties, Root } from "hast"
import { raw } from "hast-util-raw"
import { defaultSchema, sanitize, type Schema } from "hast-util-sanitize"
import type { Delete, FootnoteDefinition, FootnoteReference, Nodes, RootContent, Yaml } from "mdast"
import { type Handlers, type State, toHast } from "mdast-util-to-hast"
import { visit } from "unist-util-visit"
import type { DiffCode, DiffDelete, DiffInsert, DiffModified } from "./nodes"

// GitHub's sanitizing schema, which keeps the HTML a README may embed, plus the attributes that mark changes.
// Without <source>, a <picture> shows its <img>, so a consumer that loads pictures itself loads that one.
let markAttributes = ["dataDiff", "dataDiffBefore", "dataDiffStamp"]
let schema: Schema = {
    ...defaultSchema,
    tagNames: defaultSchema.tagNames!.filter(tagName => tagName != "source"),
    attributes: { ...defaultSchema.attributes, "*": [...defaultSchema.attributes?.["*"] ?? [], ...markAttributes] },
}

let handlers: Handlers = {
    diffInsert: (state, node: DiffInsert) => element(state, node, "ins", { dataDiff: "added" }),
    diffDelete: (state, node: DiffDelete) => element(state, node, "del", { dataDiff: "removed" }),
    diffModified: (state, node: DiffModified) =>
        element(state, node, "span", { dataDiff: "modified", ...node.before ? { dataDiffBefore: node.before.join(" ") } : {} }),
    // Strikethrough draws as <s>, leaving <del> to deletions.
    delete: (state, node: Delete) => element(state, node, "s", {}),
    diffCode(state, node: DiffCode) {
        let children = node.lines.map((line): ElementContent => {
            let text = { type: "text" as const, value: `${line.text}\n` }
            return line.change == "unchanged" ? text : { type: "element", tagName: "span", properties: { dataDiff: line.change }, children: [text] }
        })
        let code: Element = { type: "element", tagName: "code", properties: node.lang ? { className: [`language-${node.lang}`] } : {}, children }
        return state.applyData(node, { type: "element", tagName: "pre", properties: {}, children: [code] })
    },
    yaml: (state, node: Yaml) => state.applyData(node, state.handlers.code!(state, { type: "code", lang: "yaml", value: node.value }, undefined) as Element),
    // Each block renders on its own, so footnotes show their labels where they're cited and defined.
    footnoteReference: (state, node: FootnoteReference) => state.applyData(node, footnoteLabel(node.label ?? node.identifier)),
    footnoteDefinition: (state, node: FootnoteDefinition) =>
        element(state, node, "div", {}, [footnoteLabel(node.label ?? node.identifier), { type: "text", value: " " }, ...state.wrap(state.all(node), true)]),
}

/** A block as HTML elements: embedded HTML parsed in place, and everything sanitized as GitHub would. */
export function toHastContent(block: RootContent): ElementContent[] {
    let tree = toHast(block, { allowDangerousHtml: true, handlers })
    let root: Root = tree.type == "root" ? tree : { type: "root", children: [tree as ElementContent] }
    if (!hasRaw(root))
        return (sanitize(root, schema) as Root).children as ElementContent[]

    // Embedded HTML could write the attributes that mark changes, so the engine stamps its own marks before parsing it
    // and strips the marks of every element without the stamp once it's sanitized.
    let stamp = crypto.randomUUID()
    visit(root, "element", element => {
        if (element.properties.dataDiff != undefined)
            element.properties.dataDiffStamp = stamp
    })
    let clean = sanitize(raw(root), schema) as Root
    visit(clean, "element", element => {
        if (element.properties.dataDiffStamp != stamp)
            markAttributes.forEach(attribute => delete element.properties[attribute])
        delete element.properties.dataDiffStamp
    })
    return clean.children as ElementContent[]
}

function element(state: State, node: Nodes, tagName: string, properties: Properties, children = state.all(node)): Element {
    let result: Element = { type: "element", tagName, properties, children }
    state.patch(node, result)
    return state.applyData(node, result)
}

function footnoteLabel(label: string): Element {
    return { type: "element", tagName: "sup", properties: {}, children: [{ type: "text", value: `[${label}]` }] }
}

function hasRaw(root: Root) {
    let found = false
    visit(root, "raw", () => {
        found = true
    })
    return found
}
