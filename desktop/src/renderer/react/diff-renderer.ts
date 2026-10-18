import type { DiffLayout, DiffLine, FileDiffPage } from "@laneway/shared"
import { DiffHunksRenderer, type FileDiffLoadedChangedFiles, wrapCoreCSS, wrapThemeCSS } from "@pierre/diffs"
import { iconNodes } from "../src/icon-nodes"
import { contextDiff, visibleDiffLines } from "../src/inspection/diff-context"
import type { pierrePatch } from "../src/inspection/diff-patch"

export interface DiffLinesProps {
    page: FileDiffPage
    layout: DiffLayout
    showWhitespace: boolean
    /** The page's selected line IDs. */
    selected: number[]
    select(ids: number[]): void
    /** Reads the whole file around the page, so hidden lines between hunks can be shown. */
    readContext?(page: FileDiffPage, signal: AbortSignal): Promise<FileDiffLoadedChangedFiles>
}

/** Lookups built once per page, so decorating rendered lines never scans the whole page. */
interface LineIndex {
    /** Keyed by `addition:<new>`, `deletion:<old>`, `context:old:<old>` and `context:new:<new>`. */
    lines: Map<string, DiffLine>
}

// Rendered lines are 24px tall; only those near the scrolling column's viewport are drawn.
let lineHeight = 24
let renderedLines = 80

// Pierre's shadow root takes no page stylesheets, so its rules come from the theme's variables here.
let diffCSS = `:host { --diffs-font-family: var(--font-family-mono); --diffs-font-size: 12px; --diffs-line-height: 24px;
        --diffs-scrollbar-gutter-override: 0px; }
    [data-code] { padding-top: 0; scrollbar-width: none; }
    [data-separator=line-info-basic] { height: 24px; }
    [data-content] [data-separator] [data-separator-wrapper] { display: flex; align-items: center; }
    [data-whitespace] { position: relative; }
    [data-whitespace]::before { position: absolute; left: 0; color: var(--text-color-placeholder); pointer-events: none; user-select: none; }
    [data-whitespace=space]::before { content: "·"; }
    [data-whitespace=tab]::before { content: "→"; }
    [data-whitespace=line-ending] { margin-left: .5ch; }
    [data-whitespace=line-ending]::before { position: static; line-height: 0; }
    [data-whitespace=line-ending][data-ending=CR]::before { content: "←"; }
    [data-whitespace=line-ending][data-ending=LF]::before { content: "↓"; }
    [data-whitespace=line-ending][data-ending=CRLF]::before { content: "↵"; }
    .selected { background: var(--diff-selection) !important; }
    [data-gutter] button { all: unset; cursor: pointer; width: 100%; text-align: right; }
    [data-gutter] button:focus-visible, .expand-context:focus-visible { outline: 2px solid var(--focus-ring-color); }
    .expand-context { all: unset; display: inline-flex; align-items: center; gap: 6px; font: inherit; color: var(--text-color-placeholder);
        cursor: pointer; border-radius: 3px; padding: 0 4px; }
    .expand-context:hover { background: var(--diff-selection); }
    .expand-context:disabled { opacity: .4; cursor: default; }`

/**
 * Draws a diff page with Pierre into a shadow root on `host`, only the lines near the scrolling column's viewport,
 * and keeps one scrollbar pinned under the visible diff in step with every pane. Gutter buttons choose lines, and a
 * gap between hunks shows its hidden lines once the whole file is read.
 */
