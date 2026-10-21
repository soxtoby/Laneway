import type { FileHistoryEntry, FileHistorySource, FileListView } from "@laneway/shared"
import clsx from "clsx"
import type { ReactNode } from "react"
import { Button as AriaButton } from "react-aria-components"
import { CommitCopyItems } from "./commit-trail"
import { Hint, IconButton, MoreMenu } from "./controls"
import { useRowMenu } from "./dense-row"
import { DiffControls, DiffPanel, DiffScopeContext } from "./diff-panel"
import { CloseIcon, FileStatusIcon } from "./icons"
import { type CommitDiffView, diffKey, type FileHistoryView, type Inspection } from "./inspection"
import { TransferGrip, transferSource, useTransferScope } from "./transfer"
import { Button } from "./ui/Button"
import { ChevronRight } from "./ui/icons"
import { MenuItem, Separator } from "./ui/Menu"
import { Select, SelectItem } from "./ui/Select"
import { FileList } from "./working-changes"

interface AuxiliaryProps {
    inspection: Inspection
    view: FileListView
    /** The worktree its files can be copied from. */
    root?: string
    /** Whether its Workspace Column's header has a second line, which its header matches. */
    stacked: boolean
    /** Closing returns focus to the column it was opened from. */
    onClose(): void
}

/**
 * One file's history: a worktree's Working Changes to it, then each commit that changed it, unfolding to the
 * file's diff there. An entry's menu blames the file at that commit or opens the whole commit beside it.
 */
export function FileHistoryColumn({ history, inspection, view, root, stacked, onClose }: AuxiliaryProps & { history: FileHistoryView }) {
    let { page, host } = history
    let working = host.files.working
    let source = history.source
    return (
        <AuxiliaryFrame
            column={history}
            className="file-history"
            label={`History of ${history.path}`}
            title={`History · ${history.path}`}
            from={`From ${sourceName(source)}`}
            close={{ label: "Close file history", press: () => inspection.closeAuxiliary(history.id) }}
            onClose={onClose}
            inspection={inspection}
            stacked={stacked}
        >
            {history.loading && !page && <p className="column-placeholder" role="status">Reading history…</p>}
            {history.error && (
                <p className="column-placeholder" role="alert">
                    {history.error} {page && "Showing the last history."}{" "}
                    <Button variant="quiet" onPress={() => inspection.readFileHistory(history.id)}>Retry history</Button>
                </p>
            )}
            {source.kind == "worktree" && (
                <section className="history-entry" aria-label="Working Changes to this file">
                    <div className="history-row">
                        <AriaButton
                            className="history-toggle"
                            aria-expanded={history.expanded.includes("working")}
                            onPress={() => inspection.toggleHistoryEntry(history.id)}
                        >
                            <ChevronRight className="toggle-chevron" />
                            <span className="history-subject">Working Changes</span>
                        </AriaButton>
                    </div>
                    {history.expanded.includes("working") && (
                        <FileList
                            columnId={history.hostId}
                            group="working"
                            label="Working Changes files"
                            files={working && {
                                ...working,
                                inventory: working.inventory
                                    && { ...working.inventory, files: working.inventory.files.filter(file => file.path == history.path) },
                            }}
                            inspected={host}
                            inspection={inspection}
                            view={view}
                            root={root}
                            selectable
                            diffColumn={false}
                            empty="No Working Changes to this file"
                        />
                    )}
                </section>
            )}
            {page?.entries.map(entry => <HistoryEntry key={entry.objectId} history={history} entry={entry} inspection={inspection} />)}
            {page && !page.entries.length && !page.cursor && <p className="column-placeholder">No committed history.</p>}
            {page?.cursor && (
                <Button
                    variant="quiet"
                    className="load-more"
                    isDisabled={history.loading}
                    onPress={() => inspection.readFileHistory(history.id, true)}
                >
                    Load more history
                </Button>
            )}
            {history.blame && <Blame history={history} inspection={inspection} />}
        </AuxiliaryFrame>
    )
}

