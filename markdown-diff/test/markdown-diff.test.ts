import { expect, test } from "bun:test"
import type { ElementContent } from "hast"
import { toHtml } from "hast-util-to-html"
import { diffMarkdown, type DiffRow } from "../src/index"

test("diffMarkdown shows words replaced in a paragraph beside the words that replaced them", () => {
    let [result] = rows("Laneway stores them in the old branch.\n", "Laneway keeps them in the previous branch.\n")

    expect(result).toEqual({
        change: "changed",
        old: `<p data-diff="changed">Laneway ${del("stores")} them in the ${del("old")} branch.</p>`,
        new: `<p data-diff="changed">Laneway ${ins("keeps")} them in the ${ins("previous")} branch.</p>`,
        unified: `<p data-diff="changed">Laneway ${del("stores")}${ins("keeps")} them in the ${del("old")}${ins("previous")} branch.</p>`,
    })
})

test("diffMarkdown folds short surviving words between edits into one replacement", () => {
    let [result] = rows(
        "The column keeps its identity and its Active Stack while the session runs.\n",
        "The column keeps its identity and shows the stack it edits while the session runs.\n",
    )

    expect(result!.unified).toBe(
        `<p data-diff="changed">The column keeps its identity and ${del("its Active Stack")}${ins("shows the stack it edits")} while the session runs.</p>`,
    )
})

test("diffMarkdown keeps a paragraph whose lines were only rewrapped unchanged", () => {
    let result = rows("One long sentence\nwrapped across lines.\n", "One long sentence wrapped\nacross lines.\n")

    expect(result.map(row => row.change)).toEqual(["unchanged"])
})

test("diffMarkdown shows a rewritten paragraph as removed and added", () => {
    let result = rows("Old prose about tooltips.\n", "Brand new text describing the branch graph.\n")

    expect(result).toEqual([{
        change: "removed",
        old: `<p data-diff="removed">Old prose about tooltips.</p>`,
        unified: `<p data-diff="removed">Old prose about tooltips.</p>`,
    }, {
        change: "added",
        new: `<p data-diff="added">Brand new text describing the branch graph.</p>`,
        unified: `<p data-diff="added">Brand new text describing the branch graph.</p>`,
    }])
})

test("diffMarkdown aligns unchanged blocks around added and removed ones", () => {
    let result = rows("# Title\n\nAlpha.\n\nBeta.\n", "# Title\n\nBeta.\n\nGamma.\n")

    expect(result.map(row => [row.change, row.unified])).toEqual([["unchanged", "<h1>Title</h1>"], ["removed", `<p data-diff="removed">Alpha.</p>`], [
        "unchanged",
        "<p>Beta.</p>",
    ], ["added", `<p data-diff="added">Gamma.</p>`]])
})

test("diffMarkdown marks words whose formatting alone changed with the formatting they had", () => {
    let [result] = rows("Apply it immediately, as [the ADR](old.md) says.\n", "Apply it **immediately**, as [the ADR](new.md) says.\n")

    expect(result!.unified).toBe(
        `<p data-diff="changed">Apply it <strong>${modified("immediately", "")}</strong>, as <a href="new.md">${
            modified("the ADR", "link=old.md")
        }</a> says.</p>`,
    )
    expect(result!.old).toBe(`<p data-diff="changed">Apply it ${modified("immediately")}, as <a href="old.md">${modified("the ADR")}</a> says.</p>`)
})

test("diffMarkdown keeps an edit inside formatting within the formatted element", () => {
    let [result] = rows("Keep **both words**.\n", "Keep **both names**.\n")

    expect(result!.unified).toBe(`<p data-diff="changed">Keep <strong>both ${del("words")}${ins("names")}</strong>.</p>`)
})

test("diffMarkdown pairs edited list items and marks inserted ones", () => {
    let [result] = rows("- First item\n- Second item\n- Third item\n", "- First item\n- A brand new item\n- Second item, edited\n- Third item\n")

    expect(result!.unified).toBe(
        [
            `<ul data-diff="changed">`,
            "<li>First item</li>",
            `<li data-diff="added">A brand new item</li>`,
            `<li data-diff="changed">Second item${ins(", edited")}</li>`,
            "<li>Third item</li>",
            "</ul>",
        ].join("\n"),
    )
    expect(result!.old).toBe(
        [`<ul data-diff="changed">`, "<li>First item</li>", `<li data-diff="changed">Second item</li>`, "<li>Third item</li>", "</ul>"].join("\n"),
    )
})

test("diffMarkdown compares tables cell by cell under one header", () => {
    let [result] = rows("| Name | Rows |\n|---|---|\n| File | 28px |\n", "| Kind | Rows |\n|---|---|\n| File | 30px |\n| Commit | 32px |\n")

    expect(result!.unified.replaceAll("\n", "")).toBe(
        [
            `<table data-diff="changed"><thead>`,
            `<tr data-diff="changed"><th data-diff="changed">${del("Name")}${ins("Kind")}</th><th>Rows</th></tr>`,
            `</thead><tbody>`,
            `<tr data-diff="changed"><td>File</td><td data-diff="changed">${del("28px")}${ins("30px")}</td></tr>`,
            `<tr data-diff="added"><td>Commit</td><td>32px</td></tr>`,
            `</tbody></table>`,
        ].join(""),
    )
})

