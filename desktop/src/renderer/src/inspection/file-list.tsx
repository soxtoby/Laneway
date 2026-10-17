import { type ChangedFile, defaultFileListView, type FileListView } from "@laneway/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import { Icon } from "../icons"
import { groupFiles } from "./file-list-view"
import { type FileAction, FileMenu } from "./file-menu"
import { copyPathActions, copyText } from "./file-paths"

let filterMatch = css({
    color: "var(--text)",
    background: "var(--accent-wash-strong)",
    boxShadow: "inset 0 -1px var(--accent-edge)",
})

let changeFile = css({
    position: "sticky",
    top: "var(--filter-height, 0px)",
    zIndex: 5,
    background: "var(--panel)",
    display: "flex",
    gap: "4px",
    alignItems: "center",
    // Rows under a commit sit right of its history line; folded rows step in further for each level.
    "--row-indent": "2px",
    padding: "1px 6px 1px var(--row-indent)",
    minHeight: "30px",
    borderBottom: "1px solid var(--line)",
    // Rows stick to the top while scrolling, so hover and active tints are mixed into an opaque colour.
    "&:hover": { backgroundColor: "color-mix(in srgb, var(--text) 5%, var(--panel))" },
    ".inspect-commit &": {
        top: "calc(var(--filter-height, 0px) + var(--commit-heading-height, 34px))",
        zIndex: 6,
        "--row-indent": "28px",
    },
    ".inspect-commit &::before": {
        position: "absolute",
        top: "-1px",
        bottom: "-1px",
        left: "12px",
        width: "2px",
        content: '""',
        background: "var(--line-strong)",
        pointerEvents: "none",
    },
    "&.active": {
        backgroundColor: "color-mix(in srgb, var(--focus) 12%, var(--panel))",
        boxShadow: "inset 3px 0 var(--focus)",
    },
    "&.active:hover": {
        backgroundColor: "color-mix(in srgb, var(--focus) 18%, var(--panel))",
    },
    ".file-tree details &": {
        paddingLeft: "calc(var(--row-indent) + 14px * var(--tree-depth, 1))",
    },
})

let selectFileInput = css({
    accentColor: "var(--focus)",
    flex: "0 0 14px",
    width: "14px",
    height: "14px",
    minHeight: 0,
    padding: 0,
    margin: "0 3px 0 0",
})

let changeFileButton = css({
    border: "0",
    background: "transparent",
    color: "var(--text)",
    borderRadius: "var(--radius)",
    padding: "3px 6px",
    font: "inherit",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    // Natural width keeps the copy button beside the name; the row itself takes clicks on the space after it.
    flex: "0 1 auto",
    maxWidth: "100%",
    minWidth: "0",
    textAlign: "left",
    // Keyboard focus scrolls the row clear of the sticky headings above it.
    scrollMarginTop: "var(--filter-height, 0px)",
    ".inspect-commit &": { scrollMarginTop: "calc(var(--filter-height, 0px) + var(--commit-heading-height, 34px))" },
    "&:hover": {
        background: "transparent",
    },
    '&[aria-expanded="true"]': {
        background: "transparent",
    },
    "&:disabled": { opacity: "1", cursor: "default" },
})

export let fileActionButton = css({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--line)",
    background: "var(--panel)",
    color: "var(--muted)",
    borderRadius: "4px",
    padding: "2px",
    font: "inherit",
    cursor: "pointer",
    fontSize: "11px",
    flexShrink: "0",
    width: "22px",
    height: "22px",
    '&[aria-pressed="true"]': { color: "var(--focus)", background: "var(--focus-wash)", borderColor: "var(--focus-edge)" },
    "&:hover:not(:disabled)": { background: "var(--control-hover)" },
    "&:disabled": { opacity: "0.45", cursor: "default" },
})

