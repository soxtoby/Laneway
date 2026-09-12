import type { DiffLayout, FileDiffPage } from "@git-workbench/shared"
import { DiffHunksRenderer, wrapCoreCSS, wrapThemeCSS } from "@pierre/diffs"
import { css, type Handle, ref } from "remix/ui"
import { pierrePatch } from "./diff-patch"

export function DiffLines(
    handle: Handle<{ page: FileDiffPage; layout: DiffLayout; showWhitespace: boolean; selected: number[]; select(ids: number[]): void }>,
) {
    let viewer: DiffHunksRenderer | undefined
    let shadow: ShadowRoot
    let sheet: CSSStyleSheet
    let start = 0
    let host: HTMLElement
    let scrollContainer: HTMLElement | null
    let lifetime: AbortSignal
    let previous: FileDiffPage | undefined
    let diff: ReturnType<typeof pierrePatch>
    let rendered = ""
    let horizontalOffset = 0
    const syncedOffsets = new WeakMap<HTMLElement, number>()
    const scroll = () => render()
    function syncHorizontal(source?: HTMLElement) {
        if (source) {
            if (syncedOffsets.get(source) == source.scrollLeft)
                return
            horizontalOffset = source.scrollLeft
        }
        for (const pane of shadow.querySelectorAll<HTMLElement>("[data-code]")) {
            pane.scrollLeft = horizontalOffset
            // Remember the clamped offset so the resulting scroll event cannot
            // pull a wider pane back to the narrower pane's limit.
            syncedOffsets.set(pane, pane.scrollLeft)
        }
    }
    function decorate() {
        const { page, selected, select } = handle.props
        if (!shadow)
            return
        if (handle.props.showWhitespace) {
            for (const line of shadow.querySelectorAll("[data-line]")) {
                const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
                const whitespace: Text[] = []
                while (walker.nextNode()) {
                    const node = walker.currentNode as Text
                    if (/[ \t]/.test(node.data) && !node.parentElement?.closest("[data-whitespace]"))
                        whitespace.push(node)
                }
                for (const node of whitespace) {
                    node.replaceWith(
                        ...node.data.split(/([ \t])/).map(text => {
                            if (text != " " && text != "\t")
                                return document.createTextNode(text)
                            const marker = document.createElement("span")
                            marker.dataset.whitespace = text == "\t" ? "tab" : "space"
                            marker.textContent = text
                            return marker
                        }),
                    )
                }
                const number = Number(line.getAttribute("data-line"))
                const kind = line.getAttribute("data-line-type") ?? ""
                const source = page.lines.find(candidate =>
                    kind.includes("deletion")
                        ? candidate.kind == "deletion" && candidate.oldLine == number
                        : kind.includes("addition")
                        ? candidate.kind == "addition" && candidate.newLine == number
                        : candidate.kind == "context"
                            && (line.closest("[data-deletions]") ? candidate.oldLine : candidate.newLine ?? candidate.oldLine) == number
                )
                const ending = `${source?.text.endsWith("\r") ? "CR" : ""}${line.nextElementSibling?.hasAttribute("data-no-newline") ? "" : "LF"}`
                if (ending && !line.querySelector("[data-whitespace=line-ending]")) {
                    const marker = document.createElement("span")
                    marker.dataset.whitespace = "line-ending"
                    marker.dataset.ending = ending
                    marker.setAttribute("aria-hidden", "true")
                    marker.title = ending
                    // Highlighted lines retain their newline text. Insert before
                    // it so the marker stays on the same physical row.
                    const text = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
                    let last: Text | undefined
                    while (text.nextNode()) {
                        if (text.currentNode.textContent)
                            last = text.currentNode as Text
                    }
                    const suffix = last?.data.match(/[\r\n]+$/)
                    if (last && suffix)
                        last.parentNode!.insertBefore(marker, last.splitText(last.length - suffix[0].length))
                    else
                        line.append(marker)
                }
            }
        }
        const hunks = [...new Set(page.lines.filter(line => ["addition", "deletion", "context"].includes(line.kind)).map(line => line.hunk))]
        for (const header of shadow.querySelectorAll<HTMLElement>("[data-separator='metadata'] [data-separator-wrapper]")) {
            if (header.closest("[data-gutter]") || !page.selectable)
                continue
            const index = header.dataset.hunkIndex == undefined
                ? diff?.hunks.findIndex(hunk => hunk.hunkSpecs == header.textContent) ?? -1
                : Number(header.dataset.hunkIndex)
            if (index < 0)
                continue
            header.dataset.hunkIndex = String(index)
            const hunk = hunks[index]
            const ids = page.lines.filter(line => line.hunk == hunk && ["addition", "deletion"].includes(line.kind)).map(line => line.id)
            let button = header.querySelector("button")
            if (!button) {
                button = document.createElement("button")
                button.type = "button"
                button.className = "select-hunk"
                button.textContent = "✓"
                button.title = "Select hunk"
                button.setAttribute("aria-label", "Select hunk")
                header.prepend(button)
            }
            button.disabled = ids.length == 0 || page.nextOffset != undefined && page.lines.at(-1)?.hunk == hunk
            button.setAttribute("aria-pressed", String(ids.length > 0 && ids.every(id => selected.includes(id))))
            button.onclick = event => {
                event.stopPropagation()
                select(ids)
            }
        }
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
        // Follow the actual vertical viewport, including source-linked columns.
        // A list of column classes leaves new hosts stuck on the first 80 lines.
        let container = host.parentElement
        while (container && !["auto", "scroll", "overlay"].includes(getComputedStyle(container).overflowY))
            container = container.parentElement
        if (container != scrollContainer) {
            scrollContainer?.removeEventListener("scroll", scroll)
            scrollContainer = container
            scrollContainer?.addEventListener("scroll", scroll, { signal: lifetime, passive: true })
        }
        if (scrollContainer) {
            start = Math.max(
                0,
                Math.floor((scrollContainer.getBoundingClientRect().top + scrollContainer.clientTop - host.getBoundingClientRect().top) / 24) - 10,
            )
        }
        const { page, layout } = handle.props
        if (previous != page) {
            diff = pierrePatch(page)
            previous = page
            rendered = ""
        }
        const appearance = document.documentElement.dataset.appearance == "dark" ? "dark" : "light"
        const key = `${layout}:${appearance}:${start}:${handle.props.showWhitespace}`
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
            lineDiffType: "char",
            maxLineDiffLength: 10000,
        })
        if (!diff) {
            shadow.replaceChildren()
            return
        }
        // File-wide counts include collapsed context before/between hunks.
        const total = diff.hunks.reduce((count, hunk) => count + (layout == "split" ? hunk.splitLineCount : hunk.unifiedLineCount), 0)
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
        // Pierre omits a separator when a hunk starts at the beginning of the file.
        // Keep its selection control available in that case too.
        for (const code of shadow.querySelectorAll<HTMLElement>("[data-code]")) {
            for (const hunk of diff.hunks) {
                if (hunk.collapsedBefore > 0)
                    continue
                const content = code.querySelector<HTMLElement>("[data-content]")!
                const gutter = code.querySelector<HTMLElement>("[data-gutter]")!
                const line = [...content.querySelectorAll<HTMLElement>("[data-line-index]")].find(element =>
                    Number(element.dataset.lineIndex?.split(",")[layout == "split" ? 1 : 0])
                        == (layout == "split" ? hunk.splitLineStart : hunk.unifiedLineStart)
                )
                if (!line)
                    continue
                const header = document.createElement("div")
                header.dataset.separator = "metadata"
                const wrapper = document.createElement("div")
                wrapper.dataset.separatorWrapper = ""
                wrapper.textContent = hunk.hunkSpecs ?? "Changes"
                header.append(wrapper)
                content.insertBefore(header, line)
                const number = [...gutter.children].find(element => element.getAttribute("data-line-index") == line.dataset.lineIndex)
                gutter.insertBefore(header.cloneNode(true), number ?? null)
                for (const column of [content, gutter])
                    column.style.gridRow = `span ${Number(column.style.gridRow.replace("span ", "")) + 1}`
            }
        }
        rendered = key
        decorate()
        syncHorizontal()
    }
    return () => {
        handle.queueTask(() => render())
        const { page, layout } = handle.props
        return (
            <>
                {page.lines.filter(line => line.kind == "notice" && !line.text.startsWith("\\ No newline")).map(line => (
                    <div class="diff-line notice" mix={notice}>{line.text}</div>
                ))}
                <div
                    class={`pierre-diff diff-lines ${layout}`}
                    aria-label="Changed lines"
                    tabIndex={0}
                    mix={[
                        viewport,
                        ref((element, signal) => {
                            host = element
                            lifetime = signal
                            shadow = element.attachShadow({ mode: "open" })
                            shadow.addEventListener("scroll", event => {
                                const pane = event.target
                                if (pane instanceof HTMLElement && pane.hasAttribute("data-code"))
                                    syncHorizontal(pane)
                            }, { capture: true, passive: true, signal })
                            sheet = new CSSStyleSheet()
                            shadow.adoptedStyleSheets = [sheet]
                            viewer = new DiffHunksRenderer(undefined, undefined, () => render(true))
                            const observer = new MutationObserver(() => render())
                            observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] })
                            const resize = new ResizeObserver(() => render())
                            resize.observe(element)
                            if (scrollContainer)
                                resize.observe(scrollContainer)
                            signal.addEventListener("abort", () => {
                                observer.disconnect()
                                resize.disconnect()
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

const viewport = css({ overflow: "visible", userSelect: "text" })
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
    [data-code] { padding-top: 0; }
    [data-whitespace] { position: relative; }
    [data-whitespace]::before { position: absolute; left: 0; color: var(--muted); pointer-events: none; user-select: none; }
    [data-whitespace=space]::before { content: "·"; }
    [data-whitespace=tab]::before { content: "→"; }
    [data-whitespace=line-ending] { margin-left: .5ch; }
    [data-whitespace=line-ending]::before { position: static; line-height: 0; }
    [data-whitespace=line-ending][data-ending=CR]::before { content: "←"; }
    [data-whitespace=line-ending][data-ending=LF]::before { content: "↓"; }
    [data-whitespace=line-ending][data-ending=CRLF]::before { content: "↵"; }
    .selected { background: var(--accent-wash-strong) !important; }
    [data-gutter] button { all: unset; cursor: pointer; width: 100%; text-align: right; }
    [data-gutter] button:focus-visible, .select-hunk:focus-visible { outline: 2px solid var(--accent); }
    .select-hunk { font: inherit; width: 22px; height: 22px; padding: 0; margin-right: 6px; border: 0;
        border-radius: 3px; background: transparent; color: inherit; cursor: pointer; }
    .select-hunk:hover, .select-hunk[aria-pressed=true] { background: var(--accent-wash-strong); }
    .select-hunk:disabled { opacity: .4; cursor: default; }`