function HistoryEntry({ history, entry, inspection }: { history: FileHistoryView; entry: FileHistoryEntry; inspection: Inspection }) {
    let expanded = history.expanded.includes(entry.objectId)
    let id = diffKey(entry.objectId, entry.path)
    let diff = history.host.diffs[id]
    let files = history.host.files[entry.objectId]
    let eligible = history.eligible.includes(entry.objectId)
    let scope = useTransferScope()
    let source = scope && transferSource({ kind: "commit", objectId: entry.objectId, parentId: entry.followedParent }, scope.branch)
    let menu = {
        label: `Actions for ${entry.subject}`,
        items: () => (
            <>
                <MenuItem onAction={() => inspection.blame(history.id, entry.objectId)}>Blame context</MenuItem>
                <MenuItem onAction={() => inspection.openCommitDiff(history.id, entry.objectId)}>Complete commit diff</MenuItem>
                <Separator />
                <CommitCopyItems commit={entry} />
            </>
        ),
    }
    let { row, openMenu } = useRowMenu(menu)
    let title = `${entry.subject}\n${entry.objectId} · ${entry.authorName}\n${entry.previousPath ? `${entry.previousPath} → ` : ""}${entry.path}`
    return (
        <section className="history-entry" data-expanded={expanded || undefined}>
            <div ref={row} className="history-row" onContextMenu={openMenu}>
                {/* A commit the column's branch can compose moves its change to this file. */}
                {eligible && scope && source && (
                    <TransferGrip
                        composition={scope.composition}
                        selection={{
                            repositoryId: scope.repositoryId,
                            selectedRemote: scope.selectedRemote,
                            source,
                            files: [{ path: entry.path }],
                            inventoryVersion: files?.inventory?.version,
                            view: "combined",
                            label: `${entry.path} in ${entry.subject}`,
                        }}
                    />
                )}
                <AriaButton className="history-toggle" aria-expanded={expanded} onPress={() => inspection.toggleHistoryEntry(history.id, entry.objectId)}>
                    <ChevronRight className="toggle-chevron" />
                    <FileStatusIcon status={statusName(entry.status)} />
                    <Hint text={title}>
                        <span className="history-subject">{entry.subject}</span>
                    </Hint>
                </AriaButton>
                {expanded && diff && <DiffControls columnId={history.hostId} id={id} diff={diff} inspection={inspection} />}
                <span className="row-actions" data-visible={expanded || undefined}>
                    <MoreMenu label={menu.label}>{menu.items()}</MoreMenu>
                </span>
            </div>
            {expanded && (
                <div className="history-diff">
                    {entry.previousPath && <p className="history-path">{entry.previousPath} → {entry.path}</p>}
                    {entry.candidates && (
                        <Select
                            className="react-aria-Select trail-choice"
                            label="Follow copy origin"
                            aria-label="Follow copy origin"
                            selectedKey={entry.previousPath ?? "none"}
                            onSelectionChange={key =>
                                inspection.chooseOrigin(history.id, entry.objectId, key == null || key == "none" ? undefined : String(key))}
                        >
                            <SelectItem id="none">None</SelectItem>
                            {entry.candidates.map(candidate => <SelectItem key={candidate} id={candidate}>{candidate}</SelectItem>)}
                        </Select>
                    )}
                    {files?.error && <p className="column-placeholder" role="alert">{files.error}</p>}
                    {files?.loading && !diff && <p className="column-placeholder" role="status">Reading diff…</p>}
                    {diff && <DiffPanel columnId={history.hostId} id={id} diff={diff} inspection={inspection} eligible={eligible} />}
                </div>
            )}
        </section>
    )
}

/** Who last changed each line of an entry's file; each line's commit opens that file's history there. */
function Blame({ history, inspection }: { history: FileHistoryView; inspection: Inspection }) {
    let blame = history.blame!
    let { page } = blame
    return (
        <section className="blame-context" aria-label="Blame context">
            <header className="blame-header">
                <span>Blame · {blame.entry.path}</span>
                <IconButton label="Close blame" small onPress={() => inspection.closeBlame(history.id)}>
                    <CloseIcon />
                </IconButton>
            </header>
            {blame.loading && !page && <p className="column-placeholder" role="status">Reading blame…</p>}
            {blame.error && <p className="column-placeholder" role="alert">{blame.error}</p>}
            {page?.notice && <p className="column-placeholder">{page.notice}</p>}
            <div className="blame-lines">
                {page?.blame?.map(line => (
                    <div key={line.line} className="blame-line">
                        <AriaButton
                            className="blame-origin"
                            aria-label={`Open origin of line ${line.line}`}
                            onPress={() => inspection.openHistory(history.hostId, { kind: "commit", objectId: line.objectId }, line.path)}
                        >
                            <Hint text={`Open origin · ${line.author} · ${line.path}:${line.originalLine}`}>
                                <span>{line.objectId.slice(0, 8)}:{line.line}</span>
                            </Hint>
                        </AriaButton>
                        <code>{line.text}</code>
                    </div>
                ))}
            </div>
            {page?.nextBlameOffset != undefined && (
                <Button
                    variant="quiet"
                    className="load-more"
                    isDisabled={blame.loading}
                    onPress={() => inspection.blame(history.id, blame.entry.objectId, true)}
                >
                    Load more blame
                </Button>
            )}
        </section>
    )
}

