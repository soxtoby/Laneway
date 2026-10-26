import type { DiffRow, MarkdownDiff as Diff } from "@laneway/markdown-diff"
import type { DiffLayout, FileDiffPage, FileVersion, RemoteImageResult } from "@laneway/shared"
import type { ElementContent } from "hast"
import { type Components, toJsxRuntime } from "hast-util-to-jsx-runtime"
import { type ComponentProps, createContext, Fragment, type ReactNode, useContext, useEffect, useEffectEvent, useState } from "react"
import { jsx, jsxs } from "react/jsx-runtime"
import { Hint } from "./controls"
import { BrokenPictureIcon } from "./icons"
import { imageMimeType } from "./image-files"
import { type MarkdownVersions, oldDocumentPath } from "./markdown-files"
import { type PictureSource, pictureSource, usePicture } from "./markdown-pictures"
import { Button } from "./ui/Button"

/** What a rendered Markdown diff reads: the document's versions, the pictures it shows, and where its links go. */
export interface MarkdownReader {
    readMarkdown(page: FileDiffPage, signal: AbortSignal): Promise<MarkdownVersions>
    readMarkdownPicture(page: FileDiffPage, side: "old" | "new", path: string): Promise<FileVersion>
    readRemoteImage(url: string): Promise<RemoteImageResult>
    openLink(url: string): void
}

interface MarkdownDiffProps {
    page: FileDiffPage
    layout: DiffLayout
    reader: MarkdownReader
}

type Item = { kind: "row"; row: DiffRow; index: number } | { kind: "gap"; start: number; count: number }

type Side = "old" | "new"

let MarkdownContext = createContext<{ page?: FileDiffPage; reader?: MarkdownReader }>({})

// Unchanged blocks kept beside each change while a diff doesn't show its whole file.
let context = 1

/** Which document a page renders; reading another version keeps the current one on screen until it arrives. */
function markdownKey(page: FileDiffPage) {
    return JSON.stringify([page.source, page.file.path, page.file.oldPath, page.view, page.version])
}

/**
 * A Markdown file's diff as the documents render: unified, with deletions beside insertions, or side by side with
 * each version's blocks aligned. Unchanged blocks away from the changes fold away unless the diff shows whole files.
 * An added or deleted document renders as it is.
 */
