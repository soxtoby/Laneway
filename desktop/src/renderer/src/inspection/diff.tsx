import type { DiffLayout, DiffLine, FileDiffPage } from "@laneway/shared"
import { DiffHunksRenderer, type FileDiffLoadedChangedFiles, wrapCoreCSS, wrapThemeCSS } from "@pierre/diffs"
import { css, type Handle, ref } from "remix/ui"
import { iconNodes } from "../icon-nodes"
import { contextDiff, visibleDiffLines } from "./diff-context"
import { pierrePatch } from "./diff-patch"

/** Lookups built once per page so decorating rendered lines never scans the whole page. */
interface LineIndex {
    /** Keyed by `addition:<new>`, `deletion:<old>`, `context:old:<old>` and `context:new:<new>`. */
    lines: Map<string, DiffLine>
}

let viewport = css({ overflow: "visible", userSelect: "text" })
// Sticks to the bottom of the scrolling column while any of the diff is in view.
let diffScrollbar = css({
    position: "sticky",
    bottom: "0",
    zIndex: 4,
    overflowX: "auto",
    overflowY: "hidden",
    background: "var(--panel)",
    "&[hidden]": { display: "none" },
    // A styled scrollbar takes up room. Windows' default overlay scrollbar has none on this 1px-tall strip.
    "&::-webkit-scrollbar": { height: "10px" },
    "&::-webkit-scrollbar-track": { background: "transparent" },
    "&::-webkit-scrollbar-thumb": {
        background: "var(--line-strong)",
        border: "2px solid var(--panel)",
        borderRadius: "5px",
    },
    "&::-webkit-scrollbar-thumb:hover": { background: "var(--faint)" },
})
let diffScrollbarTrack = css({ height: "1px" })
let notice = css({ position: "static", height: "24px", font: "12px/24px var(--mono)", color: "var(--muted)" })

let diffCSS = `:host { --diffs-font-family: var(--mono); --diffs-font-size: 12px; --diffs-line-height: 24px;
        --diffs-scrollbar-gutter-override: 0px; }
    [data-code] { padding-top: 0; scrollbar-width: none; }
    [data-separator=line-info-basic] { height: 24px; }
    [data-content] [data-separator] [data-separator-wrapper] { display: flex; align-items: center; }
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
    [data-gutter] button:focus-visible, .expand-context:focus-visible { outline: 2px solid var(--accent); }
    .expand-context { all: unset; display: inline-flex; align-items: center; gap: 6px; font: inherit; color: var(--muted);
        cursor: pointer; border-radius: 3px; padding: 0 4px; }
    .expand-context:hover { background: var(--accent-wash-strong); }
    .expand-context:disabled { opacity: .4; cursor: default; }`

