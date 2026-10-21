import type { ChangedFile } from "@laneway/shared"
import { type MouseEvent, type RefObject, useLayoutEffect, useRef } from "react"
import { Button as AriaButton } from "react-aria-components"
import { Hint, IconButton } from "./controls"
import { useRowMenu } from "./dense-row"
import { DiffControls, DiffPanel } from "./diff-panel"
import { CopyPathButton, FileLabel, FileMenuItems } from "./file-tree"
import { ChevronDownIcon, CloseIcon, CollapseAllIcon, ExpandAllIcon, FileStatusIcon, MaximizeIcon, RestoreIcon } from "./icons"
import { type ColumnInspection, type DiffColumnView, diffKey, type FileDiffState, type Inspection, matchesFilter } from "./inspection"
import { ChevronRight } from "./ui/icons"
import { MenuItem } from "./ui/Menu"

interface DiffColumnProps {
    view: DiffColumnView
    /** The name of the column it came from. */
    sourceName: string
    /** Whether the source column's header has a second line, under which this header puts where it came from. */
    stacked: boolean
    /** What the column it came from shows, whose diffs this column draws. */
    inspected?: ColumnInspection
    inspection: Inspection
    /** The worktree the files live in, enabling "Copy full path". */
    root?: string
    /** Whether its source column is maximized, which it shares the window with. */
    maximized: boolean
    onMaximize(): void
    /** Closing returns focus to the source column. */
    onClose(): void
}

/**
 * One list's whole diff beside the column it came from: every file's diff, each under a toolbar that folds it.
 * Choosing a file in the source column scrolls its diff up under the header, and the file at the top is marked there
 * as the column scrolls.
 */
export let minimumDiffColumnWidth = 380

export function DiffColumn({ view, sourceName, stacked, inspected, inspection, root, maximized, onMaximize, onClose }: DiffColumnProps) {
    let scroller = useRef<HTMLDivElement>(null)
    let files = inspected?.files[view.group]
    // Its source column's filter narrows it as it does the source's own list.
    let filter = inspected?.filter
    let listed = files?.inventory?.files.filter(file => !file.ignored && (!filter || matchesFilter(filter, file))) ?? []
    let stopAiming = useArrival(scroller, view, listed, inspected)
    let spy = useScrollSpy(scroller, view, path => inspection.scrolledTo(view.id, path))
    // Once the user scrolls the column, it stops chasing the chosen file and marks whatever reaches the top.
    let scrolledByUser = () => {
        stopAiming()
        spy.release()
    }
    let title = diffColumnTitle(view, sourceName)
    let fold = (paths: string[], folded: boolean) => {
        // Folding moves the files, so the column stops chasing the one it scrolled to.
        stopAiming()
        inspection.foldDiffs(view.id, paths, folded)
    }
    // Like a column header, a double-click maximizes; the header's own controls keep theirs.
    let toggleMaximized = (event: MouseEvent) => {
        if (!(event.target instanceof Element && event.target.closest("button")))
            onMaximize()
    }
    return (
        <aside
            className="auxiliary-column diff-column"
            data-auxiliary-id={view.id}
            data-source-column-id={view.sourceId}
            tabIndex={-1}
            style={{ width: view.width }}
            aria-label={`${sourceName} diff`}
            onWheel={scrolledByUser}
            onPointerDown={scrolledByUser}
            onKeyDown={scrolledByUser}
        >
            <header className="column-header auxiliary-header" onDoubleClick={toggleMaximized}>
                <Hint text={title}>
                    <div className="column-title">
                        <div className="column-title-row">
                            <h2 className="column-name">{title}</h2>
                            {!stacked && <small className="auxiliary-source">From {sourceName}</small>}
                        </div>
                        {stacked && <small className="column-path auxiliary-source">From {sourceName}</small>}
                    </div>
                </Hint>
                <IconButton label="Expand all" onPress={() => fold(listed.map(file => file.path), false)}>
                    <ExpandAllIcon />
                </IconButton>
                <IconButton label="Collapse all" onPress={() => fold(listed.map(file => file.path), true)}>
                    <CollapseAllIcon />
                </IconButton>
                <IconButton label={maximized ? "Restore columns" : "Maximize column"} onPress={onMaximize}>
                    {maximized ? <RestoreIcon /> : <MaximizeIcon />}
                </IconButton>
                <IconButton
                    label="Close diff column"
                    onPress={() => {
                        inspection.closeAuxiliary(view.id)
                        onClose()
                    }}
                >
                    <CloseIcon />
                </IconButton>
            </header>
            <div ref={scroller} className="diff-column-files" onScroll={spy.update}>
                {files?.error && <p className="column-placeholder" role="alert">{files.error}</p>}
                {files?.loading && !files.inventory && <p className="column-placeholder" role="status">Reading changes…</p>}
                {listed.map(file => {
                    let id = diffKey(view.group, file.path)
                    let diff = inspected?.diffs[id]
                    return diff && (
                        <DiffColumnFile
                            key={file.path}
                            view={view}
                            file={file}
                            id={id}
                            diff={diff}
                            inspection={inspection}
                            root={root}
                            onFold={folded => fold([file.path], folded)}
                        />
                    )
                })}
            </div>
        </aside>
    )
}