export function MarkdownDiff({ page, layout, reader }: MarkdownDiffProps) {
    let key = markdownKey(page)
    let [loaded, setLoaded] = useState<{ diff?: Diff; single?: boolean; error?: string }>({})
    let [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
    let current = useEffectEvent(() => ({ page, reader }))

    // The engine and its parsers load with the first rendered diff rather than with the app.
    useEffect(() => {
        let controller = new AbortController()
        let { page, reader } = current()
        Promise.all([reader.readMarkdown(page, controller.signal), import("@laneway/markdown-diff")])
            .then(([versions, { diffMarkdown }]) => {
                if (!controller.signal.aborted)
                    setLoaded({ diff: diffMarkdown(versions.old, versions.new), single: versions.old == undefined || versions.new == undefined })
            })
            .catch(failure => {
                if (!controller.signal.aborted)
                    setLoaded({ error: failure instanceof Error ? failure.message : String(failure) })
            })
        return () => controller.abort()
    }, [key])

    let { diff, single, error } = loaded
    if (error)
        return <p className="diff-message" role="alert">{error}</p>
    if (!diff)
        return <p className="diff-progress" role="status">Reading document…</p>

    let split = layout == "split" && !single
    let items = single || page.entireFile ? diff.rows.map((row, index): Item => ({ kind: "row", row, index })) : collapse(diff.rows, expanded)
    let unchanged = !single && diff.rows.every(row => row.change == "unchanged")
    return (
        <MarkdownContext value={{ page, reader }}>
            {unchanged && <p className="diff-message">The rendered document is unchanged.</p>}
            <div className="markdown-diff" data-layout={split ? "split" : "unified"} data-whole={single || undefined}>
                {items.map(item =>
                    item.kind == "gap"
                        ? (
                            <Button
                                key={`gap-${item.start}`}
                                variant="quiet"
                                className="markdown-gap"
                                onPress={() => setExpanded(new Set([...expanded, item.start]))}
                            >
                                Show {item.count} unchanged blocks
                            </Button>
                        )
                        : split
                        ? (
                            <Fragment key={item.index}>
                                <div className="markdown-cell" data-change={item.row.change}>{item.row.old && render(item.row.old, "old")}</div>
                                <div className="markdown-cell" data-change={item.row.change}>{item.row.new && render(item.row.new, "new")}</div>
                            </Fragment>
                        )
                        : (
                            <div key={item.index} className="markdown-cell" data-change={item.row.change}>
                                {render(item.row.unified, item.row.change == "removed" ? "old" : "new")}
                            </div>
                        )
                )}
            </div>
        </MarkdownContext>
    )
}

/** The rows to show: each change with the unchanged blocks beside it, and the runs between as gaps unless opened. */
function collapse(rows: DiffRow[], expanded: ReadonlySet<number>): Item[] {
    let near = rows.map((_, index) => rows.slice(Math.max(index - context, 0), index + context + 1).some(row => row.change != "unchanged"))
    let items: Item[] = []
    rows.forEach((row, index) => {
        let last = items.at(-1)
        if (near[index])
            items.push({ kind: "row", row, index })
        else if (last?.kind == "gap")
            last.count++
        else
            items.push({ kind: "gap", start: index, count: 1 })
    })
    // A gap of one block takes as much room as the block, so the block shows instead.
    return items.flatMap(item =>
        item.kind == "gap" && (item.count == 1 || expanded.has(item.start))
            ? rows.slice(item.start, item.start + item.count).map((row, offset): Item => ({ kind: "row", row, index: item.start + offset }))
            : [item]
    )
}

let components: Partial<Components> = {
    a: MarkdownLink,
    img: MarkdownPicture,
    span: MarkdownSpan,
    input: props => <input {...props} readOnly />,
}

function render(nodes: ElementContent[], side: Side): ReactNode {
    return toJsxRuntime({ type: "root", children: nodes.map(node => sided(node, side)) }, { Fragment, jsx, jsxs, components, passKeys: true })
}

// Pictures resolve against the version of the repository they come from: deleted content, and the old side, show
// the old version's pictures. Titles go, since the browser would show them as tooltips over hints.
function sided(node: ElementContent, side: Side): ElementContent {
    if (node.type != "element")
        return node
    let own = node.properties.dataDiff == "removed" ? "old" : side
    let properties = { ...node.properties, title: undefined, ...node.tagName == "img" ? { dataSide: own } : {} }
    return { ...node, properties, children: node.children.map(child => sided(child, own)) }
}

// Web and email links open in the system's apps; links within the repository only show where they go.
function MarkdownLink({ href, children, ...props }: ComponentProps<"a">) {
    let { reader } = useContext(MarkdownContext)
    let external = href != undefined && /^(https?|mailto):/i.test(href)
    return (
        <Hint text={href}>
            <a
                {...props}
                href={href}
                onClick={event => {
                    event.preventDefault()
                    if (external && href)
                        reader?.openLink(href)
                }}
            >
                {children}
            </a>
        </Hint>
    )
}

function MarkdownPicture({ src, alt, "data-side": side, ...props }: ComponentProps<"img"> & { "data-side"?: Side }) {
    let { page, reader } = useContext(MarkdownContext)
    let version = side ?? "new"
    let documentPath = page && (version == "old" ? oldDocumentPath(page) : page.file.path)
    let source = typeof src == "string" && documentPath != undefined ? pictureSource(src, version, documentPath) : undefined
    let key = source && page && pictureKey(page, source)
    let picture = usePicture(
        key,
        () => source && page && reader ? loadPicture(reader, page, source) : Promise.reject(new Error("This picture can't be shown.")),
    )

    if (picture?.state == "ready")
        return <img {...props} src={picture.url} alt={alt} />
    if (picture?.state == "loading")
        return <span className="markdown-picture" role="img" aria-label={alt} data-state="loading" />
    return (
        <Hint text={picture?.state == "failed" ? picture.reason : "Only pictures from the web or this repository can be shown."}>
            <span className="markdown-picture" role="img" aria-label={alt} data-state="failed">
                <BrokenPictureIcon />
                {alt}
            </span>
        </Hint>
    )
}

// Working Changes move on, so their pictures read again with each new version of the diff.
function pictureKey(page: FileDiffPage, source: PictureSource) {
    let version = page.source.kind == "working" ? page.version : undefined
    return source.kind == "web" ? `web:${source.url}` : JSON.stringify([page.source, page.view, version, source.side, source.path])
}

async function loadPicture(reader: MarkdownReader, page: FileDiffPage, source: PictureSource) {
    if (source.kind == "web") {
        let result = await reader.readRemoteImage(source.url)
        if (!result.ok)
            throw new Error(result.reason)
        return result
    }

    let content = await reader.readMarkdownPicture(page, source.side, source.path)
    if (content.state == "missing")
        throw new Error(`This version doesn't have ${source.path}.`)
    if (content.state != "ready")
        throw new Error(content.state == "lfs" ? "Git LFS hasn't downloaded this picture." : content.reason)
    return { bytes: content.bytes, mimeType: source.path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : imageMimeType(source.path) ?? "" }
}

// Words whose formatting alone changed say what it was.
function MarkdownSpan(props: ComponentProps<"span"> & { "data-diff"?: string; "data-diff-before"?: string }) {
    if (props["data-diff"] != "modified")
        return <span {...props} />
    return (
        <Hint text={formattingHint(props["data-diff-before"])}>
            <span {...props} />
        </Hint>
    )
}

function formattingHint(before: string | undefined) {
    if (before == undefined)
        return "Formatting changed"
    let marks = before.split(" ").filter(Boolean).map(mark => {
        if (mark.startsWith("link="))
            return `a link to ${decoded(mark.slice(5))}`
        if (mark.startsWith("linkReference="))
            return "a reference link"
        return { strong: "bold", emphasis: "italic", delete: "struck through" }[mark] ?? mark
    })
    return `Formatting changed: was ${marks.length ? marks.join(", ") : "plain text"}`
}

function decoded(url: string) {
    try {
        return decodeURI(url)
    } catch {
        return url
    }
}
