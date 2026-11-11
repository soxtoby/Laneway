import type { ChangedFile, FileListView } from "@laneway/shared"
import clsx from "clsx"
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react"
import { Button as AriaButton, type Key, ListLayout, Rect, Tree, Virtualizer } from "react-aria-components"
import { Hint } from "./controls"
import { DenseTreeItem } from "./dense-row"
import { DiffRegion, HeldRowContext } from "./diff-panel"
import { type FileTreeNode, fileTreeNodes } from "./file-list-view"
import { copyText, fileName, fullPath } from "./file-paths"
import { CheckIcon, CopyIcon, DiffIcon, FileStatusIcon, FolderIcon } from "./icons"
import type { FileChoice } from "./inspection"
import { ChevronRight } from "./ui/icons"
import { MenuItem, Separator } from "./ui/Menu"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"

interface FileTreeProps {
    /** Names the list, such as "Staged files". */
    label: string
    files: ChangedFile[]
    view: FileListView
    /** The list's group, which prefixes its files in `selected`. */
    group: string
    selected: string[]
    /** Chooses files as `how` says, toggling them by default; without it rows can't be chosen. */
    onSelect?(files: ChangedFile[], how?: FileChoice): void
    /** The worktree the files live in, enabling "Copy full path". */
    root?: string
    /** A file's own menu items, shown above the copy actions. */
    menuItems?(file: ChangedFile): ReactNode
    /** Working Changes lists say staged by where they sit, so their rows leave the badge out. */
    hideStagedBadge?: boolean
    /** What leads a row: a grip moving the row's files, named by the file's path or the folder's or group's label. */
    leading?(files: ChangedFile[], label: string): ReactNode
    /** What pressing and opening a file's row does; without it rows don't open. */
    inspect?: FileInspection
    /** Text the column's filter looks for, marked where it shows in file names and folders. */
    highlight?: string
    /** Lays out the list's rows, drawing only those near the view. */
    layout: FileRowsLayout
}

/** How a list's files show their diffs: in their column's diff column, or under their rows. */
export interface FileInspection {
    /** What a plain press on a file's row does. */
    press(file: ChangedFile): void
    /**
     * Opens the file in the column's diff column, from a double-click or Enter, which leave focus on the row, or from
     * the row's button, which gives it to the diff column with `focus`.
     */
    open?(file: ChangedFile, focus?: boolean): void
    /** Diffs shown under their rows, in a column with no diff column of its own. */
    inline?: InlineDiffs
}

/** A list's diffs shown under their rows: which files show one, and what the row draws for it. */
export interface InlineDiffs {
    isOpen(file: ChangedFile): boolean
    /** Closes the diffs of files a folded folder or group hides. */
    close(files: ChangedFile[]): void
    /** The diff's controls, drawn in the open row. */
    controls(file: ChangedFile): ReactNode
    diff(file: ChangedFile): ReactNode
}

/**
 * Lays out a file list's rows as React Aria's ListLayout does, drawing only those within reach of the view, which
 * scrolls with the column the list sits in. The column's arrow keys step through the rows that are drawn, so rows a
 * little beyond the view are drawn too.
 */
export class FileRowsLayout extends ListLayout<unknown> {
    // Rows drawn wherever they are, such as one whose diff holds its place while the rows above it grow.
    private held = new Set<Key>()

    /** Keeps a row drawn wherever the list moves it, until the returned function lets it go. */
    hold = (key: Key) => {
        this.held.add(key)
        return () => void this.held.delete(key)
    }

    override getVisibleLayoutInfos(rect: Rect) {
        let infos = super.getVisibleLayoutInfos(new Rect(rect.x, rect.y - rowsReach, rect.width, rect.height + 2 * rowsReach))
        for (let key of this.held) {
            let info = this.getLayoutInfo(key)
            if (info && !infos.some(drawn => drawn.key == key))
                infos.push(info)
        }
        return infos
    }

