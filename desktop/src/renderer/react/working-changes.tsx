/** @jsxImportSource react */
import type { BranchGraphMarker, ChangedFile, DiffSource, FileHistorySource, FileListView } from "@laneway/shared"
import { type ReactNode, useEffect, useState } from "react"
import { Button as AriaButton, Form } from "react-aria-components"
import type { ColumnView } from "./branch-workspace"
import { type CommitComposer, defaultBranchName } from "./commit-composer"
import type { Landing } from "./composition"
import { IconButton } from "./controls"
import { DiffControls, DiffPanel } from "./diff-panel"
import { EditableName } from "./editable-name"
import { fileListViewOptions } from "./file-list-view"
import { type FileInspection, FileTree } from "./file-tree"
import { ArchiveIcon, ChevronDownIcon, CloseIcon, DetachedIcon, FolderIcon, OpenColumnIcon, TreeIcon } from "./icons"
import { type ColumnInspection, diffKey, type FilesState, type Inspection } from "./inspection"
import { TransferGrip, TransferReview, transferSource, useTransferScope, useTransferTarget } from "./transfer"
import { Button } from "./ui/Button"
import { ChevronRight } from "./ui/icons"
import { Menu, MenuItem, MenuSection, MenuTrigger, Separator } from "./ui/Menu"
import { TextArea, TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"

interface WorkingChangesProps {
    column: Extract<ColumnView, { kind: "branch" | "virtual" }>
    /** The column's worktree, which is on disk. */
    path: string
    inspected?: ColumnInspection
    inspection: Inspection
    /** Called once; the composer lives as long as this view. */
    createComposer(): CommitComposer
    blocked: boolean
    view: FileListView
    onViewChange(view: FileListView): void
}

/**
 * A worktree's Working Changes and their stashes. Staged files sit above a divider and the rest below
 * it; a clean worktree folds to one quiet row. A detached worktree also shows the branch its next
 * commit creates.
 */
export function WorkingChanges({ column, path, inspected, inspection, createComposer, blocked, view, onViewChange }: WorkingChangesProps) {
    let [composer] = useState(createComposer)
    useEffect(() => void composer.start(), [composer])
    let state = useSnapshot(composer)
    let [expanded, setExpanded] = useState(true)
    let working = inspected?.files.working
    let files = working?.inventory?.files.filter(file => !file.ignored) ?? []
    let staged = files.filter(file => file.staged)
    let disabled = state.busy || blocked
    let clean = working?.inventory != undefined && files.length == 0 && !state.composing && !state.stashing
    let { draft, preview } = state
    let detached = column.kind == "virtual" || state.loaded && preview != undefined && (!preview.branch || preview.unborn)
    let unborn = column.kind == "virtual" && /^0+$/.test(column.branch.objectId) || preview?.unborn == true
    let canCommit = !disabled && draft.title.trim() != "" && files.length > 0 && (preview?.branch != undefined || draft.branch.trim() != "") && !state.hook
    let reveal = (action: () => void) => () => {
        setExpanded(true)
        action()
    }
    // Changes from commits and stashes land in Working Changes.
    let scope = useTransferScope()
    let workingTarget = { kind: "working" as const, worktreePath: path }
    let { target: section, props: targetProps } = useTransferTarget<HTMLElement>(
        scope?.composition,
        scope && { kind: "compose", repositoryId: scope.repositoryId, target: workingTarget },
    )

    // While composing, files move between the staged and unstaged lists to stage or unstage them.
    let staging = (group: "working-staged" | "working-unstaged"): Landing | undefined =>
        scope && state.composing && !disabled
            ? {
                kind: "stage",
                repositoryId: scope.repositoryId,
                worktreePath: path,
                view: group == "working-staged" ? "staged" : "unstaged",
                apply: paths => void composer.stage(files.filter(file => paths.includes(file.path)), group == "working-unstaged"),
            }
            : undefined
    let list = (group: "working-staged" | "working-unstaged", label: string) => (
        <FileList
            columnId={column.id}
            group={group}
            label={label}
            files={inspected?.files[group]}
            inspected={inspected}
            inspection={inspection}
            view={view}
            root={path}
            selectable
            staging={staging(group)}
            menuItems={file => discardItem(column.id, group, file, inspection)}
        />
    )

    return (
        <section ref={section} {...targetProps} className="working-changes" aria-label="Working Changes">
            {scope && <TransferReview composition={scope.composition} repositoryId={scope.repositoryId} target={workingTarget} />}
            {column.kind == "branch"
                && column.branch.markers.map(stash => (
                    <StashCard
                        key={stash.id}
                        columnId={column.id}
                        stash={stash}
                        inspected={inspected}
                        inspection={inspection}
                        view={view}
                        root={path}
                        actions={{ disabled, apply: () => void composer.applyStash(stash.objectId), drop: () => void composer.dropStash(stash.objectId) }}
                    />
                ))}
            <div className={clean ? "commit-card clean" : "commit-card"} data-expanded={expanded || undefined}>
                <header className="commit-header">
                    <h3 className="commit-title">
                        <AriaButton
                            className="working-changes-toggle"
                            aria-label={expanded ? "Collapse Working Changes" : "Expand Working Changes"}
                            aria-expanded={expanded}
                            onPress={() => setExpanded(!expanded)}
                        >
                            <ChevronRight className="toggle-chevron" />
                            <FolderIcon />
                            <span>{clean ? "No Working Changes" : "Working Changes"}</span>
                        </AriaButton>
                    </h3>
                    <FileListViewMenu label="File list view for Working Changes" view={view} onChange={onViewChange} />
                    <IconButton label="Open diff column" small isDisabled={!files.length} onPress={() => inspection.openWorkingDiffColumn(column.id)}>
                        <OpenColumnIcon />
                    </IconButton>
                    {/* The form's own Commit button takes over while composing. */}
                    {!clean && !state.composing && (
                        <div className="commit-split">
                            <Button variant="accent" isDisabled={disabled || !state.loaded || !files.length} onPress={reveal(composer.compose)}>
                                Commit…
                            </Button>
                            <MenuTrigger>
                                <Button variant="accent" aria-label="More commit actions" isDisabled={disabled || !files.length}>
                                    <ChevronDownIcon />
                                </Button>
                                <Menu>
                                    <MenuItem onAction={reveal(composer.openStash)}>Stash Working Changes…</MenuItem>
                                </Menu>
                            </MenuTrigger>
                        </div>
                    )}
                </header>
                {expanded && (
                    <div className="commit-content">
                        {state.composing && (
                            <div className="commit-form">
                                <TextField
                                    aria-label="Commit title"
                                    placeholder="Commit title (required)"
                                    value={draft.title}
                                    onChange={title => composer.edit({ title })}
                                    isDisabled={disabled}
                                    autoFocus
                                />
                                <TextArea
                                    aria-label="Commit message"
                                    placeholder="Message (optional)"
                                    value={draft.message}
                                    onChange={message => composer.edit({ message })}
                                    isDisabled={disabled}
                                />
                                <div className="commit-bulk-actions">
                                    <Button
                                        variant="quiet"
                                        isDisabled={disabled || !files.some(file => file.unstaged || file.untracked)}
                                        onPress={() => void composer.stage(files.filter(file => file.unstaged || file.untracked), false)}
                                    >
                                        Stage all
                                    </Button>
                                    <Button variant="quiet" isDisabled={disabled || !staged.length} onPress={() => void composer.stage(staged, true)}>
                                        Unstage all
                                    </Button>
                                </div>
                                <div className="commit-actions">
                                    <Button variant="secondary" isDisabled={disabled} onPress={composer.cancel}>Cancel</Button>
                                    <Button variant="accent" isDisabled={!canCommit} onPress={() => void composer.commit()}>
                                        {state.busy ? "Working…" : staged.length ? `Commit staged (${staged.length})` : `Commit all changes (${files.length})`}
                                    </Button>
                                </div>
                            </div>
                        )}
                        {state.hook && (
                            <div className="commit-review" role="alert">
                                <strong>Hook changed files</strong>
                                <ul>{state.hook.changedFiles?.map(changed => <li key={changed}>{changed}</li>)}</ul>
                                <p>Continue with the prepared commit, or cancel to review the changes.</p>
                                <div className="commit-actions">
                                    <Button variant="secondary" isDisabled={disabled} onPress={composer.dismissHook}>Cancel</Button>
                                    <Button variant="accent" isDisabled={disabled} onPress={() => void composer.commit()}>Continue commit</Button>
                                </div>
                            </div>
                        )}
                        {state.stashing && (
                            <Form
                                className="commit-review"
                                onSubmit={event => {
                                    event.preventDefault()
                                    void composer.stash()
                                }}
                            >
                                <TextField
                                    aria-label="Stash label"
                                    placeholder="Stash label (optional)"
                                    value={state.stashLabel}
                                    onChange={composer.setStashLabel}
                                    autoFocus
                                />
                                <div className="commit-actions">
                                    <Button variant="secondary" isDisabled={disabled} onPress={composer.cancelStash}>Cancel</Button>
                                    <Button variant="accent" type="submit" isDisabled={disabled}>Stash all changes</Button>
                                </div>
                            </Form>
                        )}
                        {working?.loading && !working.inventory && <p className="column-placeholder" role="status">Reading Working Changes…</p>}
                        {working?.error && (
                            <p className="column-placeholder" role="alert">
                                {working.error} <Button variant="quiet" onPress={() => inspection.retry(column.id, "working")}>Retry</Button>
                            </p>
                        )}
                        {(staged.length > 0 || state.composing) && (
                            <>
                                {list("working-staged", "Staged files")}
                                <div className="staged-divider" role="separator" aria-label="Staged changes">
                                    <span>Staged · {staged.length}</span>
                                </div>
                            </>
                        )}
                        {list("working-unstaged", "Working Changes files")}
                        {state.error && <p className="commit-notice" role="status">{state.error}</p>}
                    </div>
                )}
            </div>
            {/* A detached worktree has no branch below its Working Changes, so the branch its next commit creates stands in for one. */}
            {detached && (
                <div
                    className="virtual-branch"
                    title={unborn ? "No commits yet; the first commit creates this branch" : "Committing creates this branch at the detached head"}
                >
                    <DetachedIcon className="virtual-branch-icon" />
                    <EditableName
                        name={draft.branch || preview?.suggestedBranch || defaultBranchName(path)}
                        label="new branch"
                        saveOnBlur
                        isDisabled={disabled}
                        onCommit={composer.nameBranch}
                    />
                    <small>{unborn ? "Unborn" : "Created on commit"}</small>
                </div>
            )}
        </section>
    )
}

/** A branch's stashes when no worktree has it checked out: their files, without a worktree to apply them to. */
export function StashedChanges({ column, inspected, inspection, view, root }: {
    column: Extract<ColumnView, { kind: "branch" }>
    inspected?: ColumnInspection
    inspection: Inspection
    view: FileListView
    root?: string
}) {
    return (
        <section className="working-changes" aria-label="Stashed Working Changes">
            {column.branch.markers.map(stash => (
                <StashCard key={stash.id} columnId={column.id} stash={stash} inspected={inspected} inspection={inspection} view={view} root={root} />
            ))}
        </section>
    )
}

interface StashCardProps {
    columnId: string
    stash: BranchGraphMarker
    inspected?: ColumnInspection
    inspection: Inspection
    view: FileListView
    root?: string
    /** Applying and dropping, which need the column's worktree. */
    actions?: { disabled: boolean; apply(): void; drop(): void }
}

/** A stash as a card that unfolds to its files; its untracked files, kept on the stash's third parent, list after them. */
function StashCard({ columnId, stash, inspected, inspection, view, root, actions }: StashCardProps) {
    let files = inspected?.files[stash.objectId]
    let open = files?.open ?? false
    let untracked = files?.inventory?.parents[2]
    let untrackedFiles = untracked ? inspected?.files[untracked] : undefined
    let message = stashMessage(stash)
    let list = (group: string, label: string, listed?: FilesState) => (
        <FileList
            columnId={columnId}
            group={group}
            label={label}
            files={listed}
            inspected={inspected}
            inspection={inspection}
            view={view}
            root={root}
            selectable
            empty="No changes in this stash"
        />
    )
    return (
        <div className="branch-stash" data-expanded={open || undefined}>
            <div className="branch-stash-row" title={stash.tooltip}>
                <AriaButton
                    className="branch-stash-toggle"
                    aria-expanded={open}
                    aria-label={`Stash ${stash.label}: ${message}`}
                    onPress={() => inspection.toggleStash(columnId, stash.objectId)}
                >
                    <ChevronRight className="toggle-chevron" />
                    <ArchiveIcon />
                    <span className="branch-stash-message">{message}</span>
                    <small>{stash.label}</small>
                </AriaButton>
                {actions && (
                    <>
                        <Button variant="secondary" aria-label={`Apply stash ${stash.label}`} isDisabled={actions.disabled} onPress={actions.apply}>
                            Apply
                        </Button>
                        <IconButton label={`Drop stash ${stash.label}`} small isDisabled={actions.disabled} onPress={actions.drop}>
                            <CloseIcon />
                        </IconButton>
                    </>
                )}
            </div>
            {open && (
                <div className="branch-stash-files">
                    {(files?.inventory?.files.length || !untrackedFiles?.inventory?.files.length)
                        && list(stash.objectId, `Files in stash ${stash.label}`, files)}
                    {untrackedFiles && list(untracked!, `Untracked files in stash ${stash.label}`, untrackedFiles)}
                </div>
            )}
        </div>
    )
}

interface FileListProps {
    columnId: string
    group: string
    label: string
    files?: FilesState
    inspected?: ColumnInspection
    inspection: Inspection
    view: FileListView
    root?: string
    /** Whether files and diff lines can be chosen, to move or for a bulk action. */
    selectable?: boolean
    menuItems?(file: ChangedFile): ReactNode
    /** What an empty list says, such as "No changes in this stash". */
    empty?: string
    /** Files from the other Working Changes list land here to be staged or unstaged. */
    staging?: Landing
    /** Whether diffs break out into the column's diff column; auxiliary columns have none. */
    diffColumn?: boolean
}

/** One list of a column's files, with its reading and failure states and, once files are chosen, how many. */
export function FileList(
    { columnId, group, label, files, inspected, inspection, view, root, selectable = false, menuItems, empty, staging, diffColumn: breaksOut = true }:
        FileListProps,
) {
    let scope = useTransferScope()
    let { target, props } = useTransferTarget<HTMLDivElement>(scope?.composition, staging)
    if (!files)
        return null
    let listed = files.inventory?.files.filter(file => !file.ignored) ?? []
    let selected = inspected?.selected ?? []
    let chosen = selected.filter(id => id.startsWith(`${group}:`)).length
    let working = group.startsWith("working-")
    let inventory = files.inventory
    let source = inventory && transferSource(inventory.source, scope?.branch)
    // A grip moves its own files, or every chosen file when it holds one of them.
    let leading = selectable && scope && inventory && source
        ? (rowFiles: ChangedFile[], rowLabel: string) => {
            let isChosen = (file: ChangedFile) => selected.includes(`${group}:${file.path}`)
            let taken = rowFiles.some(isChosen) ? listed.filter(isChosen) : rowFiles
            return (
                <TransferGrip
                    composition={scope.composition}
                    selection={{
                        repositoryId: scope.repositoryId,
                        source,
                        files: taken.map(file => ({ path: file.path })),
                        inventoryVersion: inventory.version,
                        selectedRemote: scope.selectedRemote,
                        view: group == "working-staged" ? "staged" : group == "working-unstaged" ? "unstaged" : "combined",
                        label: rowFiles.some(isChosen) && taken.length > 1
                            ? `${taken.length} files`
                            : rowFiles.length > 1
                            ? `${rowFiles.length} files in ${rowLabel}`
                            : rowLabel,
                    }}
                />
            )
        }
        : undefined
    // A file's row opens its diff, under it or in the diff column while there is one; a comparison's lines can't be chosen.
    let diffColumn = inspected?.diffColumn
    let inspect: FileInspection | undefined = inspected && {
        isOpen: file => !diffColumn && inspected.diffs[diffKey(group, file.path)] != undefined,
        isActive: file => diffColumn?.group == group && diffColumn.focus == file.path,
        toggle: file => inspection.toggleDiff(columnId, group, file.path),
        close: hidden => inspection.closeDiffs(columnId, group, hidden.map(file => file.path)),
        controls: file => {
            let id = diffKey(group, file.path)
            let diff = inspected.diffs[id]
            return diff && (
                <DiffControls
                    columnId={columnId}
                    id={id}
                    diff={diff}
                    inspection={inspection}
                    breakout={breaksOut
                        ? () => inspection.openDiffColumn(columnId, group, file.path)
                        : undefined}
                />
            )
        },
        diff: file => {
            let id = diffKey(group, file.path)
            let diff = inspected.diffs[id]
            return diff && <DiffPanel columnId={columnId} id={id} diff={diff} inspection={inspection} eligible={selectable && group != "comparison"} />
        },
    }
    // Every list but a comparison's opens a file's history from where the list was read.
    let history = historySource(files.source)
    let items = (file: ChangedFile) => {
        let own = menuItems?.(file)
        return (
            <>
                {history && <MenuItem onAction={() => inspection.openHistory(columnId, history, file.path)}>File history</MenuItem>}
                {history && own && <Separator />}
                {own}
            </>
        )
    }
    return (
        <div ref={target} {...props} className="change-file-list" data-group={group}>
            {staging && group == "working-staged" && !listed.length && <p className="staging-hint">Drop files here to stage them</p>}
            {!working && files.loading && !files.inventory && <p className="column-placeholder" role="status">Reading files…</p>}
            {!working && files.error && (
                <p className="column-placeholder" role="alert">
                    {files.error} <Button variant="quiet" onPress={() => inspection.retry(columnId, group)}>Retry</Button>
                </p>
            )}
            {!working && files.inventory && !listed.length && <p className="column-placeholder">{empty}</p>}
            {listed.length > 0 && (
                <FileTree
                    label={label}
                    files={listed}
                    view={view}
                    group={group}
                    selected={inspected?.selected ?? []}
                    onSelect={selectable
                        ? chosenFiles => inspection.select(columnId, group, chosenFiles)
                        : undefined}
                    root={root}
                    hideStagedBadge={working}
                    menuItems={items}
                    leading={leading}
                    inspect={inspect}
                />
            )}
            {chosen > 0 && (
                <div className="selection-summary" role="status">
                    {chosen} of {listed.length} selected
                    <Button variant="quiet" onPress={() => inspection.clearSelection(columnId)}>Clear</Button>
                </div>
            )}
        </div>
    )
}

/** Discard sits in the context menu only, so nothing on a row discards with one click. */
function discardItem(columnId: string, group: string, file: ChangedFile, inspection: Inspection) {
    let target = inspection.discardTarget(columnId, group, file)
    return target && <MenuItem onAction={() => void inspection.discard(columnId, group, file)}>{target.label}</MenuItem>
}

/** Where a list's file history reads from: a worktree's Working Changes or a commit. */
function historySource(source: DiffSource): FileHistorySource | undefined {
    if (source.kind == "working")
        return { kind: "worktree", worktreePath: source.worktreePath }
    if (source.kind == "commit")
        return { kind: "commit", objectId: source.objectId }
    return undefined
}

/** The layout and grouping of every file list; the choice applies to them all and is saved. */
export function FileListViewMenu({ label, view, onChange }: { label: string; view: FileListView; onChange(view: FileListView): void }) {
    return (
        <MenuTrigger>
            <AriaButton className="icon-button small" aria-label={label}>
                <TreeIcon />
            </AriaButton>
            <Menu aria-label="File list view">
                <MenuSection
                    selectionMode="single"
                    selectedKeys={[view.layout]}
                    onSelectionChange={keys => keys != "all" && keys.size && onChange({ ...view, layout: [...keys][0] as FileListView["layout"] })}
                >
                    {fileListViewOptions.layout.map(option => <MenuItem key={option.value} id={option.value}>{option.label}</MenuItem>)}
                </MenuSection>
                <Separator />
                <MenuSection
                    selectionMode="single"
                    selectedKeys={[view.grouping]}
                    onSelectionChange={keys => keys != "all" && keys.size && onChange({ ...view, grouping: [...keys][0] as FileListView["grouping"] })}
                >
                    {fileListViewOptions.grouping.map(option => <MenuItem key={option.value} id={option.value}>{option.label}</MenuItem>)}
                </MenuSection>
            </Menu>
        </MenuTrigger>
    )
}

/** The stash's own message, without Git's "On <branch>:" prefix that the column already implies. */
function stashMessage(stash: BranchGraphMarker) {
    return stash.tooltip.replace(/^(?:WIP on|On) [^:]+:\s*/, "") || stash.label
}
