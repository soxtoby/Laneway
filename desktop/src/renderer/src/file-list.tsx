import type { ChangedFile } from "@laneway/shared"
import { css, type Handle, on, type RemixNode } from "remix/ui"

export function InspectionItem(
    handle: Handle<{
        class?: string
        title: string
        label: RemixNode
        expanded: boolean
        actions: FileAction[]
        leading?: RemixNode
        controls?: RemixNode
        children?: RemixNode
        checked?: boolean
        checkLabel?: string
        check?(): void
        choose?(): void
    }>,
) {
    return () => {
        const props = handle.props
        return (
            <FileMenu class={`file-inspection ${props.class ?? ""}`} actions={props.actions}>
                <div class={`change-file ${props.expanded ? "active" : ""}`} mix={changeFile}>
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
                    {props.controls}
                </div>
                {props.children}
            </FileMenu>
        )
    }
}

export function FileTree(
    handle: Handle<
        {
            files: ChangedFile[]
            renderFile?(file: ChangedFile): RemixNode
            actions?(file: ChangedFile): FileAction[]
            flat?: boolean
            hideStagedBadge?: boolean
            filter?: string
            expanded: Set<string>
            diff(file: ChangedFile): RemixNode
            controls(file: ChangedFile): RemixNode
            leading?(file: ChangedFile): RemixNode
            checked?: Set<string>
            prefix?: string
            choose(file: ChangedFile): void
            check?(file: ChangedFile): void
            hide(path: string): void
        }
    >,
) {
    const collapsed = new Set<string>()
    return () => {
        const props = handle.props
        interface Directory {
            files: ChangedFile[]
            children: Map<string, Directory>
        }
        const tree: Directory = { files: [], children: new Map() }
        for (const file of props.files) {
            let directory = tree
            for (const part of file.path.split("/").slice(0, -1)) {
                let child = directory.children.get(part)
                if (!child) {
                    child = { files: [], children: new Map() }
                    directory.children.set(part, child)
                }
                directory = child
            }
            directory.files.push(file)
        }
        const rows = (files: ChangedFile[]) =>
            files.map(file =>
                props.renderFile?.(file) ?? (
                    <InspectionItem
                        key={file.path}
                        actions={props.actions?.(file) ?? []}
                        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
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
                                {fileLabel(file.path, props.flat || !!file.oldPath, file.oldPath, props.filter)}
                                {file.staged && !props.hideStagedBadge && (
                                    <small class="staged-badge" mix={stagedBadge}>
                                        staged
                                    </small>
                                )}
                                {file.submodule && <small>submodule</small>}
                            </>
                        }
                    >
                        {props.diff(file)}
                    </InspectionItem>
                )
            )
        const renderDirectory = (directory: Directory, prefix = ""): RemixNode => (
            <>
                {[...directory.children].map(([name, child]) => {
                    const path = `${prefix}${name}/`
                    return (
                        <details
                            open={!collapsed.has(path)}
                            mix={[on("toggle", event => {
                                if (event.currentTarget.open)
                                    collapsed.delete(path)
                                else {
                                    collapsed.add(path)
                                    props.hide(path)
                                }
                            })]}
                        >
                            <summary mix={fileTreeSummary}>
                                {name}/
                            </summary>
                            {renderDirectory(child, path)}
                        </details>
                    )
                })}
                {rows(directory.files)}
            </>
        )
        return <div class="file-tree">{props.flat ? rows(props.files) : renderDirectory(tree)}</div>
    }
}

function changeIcon(status: string) {
    const paths: Record<string, string> = {
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
    const separator = path.lastIndexOf("/") + 1
    const folder = `${oldPath ? `${oldPath} → ` : ""}${showFolder ? path.slice(0, separator) : ""}`
    const label = folder + path.slice(separator)
    const matches: number[] = []
    if (filter) {
        const lower = label.toLowerCase()
        const query = filter.toLowerCase()
        for (let index = lower.indexOf(query); index >= 0; index = lower.indexOf(query, index + query.length))
            matches.push(index)
    }
    function highlight(start: number, end: number): RemixNode {
        const parts: RemixNode[] = []
        let cursor = start
        for (const match of matches) {
            const from = Math.max(start, match)
            const to = Math.min(end, match + filter.length)
            if (from >= to)
                continue
            parts.push(label.slice(cursor, from), <mark mix={filterMatch}>{label.slice(from, to)}</mark>)
            cursor = to
        }
        parts.push(label.slice(cursor, end))
        return parts
    }
    return (
        <span mix={changeFileSpan}>
            {folder && <span class="file-folder" mix={fileFolder}>{highlight(0, folder.length)}</span>}
            <span class="file-name" mix={fileName}>{highlight(folder.length, label.length)}</span>
        </span>
    )
}

const filterMatch = css({
    color: "var(--text)",
    background: "var(--accent-wash-strong)",
    boxShadow: "inset 0 -1px var(--accent-edge)",
})

const changeFile = css({
    position: "sticky",
    top: "var(--filter-height, 0px)",
    zIndex: 5,
    background: "var(--panel)",
    display: "flex",
    gap: "4px",
    alignItems: "center",
    padding: "1px 6px 1px 2px",
    minHeight: "30px",
    borderBottom: "1px solid var(--line)",
    // Rows stick to the top while scrolling, so hover and active tints are mixed into an opaque colour.
    "&:hover": { backgroundColor: "color-mix(in srgb, var(--text) 5%, var(--panel))" },
    ".inspect-commit &": {
        top: "calc(var(--filter-height, 0px) + 34px)",
        zIndex: 6,
        paddingLeft: "28px",
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
        paddingLeft: "14px",
    },
})

const selectFileInput = css({
    accentColor: "var(--focus)",
    flex: "0 0 14px",
    width: "14px",
    height: "14px",
    minHeight: 0,
    padding: 0,
    margin: "0 3px 0 0",
})

const changeFileButton = css({
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
    width: "100%",
    minWidth: "0",
    textAlign: "left",
    // Keyboard focus scrolls the row clear of the sticky headings above it.
    scrollMarginTop: "var(--filter-height, 0px)",
    ".inspect-commit &": { scrollMarginTop: "calc(var(--filter-height, 0px) + 34px)" },
    "&:hover": {
        background: "transparent",
    },
    '&[aria-expanded="true"]': {
        background: "transparent",
    },
    "&:disabled": { opacity: "1", cursor: "default" },
})

export const fileActionButton = css({
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

const fileStatus = css({
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

const changeFileSpan = css({
    display: "flex",
    minWidth: "0",
    maxWidth: "100%",
    whiteSpace: "nowrap",
})

const fileFolder = css({
    color: "var(--muted)",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

const fileName = css({
    flex: "0 0 auto",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

const stagedBadge = css({
    color: "var(--muted)",
    marginLeft: "auto",
    fontSize: "10px",
})

const fileTreeSummary = css({
    padding: "5px 8px",
    color: "var(--muted)",
    font: "11px var(--mono)",
    overflowWrap: "anywhere",
    cursor: "pointer",
})
import { type FileAction, FileMenu } from "./file-menu"
