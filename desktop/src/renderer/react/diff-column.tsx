import type { ChangedFile, FileListView } from "@laneway/shared"
import { createContext, Fragment, type KeyboardEvent, memo, type MouseEvent, type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Button as AriaButton } from "react-aria-components"
import { Hint, IconButton } from "./controls"
import { useRowMenu } from "./dense-row"
import { DiffControls, DiffPanel } from "./diff-panel"
import { orderedFiles } from "./file-list-view"
import { CopyPathButton, FileLabel, FileMenuItems, FilePath } from "./file-tree"
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
    /** Whether its diffs' lines can be chosen, to move or discard. */
    eligible: boolean
    /** How the source column lists its files, whose order and groups this column follows. */
    listView: FileListView
    inspection: Inspection
    /** The worktree the files live in, enabling "Copy full path". */
    root?: string
    /** Whether its source column is maximized, which it shares the row's view with. */
    maximized: boolean
    onMaximize(): void
    /** Closing returns focus to the source column. */
    onClose(): void
}

/**
 * One list's whole diff beside the Workspace Column or Commit Diff column it came from: every file's diff, each under a
 * toolbar that folds it.
 * Choosing a file in the source column scrolls its diff up under the header, and the file at the top is marked there
 * as the column scrolls.
 */
export let minimumDiffColumnWidth = 380

export function DiffColumn({ view, sourceName, stacked, inspected, eligible, listView, inspection, root, maximized, onMaximize, onClose }: DiffColumnProps) {
    let scroller = useRef<HTMLDivElement>(null)
    let files = inspected?.files[view.group]
    // Its source column's filter narrows it as it does the source's own list.
    let filter = inspected?.filter
    let listed = files?.inventory?.files.filter(file => !file.ignored && (!filter || matchesFilter(filter, file))) ?? []
    // Its files follow their order and groups in the source list; each diff's path stands in for its folders.
    let ordered = orderedFiles(listed, listView)
    let stopAiming = useArrival(scroller, view, ordered.map(entry => entry.file), inspected)
    let spy = useScrollSpy(scroller, view, path => inspection.scrolledTo(view.id, path))
    // Once the user scrolls the column, it stops chasing the chosen file and marks whatever reaches the top.
    let scrolledByUser = () => {
        stopAiming()
        spy.release()
    }
    // Only keys that scroll it count: Escape, Tab, and keys a diff's own controls handle leave it aiming.
    let keyed = (event: KeyboardEvent) => {
        if (!event.defaultPrevented && scrollingKeys.includes(event.key))
            scrolledByUser()
    }
    let title = diffColumnTitle(view, sourceName)
    let viewId = view.id
    let fold = useCallback((paths: string[], folded: boolean) => {
        // Folding moves the files, so the column stops chasing the one it scrolled to.
        stopAiming()
        inspection.foldDiffs(viewId, paths, folded)
    }, [stopAiming, inspection, viewId])
    let foldFile = useCallback((path: string, folded: boolean) => fold([path], folded), [fold])
    let collapsed = new Set(view.collapsed)
    let nearby = useNearby(scroller)
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
            onKeyDown={keyed}
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
                <IconButton label={maximized ? "Restore column" : "Maximize column"} onPress={onMaximize}>
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
            <NearbyContext value={nearby}>
                <div ref={scroller} className="diff-column-files" data-grouped={listView.grouping != "none" || undefined} onScroll={spy.update}>
                    {files?.error && <p className="column-placeholder" role="alert">{files.error}</p>}
                    {files?.loading && !files.inventory && <p className="column-placeholder" role="status">Reading changes…</p>}
                    {ordered.map(({ file, group }, index) => {
                        let id = diffKey(view.group, file.path)
                        let diff = inspected?.diffs[id]
                        return (
                            <Fragment key={file.path}>
                                {group != ordered[index - 1]?.group && (
                                    <h3 className="diff-column-group">
                                        {group}
                                        <span className="file-group-count">{ordered.filter(entry => entry.group == group).length}</span>
                                    </h3>
                                )}
                                {diff && (
                                    <DiffColumnFile
                                        columnId={view.id}
                                        ownerId={view.ownerId}
                                        eligible={eligible}
                                        entireFiles={view.entireFiles}
                                        collapsed={collapsed.has(file.path)}
                                        file={file}
                                        id={id}
                                        diff={diff}
                                        inspection={inspection}
                                        root={root}
                                        onFold={foldFile}
                                        eager={index < eagerFiles}
                                    />
                                )}
                            </Fragment>
                        )
                    })}
                </div>
            </NearbyContext>
        </aside>
    )
}

let scrollingKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]

// The files at the top of a column draw their toolbars at once, so opening it draws nothing twice. Others draw a few a
// frame, nearest the view first, so a glide arriving among many folded files doesn't stall.
let eagerFiles = 12
let toolbarsPerFrame = 8

interface Nearby {
    /** Calls `near` once `element` comes within the column's height of its view. */
    observe(element: Element, near: () => void): () => void
    disconnect(): void
}

let NearbyContext = createContext<Nearby | undefined>(undefined)

/** One observer for every file in a column, rather than one each. */
function useNearby(scroller: RefObject<HTMLElement | null>) {
    let [nearby] = useState<Nearby>(() => {
        let waiting = new Map<Element, () => void>()
        // Files near the view while a glide passes them, which draw once it slows near its file, unless they've gone.
        let passed = new Set<Element>()
        let observer: IntersectionObserver | undefined
        let lifetime = new AbortController()
        let queued = new Set<Element>()
        let frame: number | undefined
        let draw = () => {
            frame = undefined
            let root = scroller.current
            if (!root)
                return
            let view = root.getBoundingClientRect()
            let middle = view.top + view.height / 2
            let distance = (element: Element) => {
                let box = element.getBoundingClientRect()
                return box.bottom < view.top ? view.top - box.bottom : box.top > view.bottom ? box.top - view.bottom : middle - box.top
            }
            let nearest = [...queued].map(element => ({ element, distance: distance(element) })).sort((a, b) => a.distance - b.distance)
            for (let { element } of nearest.slice(0, toolbarsPerFrame)) {
                queued.delete(element)
                waiting.get(element)?.()
            }
            if (queued.size)
                frame = requestAnimationFrame(draw)
        }
        let promote = (element: Element) => {
            queued.add(element)
            frame ??= requestAnimationFrame(draw)
        }
        let arrive = () => {
            if (scroller.current?.hasAttribute("data-gliding"))
                return
            for (let element of passed)
                promote(element)
            passed.clear()
        }
        // Files observe from their effects, between diffs drawing their spacers, so asking each time whether the column
        // has layout would lay it out again for each file. One answer serves every file observed in the same pass.
        let laidOut: boolean | undefined
        let hasLayout = (root: HTMLElement) => {
            if (laidOut == undefined) {
                laidOut = root.clientHeight > 0
                queueMicrotask(() => laidOut = undefined)
            }
            return laidOut
        }
        return {
            observe(element, near) {
                let root = scroller.current
                // Without layout, as in tests, every file is near.
                if (!root || !hasLayout(root)) {
                    near()
                    return () => {}
                }
                if (!observer) {
                    observer = new IntersectionObserver(entries => {
                        for (let entry of entries) {
                            if (!entry.isIntersecting) {
                                passed.delete(entry.target)
                                queued.delete(entry.target)
                            } else if (root.hasAttribute("data-gliding"))
                                passed.add(entry.target)
                            else
                                promote(entry.target)
                        }
                    }, { root, rootMargin: "100% 0px" })
                    root.addEventListener("scroll", arrive, { passive: true, signal: lifetime.signal })
                }
                waiting.set(element, near)
                observer.observe(element)
                return () => {
                    waiting.delete(element)
                    passed.delete(element)
                    queued.delete(element)
                    observer?.unobserve(element)
                }
            },
            disconnect() {
                observer?.disconnect()
                lifetime.abort()
                if (frame != undefined)
                    cancelAnimationFrame(frame)
            },
        }
    })
    useEffect(() => () => nearby.disconnect(), [nearby])
    return nearby
}

