import type { ChangedFile, DiffLayout, DiffView } from "@laneway/shared"
import { createContext, type ReactNode, useContext, useRef } from "react"
import { ToggleButton } from "react-aria-components"
import { DiffLines } from "./diff-lines"
import { holdLine } from "./diff-renderer"
import { EntireFileIcon, ImageModeIcon, RenderedMarkdownIcon, SplitDiffIcon, UnifiedDiffIcon, WhitespaceIcon, WrapLinesIcon } from "./icons"
import { ImageDiff, imageKey } from "./image-diff"
import { type ImageDiffMode, imageModes, isComparableImage, isImagePath, preferredImageMode, visibleSummary } from "./image-files"
import type { FileDiffState, Inspection } from "./inspection"
import { holdBlock, MarkdownDiff } from "./markdown-diff"
import { isMarkdownPath, preferredMarkdownView } from "./markdown-files"
import { TransferGrip, transferSource, useTransferScope } from "./transfer"
import { Button } from "./ui/Button"
import { SegmentedControl, SegmentedControlItem } from "./ui/SegmentedControl"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshotValue } from "./use-snapshot"

/** How a column lays out its diffs, saved with the column. */
export interface DiffScope {
    layout: DiffLayout
    setLayout(layout: DiffLayout): void
}

export let DiffScopeContext = createContext<DiffScope>({ layout: "unified", setLayout: () => {} })

/**
 * In a list that draws only the rows near the view, keeps the row with this key drawn wherever the list moves it, so
 * its diff can hold its place, until the returned function lets it go.
 */
export let HeldRowContext = createContext<((key: string) => () => void) | undefined>(undefined)

interface DiffProps {
    columnId: string
    /** The diff's `diffKey`. */
    id: string
    diff: FileDiffState
    inspection: Inspection
}

interface DiffControlsProps extends DiffProps {
    /** Whether the diff column shows files whole, which only its toolbars switch. */
    entireFiles?: { shown: boolean; toggle(): void }
}

/**
 * A diff's controls in its file's row: unified or side by side, wrapping every diff's lines, and showing whitespace.
 * A Markdown file's diff can show the rendered documents instead, where wrapping and whitespace don't apply.
 */
export function DiffControls({ columnId, id, diff, inspection, entireFiles }: DiffControlsProps) {
    let { layout, setLayout } = useContext(DiffScopeContext)
    let wrapLines = useSnapshotValue(inspection, snapshot => snapshot.wrapLines)
    let holdRow = useContext(HeldRowContext)
    let layoutToggle = useRef<HTMLDivElement>(null)
    let switchLayout = (chosen: DiffLayout) => {
        if (chosen != layout)
            holdPlace(layoutToggle.current, () => setLayout(chosen), holdRow)
    }
    // Pictures swap the line layouts for their comparison modes; added and deleted ones have nothing to compare.
    if (isImagePath(diff.path)) {
        let mode = diff.imageMode ?? preferredImageMode()
        let comparable = diff.page ? isComparableImage(diff.page.file) : true
        return comparable && (
            <div className="diff-controls">
                <ImageModeToggle mode={mode} onChange={chosen => inspection.setImageMode(columnId, id, chosen)} />
            </div>
        )
    }
    let markdown = isMarkdownPath(diff.path)
    let rendered = markdown && isRendered(diff)
    return (
        <div className="diff-controls">
            <div ref={layoutToggle} className="diff-layout-toggle" role="group" aria-label="Diff layout">
                <TooltipTrigger>
                    <ToggleButton className="icon-button small" aria-label="Unified" isSelected={layout == "unified"} onChange={() => switchLayout("unified")}>
                        <UnifiedDiffIcon />
                    </ToggleButton>
                    <Tooltip>Unified</Tooltip>
                </TooltipTrigger>
                <TooltipTrigger>
                    <ToggleButton className="icon-button small" aria-label="Side by side" isSelected={layout == "split"} onChange={() => switchLayout("split")}>
                        <SplitDiffIcon />
                    </ToggleButton>
                    <Tooltip>Side by side</Tooltip>
                </TooltipTrigger>
            </div>
            {markdown && (
                <TooltipTrigger>
                    <ToggleButton
                        className="icon-button small"
                        aria-label="Show rendered Markdown"
                        isSelected={rendered}
                        onChange={selected => inspection.setMarkdownView(columnId, id, selected ? "rendered" : "source")}
                    >
                        <RenderedMarkdownIcon />
                    </ToggleButton>
                    <Tooltip>Show rendered Markdown</Tooltip>
                </TooltipTrigger>
            )}
            {entireFiles && (
                <TooltipTrigger>
                    <ToggleButton className="icon-button small" aria-label="Show entire files" isSelected={entireFiles.shown} onChange={entireFiles.toggle}>
                        <EntireFileIcon />
                    </ToggleButton>
                    <Tooltip>Show entire files</Tooltip>
                </TooltipTrigger>
            )}
            {!rendered && (
                <>
                    <TooltipTrigger>
                        <ToggleButton className="icon-button small" aria-label="Wrap lines" isSelected={wrapLines} onChange={inspection.toggleWrapLines}>
                            <WrapLinesIcon />
                        </ToggleButton>
                        <Tooltip>Wrap lines</Tooltip>
                    </TooltipTrigger>
                    <TooltipTrigger>
                        <ToggleButton
                            className="icon-button small"
                            aria-label="Show whitespace"
                            isSelected={diff.showWhitespace}
                            onChange={() => inspection.toggleWhitespace(columnId, id)}
                        >
                            <WhitespaceIcon />
                        </ToggleButton>
                        <Tooltip>Show whitespace</Tooltip>
                    </TooltipTrigger>
                </>
            )}
        </div>
    )
}