export function DiffLines(
    handle: Handle<{
        page: FileDiffPage
        layout: DiffLayout
        showWhitespace: boolean
        selected: number[]
        select(ids: number[]): void
        readContext?(page: FileDiffPage, signal: AbortSignal): Promise<FileDiffLoadedChangedFiles>
    }>,
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
    let index: LineIndex | undefined
    let contextFiles: FileDiffLoadedChangedFiles | undefined
    let contextRead: AbortController | undefined
    let contextError: string | undefined
    let rendered = ""
    // What the rendered lines were last decorated for; decoration is skipped while this holds.
    let decorated = ""
    let horizontalOffset = 0
    // Pierre's own pane scrollbars sit under the rendered window of lines, often out of view. One scrollbar pinned to
    // the bottom of the visible diff drives every pane instead.
    let scrollbar: HTMLElement | undefined
    let scrollbarTrack: HTMLElement | undefined
    let syncedOffsets = new WeakMap<HTMLElement, number>()
    let scroll = () => render()
    return () => {
        handle.queueTask(() => render())
        let { page, layout } = handle.props
        return (
            <>
                {page.lines.filter(line => line.kind == "notice" && !line.text.startsWith("\\ No newline")).map(line => (
                    <div class="diff-line notice" mix={notice}>{line.text}</div>
                ))}
                {contextError && <p role="alert" mix={notice}>{contextError}</p>}
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
                                let pane = event.target
                                if (pane instanceof HTMLElement && pane.hasAttribute("data-code"))
                                    syncHorizontal(pane)
                            }, { capture: true, passive: true, signal })
                            sheet = new CSSStyleSheet()
                            shadow.adoptedStyleSheets = [sheet]
                            viewer = new DiffHunksRenderer(undefined, undefined, () => render(true))
                            let observer = new MutationObserver(() => render())
                            observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] })
                            // A narrower host changes how far the panes overflow, which only this measurement notices.
                            let resize = new ResizeObserver(() => {
                                render()
                                measureScrollbar()
                            })
                            resize.observe(element)
                            signal.addEventListener("abort", () => {
                                contextRead?.abort()
                                observer.disconnect()
                                resize.disconnect()
                                viewer?.cleanUp()
                                viewer = undefined
                            })
                            render()
                        }),
                    ]}
                />
                <div
                    class="diff-scrollbar"
                    aria-hidden="true"
                    mix={[
                        diffScrollbar,
                        ref((element, signal) => {
                            scrollbar = element
                            scrollbarTrack = element.firstElementChild as HTMLElement
                            element.hidden = true
                            element.addEventListener("scroll", () => {
                                if (element.scrollLeft == horizontalOffset)
                                    return
                                horizontalOffset = element.scrollLeft
                                syncHorizontal()
                            }, { passive: true, signal })
                            measureScrollbar()
                        }),
                    ]}
                >
                    <div mix={diffScrollbarTrack} />
                </div>
            </>
        )
    }

    function render(force = false) {
        if (!viewer)
            return

        // Follow the actual vertical viewport, including source-linked columns.
        // A list of column classes leaves new hosts stuck on the first 80 lines.
        // The ancestor walk reads computed styles, so it only repeats once the host has moved elsewhere.
        if (!scrollContainer?.isConnected || !scrollContainer.contains(host)) {
            let container = host.parentElement
            while (container && !["auto", "scroll", "overlay"].includes(getComputedStyle(container).overflowY))
                container = container.parentElement
            if (container != scrollContainer) {
                scrollContainer?.removeEventListener("scroll", scroll)
                scrollContainer = container
                scrollContainer?.addEventListener("scroll", scroll, { signal: lifetime, passive: true })
            }
        }
        if (scrollContainer) {
            start = Math.max(
                0,
                Math.floor((scrollContainer.getBoundingClientRect().top + scrollContainer.clientTop - host.getBoundingClientRect().top) / 24) - 10,
            )
        }
        let { page, layout } = handle.props

        if (previous != page) {
            if (previous?.version != page.version || previous?.lines != page.lines) {
                contextRead?.abort()
                contextRead = undefined
                contextFiles = undefined
                contextError = undefined
                viewer.setExpandedHunksMap(new Map())
            }
            diff = contextDiff(page, contextFiles)
            index = indexLines(page)
            previous = page
            rendered = ""
        }

        let appearance: "dark" | "light" = document.documentElement.dataset.appearance == "dark" ? "dark" : "light"
        let key = `${layout}:${appearance}:${start}:${handle.props.showWhitespace}`
        if (!force && rendered == key) {
            // Nothing rendered changed: at most the selection needs redrawing, and that writes nothing when it is the same.
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
        let result = viewer.renderDiff(diff, { startingLine: first, totalLines: 80, bufferBefore: 0, bufferAfter: 0 })
        if (!result)
            return
        sheet.replaceSync(wrapCoreCSS("") + wrapThemeCSS(result.themeStyles, appearance) + diffCSS)
        let before = document.createElement("div")
        before.style.height = `${first * 24}px`
        let after = document.createElement("div")
        after.style.height = `${Math.max(0, total - first - 80) * 24}px`
        shadow.replaceChildren(before, astNode(viewer.renderFullAST(result)), after)

        for (let code of shadow.querySelectorAll<HTMLElement>("[data-code]")) {
            let type = code.hasAttribute("data-deletions") ? "deletions" : code.hasAttribute("data-additions") ? "additions" : "unified"
            let gaps = result.hunkData.filter(gap => gap.type == type)
            for (let column of code.querySelectorAll<HTMLElement>("[data-content], [data-gutter]")) {
                for (let [position, wrapper] of [...column.querySelectorAll<HTMLElement>("[data-separator-wrapper]")].entries()) {
                    let gap = gaps[position]
                    wrapper.dataset.hunkIndex = String(gap.hunkIndex)
                    wrapper.dataset.hiddenLines = String(gap.lines)
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
        if (!viewer || !diff || contextRead || !handle.props.readContext)
            return

        let page = handle.props.page
        let controller = new AbortController()
        contextRead = controller
        contextError = undefined
        render(true)
        try {
            if (!contextFiles) {
                let files = await handle.props.readContext(page, AbortSignal.any([handle.signal, controller.signal]))
                controller.signal.throwIfAborted()
                if (handle.props.page.version != page.version || handle.props.page.lines != page.lines)
                    controller.abort()
                controller.signal.throwIfAborted()
                contextFiles = files
                diff = contextDiff(page, files)
            }
            // The last gap expands forward from the final hunk; earlier gaps expand from their start.
            viewer.expandHunk(position, "up", count)
        } catch (error) {
            if (!controller.signal.aborted)
                contextError = error instanceof Error ? error.message : String(error)
        } finally {
            if (contextRead == controller) {
                contextRead = undefined
                render(true)
                void handle.update()
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
            // Remember the clamped offset so the resulting scroll event cannot
            // pull a wider pane back to the narrower pane's limit.
            syncedOffsets.set(pane, pane.scrollLeft)
        }
        if (scrollbar && source != scrollbar)
            scrollbar.scrollLeft = horizontalOffset
    }

    // Runs only when the rendered lines or the host's size change: every write here invalidates layout for the
    // other diff viewers in the same column, which then pay for a reflow on their next measurement.
    function measureScrollbar() {
        if (!scrollbar || !scrollbarTrack || !shadow)
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
        let { page, selected } = handle.props
        if (!shadow || !index)
            return
        // Rendered lines only need decorating again when the selection they show changes.
        let stamp = `${page.selectable}:${selected.join(",")}`
        if (decorated == stamp)
            return
        decorated = stamp
        let { lines } = index
        if (handle.props.showWhitespace) {
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
                let text = source?.text ?? (!diff?.isPartial
                    ? (line.closest("[data-deletions]") || kind.includes("deletion") ? diff?.deletionLines : diff?.additionLines)?.[number - 1]?.replace(
                        /\n$/,
                        "",
                    )
                    : undefined)
                let ending = `${text?.endsWith("\r") ? "CR" : ""}${line.nextElementSibling?.hasAttribute("data-no-newline") ? "" : "LF"}`
                if (ending && !line.querySelector("[data-whitespace=line-ending]")) {
                    let marker = document.createElement("span")
                    marker.dataset.whitespace = "line-ending"
                    marker.dataset.ending = ending
                    marker.setAttribute("aria-hidden", "true")
                    marker.title = ending
                    // Highlighted lines retain their newline text. Insert before
                    // it so the marker stays on the same physical row.
                    let text = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
                    let last: Text | undefined
                    while (text.nextNode()) {
                        if (text.currentNode.textContent)
                            last = text.currentNode as Text
                    }
                    let suffix = last?.data.match(/[\r\n]+$/)
                    if (last && suffix)
                        last.parentNode!.insertBefore(marker, last.splitText(last.length - suffix[0].length))
                    else
                        line.append(marker)
                }
            }
        }

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
                expand.disabled = !!contextRead || !handle.props.readContext
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
                    button.onclick = event => {
                        event.stopPropagation()
                        handle.props.select([line.id])
                    }
                    element.replaceChildren(button)
                }
                button.setAttribute("aria-pressed", String(selected.includes(line.id)))
            }
        }
    }
}

// Built imperatively because Pierre owns this part of the DOM; it mirrors the renderer's Icon component.
function expandContextIcon() {
    let namespace = "http://www.w3.org/2000/svg"
    let icon = document.createElementNS(namespace, "svg")
    for (
        let [name, value] of Object.entries({
            "aria-hidden": "true",
            width: "16",
            height: "16",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2.25",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
        })
    ) {
        icon.setAttribute(name, value)
    }
    for (let [tag, attributes] of iconNodes["expand-all"]) {
        let shape = document.createElementNS(namespace, tag)
        for (let [name, value] of Object.entries(attributes))
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

// Apply Pierre's HAST through DOM/CSSOM APIs: HTML style attributes and style
// elements are rejected by the renderer's strict Content Security Policy.
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