/** A history entry's whole commit: its files against the parent the history followed, and files related to the history's. */
export function CommitDiffColumn({ commit, inspection, view, root, stacked, onClose }: AuxiliaryProps & { commit: CommitDiffView }) {
    let { entry, related } = commit
    let objectId = entry.objectId
    return (
        <AuxiliaryFrame
            column={commit}
            className="commit-diff"
            label={`Commit diff · ${entry.subject}`}
            title={entry.subject}
            from={`From history · ${entry.path} · ${objectId.slice(0, 8)}`}
            close={{ label: "Close commit diff", press: () => inspection.closeAuxiliary(commit.id) }}
            onClose={onClose}
            inspection={inspection}
            stacked={stacked}
        >
            {entry.parentIds.length > 1 && (
                <Select
                    className="react-aria-Select trail-choice"
                    label="Compare with parent"
                    aria-label="Commit diff parent"
                    selectedKey={commit.parentId ?? entry.parentIds[0]}
                    onSelectionChange={key => key != null && inspection.chooseCommitParent(commit.id, String(key))}
                >
                    {entry.parentIds.map((parent, index) => <SelectItem key={parent} id={parent}>{`Parent ${index + 1} · ${parent.slice(0, 8)}`}</SelectItem>)}
                </Select>
            )}
            <FileList
                columnId={commit.hostId}
                group={objectId}
                label={`Files in commit ${entry.subject}`}
                files={commit.host.files[objectId]}
                inspected={commit.host}
                inspection={inspection}
                view={view}
                root={root}
                selectable={commit.eligible.includes(objectId)}
                diffColumn={false}
                empty="No changes against this parent"
            />
            <section className="related-files" aria-label="Related files">
                {!related && <Button variant="quiet" isDisabled={commit.loading} onPress={() => inspection.findRelated(commit.id)}>Find related files</Button>}
                {commit.loading && !related && <p className="column-placeholder" role="status">Reading file evidence…</p>}
                {commit.error && <p className="column-placeholder" role="alert">{commit.error}</p>}
                {related && <p className="column-placeholder">Related files · evidence, not proven origins</p>}
                {related?.notice && <p className="column-placeholder">{related.notice}</p>}
                {related?.related?.map(file => (
                    <AriaButton
                        key={`${file.objectId}:${file.path}`}
                        className="related-file"
                        onPress={() => inspection.openHistory(commit.hostId, { kind: "commit", objectId: file.objectId }, file.path)}
                    >
                        <Hint text={`${file.evidence} · ${file.path}`}>
                            <span className="related-path">{file.path}</span>
                        </Hint>
                        <small>{file.evidence}{file.evidence == "shared lines" ? ` · ${file.score}` : ""}</small>
                    </AriaButton>
                ))}
                {related?.related?.length == 0 && <p className="column-placeholder">No other changed files.</p>}
                {related?.nextRelatedOffset != undefined && (
                    <Button
                        variant="quiet"
                        className="load-more"
                        isDisabled={commit.loading}
                        onPress={() => inspection.findRelated(commit.id, true)}
                    >
                        Load more related files
                    </Button>
                )}
            </section>
        </AuxiliaryFrame>
    )
}

/** An auxiliary column's card: a header like its Workspace Column's, then its contents scrolling beneath. */
function AuxiliaryFrame({ column, className, label, title, from, close, onClose, inspection, stacked, children }: {
    column: FileHistoryView | CommitDiffView
    className: string
    label: string
    title: string
    from: string
    close: { label: string; press(): void }
    onClose(): void
    inspection: Inspection
    stacked: boolean
    children: ReactNode
}) {
    let diffs = { layout: column.layout, setLayout: (layout: typeof column.layout) => inspection.setLayout(column.hostId, layout) }
    return (
        <DiffScopeContext value={diffs}>
            <aside
                className={clsx("auxiliary-column", className)}
                data-auxiliary-id={column.id}
                data-source-column-id={column.sourceId}
                tabIndex={-1}
                style={{ width: column.width }}
                aria-label={label}
            >
                <header className="column-header auxiliary-header">
                    <Hint text={title}>
                        <div className="column-title">
                            <div className="column-title-row">
                                <h2 className="column-name">{title}</h2>
                                {!stacked && <small className="auxiliary-source">{from}</small>}
                            </div>
                            {stacked && <small className="column-path auxiliary-source">{from}</small>}
                        </div>
                    </Hint>
                    <IconButton
                        label={close.label}
                        onPress={() => {
                            close.press()
                            onClose()
                        }}
                    >
                        <CloseIcon />
                    </IconButton>
                </header>
                <div className="auxiliary-body">{children}</div>
            </aside>
        </DiffScopeContext>
    )
}

/** Where a history was read from: a branch, a worktree, or a commit. */
function sourceName(source: FileHistorySource) {
    return source.kind == "branch"
        ? source.ref.replace(/^refs\/(heads|remotes)\//, "")
        : source.kind == "worktree"
        ? source.worktreePath
        : source.objectId.slice(0, 8)
}

// History entries carry Git's one-letter status.
function statusName(status: string) {
    return { A: "added", D: "deleted", R: "renamed", C: "copied" }[status[0] ?? ""] ?? "modified"
}