/**
 * Switching layout draws every diff in the column at another height, so the diff whose controls `change` it holds its
 * place: the line or rendered block just under its header stays where it is, whether the header is pinned over the
 * diff or sits above it. A file list moves the rows below a diff only once it has measured the diff's new height, a
 * frame or more later, so the place is held each frame until it stays put, or until the user takes over, and the
 * list keeps the diff's row drawn meanwhile, though it may move far from the view.
 */
function holdPlace(controls: Element | null, change: () => void, holdRow?: (key: string) => () => void) {
    // The controls sit in the diff's header (its file's row, its toolbar in a diff column, or its history entry's row),
    // beside its panel.
    let header = controls?.closest(".file-content, .diff-toolbar, .history-row")
    let panel = header?.parentElement?.querySelector(".diff-panel")
    let y = header?.getBoundingClientRect().bottom ?? 0
    let lines = panel?.querySelector(".pierre-diff")
    let markdown = panel?.querySelector(".markdown-diff")
    let restore = lines ? holdLine(lines, y) : markdown ? holdBlock(markdown, y) : undefined
    if (!restore) {
        change()
        return
    }
    let held = new AbortController()
    let key = header?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey
    if (key != undefined && holdRow)
        held.signal.addEventListener("abort", holdRow(key))
    change()
    let still = 0
    let frames = 0
    let frame = requestAnimationFrame(function hold() {
        still = Math.abs(restore()) < 1 ? still + 1 : 0
        if (still < settledFrames && ++frames < heldFrames)
            frame = requestAnimationFrame(hold)
        else
            held.abort()
    })
    for (let type of ["wheel", "pointerdown", "keydown"]) {
        addEventListener(type, () => {
            cancelAnimationFrame(frame)
            held.abort()
        }, { capture: true, passive: true, signal: held.signal })
    }
}

// A place held after a switch of layout is let go once it has stayed put this many frames, or after the most.
let settledFrames = 4
let heldFrames = 60

/** How a changed picture compares: its versions side by side, or stacked to swipe, fade, or difference. */
export function ImageModeToggle({ mode, onChange }: { mode: ImageDiffMode; onChange(mode: ImageDiffMode): void }) {
    return (
        <div className="diff-layout-toggle" role="group" aria-label="Image comparison mode">
            {imageModes.map(choice => (
                <TooltipTrigger key={choice.mode}>
                    <ToggleButton
                        className="icon-button small"
                        aria-label={choice.label}
                        isSelected={mode == choice.mode}
                        onChange={() => onChange(choice.mode)}
                    >
                        <ImageModeIcon mode={choice.mode} />
                    </ToggleButton>
                    <Tooltip>{choice.label}</Tooltip>
                </TooltipTrigger>
            ))}
        </div>
    )
}

/**
 * A file's diff under its row: its lines, choosable in every list but a comparison's, with the chosen lines'
 * grip and discard; a Working Changes diff also switches between its staged and unstaged sides.
 */
