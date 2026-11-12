import type { FileDiffPage, FileVersion, FileVersionRequest } from "@laneway/shared"

// Which files render as Markdown, and reading their versions for the rendered diff.

/** How a Markdown file's diff shows: as its source lines, or as the documents they render. */
export type MarkdownView = "source" | "rendered"

let extensions = new Set(["md", "mdx", "markdown", "mdown", "mkd", "mkdn", "mdwn"])

// Rendered until a Markdown diff chooses otherwise, then remembered for the session, so every Markdown diff opens the
// way the last one was chosen.
let preferredView: MarkdownView = "rendered"

export function isMarkdownPath(path: string) {
    let dot = path.lastIndexOf(".")
    return dot >= 0 && extensions.has(path.slice(dot + 1).toLowerCase())
}

export function preferredMarkdownView() {
    return preferredView
}

export function rememberMarkdownView(view: MarkdownView) {
    preferredView = view
}

/** A Markdown document's old and new text; a version without the document has none. */
export interface MarkdownVersions {
    old?: string
    new?: string
}

type VersionApi = Pick<Window["laneway"], "readFileVersion" | "cancelInspection">

export async function readMarkdownVersions(api: VersionApi, repositoryId: string, page: FileDiffPage, signal: AbortSignal): Promise<MarkdownVersions> {
    let text = async (side: "old" | "new", path: string) => {
        let content = await readFileVersion(api, repositoryId, { source: page.source, view: page.view, side, path, fetchLfs: true }, signal)
        if (content.state == "missing")
            return undefined
        if (content.state != "ready")
            throw new Error(content.state == "lfs" ? "Git LFS hasn't downloaded this document." : content.reason)
        return new TextDecoder().decode(content.bytes)
    }
    let [old, current] = await Promise.all([text("old", oldDocumentPath(page)), text("new", page.file.path)])
    return { ...old != undefined ? { old } : {}, ...current != undefined ? { new: current } : {} }
}

/** Where a page's old version keeps the document: before a rename, except on the unstaged side, whose index has it renamed. */
export function oldDocumentPath(page: FileDiffPage) {
    return page.view == "unstaged" ? page.file.path : page.file.oldPath ?? page.file.path
}

/** One version of a file for rendered Markdown: the document itself, or a picture it shows. */
export async function readFileVersion(api: VersionApi, repositoryId: string, request: FileVersionRequest, signal?: AbortSignal): Promise<FileVersion> {
    let requestId = `markdown:${crypto.randomUUID()}`
    let cancel = () => void api.cancelInspection(repositoryId, requestId)
    signal?.addEventListener("abort", cancel, { once: true })
    try {
        signal?.throwIfAborted()
        let result = await api.readFileVersion(repositoryId, requestId, request)
        signal?.throwIfAborted()
        if (!result.ok)
            throw new Error(result.error.message)
        return result.content
    } finally {
        signal?.removeEventListener("abort", cancel)
    }
}
