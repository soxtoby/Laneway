import type { DiffLayout, DiffLine, FileDiffPage } from "@laneway/shared"
import { canUseWASM, DEFAULT_THEMES, DiffHunksRenderer, type FileDiffLoadedChangedFiles, getFiletypeFromFileName, getHighlighterIfLoaded, getHighlighterOptions, type HighlighterTypes, preloadHighlighter, wrapCoreCSS, wrapThemeCSS } from "@pierre/diffs"
import { contextDiff, drawnRow, visibleDiffLines } from "./diff-context"
import type { pierrePatch } from "./diff-patch"
import { expandAllNode } from "./icon-nodes"

export interface DiffLinesProps {
    page: FileDiffPage
    layout: DiffLayout
    /** Wraps long lines instead of scrolling them sideways. */
    wrap: boolean
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

/** A drawn line, by its row in the whole file in each layout, and where its top was on screen. */
interface HeldLine {
    unified: number
    split: number
    top: number
}

let renderers = new WeakMap<Element, ReturnType<typeof createDiffRenderer>>()

/**
 * Notes the line drawn at `y` on screen in the diff drawn into `host`, or the first drawn below it. Once the diff has
 * switched layout, the returned function scrolls the diff's column to put that line back where it was, and returns how
 * far it scrolled.
 */
export function holdLine(host: Element, y: number) {
    let line = renderers.get(host)?.lineAt(y)
    return line && (() => renderers.get(host)?.showLine(line) ?? 0)
}

// Rendered lines are 24px tall, unless they wrap; only those near the scrolling column's viewport are drawn.
let lineHeight = 24
let renderedLines = 80

/**
 * Pierre's Highlights, which runs as WebAssembly, tokenizes many times faster than Shiki's regular expressions; Shiki
 * stands in wherever WebAssembly can't compile. A page runs one kind of highlighter, so conflicts use this one too.
 */
export let highlighter: HighlighterTypes = canUseWASM() ? "highlights" : "shiki-js"

interface Language {
    loaded: Promise<void>
    failed?: boolean
}

// Each language's highlighting loads once for every diff. One that fails to load is left to Pierre.
let languages = new Map<string, Language>()

function loadLanguage(name: string) {
    let language = languages.get(name)
    if (!language) {
        let loading: Language = {
            loaded: preloadHighlighter(getHighlighterOptions(name, { theme: DEFAULT_THEMES, preferredHighlighter: highlighter })).catch(() => {
                loading.failed = true
            }),
        }
        language = loading
        languages.set(name, language)
    }
    return language
}

// Pierre's shadow root takes no page stylesheets, so its rules come from the theme's variables here.
let diffCSS = `:host { --diffs-font-family: var(--font-family-mono); --diffs-font-size: 12px; --diffs-line-height: 24px;
        --diffs-scrollbar-gutter-override: 0px; }
    [data-code] { padding-top: 0; scrollbar-width: none; }
    [data-overflow=wrap] { padding-top: 0; }
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
 *
 * It follows the page only while connected. A diff hidden with its repository disconnects, keeping what it drew, so
 * showing the repository again draws nothing it doesn't have to.
 */
export function createDiffRenderer(host: HTMLElement, scrollbar: HTMLElement, initial: DiffLinesProps, onContextError: (message?: string) => void) {
    let props = initial
    // What the diff follows outside its own elements while connected, which disconnecting lets go of.
    let connection: AbortController | undefined
    let shadow = host.attachShadow({ mode: "open" })
    let sheet = new CSSStyleSheet()
    shadow.adoptedStyleSheets = [sheet]
    let viewer = new DiffHunksRenderer(undefined, undefined, () => render(true))
    let scrollbarTrack = scrollbar.firstElementChild as HTMLElement
    let start = 0
    let scrollContainer: HTMLElement | null = null
    let previous: FileDiffPage | undefined
    let diff: ReturnType<typeof pierrePatch>
    let index: LineIndex | undefined
    let contextFiles: FileDiffLoadedChangedFiles | undefined
    let contextRead: AbortController | undefined
    let rendered = ""
    // What the drawn lines show, other than where they start; empty while a spacer stands in for them.
    let drawn = ""
    let spacer = document.createElement("div")
    // The language it waits for before it can draw.
    let waiting: Language | undefined
    // Wrapped rows' measured heights, which place the drawn lines; rows never drawn count as one line.
    let heights: number[] = []
    // The layout the heights were measured in.
    let measuredFor = ""
    // What the rendered lines were last decorated for; decoration is skipped while this holds.
    let decorated = ""
    let horizontalOffset = 0
    let syncedOffsets = new WeakMap<HTMLElement, number>()
    // The line last put back in place after a switch of layout.
    let placed: HeldLine | undefined
    // Scrolling moves the drawn lines only for a diff near the view; the observer notices one coming near.
    let scroll = () => {
        if (near)
            render()
    }
    // Whether the diff is within the viewport's height of the column's view. The observer notices it coming near or
    // going away for any reason, such as the files above it folding, and measures every diff in the column at once
    // after layout, where measuring each here would lay out the column again for each diff.
    let approach: IntersectionObserver | undefined
    let following: AbortController | undefined
    let near = false
    let dark = matchMedia("(prefers-color-scheme: dark)")

    // Pierre's own pane scrollbars sit under the drawn window of lines, often out of view; the pinned one drives them all.
    shadow.addEventListener("scroll", event => {
        let pane = event.target
        if (pane instanceof HTMLElement && pane.hasAttribute("data-code"))
            syncHorizontal(pane)
    }, { capture: true, passive: true })
    scrollbar.hidden = true
    scrollbar.addEventListener("scroll", () => {
        if (scrollbar.scrollLeft == horizontalOffset)
            return
        horizontalOffset = scrollbar.scrollLeft
        syncHorizontal()
    }, { passive: true })
    // A narrower host changes how far the panes overflow, which only this measurement notices. It measures on the next
    // frame: showing the pinned scrollbar or drawing other lines here resizes the column's file list inside the
    // browser's ResizeObserver loop, which reports it as undelivered notifications.
    let resizeFrame = 0
    let resize = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
            render()
            measureScrollbar()
        })
    })

    function connect() {
        connection = new AbortController()
        dark.addEventListener("change", () => render(), { signal: connection.signal })
        resize.observe(host)
        // Shown again, it keeps the lines it drew; the observer's first report, which comes after layout, draws others
        // if the diff has moved.
        if (scrollContainer?.isConnected && scrollContainer.contains(host))
            follow(scrollContainer)
        else
            render()
    }

    function disconnect() {
        connection?.abort()
        unfollow()
        resize.disconnect()
        cancelAnimationFrame(resizeFrame)
        contextRead?.abort()
    }

    function render(force = false) {
        // Follow the actual vertical viewport. The ancestor walk reads computed styles, so it only repeats once
        // the host has moved into another scrolling container.
        if (!scrollContainer?.isConnected || !scrollContainer.contains(host)) {
            let container = host.parentElement
            while (container && !["auto", "scroll", "overlay"].includes(getComputedStyle(container).overflowY))
                container = container.parentElement
            if (container != scrollContainer) {
                scrollContainer = container
                near = false
                // A diff drawn again once it has gone, as when a highlight finishes late, follows nothing.
                if (connection && !connection.signal.aborted)
                    follow(container)
            }
        }
        let { page, layout, wrap } = props
        if (measuredFor != `${layout}:${wrap}`) {
            heights = []
            measuredFor = `${layout}:${wrap}`
        }
        // A diff away from the column's view isn't drawn, nor highlighted, until it nears; nor is one a glide is
        // passing on its way to a chosen file (`data-gliding` on the column), which a scroll event redraws as it slows.
        let shown = !scrollContainer || near && !scrollContainer.hasAttribute("data-gliding")
        if (scrollContainer && near) {
            let offset = scrollContainer.getBoundingClientRect().top + scrollContainer.clientTop - host.getBoundingClientRect().top
            start = Math.max(0, rowAt(offset) - 10)
        }
        if (previous != page) {
            if (previous?.version != page.version || previous?.lines != page.lines) {
                contextRead?.abort()
                contextRead = undefined
                contextFiles = undefined
                onContextError(undefined)
                viewer.setExpandedHunksMap(new Map())
                heights = []
            }
            diff = contextDiff(page, contextFiles)
            index = indexLines(page)
            previous = page
            rendered = ""
            drawn = ""
        }
        if (!diff) {
            shadow.replaceChildren()
            rendered = ""
            drawn = ""
            return
        }

        let appearance = dark.matches ? "dark" as const : "light" as const
        let total = visibleDiffLines(diff, layout, viewer.getExpandedHunksMap())
        let first = Math.min(start, Math.max(0, total - 60))
        let content = `${layout}:${wrap}:${appearance}:${props.showWhitespace}`
        let key = `${content}:${first}`
        if (!force && rendered == key) {
            // Nothing drawn changed: at most the selection needs redrawing, which writes nothing when it is the same.
            decorate()
            return
        }
        if (!shown) {
            // Lines drawn for what it still shows stay until it nears; otherwise a spacer holds its place.
            if (force)
                rendered = ""
            if (drawn != content)
                hold(rowsHeight(0, total))
            return
        }

        viewer.setOptions({
            diffStyle: layout,
            themeType: appearance,
            preferredHighlighter: highlighter,
            disableFileHeader: true,
            hunkSeparators: "line-info-basic",
            collapsedContextThreshold: 0,
            lineDiffType: "char",
            maxLineDiffLength: 10000,
            overflow: wrap ? "wrap" : "scroll",
        })
        // Until its language has loaded, each call to Pierre queues another highlight of the whole diff, which runs even
        // once the diff has gone. So the diff holds its place, and draws once the language loads if it is still near.
        let name = diff.lang ?? getFiletypeFromFileName(diff.name)
        let language = getHighlighterIfLoaded({ theme: DEFAULT_THEMES, lang: name }) ? undefined : loadLanguage(name)
        if (language && !language.failed) {
            if (!drawn)
                hold(rowsHeight(0, total))
            if (waiting != language) {
                let loading = language
                waiting = loading
                void loading.loaded.then(() => {
                    if (waiting == loading) {
                        waiting = undefined
                        render()
                    }
                })
            }
            return
        }
        let result = viewer.renderDiff(diff, { startingLine: first, totalLines: renderedLines, bufferBefore: 0, bufferAfter: 0 })
        if (!result) {
            if (!drawn)
                hold(rowsHeight(0, total))
            return
        }
        sheet.replaceSync(wrapCoreCSS("") + wrapThemeCSS(result.themeStyles, appearance) + diffCSS)
        let before = document.createElement("div")
        before.style.height = `${rowsHeight(0, first)}px`
        let after = document.createElement("div")
        after.style.height = `${rowsHeight(first + renderedLines, total)}px`
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
        drawn = content
        decorated = ""
        decorate()
        if (wrap)
            measureRows(first)
        measureScrollbar()
        syncHorizontal()
    }

    // Follows the column that scrolls the diff: scrolling it moves the drawn lines, and its observer notices the diff
    // coming near its view or going away.
    function follow(container: HTMLElement | null) {
        unfollow()
        if (!container)
            return
        following = new AbortController()
        container.addEventListener("scroll", scroll, { signal: following.signal, passive: true })
        approach = new IntersectionObserver(entries => {
            near = entries.at(-1)?.isIntersecting ?? near
            render()
        }, { root: container, rootMargin: "100% 0px" })
        approach.observe(host)
    }

    function unfollow() {
        following?.abort()
        approach?.disconnect()
        approach = undefined
    }

    // Stands in for undrawn lines at their unwrapped height, without the scrollbar of lines that aren't there.
    function hold(height: number) {
        if (shadow.childNodes.length != 1 || shadow.firstChild != spacer)
            shadow.replaceChildren(spacer)
        let size = `${height}px`
        if (spacer.style.height != size)
            spacer.style.height = size
        rendered = ""
        drawn = ""
        if (!scrollbar.hidden)
            scrollbar.hidden = true
    }

    // Only rows up to the last one measured are walked; past it every row is one line, so without wrapping (when
    // nothing is measured) both of these are plain arithmetic.
    function rowAt(offset: number) {
        let row = 0
        let top = 0
        while (row < heights.length && top + (heights[row] ?? lineHeight) <= offset)
            top += heights[row++] ?? lineHeight
        return row < heights.length ? row : row + Math.floor((offset - top) / lineHeight)
    }

    function rowsHeight(from: number, to: number) {
        let height = Math.max(0, to - from) * lineHeight
        for (let row = from; row < Math.min(to, heights.length); row++)
            height += (heights[row] ?? lineHeight) - lineHeight
        return height
    }

    // A wrapped row keeps its height once it scrolls out of the drawn lines, so the lines in view don't shift. Rows not
    // drawn yet count as one line, and rows last drawn at another width keep that height, so scrolling up into either
    // moves the lines below them.
    function measureRows(first: number) {
        for (let content of shadow.querySelectorAll("[data-content]")) {
            let row = first
            for (let element of content.children) {
                if (element.hasAttribute("data-content-buffer"))
                    row += Number(element.getAttribute("data-buffer-size"))
                else if (element.hasAttribute("data-line")) {
                    // Both sides of a split row share one grid row, so either side's line measures it.
                    let height = element.getBoundingClientRect().height
                    if (height > 0)
                        heights[row] = height
                    row++
                }
            }
        }
    }

    async function expandContext(position: number, count: number) {
        if (!diff || contextRead || !props.readContext)
            return
        let page = props.page
        let controller = new AbortController()
        contextRead = controller
        onContextError(undefined)
        render(true)
        try {
            if (!contextFiles) {
                let files = await props.readContext(page, controller.signal)
                controller.signal.throwIfAborted()
                if (props.page.version != page.version || props.page.lines != page.lines)
                    controller.abort()
                controller.signal.throwIfAborted()
                contextFiles = files
                diff = contextDiff(page, files)
            }
            // The last gap expands forward from the final hunk; earlier gaps expand from their start.
            viewer.expandHunk(position, "up", count)
            heights = []
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
        if (!drawn)
            return
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

    function lineAt(y: number) {
        let held: HeldLine | undefined
        for (let line of shadow.querySelectorAll<HTMLElement>("[data-line][data-line-index]")) {
            let { top, bottom } = line.getBoundingClientRect()
            if (bottom > y && bottom > top && (!held || top < held.top)) {
                let [unified = 0, split = 0] = line.dataset.lineIndex!.split(",").map(Number)
                held = { unified, split, top }
            }
        }
        // A side by side row holds a deletion and an addition, so a line just put back there is held again, and
        // switching back returns to it rather than to its row's deletion.
        let split = props.layout == "split"
        if (held && placed && (split ? placed.split == held.split : placed.unified == held.unified) && Math.abs(placed.top - held.top) < 1)
            return placed
        return held
    }

    // Scrolls the column to put the line back where it was, and returns how far. Lines are drawn only near the view, so
    // a line that isn't drawn is scrolled to by its row first, then by where it's drawn.
    function showLine(line: HeldLine) {
        if (!diff || !scrollContainer)
            return 0
        placed = line
        let split = props.layout == "split"
        let index = split ? line.split : line.unified
        let row = drawnRow(diff, props.layout, viewer.getExpandedHunksMap(), index)
        let from = scrollContainer.scrollTop
        for (let attempt = 0; attempt < 4; attempt++) {
            render()
            let drawnLine = [...shadow.querySelectorAll<HTMLElement>("[data-line][data-line-index]")]
                .find(element => Number(element.dataset.lineIndex!.split(",")[split ? 1 : 0]) == index)
            let top = drawnLine?.getBoundingClientRect().top ?? host.getBoundingClientRect().top + rowsHeight(0, row)
            if (Math.abs(top - line.top) < 1)
                break
            scrollContainer.scrollTop += top - line.top
        }
        return scrollContainer.scrollTop - from
    }

    let renderer = {
        update(next: DiffLinesProps) {
            // The same props come again as the diff shows again, or just after it first draws.
            if (next == props)
                return
            props = next
            render()
        },
        connect,
        disconnect,
        lineAt,
        showLine,
    }
    renderers.set(host, renderer)
    return renderer
}

// Built imperatively because Pierre owns this part of the page; it draws the expand-all icon.
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
    for (let [tag, shapeAttributes] of expandAllNode) {
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