export function DiffPanel({ columnId, id, diff, inspection, eligible }: DiffProps & { eligible: boolean }) {
    let { layout } = useContext(DiffScopeContext)
    let wrapLines = useSnapshotValue(inspection, snapshot => snapshot.wrapLines)
    let scope = useTransferScope()
    let page = diff.page && !eligible ? { ...diff.page, selectable: false } : diff.page
    let image = page != undefined && isImagePath(page.file.path)
    let markdown = page != undefined && isMarkdownPath(page.file.path) && isRendered(diff)
    let summary = page ? visibleSummary(page) : []
    let selection = eligible ? diff.selection : undefined
    let views = page?.source.kind == "working" ? viewChoices(diff, page.file) : []
    let source = page && transferSource(page.source, scope?.branch)
    let discardable = page?.source.kind == "working" && (diff.view == "unstaged" || diff.view == "combined" && !page.file.staged)
    return (
        <section className="diff-panel" aria-label={`Diff for ${diff.path}`}>
            {views.length > 1 && (
                <div className="diff-views">
                    <SegmentedControl
                        aria-label="Comparison"
                        selectedKeys={[diff.view]}
                        disallowEmptySelection
                        onSelectionChange={keys => {
                            let view = [...keys][0]
                            if (view && view != diff.view)
                                inspection.changeView(columnId, id, view as DiffView)
                        }}
                    >
                        {views.map(view => (
                            <SegmentedControlItem key={view} id={view}>
                                {view == "combined" ? "Working Changes" : `${view[0]!.toUpperCase()}${view.slice(1)}`}
                            </SegmentedControlItem>
                        ))}
                    </SegmentedControl>
                </div>
            )}
            {diff.notice && <p className="diff-message" role="status">{diff.notice}</p>}
            {diff.error && (
                <p className="diff-message" role="alert">
                    {diff.error} <Button variant="quiet" onPress={() => inspection.readDiff(columnId, id)}>Retry diff</Button>
                </p>
            )}
            {page && (
                <>
                    {summary.map(text => <p key={text} className="diff-summary">{text}</p>)}
                    {!image && page.lines.length == 0 && page.summary.length == 0 && <p className="diff-message">No net content difference in this view.</p>}
                    {image
                        ? <ImageDiff key={imageKey(page)} page={page} mode={diff.imageMode ?? preferredImageMode()} read={inspection.readImage} />
                        : markdown
                        ? <MarkdownDiff page={page} layout={layout} reader={inspection} />
                        : (
                            <DiffLines
                                page={page}
                                layout={layout}
                                wrap={wrapLines}
                                showWhitespace={diff.showWhitespace}
                                selected={selection?.lineIds ?? []}
                                readContext={inspection.readContext}
                                select={lineIds => {
                                    if (eligible)
                                        inspection.selectLines(columnId, id, lineIds)
                                }}
                            />
                        )}
                    {selection && (
                        <div className="line-selection" role="status">
                            {scope && source && (
                                <TransferGrip
                                    composition={scope.composition}
                                    alone
                                    selection={{
                                        repositoryId: scope.repositoryId,
                                        selectedRemote: scope.selectedRemote,
                                        source,
                                        files: [{ path: diff.path, version: page.version, entireFile: page.entireFile, lineIds: selection.lineIds }],
                                        view: diff.view == "staged" || diff.view == "unstaged" ? diff.view : "combined",
                                        label: `${selection.lineIds.length} lines in ${diff.path}`,
                                    }}
                                />
                            )}
                            <span className="line-selection-count">
                                {selection.lineIds.length} {selection.lineIds.length == 1 ? "line" : "lines"}{" "}
                                selected{selection.rename ? " · rename selected" : ""}
                            </span>
                            {discardable && selection.lineIds.length > 0 && (
                                <Button
                                    variant="quiet"
                                    className="discard-lines"
                                    onPress={() => void inspection.discardLines(columnId, id)}
                                >
                                    Discard selected
                                </Button>
                            )}
                            <Button variant="quiet" onPress={() => inspection.clearLines(columnId, id)}>Clear selection</Button>
                        </div>
                    )}
                    {page.nextOffset != undefined && (
                        <Button variant="quiet" isDisabled={diff.loading} onPress={() => inspection.readDiff(columnId, id, true)}>Load more</Button>
                    )}
                </>
            )}
            {diff.loading && (
                <p className="diff-progress" role="status">
                    Reading diff… <Button variant="quiet" onPress={() => inspection.cancelDiff(columnId, id)}>Cancel</Button>
                </p>
            )}
        </section>
    )
}

function isRendered(diff: FileDiffState) {
    return (diff.markdownView ?? preferredMarkdownView()) == "rendered"
}

// The staged and unstaged lists each show their own side of a file, so only conflict views remain to choose there;
// the combined Working Changes view keeps its staged and unstaged choices.
function viewChoices(diff: FileDiffState, file: ChangedFile): DiffView[] {
    let fixed = diff.group.startsWith("working-")
    return [
        ...(fixed ? [diff.view] : ["combined" as const, ...(file.staged ? ["staged" as const, "unstaged" as const] : [])]),
        ...(file.conflicted ? ["base" as const, "ours" as const, "theirs" as const] : []),
    ]
}

/** Wraps a diff so presses, clicks, and text selection inside it stay out of the row it sits in. */
export function DiffRegion({ children }: { children: ReactNode }) {
    let stop = (event: { stopPropagation(): void }) => event.stopPropagation()
    return (
        <div className="file-diff" onPointerDown={stop} onPointerUp={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop}>
            {children}
        </div>
    )
}