export function createDiffRenderer(host: HTMLElement, scrollbar: HTMLElement, initial: DiffLinesProps, onContextError: (message?: string) => void) {
    let props = initial
    let lifetime = new AbortController()
    let shadow = host.attachShadow({ mode: "open" })
    let sheet = new CSSStyleSheet()
    shadow.adoptedStyleSheets = [sheet]
    let viewer: DiffHunksRenderer | undefined = new DiffHunksRenderer(undefined, undefined, () => render(true))
    let scrollbarTrack = scrollbar.firstElementChild as HTMLElement
    let start = 0
    let scrollContainer: HTMLElement | null = null
    let previous: FileDiffPage | undefined
    let diff: ReturnType<typeof pierrePatch>
    let index: LineIndex | undefined
    let contextFiles: FileDiffLoadedChangedFiles | undefined
    let contextRead: AbortController | undefined
    let rendered = ""
    // What the rendered lines were last decorated for; decoration is skipped while this holds.
    let decorated = ""
    let horizontalOffset = 0
    let syncedOffsets = new WeakMap<HTMLElement, number>()
    let scroll = () => render()
    let dark = matchMedia("(prefers-color-scheme: dark)")

    // Pierre's own pane scrollbars sit under the drawn window of lines, often out of view; the pinned one drives them all.
    shadow.addEventListener("scroll", event => {
        let pane = event.target
        if (pane instanceof HTMLElement && pane.hasAttribute("data-code"))
            syncHorizontal(pane)
    }, { capture: true, passive: true, signal: lifetime.signal })
    scrollbar.hidden = true
    scrollbar.addEventListener("scroll", () => {
        if (scrollbar.scrollLeft == horizontalOffset)
            return
        horizontalOffset = scrollbar.scrollLeft
        syncHorizontal()
    }, { passive: true, signal: lifetime.signal })
    dark.addEventListener("change", () => render(), { signal: lifetime.signal })
    // A narrower host changes how far the panes overflow, which only this measurement notices.
    let resize = new ResizeObserver(() => {
        render()
        measureScrollbar()
    })
    resize.observe(host)
    render()

    function render(force = false) {
        if (!viewer)
            return
        // Follow the actual vertical viewport. The ancestor walk reads computed styles, so it only repeats once
        // the host has moved into another scrolling container.
        if (!scrollContainer?.isConnected || !scrollContainer.contains(host)) {
            let container = host.parentElement
            while (container && !["auto", "scroll", "overlay"].includes(getComputedStyle(container).overflowY))
                container = container.parentElement
            if (container != scrollContainer) {
                scrollContainer?.removeEventListener("scroll", scroll)
                scrollContainer = container
                scrollContainer?.addEventListener("scroll", scroll, { signal: lifetime.signal, passive: true })
            }
        }
        if (scrollContainer) {
            let offset = scrollContainer.getBoundingClientRect().top + scrollContainer.clientTop - host.getBoundingClientRect().top
            start = Math.max(0, Math.floor(offset / lineHeight) - 10)
        }
        let { page, layout } = props
        if (previous != page) {
            if (previous?.version != page.version || previous?.lines != page.lines) {
                contextRead?.abort()
                contextRead = undefined
                contextFiles = undefined
                onContextError(undefined)
                viewer.setExpandedHunksMap(new Map())
            }
            diff = contextDiff(page, contextFiles)
            index = indexLines(page)
            previous = page
            rendered = ""
        }

        let appearance = dark.matches ? "dark" as const : "light" as const
        let key = `${layout}:${appearance}:${start}:${props.showWhitespace}`
        if (!force && rendered == key) {
            // Nothing drawn changed: at most the selection needs redrawing, which writes nothing when it is the same.
            decorate()
            return
        }

        viewer.setOptions({
            diffStyle: layout,
            themeType: appearance,
            preferredHighlighter: "shiki-js",
            disableFileHeader: true,
            hunkSeparators: "line-info-basic",
            collapsedContextThreshold: 0,
            lineDiffType: "char",
            maxLineDiffLength: 10000,
        })
        if (!diff) {
            shadow.replaceChildren()
            return
        }
        let total = visibleDiffLines(diff, layout, viewer.getExpandedHunksMap())
        let first = Math.min(start, Math.max(0, total - 60))
        let result = viewer.renderDiff(diff, { startingLine: first, totalLines: renderedLines, bufferBefore: 0, bufferAfter: 0 })
        if (!result)
            return
        sheet.replaceSync(wrapCoreCSS("") + wrapThemeCSS(result.themeStyles, appearance) + diffCSS)
        let before = document.createElement("div")
        before.style.height = `${first * lineHeight}px`
        let after = document.createElement("div")
        after.style.height = `${Math.max(0, total - first - renderedLines) * lineHeight}px`
        shadow.replaceChildren(before, astNode(viewer.renderFullAST(result)), after)

        for (let code of shadow.querySelectorAll<HTMLElement>("[data-code]")) {
            let type = code.hasAttribute("data-deletions") ? "deletions" : code.hasAttribute("data-additions") ? "additions" : "unified"
            let gaps = result.hunkData.filter(gap => gap.type == type)
            for (let column of code.querySelectorAll<HTMLElement>("[data-content], [data-gutter]")) {
                for (let [position, wrapper] of [...column.querySelectorAll<HTMLElement>("[data-separator-wrapper]")].entries()) {
                    let gap = gaps[position]
                    wrapper.dataset.hunkIndex = String(gap?.hunkIndex)
                    wrapper.dataset.hiddenLines = String(gap?.lines ?? 0)
                    wrapper.replaceChildren()
                }
            }
        }

        rendered = key
        decorated = ""
        decorate()
        measureScrollbar()
        syncHorizontal()
    }

    async function expandContext(position: number, count: number) {
        if (!viewer || !diff || contextRead || !props.readContext)
            return
        let page = props.page
        let controller = new AbortController()
        contextRead = controller
        onContextError(undefined)
        render(true)
        try {
            if (!contextFiles) {
                let files = await props.readContext(page, AbortSignal.any([lifetime.signal, controller.signal]))
                controller.signal.throwIfAborted()
                if (props.page.version != page.version || props.page.lines != page.lines)
                    controller.abort()
                controller.signal.throwIfAborted()
                contextFiles = files
                diff = contextDiff(page, files)
            }
            // The last gap expands forward from the final hunk; earlier gaps expand from their start.
            viewer.expandHunk(position, "up", count)
        } catch (error) {
            if (!controller.signal.aborted)
                onContextError(error instanceof Error ? error.message : String(error))
        } finally {
            if (contextRead == controller) {
                contextRead = undefined
                render(true)
            }
        }
    }

    function syncHorizontal(source?: HTMLElement) {
        if (source) {
            if (syncedOffsets.get(source) == source.scrollLeft)
                return
            horizontalOffset = source.scrollLeft
        }
        for (let pane of shadow.querySelectorAll<HTMLElement>("[data-code]")) {
            pane.scrollLeft = horizontalOffset
            // Remember the clamped offset, so the resulting scroll event can't pull a wider pane back to the narrower one's limit.
            syncedOffsets.set(pane, pane.scrollLeft)
        }
        if (source != scrollbar)
            scrollbar.scrollLeft = horizontalOffset
    }

    // Runs only when the drawn lines or the host's size change: every write here invalidates layout for the other
    // diffs in the column, which then pay for a reflow on their next measurement.
    function measureScrollbar() {
        let range = Math.max(0, ...[...shadow.querySelectorAll<HTMLElement>("[data-code]")].map(pane => pane.scrollWidth - pane.clientWidth))
        let hidden = range == 0
        if (scrollbar.hidden != hidden)
            scrollbar.hidden = hidden
        // The scrollbar's own range matches the widest pane's.
        let width = `${scrollbar.clientWidth + range}px`
        if (scrollbarTrack.style.width != width)
            scrollbarTrack.style.width = width
        if (scrollbar.scrollLeft != horizontalOffset)
            scrollbar.scrollLeft = horizontalOffset
    }

    function decorate() {
        let { page, selected } = props
        if (!index)
            return
        // Drawn lines only need decorating again when the selection they show changes.
        let stamp = `${page.selectable}:${selected.join(",")}:${props.showWhitespace}:${!!contextRead}`
        if (decorated == stamp)
            return
        decorated = stamp
        let { lines } = index
        if (props.showWhitespace)
            markWhitespace(lines)

        for (let header of shadow.querySelectorAll<HTMLElement>("[data-separator-wrapper]")) {
            if (header.closest("[data-gutter]"))
                continue
            let position = Number(header.dataset.hunkIndex)
            let count = Number(header.dataset.hiddenLines ?? 0)
            if (count > 0) {
                let expand = header.querySelector<HTMLButtonElement>(".expand-context")
                if (!expand) {
                    expand = document.createElement("button")
                    expand.type = "button"
                    expand.className = "expand-context"
                    expand.textContent = `${count} hidden ${count == 1 ? "line" : "lines"}`
                    expand.setAttribute("aria-label", `Show ${expand.textContent}`)
                    expand.prepend(expandContextIcon())
                    expand.onclick = event => {
                        event.stopPropagation()
                        void expandContext(position, count)
                    }
                    header.append(expand)
                }
                expand.disabled = !!contextRead || !props.readContext
                expand.setAttribute("aria-busy", String(!!contextRead))
            }
        }
        for (let element of shadow.querySelectorAll<HTMLElement>("[data-line], [data-column-number]")) {
            let kind = element.dataset.lineType?.includes("addition") ? "addition" : element.dataset.lineType?.includes("deletion") ? "deletion" : undefined
            if (!kind)
                continue
            let number = Number(element.dataset.line ?? element.dataset.columnNumber)
            let line = lines.get(`${kind}:${number}`)
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
                    element.replaceChildren(button)
                }
                let id = line.id
                button.onclick = event => {
                    event.stopPropagation()
                    props.select([id])
                }
                button.setAttribute("aria-pressed", String(selected.includes(line.id)))
            }
        }
    }

    // Spaces and tabs become marked spans, and each line ends with a mark for its line ending.
    function markWhitespace(lines: Map<string, DiffLine>) {
        for (let line of shadow.querySelectorAll("[data-line]")) {
            let walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
            let whitespace: Text[] = []
            while (walker.nextNode()) {
                let node = walker.currentNode as Text
                if (/[ \t]/.test(node.data) && !node.parentElement?.closest("[data-whitespace]"))
                    whitespace.push(node)
            }
            for (let node of whitespace) {
                node.replaceWith(
                    ...node.data.split(/([ \t])/).map(text => {
                        if (text != " " && text != "\t")
                            return document.createTextNode(text)
                        let marker = document.createElement("span")
                        marker.dataset.whitespace = text == "\t" ? "tab" : "space"
                        marker.textContent = text
                        return marker
                    }),
                )
            }
            let number = Number(line.getAttribute("data-line"))
            let kind = line.getAttribute("data-line-type") ?? ""
            let source = lines.get(
                kind.includes("deletion")
                    ? `deletion:${number}`
                    : kind.includes("addition")
                    ? `addition:${number}`
                    : `context:${line.closest("[data-deletions]") ? "old" : "new"}:${number}`,
            )
            let deleted = line.closest("[data-deletions]") || kind.includes("deletion")
            let text = source?.text ?? (!diff?.isPartial ? (deleted ? diff?.deletionLines : diff?.additionLines)?.[number - 1]?.replace(/\n$/, "") : undefined)
            let ending = `${text?.endsWith("\r") ? "CR" : ""}${line.nextElementSibling?.hasAttribute("data-no-newline") ? "" : "LF"}`
            if (ending && !line.querySelector("[data-whitespace=line-ending]")) {
                let marker = document.createElement("span")
                marker.dataset.whitespace = "line-ending"
                marker.dataset.ending = ending
                marker.setAttribute("aria-hidden", "true")
                marker.title = ending
                // Highlighted lines keep their newline text; the mark goes before it to stay on the same row.
                let texts = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
                let last: Text | undefined
                while (texts.nextNode()) {
                    if (texts.currentNode.textContent)
                        last = texts.currentNode as Text
                }
                let suffix = last?.data.match(/[\r\n]+$/)
                if (last && suffix)
                    last.parentNode!.insertBefore(marker, last.splitText(last.length - suffix[0].length))
                else
                    line.append(marker)
            }
        }
    }

    return {
        update(next: DiffLinesProps) {
            props = next
            render()
        },
        dispose() {
            lifetime.abort()
            contextRead?.abort()
            resize.disconnect()
            viewer?.cleanUp()
            viewer = undefined
        },
    }
}

