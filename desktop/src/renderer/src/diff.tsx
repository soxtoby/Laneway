import type { DiffLayout, FileDiffPage } from "@git-workbench/shared"
import { DiffHunksRenderer, wrapCoreCSS, wrapThemeCSS } from "@pierre/diffs"
import { css, type Handle, on, ref } from "remix/ui"
import { pierrePatch } from "./diff-patch"

export function DiffLines(handle: Handle<{ page: FileDiffPage; layout: DiffLayout; selected: number[]; select(ids: number[]): void }>) {
    let viewer: DiffHunksRenderer | undefined
    let shadow: ShadowRoot
    let sheet: CSSStyleSheet
    let start = 0
    let previous: FileDiffPage | undefined
    let diff: ReturnType<typeof pierrePatch>
    let rendered = ""
    function decorate() {
        const { page, selected, select } = handle.props
        if (!shadow)
            return
        for (const element of shadow.querySelectorAll<HTMLElement>("[data-line], [data-column-number]")) {
            const kind = element.dataset.lineType?.includes("addition") ? "addition" : element.dataset.lineType?.includes("deletion") ? "deletion" : undefined
            if (!kind)
                continue
            const number = Number(element.dataset.line ?? element.dataset.columnNumber)
            const line = page.lines.find(line => line.kind == kind && (kind == "addition" ? line.newLine : line.oldLine) == number)
            if (!line)
                continue
            element.classList.toggle("selected", selected.includes(line.id))
            if (element.hasAttribute("data-line")) {
                element.classList.add("diff-line", kind)
                element.dataset.lineId = String(line.id)
            } else if (page.selectable) {
                let button = element.querySelector("button")
                if (!button) {
                    button = document.createElement("button")
                    button.type = "button"
                    button.textContent = String(number)
                    button.setAttribute("aria-label", `Select ${kind} line ${number}`)
                    button.onclick = event => {
                        event.stopPropagation()
                        select([line.id])
                    }
                    element.replaceChildren(button)
                }
                button.setAttribute("aria-pressed", String(selected.includes(line.id)))
            }
        }
    }
    function render(force = false) {
        if (!viewer)
            return
        const { page, layout } = handle.props
        if (previous != page) {
            diff = pierrePatch(page)
            previous = page
            rendered = ""
        }
        const appearance = document.documentElement.dataset.appearance == "dark" ? "dark" : "light"
        const key = `${layout}:${appearance}:${start}`
        if (!force && rendered == key) {
            decorate()
            return
        }
        viewer.setOptions({
            diffStyle: layout,
            themeType: appearance,
            preferredHighlighter: "shiki-js",
            disableFileHeader: true,
            hunkSeparators: "metadata",
        })
        if (!diff) {
            shadow.replaceChildren()
            return
        }
        const total = layout == "split" ? diff.splitLineCount : diff.unifiedLineCount
        const first = Math.min(start, Math.max(0, total - 60))
        const result = viewer.renderDiff(diff, { startingLine: first, totalLines: 80, bufferBefore: 0, bufferAfter: 0 })
        if (!result)
            return
        sheet.replaceSync(wrapCoreCSS("") + wrapThemeCSS(result.themeStyles, appearance) + diffCSS)
        const before = document.createElement("div")
        before.style.height = `${first * 24}px`
        const after = document.createElement("div")
        after.style.height = `${Math.max(0, total - first - 80) * 24}px`
        shadow.replaceChildren(before, astNode(viewer.renderFullAST(result)), after)
        rendered = key
        decorate()
    }
    return () => {
        handle.queueTask(() => render())
        const { page, layout, select } = handle.props
        return (
            <>
                {page.selectable
                    && page.lines.filter(line => line.kind == "hunk").map(line => (
                        <button
                            type="button"
                            disabled={page.nextOffset != undefined && page.lines.at(-1)?.hunk == line.hunk}
                            title={line.text}
                            mix={on("click", () =>
                                select(
                                    page.lines.filter(candidate => candidate.hunk == line.hunk && ["addition", "deletion"].includes(candidate.kind)).map(line =>
                                        line.id
                                    ),
                                ))}
                        >
                            Select hunk
                        </button>
                    ))}
                {page.lines.filter(line => line.kind == "notice").map(line => <div class="diff-line notice" mix={notice}>{line.text}</div>)}
                <div
                    class={`pierre-diff diff-lines ${layout}`}
                    aria-label="Changed lines"
                    tabIndex={0}
                    mix={[
                        viewport,
                        on("scroll", event => {
                            const next = Math.max(0, Math.floor(event.currentTarget.scrollTop / 24) - 10)
                            if (next != start) {
                                start = next
                                render()
                            }
                        }),
                        ref((element, signal) => {
                            shadow = element.attachShadow({ mode: "open" })
                            sheet = new CSSStyleSheet()
                            shadow.adoptedStyleSheets = [sheet]
                            viewer = new DiffHunksRenderer(undefined, undefined, () => render(true))
                            const observer = new MutationObserver(() => render())
                            observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] })
                            signal.addEventListener("abort", () => {
                                observer.disconnect()
                                viewer?.cleanUp()
                                viewer = undefined
                            })
                            render()
                        }),
                    ]}
                />
            </>
        )
    }
}

const viewport = css({ maxHeight: "480px", overflow: "auto", userSelect: "text" })
const notice = css({ position: "static", height: "24px", font: "12px/24px var(--mono)", color: "var(--muted)" })

// Apply Pierre's HAST through DOM/CSSOM APIs: HTML style attributes and style
// elements are rejected by the renderer's strict Content Security Policy.
function astNode(node: ReturnType<DiffHunksRenderer["renderFullAST"]>["children"][number]): Node {
    if (node.type == "text")
        return document.createTextNode(node.value)
    if (node.type == "comment")
        return document.createComment(node.value)
    const element = document.createElement(node.tagName)
    for (const [key, value] of Object.entries(node.properties)) {
        if (value == null || value === false)
            continue
        if (key == "style")
            element.style.cssText = String(value)
        else
            element.setAttribute(key == "className" ? "class" : key, Array.isArray(value) ? value.join(" ") : value === true ? "" : String(value))
    }
    element.append(...node.children.map(astNode))
    return element
}

const diffCSS = `:host { --diffs-font-family: var(--mono); --diffs-font-size: 12px; --diffs-line-height: 24px; }
    .selected { background: var(--accent-wash-strong) !important; }
    [data-gutter] button { all: unset; cursor: pointer; width: 100%; text-align: right; }
    [data-gutter] button:focus-visible { outline: 2px solid var(--accent); }`
