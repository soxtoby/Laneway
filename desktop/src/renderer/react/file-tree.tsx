import type { ChangedFile, FileListView } from "@laneway/shared"
import clsx from "clsx"
import { type ReactNode, useEffect, useState } from "react"
import { Button as AriaButton, type Key, type Selection, Tree } from "react-aria-components"
import { Hint } from "./controls"
import { DenseTreeItem } from "./dense-row"
import { DiffRegion } from "./diff-panel"
import { type FileTreeNode, fileTreeNodes } from "./file-list-view"
import { copyText, fileName, fullPath } from "./file-paths"
import { CheckIcon, CopyIcon, FileStatusIcon, FolderIcon } from "./icons"
import { Checkbox } from "./ui/Checkbox"
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
    /** Chooses or clears files together; without it the list has no checkboxes. */
    onSelect?(files: ChangedFile[]): void
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
 * A list of changed files, flat or in folders and optionally grouped, as React Aria's Tree. A file's
 * checkbox chooses it for bulk actions; a folder's or group's chooses every file it holds.
 */
export function FileTree({ label, files, view, group, selected, onSelect, root, menuItems, hideStagedBadge, leading, inspect, highlight }: FileTreeProps) {
    let nodes = fileTreeNodes(files, view)
    let folders = foldingNodes(nodes)
    // Folders start open; a folded one remembers that by its key while the list stays.
    let [folded, setFolded] = useState<Set<string>>(new Set())
    let expandedKeys = new Set([...folders.keys()].filter(key => !folded.has(key)))
    let isChosen = (file: ChangedFile) => selected.includes(`${group}:${file.path}`)
    let selectedKeys = new Set<Key>([
        ...files.filter(isChosen).map(file => file.path),
        ...[...folders].filter(([, node]) => node.files.every(isChosen)).map(([key]) => key),
    ])

    // React Aria reports the whole selection; the row whose checkbox changed is the one that differs.
    let changeSelection = (keys: Selection) => {
        if (!onSelect || keys == "all")
            return
        let changed = [...keys].find(key => !selectedKeys.has(key)) ?? [...selectedKeys].find(key => !keys.has(key))
        let folder = changed != undefined ? folders.get(String(changed)) : undefined
        let file = files.find(candidate => candidate.path == changed)
        if (folder)
            onSelect(folder.files)
        else if (file)
            onSelect([file])
    }

    // Folding a folder or group closes the diffs of the files it hides.
    let fold = (keys: Set<string>) => {
        let hidden = [...keys].filter(key => !folded.has(key)).flatMap(key => folders.get(key)?.files ?? [])
        if (hidden.length)
            inspect?.close(hidden)
        setFolded(keys)
    }

    // A folder's row folds it; a file's row shows or hides its diff.
    let act = (key: Key) => {
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
            aria-label={label}
            className="file-tree"
            selectionMode={onSelect ? "multiple" : "none"}
            selectionBehavior="toggle"
            selectedKeys={selectedKeys}
            onSelectionChange={changeSelection}
            expandedKeys={expandedKeys}
            onExpandedChange={keys => fold(new Set([...folders.keys()].filter(key => !keys.has(key))))}
            onAction={act}
        >
            {nodes.map(node => (
                <FileTreeRow
                    key={node.key}
                    node={node}
                    flat={view.layout == "flat"}
                    props={{ onSelect, root, menuItems, hideStagedBadge, leading, inspect, highlight }}
                />
            ))}
        </Tree>
    )
}

function FileTreeRow(
    { node, flat, props }: {
        node: FileTreeNode
        flat: boolean
        props: Pick<FileTreeProps, "onSelect" | "root" | "menuItems" | "hideStagedBadge" | "leading" | "inspect" | "highlight">
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
                menu={{ label: `Actions for ${file.path}`, items: () => <FileMenuItems file={file} root={props.root} items={props.menuItems} /> }}
                content={({ actions }) => (
                    <>
                        <div className="row-content file-content">
                            {props.leading?.([file], file.path)}
                            {props.onSelect && <Checkbox slot="selection" aria-label={`Select file ${file.path}`} />}
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
            content={({ isExpanded }) => (
                // Shaped like a file row, with the chevron where a file's status icon sits, so checkboxes line up.
                <div className="row-content folder-content">
                    {props.leading?.(node.files, node.label)}
                    {props.onSelect && <Checkbox slot="selection" aria-label={`Select ${node.files.length} files in ${node.label}`} />}
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
            {node.children.map(child => <FileTreeRow key={child.key} node={child} flat={flat} props={props} />)}
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