// Built imperatively because Pierre owns this part of the page; it draws Lucide's expand-all icon.
function expandContextIcon() {
    let namespace = "http://www.w3.org/2000/svg"
    let icon = document.createElementNS(namespace, "svg")
    let attributes = {
        "aria-hidden": "true",
        width: "16",
        height: "16",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.25",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
    }
    for (let [name, value] of Object.entries(attributes))
        icon.setAttribute(name, value)
    for (let [tag, shapeAttributes] of iconNodes["expand-all"]) {
        let shape = document.createElementNS(namespace, tag)
        for (let [name, value] of Object.entries(shapeAttributes))
            shape.setAttribute(name, String(value))
        icon.append(shape)
    }
    return icon
}

function indexLines(page: FileDiffPage): LineIndex {
    let lines = new Map<string, DiffLine>()
    let record = (key: string, line: DiffLine) => {
        if (!lines.has(key))
            lines.set(key, line)
    }
    for (let line of page.lines) {
        if (line.kind == "addition")
            record(`addition:${line.newLine}`, line)
        else if (line.kind == "deletion")
            record(`deletion:${line.oldLine}`, line)
        else if (line.kind == "context") {
            record(`context:old:${line.oldLine}`, line)
            record(`context:new:${line.newLine ?? line.oldLine}`, line)
        }
    }
    return { lines }
}

// Pierre's HAST goes in through DOM and CSSOM calls: the strict Content Security Policy rejects style attributes
// and style elements written as markup.
function astNode(node: ReturnType<DiffHunksRenderer["renderFullAST"]>["children"][number]): Node {
    if (node.type == "text")
        return document.createTextNode(node.value)
    if (node.type == "comment")
        return document.createComment(node.value)
    let element = document.createElement(node.tagName)
    for (let [key, value] of Object.entries(node.properties)) {
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
