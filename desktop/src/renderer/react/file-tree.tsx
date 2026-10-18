/** @jsxImportSource react */
import type { ChangedFile, FileListView } from "@laneway/shared"
import { type ReactNode, useEffect, useState } from "react"
import { Button as AriaButton, type Key, type Selection, Tree } from "react-aria-components"
import { copyText, fileName, fullPath } from "../src/inspection/file-paths"
import { DenseTreeItem } from "./dense-row"
import { type FileTreeNode, fileTreeNodes } from "./file-list-view"
import { CheckIcon, CopyIcon, FileStatusIcon, FolderIcon } from "./icons"
import { Checkbox } from "./ui/Checkbox"
import { ChevronRight } from "./ui/icons"
import { MenuItem, Separator } from "./ui/Menu"

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
}

/**
 * A list of changed files, flat or in folders and optionally grouped, as React Aria's Tree. A file's
 * checkbox chooses it for bulk actions; a folder's or group's chooses every file it holds.
 */
export function FileTree({ label, files, view, group, selected, onSelect, root, menuItems, hideStagedBadge }: FileTreeProps) {
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

    let toggleFolder = (key: Key) => {
        if (!folders.has(String(key)))
            return
        setFolded(current => {
            let next = new Set(current)
            if (!next.delete(String(key)))
                next.add(String(key))
            return next
        })
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
            onExpandedChange={keys => setFolded(new Set([...folders.keys()].filter(key => !keys.has(key))))}
            onAction={toggleFolder}
        >
            {nodes.map(node => <FileTreeRow key={node.key} node={node} flat={view.layout == "flat"} props={{ onSelect, root, menuItems, hideStagedBadge }} />)}
        </Tree>
    )
}

function FileTreeRow(
    { node, flat, props }: { node: FileTreeNode; flat: boolean; props: Pick<FileTreeProps, "onSelect" | "root" | "menuItems" | "hideStagedBadge"> },
) {
    if (node.kind == "file") {
        let file = node.file
        let path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
        return (
            <DenseTreeItem
                id={node.key}
                textValue={file.path}
                className="compact file-row"
                menu={{ label: `Actions for ${file.path}`, items: () => <FileMenuItems file={file} root={props.root} items={props.menuItems} /> }}
                content={({ actions }) => (
                    <div className="row-content file-content" title={path}>
                        {props.onSelect && <Checkbox slot="selection" aria-label={`Select file ${file.path}`} />}
                        <FileStatusIcon status={file.conflicted ? "conflicted" : file.status} />
                        <FileLabel file={file} showFolder={flat || !!file.oldPath} />
                        <CopyPathButton path={file.path} />
                        {file.staged && !props.hideStagedBadge && <span className="file-badge">staged</span>}
                        {file.submodule && <span className="file-badge">submodule</span>}
                        {actions}
                    </div>
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
                    {props.onSelect && <Checkbox slot="selection" aria-label={`Select ${node.files.length} files in ${node.label}`} />}
                    <AriaButton slot="chevron" className="folder-chevron" aria-label={isExpanded ? `Fold ${node.label}` : `Unfold ${node.label}`}>
                        <ChevronRight />
                    </AriaButton>
                    {node.kind == "folder" && <FolderIcon className="folder-icon" />}
                    <span className="folder-name">{node.label}</span>
                    {node.kind == "group" && <span className="file-group-count">{node.files.length}</span>}
                </div>
            )}
        >
            {node.children.map(child => <FileTreeRow key={child.key} node={child} flat={flat} props={props} />)}
        </DenseTreeItem>
    )
}

/** A file's own actions, then copying where it lives. */
function FileMenuItems({ file, root, items }: { file: ChangedFile; root?: string; items?(file: ChangedFile): ReactNode }) {
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

/** The file's name, after its folder when the list doesn't show folders, and after its old path when renamed. */
function FileLabel({ file, showFolder }: { file: ChangedFile; showFolder: boolean }) {
    let separator = file.path.lastIndexOf("/") + 1
    let folder = `${file.oldPath ? `${file.oldPath} → ` : ""}${showFolder ? file.path.slice(0, separator) : ""}`
    return (
        <span className="file-path">
            {folder && <span className="file-directory">{folder}</span>}
            <span className="file-name">{file.path.slice(separator)}</span>
        </span>
    )
}

/** Copies the file's repository-relative path; it shows while the row is hovered or focused, and confirms the copy. */
function CopyPathButton({ path }: { path: string }) {
    let [copied, setCopied] = useState(false)
    useEffect(() => {
        if (!copied)
            return
        let timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
    }, [copied])
    return (
        <AriaButton
            className="copy-path icon-button small"
            aria-label={`Copy relative path of ${path}`}
            data-copied={copied || undefined}
            onPress={() => void copyText(path).then(() => setCopied(true))}
        >
            {copied ? <CheckIcon /> : <CopyIcon />}
        </AriaButton>
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