let fileStatus = css({
    width: "14px",
    flex: "0 0 14px",
    color: "var(--accent)",
    font: "11px var(--mono)",
    "&.added": {
        color: "var(--ok)",
    },
    "&.deleted": {
        color: "var(--danger)",
    },
    "&.conflicted": {
        color: "var(--danger)",
    },
    "&:nth-child(2)": {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
})

let changeFileSpan = css({
    display: "flex",
    minWidth: "0",
    maxWidth: "100%",
    whiteSpace: "nowrap",
})

let fileFolder = css({
    color: "var(--muted)",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

let fileName = css({
    flex: "0 0 auto",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

let stagedBadge = css({
    color: "var(--muted)",
    fontSize: "10px",
})

let changeFileTrailing = css({
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flex: "0 0 auto",
    marginLeft: "auto",
})

// Hidden until the row is hovered, so the name stays uncluttered; focus and a fresh copy keep it visible.
let copyPathButton = css({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "0 0 auto",
    width: "18px",
    height: "18px",
    padding: 0,
    border: 0,
    borderRadius: "3px",
    background: "transparent",
    color: "var(--muted)",
    cursor: "pointer",
    opacity: 0,
    ".change-file:hover &": { opacity: 1 },
    ".diff-file-menu:hover &": { opacity: 1 },
    "&:focus-visible": { opacity: 1 },
    "&[data-copied]": { opacity: 1, color: "var(--ok)" },
    "&:hover": { background: "var(--control-hover)", color: "var(--text)" },
})

// A folder or group row is shaped like a file row: grip, checkbox, then a chevron where the status icon would sit.
let folderRow = css({
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minHeight: "30px",
    "--row-indent": "2px",
    padding: "1px 6px 1px calc(var(--row-indent) + 14px * (var(--tree-depth, 1) - 1))",
    borderBottom: "1px solid var(--line)",
    color: "var(--text)",
    cursor: "pointer",
    listStyle: "none",
    userSelect: "none",
    "&::-webkit-details-marker": { display: "none" },
    "&:hover": { backgroundColor: "color-mix(in srgb, var(--text) 5%, var(--panel))" },
    ".inspect-commit &": { "--row-indent": "28px" },
    ".inspect-commit &::before": {
        position: "absolute",
        top: "-1px",
        bottom: "-1px",
        left: "12px",
        width: "2px",
        content: '""',
        background: "var(--line-strong)",
        pointerEvents: "none",
    },
    "& .folder-toggle": {
        display: "inline-flex",
        justifyContent: "center",
        flex: "0 0 14px",
        width: "14px",
        marginLeft: "6px",
        color: "var(--muted)",
    },
    "& .folder-icon": { display: "inline-flex", flex: "0 0 auto", color: "var(--muted)" },
    "& .folder-name": { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    "&.file-group .folder-name": { fontWeight: "600" },
    "& .file-group-count": { color: "var(--muted)", fontSize: "11px" },
})

export function FileTree(
    handle: Handle<
        {
            files: ChangedFile[]
            /** The worktree the files live in, enabling "Copy full path". */
            root?: string
            renderFile?(file: ChangedFile): RemixNode
            actions?(file: ChangedFile): FileAction[]
            /** Flat or folded, and grouped or not; flat and ungrouped by default. */
            view?: FileListView
            hideStagedBadge?: boolean
            filter?: string
            expanded: Set<string>
            diff(file: ChangedFile): RemixNode
            controls(file: ChangedFile): RemixNode
            leading?(file: ChangedFile): RemixNode
            /** A grip for a folder or group row, moving every file it holds. */
            folderLeading?(files: ChangedFile[], label: string): RemixNode
            checked?: Set<string>
            prefix?: string
            choose(file: ChangedFile): void
            check?(file: ChangedFile): void
            /** Selects every file in a folder or group, or clears them when all are already selected. */
            checkFolder?(files: ChangedFile[]): void
            /** Called with the files a folded node hides, so their open diffs can close. */
            hide(paths: string[]): void
        }
    >,
) {
    let collapsed = new Set<string>()
    return () => {
        let props = handle.props
        let view = props.view ?? defaultFileListView
        let flat = view.layout == "flat"
        let rows = (files: ChangedFile[]) =>
            files.map(file =>
                props.renderFile?.(file) ?? (
                    <InspectionItem
                        key={file.path}
                        actions={props.actions?.(file) ?? []}
                        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                        path={file.path}
                        root={props.root}
                        expanded={props.expanded.has(file.path)}
                        checked={props.checked?.has(`${props.prefix}:${file.path}`) ?? false}
                        checkLabel={`Select file ${file.path}`}
                        check={props.check
                            ? () => props.check?.(file)
                            : undefined}
                        choose={() => props.choose(file)}
                        leading={props.leading?.(file)}
                        controls={props.controls(file)}
                        label={
                            <>
                                <span class={`file-status ${file.status.replaceAll(" ", "-")}`} mix={fileStatus}>
                                    {changeIcon(file.conflicted ? "conflicted" : file.status)}
                                </span>
                                {fileLabel(file.path, flat || !!file.oldPath, file.oldPath, props.filter)}
                            </>
                        }
                        trailing={(file.staged && !props.hideStagedBadge || file.submodule) && (
                            <>
                                {file.staged && !props.hideStagedBadge && (
                                    <small class="staged-badge" mix={stagedBadge}>
                                        staged
                                    </small>
                                )}
                                {file.submodule && <small>submodule</small>}
                            </>
                        )}
                    >
                        {props.diff(file)}
                    </InspectionItem>
                )
            )
        // A folded node remembers its state by key; `hide` closes the diffs of the files it covers.
        // The grip and checkbox inside the row act on its files; the rest of the row folds it.
        let fold = (key: string, depth: number, kind: "folder" | "group", label: string, files: ChangedFile[], children: RemixNode) => {
            let open = !collapsed.has(key)
            let selected = !!props.checkFolder && files.every(file => props.checked?.has(`${props.prefix}:${file.path}`))
            return (
                <details
                    open={open}
                    mix={[
                        ref(element => element.style.setProperty("--tree-depth", String(depth))),
                        on("toggle", event => {
                            if (event.currentTarget.open)
                                collapsed.delete(key)
                            else {
                                collapsed.add(key)
                                props.hide(files.map(file => file.path))
                            }
                            void handle.update()
                        }),
                    ]}
                >
                    <summary class={kind == "group" ? "file-group" : "file-folder-row"} mix={folderRow}>
                        {props.folderLeading?.(files, label)}
                        {props.checkFolder && (
                            <input
                                type="checkbox"
                                aria-label={`Select ${files.length} files in ${label}`}
                                checked={selected}
                                mix={[selectFileInput, on("change", () => props.checkFolder?.(files))]}
                            />
                        )}
                        <span class="folder-toggle" aria-hidden="true">
                            <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
                        </span>
                        {kind == "folder" && (
                            <span class="folder-icon">
                                <Icon name="folder" size={14} />
                            </span>
                        )}
                        <span class="folder-name">{label}</span>
                        {kind == "group" && <span class="file-group-count">{files.length}</span>}
                    </summary>
                    {children}
                </details>
            )
        }
        let renderDirectory = (directory: Directory, prefix: string, depth: number): RemixNode => (
            <>
                {[...directory.children].map(([name, child]) => {
                    // A run of folders holding nothing but the next folder collapses into one row.
                    let label = name
                    while (child.files.length == 0 && child.children.size == 1) {
                        let [[nextName, next]] = child.children
                        label += `/${nextName}`
                        child = next
                    }
                    let path = `${prefix}${label}/`
                    return fold(path, depth, "folder", label, directoryFiles(child), renderDirectory(child, path, depth + 1))
                })}
                {rows(directory.files)}
            </>
        )
        let section = (files: ChangedFile[], keyPrefix: string, depth: number) => flat ? rows(files) : renderDirectory(buildTree(files), keyPrefix, depth)

        return (
            <div class="file-tree" data-layout={view.layout} data-grouping={view.grouping}>
                {view.grouping == "none"
                    ? section(props.files, "", 1)
                    : groupFiles(props.files, view.grouping).map(group =>
                        fold(`${group.id}:`, 1, "group", group.label, group.files, section(group.files, `${group.id}:`, 2))
                    )}
            </div>
        )
    }
}

interface Directory {
    files: ChangedFile[]
    children: Map<string, Directory>
}

function buildTree(files: ChangedFile[]): Directory {
    let tree: Directory = { files: [], children: new Map() }
    for (let file of files) {
        let directory = tree
        for (let part of file.path.split("/").slice(0, -1)) {
            let child = directory.children.get(part)
            if (!child) {
                child = { files: [], children: new Map() }
                directory.children.set(part, child)
            }
            directory = child
        }
        directory.files.push(file)
    }
    return tree
}

function directoryFiles(directory: Directory): ChangedFile[] {
    return [...directory.files, ...[...directory.children.values()].flatMap(directoryFiles)]
}

export function InspectionItem(
    handle: Handle<{
        class?: string
        title: string
        label: RemixNode
        /** The repository-relative path a copy button and copy menu items describe; rows without one are not files. */
        path?: string
        /** The worktree the file lives in, enabling "Copy full path". */
        root?: string
        expanded: boolean
        actions: FileAction[]
        leading?: RemixNode
        /** Badges shown after the name, pushed to the right edge of the row. */
        trailing?: RemixNode
        controls?: RemixNode
        children?: RemixNode
        checked?: boolean
        checkLabel?: string
        check?(): void
        choose?(): void
    }>,
) {
    return () => {
        let props = handle.props
        let actions = props.path ? [...props.actions, ...copyPathActions(props.path, props.root)] : props.actions
        return (
            <FileMenu class={`file-inspection ${props.class ?? ""}`} actions={actions}>
                <div
                    class={`change-file ${props.expanded ? "active" : ""}`}
                    mix={[
                        changeFile,
                        // The name button only spans its text, so the rest of the row still chooses the file.
                        on("click", event => {
                            if (event.target == event.currentTarget)
                                props.choose?.()
                        }),
                    ]}
                >
                    {props.leading}
                    {props.check && (
                        <input
                            type="checkbox"
                            aria-label={props.checkLabel}
                            checked={props.checked}
                            mix={[selectFileInput, on("change", () => props.check?.())]}
                        />
                    )}
                    <button
                        type="button"
                        title={props.title}
                        aria-expanded={props.expanded}
                        disabled={!props.choose}
                        mix={[changeFileButton, on("click", () => props.choose?.())]}
                    >
                        {props.label}
                    </button>
                    {props.path && <CopyPathButton path={props.path} />}
                    {props.trailing && <span mix={changeFileTrailing}>{props.trailing}</span>}
                    {props.controls}
                </div>
                {props.children}
            </FileMenu>
        )
    }
}

/** A quiet button beside a file name that copies its repository-relative path; it only shows while the row is hovered or focused. */
export function CopyPathButton(handle: Handle<{ path: string }>) {
    let copied = false
    let timer: ReturnType<typeof setTimeout> | undefined
    handle.signal.addEventListener("abort", () => clearTimeout(timer))
    return () => (
        <button
            type="button"
            class="copy-path"
            aria-label={`Copy relative path of ${handle.props.path}`}
            title={copied ? "Copied" : "Copy relative path"}
            data-copied={copied ? "" : undefined}
            mix={[
                copyPathButton,
                on("click", () =>
                    void copyText(handle.props.path).then(() => {
                        copied = true
                        clearTimeout(timer)
                        timer = setTimeout(() => {
                            copied = false
                            void handle.update()
                        }, 1500)
                        void handle.update()
                    })),
            ]}
        >
            <Icon name={copied ? "check" : "copy"} size={12} />
        </button>
    )
}

function changeIcon(status: string) {
    let paths: Record<string, string> = {
        added: "M8 3v10M3 8h10",
        deleted: "M3 8h10",
        modified: "m3 10 7-7 3 3-7 7H3v-3ZM9 4l3 3",
        renamed: "M2 8h11M9 4l4 4-4 4",
        copied: "M6 6h7v7H6ZM3 10H2V2h8v1",
        conflicted: "M8 2 1 14h14L8 2ZM8 6v4M8 11v1",
    }
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" role="img" aria-label={status}>
            <path d={paths[status] ?? "M8 3v10M3 8h10"} />
        </svg>
    )
}

export function fileLabel(path: string, showFolder = true, oldPath?: string, filter = "") {
    let separator = path.lastIndexOf("/") + 1
    let folder = `${oldPath ? `${oldPath} → ` : ""}${showFolder ? path.slice(0, separator) : ""}`
    let label = folder + path.slice(separator)
    let matches: number[] = []
    if (filter) {
        let lower = label.toLowerCase()
        let query = filter.toLowerCase()
        for (let index = lower.indexOf(query); index >= 0; index = lower.indexOf(query, index + query.length))
            matches.push(index)
    }
    return (
        <span mix={changeFileSpan}>
            {folder && <span class="file-folder" mix={fileFolder}>{highlight(0, folder.length)}</span>}
            <span class="file-name" mix={fileName}>{highlight(folder.length, label.length)}</span>
        </span>
    )

    function highlight(start: number, end: number): RemixNode {
        let parts: RemixNode[] = []
        let cursor = start
        for (let match of matches) {
            let from = Math.max(start, match)
            let to = Math.min(end, match + filter.length)
            if (from >= to)
                continue
            parts.push(label.slice(cursor, from), <mark mix={filterMatch}>{label.slice(from, to)}</mark>)
            cursor = to
        }
        parts.push(label.slice(cursor, end))

        return parts
    }
}
