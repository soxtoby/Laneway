import type { ChangedFile, DiffLayout, DiffView, FileDiffPage, FileImagePage } from "@laneway/shared"
import type { FileDiffLoadedChangedFiles } from "@pierre/diffs"
import { css, type Handle, on, type RemixNode } from "remix/ui"
import { DiffLines } from "./diff"
import { ImageDiff, isImagePath, visibleSummary } from "./image-diff"
import type { FileDiffState } from "./inspection-diff-session"

let diffViews = css({
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    padding: "6px 8px",
})

let diffViewsButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    fontSize: "11px",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

let inspectionNotice = css({
    margin: "0",
    padding: "8px 10px",
    color: "var(--warning)",
    fontSize: "12px",
    overflowWrap: "anywhere",
    background: "var(--warning-wash)",
})

let diffInspectorP = css({
    margin: 0,
    padding: "8px 10px",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
})

let diffInspectorButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

let diffSummary = css({
    margin: "0",
    padding: "4px 10px",
    color: "var(--muted)",
    fontSize: "11px",
    lineHeight: "16px",
    overflowWrap: "anywhere",
})

export let selectionSummary = css({
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 8px",
    fontSize: "11px",
    color: "var(--accent)",
    borderTop: "1px solid var(--line)",
})

let selectionSummaryButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

let loadDiff = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    margin: "8px",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

let inspectionMutedButton = css({
    border: "1px solid var(--line)",
    background: "var(--control)",
    color: "var(--text)",
    borderRadius: "3px",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    '&[aria-pressed="true"]': {
        background: "var(--accent-wash-strong)",
        borderColor: "var(--accent-edge)",
    },
    "&:hover": {
        background: "var(--control-hover)",
    },
})

export let inspectionProgress = css({
    position: "absolute",
    top: "0",
    right: "0",
    zIndex: 1,
    margin: "0",
    padding: "4px 8px",
    maxWidth: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--line)",
    borderRadius: "3px",
    background: "var(--panel)",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
    pointerEvents: "none",
    "& button": {
        pointerEvents: "auto",
    },
})

export let inspectionMuted = css({
    margin: "0",
    padding: "8px 10px",
    color: "var(--muted)",
    fontSize: "12px",
    overflowWrap: "anywhere",
})

export function InspectionDiffContents(
    handle: Handle<{
        diff: FileDiffState
        eligible: boolean
        layout: DiffLayout
        selectionControl?: RemixNode
        changeView(view: DiffView): void
        read(more?: boolean): void
        readContext(page: FileDiffPage, signal: AbortSignal): Promise<FileDiffLoadedChangedFiles>
        readImage(page: FileDiffPage, signal: AbortSignal, fetchLfs?: boolean): Promise<FileImagePage>
        select(ids: number[]): void
        clearSelection(): void
        cancel(): void
    }>,
) {
    return () => {
        let { diff, eligible, layout } = handle.props
        let page = diff.page && !eligible ? { ...diff.page, selectable: false } : diff.page
        let image = page != undefined && isImagePath(page.file.path)
        let summary = page ? visibleSummary(page) : []

        return (
            <>
                {page?.source.kind == "working" && diffViewChoices(diff, page.file).length > 1 && (
                    <div class="diff-views" role="group" aria-label="Comparison" mix={diffViews}>
                        {diffViewChoices(diff, page.file).map(view => (
                            <button
                                type="button"
                                aria-pressed={diff.view == view}
                                mix={[diffViewsButton, on("click", () => handle.props.changeView(view))]}
                            >
                                {view == "combined" ? "Working Changes" : view[0].toUpperCase() + view.slice(1)}
                            </button>
                        ))}
                    </div>
                )}
                {diff.notice && (
                    <p class="inspection-notice" role="status" mix={inspectionNotice}>
                        {diff.notice}
                    </p>
                )}
                {diff.error && (
                    <p role="alert" mix={diffInspectorP}>
                        {diff.error}{" "}
                        <button type="button" mix={[diffInspectorButton, on("click", () => handle.props.read())]}>
                            Retry diff
                        </button>
                    </p>
                )}
                {page && (
                    <>
                        {summary.map(text => (
                            <p class="diff-summary" mix={diffSummary}>
                                {text}
                            </p>
                        ))}
                        {!image && page.lines.length == 0 && page.summary.length == 0 && (
                            <p class="inspection-muted" mix={inspectionMuted}>
                                No net content difference in this view.
                            </p>
                        )}
                        {image
                            ? <ImageDiff page={page} read={handle.props.readImage} />
                            : (
                                <DiffLines
                                    page={page}
                                    layout={layout}
                                    showWhitespace={diff.showWhitespace}
                                    selected={eligible ? diff.selection?.lineIds ?? [] : []}
                                    readContext={handle.props.readContext}
                                    select={ids => {
                                        if (eligible)
                                            handle.props.select(ids)
                                    }}
                                />
                            )}
                        {eligible && diff.selection && (
                            <div class="selection-summary" role="status" mix={selectionSummary}>
                                {handle.props.selectionControl}
                                {diff.selection.lineIds.length} lines selected{diff.selection.rename ? " · rename selected" : ""}
                                <button
                                    type="button"
                                    data-mousedown-activate
                                    mix={[
                                        selectionSummaryButton,
                                        on("click", () => {
                                            handle.props.clearSelection()
                                        }),
                                    ]}
                                >
                                    Clear selection
                                </button>
                            </div>
                        )}
                        {page.nextOffset != undefined && (
                            <button
                                type="button"
                                class="load-diff"
                                disabled={diff.loading}
                                mix={[loadDiff, on("click", () => handle.props.read(true))]}
                            >
                                Load more
                            </button>
                        )}
                    </>
                )}
                {diff.loading && (
                    <p class="inspection-progress" role="status" mix={inspectionProgress}>
                        Reading diff…{" "}
                        <button
                            type="button"
                            mix={[
                                inspectionMutedButton,
                                on("click", () => {
                                    handle.props.cancel()
                                }),
                            ]}
                        >
                            Cancel
                        </button>
                    </p>
                )}
            </>
        )
    }
}

// The staged and unstaged lists each show their own side of a file, so only conflict views remain
// selectable there; the combined Working Changes view keeps its staged and unstaged toggles.
function diffViewChoices(diff: FileDiffState, file: ChangedFile): DiffView[] {
    let fixed = diff.group.startsWith("working-")
    return [
        ...(fixed ? [diff.view] : ["combined", ...(file.staged ? ["staged", "unstaged"] : [])]),
        ...(file.conflicted ? ["base", "ours", "theirs"] : []),
    ] as DiffView[]
}