    // Scrolling with its column, the list is as tall as its rows, so its height changes whenever a row opens a diff or
    // a diff grows. Only a new width invalidates every row's measured height: ListLayout would otherwise drop them all
    // for its estimate, collapsing the list for the layout in which the drawn rows measure themselves again, which
    // moves the column's content under the view and leaves the rows the view passed undrawn.
    override shouldInvalidate(newRect: Rect, oldRect: Rect) {
        return newRect.width != oldRect.width
    }
}

let rowsReach = 200
// Rows are 28px, and grow to show a diff opened under them.
let rowsLayout = { estimatedRowHeight: 28 }

/**
 * A list of changed files, flat or in folders and optionally grouped, as React Aria's Tree. A click chooses a file for
 * bulk actions in place of the files chosen before, and acts on it as `inspect` says. Ctrl+click or Space adds a file
 * or takes it away, or every file a folder or group holds, and Shift adds the rows from the last one pressed. A
 * double-click or Enter opens a file. Only the rows near the view are drawn.
 */
export function FileTree(
    { label, files, view, group, selected, onSelect, root, menuItems, hideStagedBadge, leading, inspect, highlight, layout }: FileTreeProps,
) {
    let nodes = fileTreeNodes(files, view)
    let folders = foldingNodes(nodes)
    // Folders start open; a folded one remembers that by its key while the list stays.
    let [folded, setFolded] = useState<Set<string>>(new Set())
    let expandedKeys = new Set([...folders.keys()].filter(key => !folded.has(key)))
    let isChosen = (file: ChangedFile) => selected.includes(`${group}:${file.path}`)
    // Folders and groups chosen as rows, by key. One shows as chosen only while every file it holds still is, so
    // choosing its files one by one leaves it unmarked.
    let [chosenFolders, setChosenFolders] = useState<Set<string>>(new Set())
    let isFolderChosen = (key: string) => chosenFolders.has(key) && folders.get(key)?.files.every(isChosen) == true
    let tree = useRef<HTMLDivElement>(null)
    // Where a Shift range starts: the row last pressed or chosen on its own.
    let anchor = useRef<string>(undefined)
    // Ctrl or Shift held as a row is pressed, so React Aria's action for the press chooses the row instead, or Enter,
    // whose action opens the row's file.
    let held = useRef<{ toggle: boolean; range: boolean; enter?: boolean }>(undefined)

    let rowFiles = (key: string) => folders.get(key)?.files ?? files.filter(file => file.path == key)
    let choose = (key: string, range: boolean) => {
        let rows = rowKeys(nodes, folded)
        let from = range && anchor.current != undefined ? rows.indexOf(anchor.current) : -1
        let to = rows.indexOf(key)
        // A folder whose files were taken away since it was chosen isn't chosen anymore.
        let stillChosen = new Set([...chosenFolders].filter(isFolderChosen))
        if (from < 0 || to < 0) {
            anchor.current = key
            if (!folders.has(key)) {
                setChosenFolders(stillChosen)
                onSelect?.(rowFiles(key))
            } else if (stillChosen.delete(key)) {
                setChosenFolders(stillChosen)
                onSelect?.(rowFiles(key))
            } else {
                // A folder that isn't marked chooses its files, even when they are all chosen already.
                setChosenFolders(stillChosen.add(key))
                onSelect?.(rowFiles(key), "add")
            }
            return
        }
        // An open folder's files are rows of their own; a folded one brings the files it hides.
        let between = rows.slice(Math.min(from, to), Math.max(from, to) + 1)
        setChosenFolders(new Set([...stillChosen, ...between.filter(row => folders.has(row))]))
        onSelect?.(between.flatMap(row => folders.has(row) && !folded.has(row) ? [] : rowFiles(row)), "add")
    }

    // Native capturing listeners see a press's modifiers and a Space before React Aria's own handlers.
    let pointerDown = useEffectEvent((event: PointerEvent) => {
        held.current = { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }
    })
    let keyDown = useEffectEvent((event: KeyboardEvent) => {
        held.current = event.key == "Enter" ? { toggle: false, range: false, enter: true } : undefined
        let row = event.target as HTMLElement
        if (event.key != " " || !onSelect || !row.dataset.rowKey)
            return
        event.preventDefault()
        event.stopPropagation()
        choose(row.dataset.rowKey, event.shiftKey)
    })
    // A double-click on a file's row opens it, unless it lands on one of the row's controls.
    let doubleClick = useEffectEvent((event: MouseEvent) => {
        let target = event.target as Element
        let row = target.closest<HTMLElement>("[data-row-key]")
        if (!inspect?.open || !row || event.ctrlKey || event.metaKey || event.shiftKey || target.closest("button, a, input, .file-diff"))
            return
        let file = files.find(candidate => candidate.path == row.dataset.rowKey)
        if (file)
            inspect.open(file)
    })
    useEffect(() => {
        let element = tree.current
        if (!element)
            return
        let onPointerDown = (event: PointerEvent) => pointerDown(event)
        let onKeyDown = (event: KeyboardEvent) => keyDown(event)
        let onDoubleClick = (event: MouseEvent) => doubleClick(event)
        element.addEventListener("pointerdown", onPointerDown, true)
        element.addEventListener("keydown", onKeyDown, true)
        element.addEventListener("dblclick", onDoubleClick)
        return () => {
            element.removeEventListener("pointerdown", onPointerDown, true)
            element.removeEventListener("keydown", onKeyDown, true)
            element.removeEventListener("dblclick", onDoubleClick)
        }
    }, [])

    // Folding a folder or group closes the diffs of the files it hides.
    let fold = (keys: Set<string>) => {
        let hidden = [...keys].filter(key => !folded.has(key)).flatMap(key => folders.get(key)?.files ?? [])
        if (hidden.length)
            inspect?.inline?.close(hidden)
        setFolded(keys)
    }

    // A folder's row folds it; a file's row is pressed, or opened with Enter. With Ctrl or Shift held, the row is chosen,
    // and a click without them chooses only its file. Arrow keys that press a row choose nothing.
    let act = (key: Key) => {
        let modifiers = held.current
        held.current = undefined
        if (onSelect && (modifiers?.toggle || modifiers?.range)) {
            choose(String(key), modifiers.range)
            return
        }
        anchor.current = String(key)
        if (folders.has(String(key))) {
            let next = new Set(folded)
            if (!next.delete(String(key)))
                next.add(String(key))
            fold(next)
            return
        }
        let file = files.find(candidate => candidate.path == key)
        if (file && modifiers?.enter && inspect?.open)
            inspect.open(file)
        else if (file) {
            if (modifiers && !modifiers.enter && onSelect) {
                setChosenFolders(new Set())
                onSelect([file], "only")
            }
            inspect?.press(file)
        }
    }

    return (
        <HeldRowContext value={layout.hold}>
            <Virtualizer layout={layout} layoutOptions={rowsLayout} shouldObserveItemSize>
                <Tree
                    ref={tree}
                    aria-label={label}
                    className="file-tree"
                    expandedKeys={expandedKeys}
                    onExpandedChange={keys => fold(new Set([...folders.keys()].filter(key => !keys.has(key))))}
                    onAction={act}
                >
                    {nodes.map(node => (
                        <FileTreeRow
                            key={node.key}
                            node={node}
                            flat={view.layout == "flat"}
                            nested={folders.size > 0}
                            props={{ isChosen, isFolderChosen, root, menuItems, hideStagedBadge, leading, inspect, highlight }}
                        />
                    ))}
                </Tree>
            </Virtualizer>
        </HeldRowContext>
    )
}