test("diffMarkdown compares code blocks line by line", () => {
    let [result] = rows("```ts\nlet a = 1\nlet b = 2\n```\n", "```ts\nlet a = 1\nlet b = 3\n```\n")

    expect(result).toEqual({
        change: "changed",
        old: `<pre data-diff="changed"><code class="language-ts">let a = 1\n<span data-diff="removed">let b = 2\n</span></code></pre>`,
        new: `<pre data-diff="changed"><code class="language-ts">let a = 1\n<span data-diff="added">let b = 3\n</span></code></pre>`,
        unified:
            `<pre data-diff="changed"><code class="language-ts">let a = 1\n<span data-diff="removed">let b = 2\n</span><span data-diff="added">let b = 3\n</span></code></pre>`,
    })
})

test("diffMarkdown shows front matter as YAML compared line by line", () => {
    let [result] = rows("---\ntitle: Old\ntags: [a]\n---\n\nBody.\n", "---\ntitle: New\ntags: [a]\n---\n\nBody.\n")

    expect(result!.unified).toBe(
        `<pre data-diff="changed"><code class="language-yaml"><span data-diff="removed">title: Old\n</span><span data-diff="added">title: New\n</span>tags: [a]\n</code></pre>`,
    )
})

test("diffMarkdown shows every block as added when there's no old version", () => {
    let result = rows(undefined, "# Title\n\nBody.\n")

    expect(result).toEqual([{ change: "added", new: `<h1 data-diff="added">Title</h1>`, unified: `<h1 data-diff="added">Title</h1>` }, {
        change: "added",
        new: `<p data-diff="added">Body.</p>`,
        unified: `<p data-diff="added">Body.</p>`,
    }])
})

test("diffMarkdown resolves reference links and drops their definitions", () => {
    let result = rows(undefined, "See [the guide][guide] and ![logo][].\n\n[guide]: docs/guide.md\n[logo]: assets/logo.png\n")

    expect(result.map(row => row.unified)).toEqual([
        `<p data-diff="added">See <a href="docs/guide.md">the guide</a> and <img src="assets/logo.png" alt="logo">.</p>`,
    ])
})

test("diffMarkdown renders embedded HTML sanitized as GitHub does", () => {
    let result = rows(
        undefined,
        `<p align="center"><img src="logo.png" width="120" onerror="alert(1)"></p>\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n`,
    )

    expect(result.map(row => row.unified)).toEqual([`<p align="center"><img src="logo.png" width="120"></p>`, "", `<p data-diff="added"><a>x</a></p>`])
})

test("diffMarkdown strips change marks that embedded HTML writes itself", () => {
    let [result] = rows(undefined, `Plain <span data-diff="modified" data-diff-before="link=%E0">forged</span>.\n`)

    expect(result!.unified).toBe(`<p data-diff="added">Plain <span>forged</span>.</p>`)
})

test("diffMarkdown shows a picture element's own image rather than its sources", () => {
    let result = rows(undefined, `<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" alt="Logo"></picture>\n`)

    expect(result.map(row => row.unified)).toEqual([`<p data-diff="added"><picture><img src="light.png" alt="Logo"></picture></p>`])
})

test("diffMarkdown compares code the same whatever its line endings", () => {
    let result = rows("```ts\nlet a = 1\nlet b = 2\n```\n", "```ts\r\nlet a = 1\r\nlet b = 2\r\n```\r\n")

    expect(result.map(row => row.change)).toEqual(["unchanged"])
})

test("diffMarkdown draws strikethrough as s, leaving del to deletions", () => {
    let [result] = rows(undefined, "Some ~~struck~~ text.\n")

    expect(result!.unified).toBe(`<p data-diff="added">Some <s>struck</s> text.</p>`)
})

function rows(oldSource: string | undefined, newSource: string | undefined) {
    return diffMarkdown(oldSource, newSource).rows.map(html)
}

function html(row: DiffRow) {
    let render = (nodes: ElementContent[]) => toHtml({ type: "root", children: nodes })
    return {
        change: row.change,
        ...row.old ? { old: render(row.old) } : {},
        ...row.new ? { new: render(row.new) } : {},
        unified: render(row.unified),
    }
}

function del(text: string) {
    return `<del data-diff="removed">${text}</del>`
}

function ins(text: string) {
    return `<ins data-diff="added">${text}</ins>`
}

function modified(text: string, before?: string) {
    return before == undefined ? `<span data-diff="modified">${text}</span>` : `<span data-diff="modified" data-diff-before="${before}">${text}</span>`
}
