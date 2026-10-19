import type { ChangedFile, FileListView } from "@laneway/shared"
import clsx from "clsx"
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react"
import { Button as AriaButton, type Key, Tree } from "react-aria-components"
import { Hint } from "./controls"
import { DenseTreeItem } from "./dense-row"
import { DiffRegion } from "./diff-panel"
import { type FileTreeNode, fileTreeNodes } from "./file-list-view"
import { copyText, fileName, fullPath } from "./file-paths"
import { CheckIcon, CopyIcon, FileStatusIcon, FolderIcon } from "./icons"
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
    /** Chooses or clears files together, or with `add` only chooses them; without it rows can't be chosen. */
    onSelect?(files: ChangedFile[], add?: boolean): void
    /** The worktree the files live in, enabling "Copy full path". */
    root?: string
    /** A file's own menu items, shown above the copy actions. */
    menuItems?(file: ChangedFile): ReactNode
    /** Working Changes lists say staged by where they sit, so their rows leave the badge out. */
    hideStagedBadge?: boolean
    /** What leads a row: a grip moving the row's files, named by the file's path or the folder's or group's label. */
    leading?(files: ChangedFile[], label: string): ReactNode
    /** Opens a file's diff under its row when the row is pressed; without it rows don't open. */
    inspect?: FileInspection
    /** Text the column's filter looks for, marked where it shows in file names and folders. */
    highlight?: string
}

/** A list's diffs: which files show one, and what the row draws for it. */
export interface FileInspection {
    isOpen(file: ChangedFile): boolean
    /** Whether the file is the one the column's diff column shows; its row is marked. */
    isActive(file: ChangedFile): boolean
    toggle(file: ChangedFile): void
    /** Closes the diffs of files a folded folder or group hides. */
    close(files: ChangedFile[]): void
    /** The diff's controls, drawn in the open row. */
    controls(file: ChangedFile): ReactNode
    diff(file: ChangedFile): ReactNode
}

/**
 * A list of changed files, flat or in folders and optionally grouped, as React Aria's Tree. Ctrl+click or Space
 * chooses a file for bulk actions, or every file a folder or group holds, and Shift adds the rows from the last
 * one pressed; a plain press still opens the row.
 */
export function FileTree({ label, files, view, group, selected, onSelect, root, menuItems, hideStagedBadge, leading, inspect, highlight }: FileTreeProps) {
    let nodes = fileTreeNodes(files, view)
    let folders = foldingNodes(nodes)
    // Folders start open; a folded one remembers that by its key while the list stays.
    let [folded, setFolded] = useState<Set<string>>(new Set())
    let expandedKeys = new Set([...folders.keys()].filter(key => !folded.has(key)))
    let isChosen = (file: ChangedFile) => selected.includes(`${group}:${file.path}`)
    let tree = useRef<HTMLDivElement>(null)
    // Where a Shift range starts: the row last pressed or chosen on its own.
    let anchor = useRef<string>(undefined)
    // Ctrl or Shift held as a row is pressed, so React Aria's action for the press chooses the row instead.
    let held = useRef<{ toggle: boolean; range: boolean }>(undefined)

    let rowFiles = (key: string) => folders.get(key)?.files ?? files.filter(file => file.path == key)
    let choose = (key: string, range: boolean) => {
        let rows = [...tree.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? []].map(row => row.dataset.rowKey!)
        let from = range && anchor.current != undefined ? rows.indexOf(anchor.current) : -1
        let to = rows.indexOf(key)
        if (from < 0 || to < 0) {
            anchor.current = key
            onSelect?.(rowFiles(key))
            return
        }
        // An open folder's files are rows of their own; a folded one brings the files it hides.
        let between = rows.slice(Math.min(from, to), Math.max(from, to) + 1)
        onSelect?.(between.flatMap(row => folders.has(row) && !folded.has(row) ? [] : rowFiles(row)), true)
    }

    // Native capturing listeners see a press's modifiers and a Space before React Aria's own handlers.
    let pointerDown = useEffectEvent((event: PointerEvent) => {
        held.current = { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }
    })
    let keyDown = useEffectEvent((event: KeyboardEvent) => {
        held.current = undefined
        let row = event.target as HTMLElement
        if (event.key != " " || !onSelect || !row.dataset.rowKey)
            return
        event.preventDefault()
        event.stopPropagation()
        choose(row.dataset.rowKey, event.shiftKey)
    })
    useEffect(() => {
        let element = tree.current
        if (!element)
            return
        let onPointerDown = (event: PointerEvent) => pointerDown(event)
        let onKeyDown = (event: KeyboardEvent) => keyDown(event)
        element.addEventListener("pointerdown", onPointerDown, true)
        element.addEventListener("keydown", onKeyDown, true)
        return () => {
            element.removeEventListener("pointerdown", onPointerDown, true)
            element.removeEventListener("keydown", onKeyDown, true)
        }
    }, [])

    // Folding a folder or group closes the diffs of the files it hides.
    let fold = (keys: Set<string>) => {
        let hidden = [...keys].filter(key => !folded.has(key)).flatMap(key => folders.get(key)?.files ?? [])
        if (hidden.length)
            inspect?.close(hidden)
        setFolded(keys)
    }

    // A folder's row folds it; a file's row shows or hides its diff. With Ctrl or Shift held, the row is chosen.
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
        if (file)
            inspect?.toggle(file)
    }

    return (
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
                    props={{ isChosen, root, menuItems, hideStagedBadge, leading, inspect, highlight }}
                />
            ))}
        </Tree>
    )
}

function FileTreeRow(
    { node, flat, nested, props }: {
        node: FileTreeNode
        flat: boolean
        /** Whether the list has folders or groups, whose chevrons lead their rows; a file keeps a space for one. */
        nested: boolean
        props: Pick<FileTreeProps, "root" | "menuItems" | "hideStagedBadge" | "leading" | "inspect" | "highlight"> & {
            isChosen(file: ChangedFile): boolean
        }
    },
) {
    if (node.kind == "file") {
        let file = node.file
        let open = props.inspect?.isOpen(file) == true
        return (
            <DenseTreeItem
                id={node.key}
                textValue={file.path}
                className={clsx("compact file-row", open && "inspected", props.inspect?.isActive(file) && "active")}
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
                            {open && props.inspect?.controls(file)}
                            {actions}
                        </div>
                        {open && <DiffRegion>{props.inspect?.diff(file)}</DiffRegion>}
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
            data-chosen={node.files.every(props.isChosen) || undefined}
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
    let separator = file.path.lastIndexOf("/") + 1
    let folder = showFolder ? file.path.slice(0, separator) : ""
    let name = file.path.slice(separator)
    // A match can run from the folder into the name, so it is found across the whole path.
    let found = highlight ? occurrences(folder + name, highlight) : []
    let moved = file.oldPath && highlight ? occurrences(file.oldPath, highlight) : []
    return (
        <Hint text={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
            <span className="file-path">
                <span className="file-name">{marked(name, folder.length, found)}</span>
                {(folder || file.oldPath) && (
                    <span className="file-directory">
                        {marked(folder.replace(/\/$/, ""), 0, found)}
                        {file.oldPath && <>{folder && " "}← {marked(file.oldPath, 0, moved)}</>}
                    </span>
                )}
            </span>
        </Hint>
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