/**
 * Scrolls the list's column just far enough to show a row. A row out of reach of the view isn't drawn, so its place
 * comes from the list's layout.
 */
export function revealRow(tree: HTMLElement, layout: FileRowsLayout, key: string) {
    let row = [...tree.querySelectorAll<HTMLElement>("[data-row-key]")].find(candidate => candidate.dataset.rowKey == key)
    if (row) {
        row.scrollIntoView({ block: "nearest", container: "nearest" })
        return
    }
    let place = layout.getLayoutInfo(key)?.rect
    let scroller = tree.parentElement
    while (scroller && !["auto", "scroll", "overlay"].includes(getComputedStyle(scroller).overflowY))
        scroller = scroller.parentElement
    if (!place || !scroller)
        return
    let top = tree.getBoundingClientRect().top + place.y
    let view = scroller.getBoundingClientRect()
    if (top < view.top)
        scroller.scrollTop -= view.top - top
    else if (top + place.height > view.bottom)
        scroller.scrollTop += top + place.height - view.bottom
}

// The list's rows in the order they show: each folder or group, then the rows it holds unless it is folded.
function rowKeys(nodes: FileTreeNode[], folded: Set<string>): string[] {
    return nodes.flatMap(node => node.kind == "file" ? [node.key] : [node.key, ...folded.has(node.key) ? [] : rowKeys(node.children, folded)])
}

