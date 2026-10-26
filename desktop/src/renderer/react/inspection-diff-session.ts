import type { ChangeSelection, DiffSource, DiffView, FileDiffPage } from "@laneway/shared"
import type { ImageDiffMode } from "./image-files"
import type { MarkdownView } from "./markdown-files"

export interface FileDiffState {
    showWhitespace: boolean
    /** How a changed picture is compared; unset until chosen, when the session's preferred mode applies. */
    imageMode?: ImageDiffMode
    /** How a Markdown file's diff shows; unset until chosen, when the session's preferred view applies. */
    markdownView?: MarkdownView
    group: string
    path: string
    view: DiffView
    page?: FileDiffPage
    loading: boolean
    /** A quiet re-read keeps the current page on screen until a different version arrives. */
    refreshing?: boolean
    error?: string
    selection?: ChangeSelection
    generation: number
    notice?: string
}

interface DiffInput {
    source?: DiffSource
    inventoryVersion?: string
    entireFile?: boolean
    unavailable?: boolean
}

interface Options {
    api: Pick<Window["laneway"], "readFileDiff">
    repositoryId: string
    alive(): boolean
    requestId(diff: FileDiffState): string
    update(): void
    settled(diff: FileDiffState): void
}

/** One column's diff reads, bounded page cache, and exact-content line selections. */
export function createDiffSession(options: Options) {
    let pages = new Map<string, FileDiffPage>()

    return { create, read, select }

    function create(group: string, path: string, input: DiffInput): FileDiffState {
        let view: DiffView = group == "working-staged" ? "staged" : group == "working-unstaged" ? "unstaged" : "combined"

        return {
            group,
            path,
            view,
            page: input.unavailable ? undefined : pages.get(pageKey(input, path, view)),
            loading: false,
            generation: 0,
            showWhitespace: false,
        }
    }

    async function read(diff: FileDiffState, input: DiffInput, more = false, refresh = false) {
        let source = input.source
        if (!source || !options.alive() || refresh && (diff.loading || diff.refreshing))
            return

        let previous = diff.page
        let generation = ++diff.generation
        let quiet = refresh && !!previous
        if (quiet)
            diff.refreshing = true
        else {
            diff.loading = true
            diff.error = undefined
            options.update()
        }

        try {
            let result = await options.api.readFileDiff(options.repositoryId, options.requestId(diff), {
                source,
                path: diff.path,
                view: diff.view,
                entireFile: input.entireFile,
                inventoryVersion: input.inventoryVersion,
                ...(more && previous ? { offset: previous.nextOffset, expectedVersion: previous.version } : {}),
            })
            if (options.alive() && generation == diff.generation) {
                if (!result.ok)
                    throw new Error(result.error.message)

                let page = result.page
                if (!more && textLength(page) <= 128_000) {
                    let id = pageKey(input, diff.path, diff.view)
                    pages.delete(id)
                    pages.set(id, page)
                    if (pages.size > 16)
                        pages.delete(pages.keys().next().value!)
                }

                if (previous && previous.version != page.version) {
                    diff.selection = undefined
                    diff.notice = "File changed. Change Selection cleared."
                }
                diff.page = more && previous
                    ? { ...page, lines: [...previous.lines, ...page.lines] }
                    : refresh && previous?.version == page.version
                    ? previous
                    : page
            }
        } catch (error) {
            if (options.alive() && generation == diff.generation) {
                diff.error = error instanceof Error ? error.message : String(error)
                diff.selection = undefined
                if (!more)
                    diff.page = undefined
            }
        } finally {
            if (generation == diff.generation) {
                diff.loading = false
                diff.refreshing = false
                // An unchanged quiet read leaves the screen alone.
                if (!quiet || diff.page != previous || diff.error)
                    options.update()
                options.settled(diff)
            }
        }
    }

    function select(diff: FileDiffState, ids: number[]) {
        let page = diff.page
        if (!page?.selectable)
            return

        let selection = diff.selection ?? { source: page.source, path: page.file.path, version: page.version, lineIds: [], rename: false }
        let current = new Set(selection.lineIds)
        let remove = ids.every(id => current.has(id))
        for (let id of ids) {
            if (remove)
                current.delete(id)
            else
                current.add(id)
        }
        diff.selection = { ...selection, lineIds: [...current].sort((a, b) => a - b) }
        options.update()
    }
}

function pageKey(input: DiffInput, path: string, view: DiffView) {
    return JSON.stringify([input.source, input.inventoryVersion, path, view, !!input.entireFile])
}

function textLength(page: FileDiffPage) {
    let length = 0
    for (let line of page.lines)
        length += line.text.length

    return length
}
