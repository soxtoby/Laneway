import type { ConflictResult, DiffLine, FileDiffPage } from "@git-workbench/shared"
import { css, type Handle } from "remix/ui"
import { DiffLines } from "./diff"

type View = NonNullable<ConflictResult["view"]>
type File = View["files"][number]

export function resolutionReview(view: View, file: File): FileDiffPage {
    const lines: DiffLine[] = []
    let oldLine = 0, newLine = 0, hunk = -1
    for (const text of file.diff.split("\n")) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
        if (header) {
            oldLine = Number(header[1])
            newLine = Number(header[2])
            hunk++
            lines.push({ id: lines.length, kind: "hunk", text, hunk })
        } else if (hunk >= 0 && /^[ +\-]/.test(text)) {
            const kind = text[0] == "+" ? "addition" : text[0] == "-" ? "deletion" : "context"
            lines.push({
                id: lines.length,
                kind,
                text: text.slice(1),
                hunk,
                ...(kind != "addition" ? { oldLine: oldLine++ } : {}),
                ...(kind != "deletion" ? { newLine: newLine++ } : {}),
            })
        } else if (hunk >= 0 && text.startsWith("\\ No newline")) {
            lines.push({ id: lines.length, kind: "notice", text, hunk })
        }
    }
    return {
        source: { kind: "comparison", fromObjectId: view.reviewTree, toObjectId: view.resultTree },
        file: { path: file.path, status: "M", staged: false, unstaged: false, untracked: false, ignored: false, conflicted: false },
        view: "combined",
        version: `${view.candidate.revision}:${file.path}`,
        lines,
        summary: [],
        selectable: false,
    }
}

export function ResolutionReview(handle: Handle<{ page: FileDiffPage; file: File; deleted: boolean }>) {
    return () => (
        <div
            class="resolution-review"
            aria-label="Resolution review"
            mix={css({ minWidth: "0", "& .file-notice": { padding: "12px", color: "var(--muted)", margin: "0" } })}
        >
            {handle.props.page.lines.length
                ? <DiffLines page={handle.props.page} layout="unified" showWhitespace={false} selected={[]} select={() => {}} />
                : (
                    <p class="file-notice">
                        {handle.props.deleted
                            ? "This file will be deleted."
                            : handle.props.file.resultText === null
                            ? "Binary or structural file selected."
                            : "Matches the updated stack."}
                    </p>
                )}
        </div>
    )
}