function FileTreeRow(
    { node, flat, nested, props }: {
        node: FileTreeNode
        flat: boolean
        /** Whether the list has folders or groups, whose chevrons lead their rows; a file keeps a space for one. */
        nested: boolean
        props: Pick<FileTreeProps, "root" | "menuItems" | "hideStagedBadge" | "leading" | "inspect" | "highlight"> & {
            isChosen(file: ChangedFile): boolean
            isFolderChosen(key: string): boolean
        }
    },
) {
    if (node.kind == "file") {
        let file = node.file
        let open = props.inspect?.inline?.isOpen(file) == true
        return (
            <DenseTreeItem
                id={node.key}
                textValue={file.path}
                className={clsx("compact file-row", open && "inspected")}
                data-row-key={node.key}
                data-chosen={props.isChosen(file) || undefined}
                menu={{ label: `Actions for ${file.path}`, items: () => <FileMenuItems file={file} root={props.root} items={props.menuItems} /> }}
                content={({ actions }) => (
                    <>
                        <div className="row-content file-content">
                            {props.leading?.([file], file.path)}
                            {nested && <span className="chevron-space" />}
                            <FileStatusIcon status={file.conflicted ? "conflicted" : file.status} />
                            <FileLabel file={file} showFolder={flat || !!file.oldPath} highlight={props.highlight} />
                            <CopyPathButton path={file.path} />
                            {file.staged && !props.hideStagedBadge && <span className="file-badge">staged</span>}
                            {file.submodule && <span className="file-badge">submodule</span>}
                            {open && props.inspect?.inline?.controls(file)}
                            {props.inspect?.open && (
                                <OpenDiffButton path={file.path} onPress={() => props.inspect?.open?.(file, true)} />
                            )}
                            {actions}
                        </div>
                        {open && <DiffRegion>{props.inspect?.inline?.diff(file)}</DiffRegion>}
                    </>
                )}
            />
        )
    }
    return (
        <DenseTreeItem
            id={node.key}
            textValue={node.label}
            className="compact folder-row"
            data-row-key={node.key}
            data-chosen={props.isFolderChosen(node.key) || undefined}
            content={({ isExpanded }) => (
                // Shaped like a file row, its chevron where a file keeps a space, so icons line up.
                <div className="row-content folder-content">
                    {props.leading?.(node.files, node.label)}
                    <AriaButton slot="chevron" className="folder-chevron" aria-label={isExpanded ? `Fold ${node.label}` : `Unfold ${node.label}`}>
                        <ChevronRight />
                    </AriaButton>
                    {node.kind == "folder" && <FolderIcon className="folder-icon" />}
                    <span className="folder-name">
                        <Highlighted text={node.label} highlight={props.highlight} />
                    </span>
                    {node.kind == "group" && <span className="file-group-count">{node.files.length}</span>}
                </div>
            )}
        >
            {node.children.map(child => <FileTreeRow key={child.key} node={child} flat={flat} nested={nested} props={props} />)}
        </DenseTreeItem>
    )
}

/** A file's own actions, then copying where it lives. */
export function FileMenuItems({ file, root, items }: { file: ChangedFile; root?: string; items?(file: ChangedFile): ReactNode }) {
    let own = items?.(file)
    return (
        <>
            {own}
            {own && <Separator />}
            {root && <MenuItem onAction={() => void copyText(fullPath(root, file.path))}>Copy full path</MenuItem>}
            <MenuItem onAction={() => void copyText(file.path)}>Copy relative path</MenuItem>
            <MenuItem onAction={() => void copyText(fileName(file.path))}>Copy file name</MenuItem>
        </>
    )
}