/** Whether a file has come within the column's height of its view; once it has, it stays near. */
function useNear(section: RefObject<HTMLElement | null>, eager: boolean) {
    let nearby = useContext(NearbyContext)
    let [near, setNear] = useState(eager || !nearby)
    useEffect(() => {
        let element = section.current
        if (near || !element || !nearby)
            return
        return nearby.observe(element, () => setNear(true))
    }, [section, near, nearby])
    return near
}

interface DiffColumnFileProps {
    /** The diff column's ID. */
    columnId: string
    /** The column state whose diffs it shows. */
    ownerId: string
    eligible: boolean
    entireFiles: boolean
    collapsed: boolean
    file: ChangedFile
    id: string
    diff: FileDiffState
    inspection: Inspection
    root?: string
    onFold(path: string, folded: boolean): void
}

/**
 * One file's toolbar and diff. It re-renders only when its own diff or fold changes, since a large column's every
 * other file would otherwise re-render each time any diff loads. Its toolbar draws its controls once the file nears the
 * view; before then the file shows as they would leave it.
 */
const DiffColumnFile = memo(function DiffColumnFile(props: DiffColumnFileProps & { eager: boolean }) {
    let { ownerId, eligible, collapsed, file, id, diff, inspection, eager } = props
    let section = useRef<HTMLDivElement>(null)
    let near = useNear(section, eager)
    return (
        <div ref={section} className="diff-column-file" data-diff-path={file.path}>
            {near
                ? <DiffToolbar {...props} />
                : (
                    <header className="diff-toolbar">
                        <span className="diff-file-toggle">
                            {collapsed ? <ChevronRight /> : <ChevronDownIcon />}
                            <FileStatusIcon status={file.conflicted ? "conflicted" : file.status} />
                            <FilePath file={file} showFolder />
                        </span>
                    </header>
                )}
            {!collapsed && <DiffPanel columnId={ownerId} id={id} diff={diff} inspection={inspection} eligible={eligible} />}
        </div>
    )
})

function DiffToolbar({ columnId, ownerId, entireFiles, collapsed, file, id, diff, inspection, root, onFold }: DiffColumnFileProps) {
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
                items={history && (() => <MenuItem onAction={() => inspection.openHistory(columnId, history, file.path)}>File history</MenuItem>)}
            />
        ),
    }
    let { row, openMenu } = useRowMenu<HTMLElement>(menu)
    return (
        <header ref={row} className="diff-toolbar" onContextMenu={openMenu}>
            <AriaButton
                className="diff-file-toggle"
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
                aria-expanded={!collapsed}
                onPress={() => onFold(file.path, !collapsed)}
            >
                {collapsed ? <ChevronRight /> : <ChevronDownIcon />}
                <FileStatusIcon status={file.conflicted ? "conflicted" : file.status} />
                <FileLabel file={file} showFolder />
            </AriaButton>
            <CopyPathButton path={file.path} />
            <DiffControls
                columnId={ownerId}
                id={id}
                diff={diff}
                inspection={inspection}
                entireFiles={{ shown: entireFiles, toggle: () => inspection.toggleEntireFiles(columnId) }}
            />
        </header>
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
    let gliding = useRef<Glide>(undefined)
    useEffect(() => () => gliding.current?.stop(), [])
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
        let toolbar = target.querySelector<HTMLElement>(".diff-toolbar")
        // Under a group's heading the toolbar pins below it, so the file stops there to keep the heading in view.
        let pinned = toolbar ? parseFloat(getComputedStyle(toolbar).top) || 0 : 0
        let distance = () => target.getBoundingClientRect().top - element.getBoundingClientRect().top - pinned
        // A chosen file glides into place, unless motion is reduced or there's no layout to glide through. While it
        // glides, its place is measured again each frame, so it follows the diffs above it as they draw.
        if (arrived && element.clientHeight > 0 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
            gliding.current ??= glide(element, () => gliding.current = undefined)
            gliding.current.to(distance)
        } else if (!gliding.current) {
            element.scrollTo({ top: element.scrollTop + distance(), behavior: "instant" })
        }
        if (arrived)
            highlight(toolbar)
        let above = listed.slice(0, listed.findIndex(file => file.path == focus.path) + 1)
        if (above.every(file => !inspected?.diffs[diffKey(view.group, file.path)]?.loading))
            aiming.current = false
    })
    return useCallback(() => {
        aiming.current = false
        gliding.current?.stop()
    }, [])
}