function DiffColumnFile({ view, file, id, diff, inspection, root, onFold }: {
    view: DiffColumnView
    file: ChangedFile
    id: string
    diff: FileDiffState
    inspection: Inspection
    root?: string
    onFold(folded: boolean): void
}) {
    let collapsed = view.collapsed.includes(file.path)
    // The file's history reads from where the list was read: its worktree or its commit.
    let source = diff.page?.source
    let history = source?.kind == "working"
        ? { kind: "worktree" as const, worktreePath: source.worktreePath }
        : source?.kind == "commit"
        ? { kind: "commit" as const, objectId: source.objectId }
        : undefined
    let menu = {
        label: `Actions for ${file.path}`,
        items: () => (
            <FileMenuItems
                file={file}
                root={root}
                items={history && (() => <MenuItem onAction={() => inspection.openHistory(view.id, history, file.path)}>File history</MenuItem>)}
            />
        ),
    }
    let { row, openMenu } = useRowMenu<HTMLElement>(menu)
    return (
        <div className="diff-column-file" data-diff-path={file.path}>
            <header ref={row} className="diff-toolbar" onContextMenu={openMenu}>
                <AriaButton
                    className="diff-file-toggle"
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
                    aria-expanded={!collapsed}
                    onPress={() => onFold(!collapsed)}
                >
                    {collapsed ? <ChevronRight /> : <ChevronDownIcon />}
                    <FileStatusIcon status={file.conflicted ? "conflicted" : file.status} />
                    <FileLabel file={file} showFolder />
                </AriaButton>
                <CopyPathButton path={file.path} />
                <DiffControls
                    columnId={view.sourceId}
                    id={id}
                    diff={diff}
                    inspection={inspection}
                    entireFiles={{ shown: view.entireFiles, toggle: () => inspection.toggleEntireFiles(view.id) }}
                />
            </header>
            {!collapsed && <DiffPanel columnId={view.sourceId} id={id} diff={diff} inspection={inspection} eligible={view.group != "comparison"} />}
        </div>
    )
}

/** What a diff column shows: a Working Changes list, a commit, or another list of its source column's. */
export function diffColumnTitle(view: DiffColumnView, sourceName: string) {
    switch (view.group) {
        case "working":
            return `Working Changes · ${sourceName}`
        case "working-staged":
            return `Staged · ${sourceName}`
        case "working-unstaged":
            return `Unstaged · ${sourceName}`
        default:
            return view.subject ? `Commit · ${view.subject}` : `Diff · ${sourceName}`
    }
}

/**
 * Scrolls a chosen file's toolbar to the top of the column's files, and marks it as it arrives. Diffs above it push it
 * down as they load, so the column keeps aiming at it until they have all loaded; the returned function stops it early.
 */
function useArrival(scroller: RefObject<HTMLElement | null>, view: DiffColumnView, listed: ChangedFile[], inspected?: ColumnInspection) {
    let seen = useRef<number>(undefined)
    let aiming = useRef(false)
    useLayoutEffect(() => {
        let focus = view.focus
        let element = scroller.current
        if (!focus || !element)
            return
        let arrived = seen.current != focus.serial
        if (arrived) {
            seen.current = focus.serial
            aiming.current = true
        }
        let target = [...element.querySelectorAll<HTMLElement>("[data-diff-path]")].find(candidate => candidate.dataset.diffPath == focus.path)
        if (!aiming.current || !target)
            return
        element.scrollTo({
            top: element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top,
            behavior: arrived && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant",
        })
        if (arrived)
            highlight(target.querySelector<HTMLElement>(".diff-toolbar"))
        let above = listed.slice(0, listed.findIndex(file => file.path == focus.path) + 1)
        if (above.every(file => !inspected?.diffs[diffKey(view.group, file.path)]?.loading))
            aiming.current = false
    })
    return () => {
        aiming.current = false
    }
}

// The attribute restarts the toolbar's arrival animation; React doesn't manage it, so renders leave it alone.
function highlight(toolbar: HTMLElement | null) {
    if (!toolbar)
        return
    toolbar.removeAttribute("data-arrived")
    void toolbar.offsetWidth
    toolbar.setAttribute("data-arrived", "")
    toolbar.addEventListener("animationend", () => toolbar.removeAttribute("data-arrived"), { once: true })
}

/**
 * Reports the file whose diff is at the top of the column's files, after each render and as they scroll. While the
 * column scrolls to a file chosen in its source column, which stays marked, the files it passes aren't reported;
 * `release` hands the mark back to the column once the user scrolls it, with the wheel, the keyboard, or the pointer.
 */
function useScrollSpy(scroller: RefObject<HTMLElement | null>, view: DiffColumnView, report: (path: string) => void) {
    let seen = useRef<number>(undefined)
    let held = useRef(false)

    let update = () => {
        let element = scroller.current
        if (held.current || !element)
            return
        let top = element.getBoundingClientRect().top
        let sections = [...element.querySelectorAll<HTMLElement>("[data-diff-path]")]
            .map(section => ({ path: section.dataset.diffPath!, top: section.getBoundingClientRect().top - top }))
        let path = shownFile(sections)
        if (path)
            report(path)
    }

    // Runs after `useArrival` has scrolled to a newly chosen file, and checks again once diffs load and fold.
    useLayoutEffect(() => {
        let focus = view.focus
        if (focus && focus.serial != seen.current) {
            seen.current = focus.serial
            held.current = true
        }
        update()
    })

    let release = () => {
        held.current = false
    }
    return { update, release }
}

/**
 * The file at the top of a diff column: the last whose section starts at or above the top of the files, given each
 * section's top relative to it, or the first while none has reached it. A pixel's leeway allows for fractional
 * scrolling. Files too short to reach the top at the end of the column are only marked by choosing them.
 */
export function shownFile(sections: { path: string; top: number }[]) {
    return (sections.findLast(section => section.top <= 1) ?? sections[0])?.path
}