/**
 * The file's name, then quietly its folder when the list doesn't show folders, and where a renamed file
 * came from.
 */
export function FileLabel({ file, showFolder, highlight }: { file: ChangedFile; showFolder: boolean; highlight?: string }) {
    return (
        <Hint text={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
            <FilePath file={file} showFolder={showFolder} highlight={highlight} />
        </Hint>
    )
}

/** A file's name, then its folder and where it moved from, with the filter's matches marked. */
export function FilePath({ file, showFolder, highlight }: { file: ChangedFile; showFolder: boolean; highlight?: string }) {
    let separator = file.path.lastIndexOf("/") + 1
    let folder = showFolder ? file.path.slice(0, separator) : ""
    let name = file.path.slice(separator)
    // A match can run from the folder into the name, so it is found across the whole path.
    let found = highlight ? occurrences(folder + name, highlight) : []
    let moved = file.oldPath && highlight ? occurrences(file.oldPath, highlight) : []
    return (
        <span className="file-path">
            <span className="file-name">{marked(name, folder.length, found)}</span>
            {(folder || file.oldPath) && (
                <span className="file-directory">
                    {marked(folder.replace(/\/$/, ""), 0, found)}
                    {file.oldPath && <>{folder && " "}← {marked(file.oldPath, 0, moved)}</>}
                </span>
            )}
        </span>
    )
}

function Highlighted({ text, highlight }: { text: string; highlight?: string }) {
    return marked(text, 0, highlight ? occurrences(text, highlight) : [])
}

/** Where `needle` occurs in `text`, ignoring case, as start and end offsets. */
function occurrences(text: string, needle: string) {
    let found: [number, number][] = []
    let lower = text.toLowerCase(), wanted = needle.toLowerCase()
    for (let at = lower.indexOf(wanted); wanted && at != -1; at = lower.indexOf(wanted, at + wanted.length))
        found.push([at, at + wanted.length])
    return found
}

/** `text`, which starts at `offset` in the label, with the parts of `found` that fall in it marked. */
function marked(text: string, offset: number, found: [number, number][]) {
    let parts: ReactNode[] = []
    let at = 0
    for (let [start, end] of found) {
        let from = Math.max(start - offset, at), to = Math.min(end - offset, text.length)
        if (to <= from)
            continue
        parts.push(text.slice(at, from), <mark key={from}>{text.slice(from, to)}</mark>)
        at = to
    }
    parts.push(text.slice(at))
    return parts
}

/** Copies the file's repository-relative path; it shows while the row is hovered or focused, and confirms the copy. */
export function CopyPathButton({ path }: { path: string }) {
    let [copied, setCopied] = useState(false)
    useEffect(() => {
        if (!copied)
            return
        let timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
    }, [copied])
    return (
        <TooltipTrigger>
            <AriaButton
                className="copy-path icon-button small"
                aria-label={`Copy relative path of ${path}`}
                data-copied={copied || undefined}
                onPress={() => void copyText(path).then(() => setCopied(true))}
            >
                {copied ? <CheckIcon /> : <CopyIcon />}
            </AriaButton>
            <Tooltip>{copied ? "Copied" : "Copy relative path"}</Tooltip>
        </TooltipTrigger>
    )
}

/** Opens the file in its column's diff column; it shows while the row is hovered or focused. */
function OpenDiffButton({ path, onPress }: { path: string; onPress(): void }) {
    return (
        <TooltipTrigger>
            <AriaButton className="open-diff icon-button small" aria-label={`Open ${path} in diff column`} onPress={onPress}>
                <DiffIcon />
            </AriaButton>
            <Tooltip>Open in diff column</Tooltip>
        </TooltipTrigger>
    )
}

/** Every folder and group in the list by key, which are the rows that fold. */
function foldingNodes(nodes: FileTreeNode[], found = new Map<string, Extract<FileTreeNode, { kind: "folder" | "group" }>>()) {
    for (let node of nodes) {
        if (node.kind != "file") {
            found.set(node.key, node)
            foldingNodes(node.children, found)
        }
    }
    return found
}