interface Glide {
    /** Retargets the glide, keeping its speed: `distance` measures how far the column still has to go. */
    to(distance: () => number): void
    stop(): void
}

// The spring's angular frequency, per millisecond: a glide settles in about half a second whatever the distance.
let springRate = 0.015

/**
 * Scrolls `element` toward a target on a critically damped spring, as Pierre's CodeView does. The target is measured
 * again each frame, and the browser's scroll anchoring, which moves the column as diffs above the view draw, carries
 * the glide with it, so it lands where the target ends up rather than where it was when it started. While it is more
 * than a screen from the target it marks the column `data-gliding`, so the files it passes draw nothing; once it is
 * near, a scroll event has those around the target draw as the glide slows into place.
 */
function glide(element: HTMLElement, settled: () => void): Glide {
    let passing = (fast: boolean) => {
        if (fast == element.hasAttribute("data-gliding"))
            return
        element.toggleAttribute("data-gliding", fast)
        if (!fast)
            element.dispatchEvent(new Event("scroll"))
    }
    let distance = () => 0
    let position = element.scrollTop
    let velocity = 0
    let written = position
    let last = performance.now()
    let request = requestAnimationFrame(function step(now) {
        position += element.scrollTop - written
        let destination = element.scrollTop + distance()
        let elapsed = Math.max(0, now - last)
        last = now
        let decay = Math.exp(-springRate * elapsed)
        let displacement = position - destination
        let spring = velocity + springRate * displacement
        position = destination + (displacement + spring * elapsed) * decay
        velocity = (spring * (1 - springRate * elapsed) - springRate * displacement) * decay
        if (Math.abs(destination - position) <= 0.5 && Math.abs(velocity) <= 0.05) {
            element.scrollTop = destination
            passing(false)
            settled()
            return
        }
        passing(Math.abs(destination - position) > element.clientHeight)
        element.scrollTop = position
        written = element.scrollTop
        request = requestAnimationFrame(step)
    })
    return {
        to(next) {
            distance = next
        },
        stop() {
            cancelAnimationFrame(request)
            passing(false)
            settled()
        },
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
        // Grouped, toolbars pin under the group heading, so a file is at the top where arrival leaves it: under that heading.
        let toolbar = element.querySelector<HTMLElement>(".diff-toolbar")
        let top = element.getBoundingClientRect().top + (toolbar ? parseFloat(getComputedStyle(toolbar).top) || 0 : 0)
        // Each section is measured only if the search reaches it.
        let sections = [...element.querySelectorAll<HTMLElement>("[data-diff-path]")].map(section => ({
            path: section.dataset.diffPath!,
            get top() {
                return section.getBoundingClientRect().top - top
            },
        }))
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
 * scrolling. Files too short to reach the top at the end of the column are only marked by choosing them. Sections
 * run down the column, so halving finds it, reading few of their tops.
 */
export function shownFile(sections: { path: string; top: number }[]) {
    let below = 0
    let above = sections.length
    while (below < above) {
        let middle = (below + above) >> 1
        if (sections[middle]!.top <= 1)
            below = middle + 1
        else
            above = middle
    }
    return (sections[below - 1] ?? sections[0])?.path
}
