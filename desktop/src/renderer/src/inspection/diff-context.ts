import type { DiffLayout, FileDiffPage, FileDiffRequest } from "@laneway/shared"
import { type FileDiffLoadedChangedFiles, type FileDiffMetadata, type HunkExpansionRegion, hydratePartialDiff } from "@pierre/diffs"
import { pierrePatch } from "./diff-patch"

export async function readDiffContext(
    api: Pick<Window["laneway"], "readFileDiff" | "cancelInspection">,
    repositoryId: string,
    page: FileDiffPage,
    signal: AbortSignal,
): Promise<FileDiffLoadedChangedFiles> {
    let requestId = `diff-context:${crypto.randomUUID()}`
    let cancel = () => void api.cancelInspection(repositoryId, requestId)
    signal.addEventListener("abort", cancel, { once: true })
    let original = { source: page.source, path: page.file.path, view: page.view, entireFile: page.entireFile, expectedVersion: page.version }

    try {
        await read(original)
        let full = await read({ ...original, entireFile: true, expectedVersion: undefined })
        let lines = [...full.lines]
        let next = full.nextOffset
        while (next != undefined) {
            let continuation = await read({ ...original, entireFile: true, expectedVersion: full.version, offset: next })
            lines.push(...continuation.lines)
            next = continuation.nextOffset
        }
        // Full-file and compact patches have different versions. Validate the displayed snapshot again before using the context.
        await read(original)
        let diff = pierrePatch({ ...full, lines })
        if (!diff)
            throw new Error("The file has no context to show.")

        return {
            oldFile: { name: page.file.oldPath ?? page.file.path, contents: diff.deletionLines.join("") },
            newFile: { name: page.file.path, contents: diff.additionLines.join("") },
        }
    } finally {
        signal.removeEventListener("abort", cancel)
    }

    async function read(request: FileDiffRequest) {
        signal.throwIfAborted()
        let result = await api.readFileDiff(repositoryId, requestId, request)
        signal.throwIfAborted()
        if (!result.ok)
            throw new Error(result.error.message)
        if (request.expectedVersion != undefined && result.page.version != request.expectedVersion)
            throw new Error("The diff source changed. Refresh the diff before showing hidden lines.")

        return result.page
    }
}

export function contextDiff(page: FileDiffPage, files?: FileDiffLoadedChangedFiles) {
    let diff = pierrePatch(page)
    if (files && diff?.isPartial) {
        diff = hydratePartialDiff("clone", diff, files)
        // A paginated patch has not modeled later changes yet; those lines must not appear as unchanged context.
        if (page.nextOffset != undefined) {
            let last = diff.hunks.at(-1)!
            diff.deletionLines = diff.deletionLines.slice(0, Math.max(last.deletionStart - 1, 0) + last.deletionCount)
            diff.additionLines = diff.additionLines.slice(0, Math.max(last.additionStart - 1, 0) + last.additionCount)
        }
    }

    return diff
}

export function visibleDiffLines(diff: FileDiffMetadata, layout: DiffLayout, expanded: Map<number, HunkExpansionRegion>) {
    let total = 0
    for (let [position, hunk] of diff.hunks.entries()) {
        let region = expanded.get(position)
        total += layout == "split" ? hunk.splitLineCount : hunk.unifiedLineCount
        if (!diff.isPartial)
            total += Math.min(hunk.collapsedBefore, (region?.fromStart ?? 0) + (region?.fromEnd ?? 0))
    }
    let last = diff.hunks.at(-1)
    if (!diff.isPartial && last) {
        let remaining = Math.max(0, diff.additionLines.length - Math.max(last.additionStart - 1, 0) - last.additionCount)
        total += Math.min(remaining, expanded.get(diff.hunks.length)?.fromStart ?? 0)
    }

    return total
}
