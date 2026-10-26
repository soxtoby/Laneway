import type { Definition, Root, RootContent } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import { frontmatterFromMarkdown } from "mdast-util-frontmatter"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { frontmatter } from "micromark-extension-frontmatter"
import { gfm } from "micromark-extension-gfm"
import { SKIP, visit } from "unist-util-visit"

/**
 * A document's blocks, parsed as GitHub Flavored Markdown with YAML front matter. References resolve to the links
 * and images they name, so each block renders alone; the definitions themselves render nothing and are dropped.
 */
export function parseMarkdown(source: string): RootContent[] {
    // Code and front matter keep their line endings, which a worktree may convert to CRLF.
    let tree = fromMarkdown(source.replace(/\r\n?/g, "\n"), {
        extensions: [gfm(), frontmatter()],
        mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown()],
    })
    resolveReferences(tree)
    return tree.children.filter(node => node.type != "definition")
}

function resolveReferences(tree: Root) {
    let definitions = new Map<string, Definition>()
    visit(tree, "definition", node => {
        if (!definitions.has(node.identifier))
            definitions.set(node.identifier, node)
    })

    visit(tree, (node, index, parent) => {
        if (node.type != "linkReference" && node.type != "imageReference" || !parent || index == undefined)
            return

        let definition = definitions.get(node.identifier)
        if (!definition)
            return

        let target = { url: definition.url, title: definition.title, position: node.position }
        parent.children[index] = node.type == "linkReference"
            ? { type: "link", ...target, children: node.children }
            : { type: "image", ...target, alt: node.alt }
        return node.type == "imageReference" ? SKIP : undefined
    })
}
