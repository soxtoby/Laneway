import type { BranchGraphMarker, ChangedFile, DiffSource, FileHistorySource, FileListView } from "@laneway/shared"
import { memo, type ReactNode, type RefObject, useCallback, useEffect, useState } from "react"
import { Button as AriaButton, Form } from "react-aria-components"
import type { ColumnView } from "./branch-workspace"
import { type CommitComposer, defaultBranchName } from "./commit-composer"
import { type ComparisonColumnNode, comparisonHistorySource } from "./comparison-columns"
import type { Landing, TransferSelection } from "./composition"
import { Hint, IconButton } from "./controls"
import { DiffControls, DiffPanel } from "./diff-panel"
import { EditableName } from "./editable-name"
import { fileListViewOptions } from "./file-list-view"
import { type FileInspection, FileRowsLayout, FileTree, revealRow } from "./file-tree"
import { applySelection } from "./historical-edit"
import { applyTarget } from "./historical-edit-banner"
import { ArchiveIcon, ChevronDownIcon, CloseIcon, DetachedIcon, FolderIcon, OpenColumnIcon, TreeIcon } from "./icons"
import { type ColumnInspection, diffKey, type FilesState, type Inspection, matchesFilter } from "./inspection"
import { TransferGrip, TransferReview, transferSource, useTransferScope, useTransferTarget } from "./transfer"
import { Button } from "./ui/Button"
import { ChevronRight } from "./ui/icons"
import { Menu, MenuItem, MenuSection, MenuTrigger, Separator } from "./ui/Menu"
import { TextArea, TextField } from "./ui/TextField"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot, useSnapshotValue } from "./use-snapshot"

interface WorkingChangesProps {
    column: Extract<ColumnView, { kind: "branch" | "virtual" }>
    /** The column's worktree, which is on disk. */
    path: string
    inspected?: ColumnInspection
    inspection: Inspection
    /** Called once; the composer lives as long as this view. */
    createComposer(): CommitComposer
    blocked: boolean
    /** Every Historical Edit's stash, in any worktree. */
    sessionStashes: string[]
    view: FileListView
    onViewChange(view: FileListView): void
}

/**
 * A worktree's Working Changes and their stashes. Staged files sit above a divider and the rest below
 * it; a clean worktree folds to one quiet row. A detached worktree also shows the branch its next
 * commit creates. In a Historical Edit, the changes apply to the edited commit instead of committing.
 */
export function WorkingChanges({ column, path, inspected, inspection, createComposer, blocked, sessionStashes, view, onViewChange }: WorkingChangesProps) {
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
    let edit = column.worktree?.historicalEdit
    let detached = !edit && (column.kind == "virtual" || state.loaded && preview != undefined && (!preview.branch || preview.unborn))
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
    // Kept across renders, so the lists skip renders that change nothing they show.
    let columnId = column.id
    let stagedItems = useCallback((file: ChangedFile) => discardItem(columnId, "working-staged", file, inspection), [columnId, inspection])
    let unstagedItems = useCallback((file: ChangedFile) => discardItem(columnId, "working-unstaged", file, inspection), [columnId, inspection])
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
            menuItems={group == "working-staged" ? stagedItems : unstagedItems}
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
                        // A Historical Edit's own stash comes back when it returns, so it stays as it is until then,
                        // including on a branch another worktree checked out meanwhile.
                        actions={sessionStashes.includes(stash.objectId)
                            ? undefined
                            : { disabled, apply: () => void composer.applyStash(stash.objectId), drop: () => void composer.dropStash(stash.objectId) }}
                    />
                ))}
            <div className={clean ? "commit-card clean" : "commit-card"} data-expanded={expanded || undefined}>
                <header className="commit-header">
                    <h3 className="commit-title">
                        {/* A clean worktree has nothing to unfold or act on. */}
                        {clean
                            ? (
                                <span className="working-changes-label">
                                    <FolderIcon />
                                    <span>No Working Changes</span>
                                </span>
                            )
                            : (
                                <AriaButton
                                    className="working-changes-toggle"
                                    aria-label={expanded ? "Collapse Working Changes" : "Expand Working Changes"}
                                    aria-expanded={expanded}
                                    onPress={() => setExpanded(!expanded)}
                                >
                                    <ChevronRight className="toggle-chevron" />
                                    <FolderIcon />
                                    <span>Working Changes</span>
                                </AriaButton>
                            )}
                    </h3>
                    {!clean && (
                        <>
                            <FileListViewMenu label="File list view for Working Changes" view={view} onChange={onViewChange} />
                            <IconButton label="Open diff column" small isDisabled={!files.length} onPress={() => inspection.openWorkingDiffColumn(column.id)}>
                                <OpenColumnIcon />
                            </IconButton>
                        </>
                    )}
                    {!clean && edit && scope && (
                        <ApplyButton
                            disabled={disabled || !files.length || edit.state != "active"}
                            selection={applySelection(scope.repositoryId, path, inspected, scope.selectedRemote)}
                            apply={selection =>
                                scope.composition.land(selection, { kind: "compose", repositoryId: scope.repositoryId, target: applyTarget(edit) }, false)}
                        />
                    )}
                    {/* The form's own Commit button takes over while composing. */}
                    {!clean && !edit && !state.composing && (
                        <div className="commit-split">
                            <Button variant="accent" isDisabled={disabled || !state.loaded || !files.length} onPress={reveal(composer.compose)}>
                                Commit…
                            </Button>
                            <MenuTrigger>
                                <TooltipTrigger>
                                    <Button variant="accent" aria-label="More commit actions" isDisabled={disabled || !files.length}>
                                        <ChevronDownIcon />
                                    </Button>
                                    <Tooltip>More commit actions</Tooltip>
                                </TooltipTrigger>
                                <Menu>
                                    <MenuItem onAction={reveal(composer.openStash)}>Stash Working Changes…</MenuItem>
                                </Menu>
                            </MenuTrigger>
                        </div>
                    )}
                </header>
                {(expanded || clean) && (
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
                <Hint text={unborn ? "No commits yet; the first commit creates this branch" : "Committing creates this branch at the detached head"}>
                    <div className="virtual-branch">
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
                </Hint>
            )}
        </section>
    )
}

/** Apply changes, the default action of a Historical Edit: the chosen changes, or all of them, into the edited commit. */
function ApplyButton({ disabled, selection, apply }: { disabled: boolean; selection: TransferSelection; apply(selection: TransferSelection): void }) {
    return (
        <Button variant="accent" isDisabled={disabled} onPress={() => apply(selection)}>
            {selection.files ? "Apply selected" : "Apply changes"}
        </Button>
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
            <div className="branch-stash-row">
                <AriaButton
                    className="branch-stash-toggle"
                    aria-expanded={open}
                    aria-label={`Stash ${stash.label}: ${message}`}
                    onPress={() => inspection.toggleStash(columnId, stash.objectId)}
                >
                    <ChevronRight className="toggle-chevron" />
                    <ArchiveIcon />
                    <Hint text={stash.tooltip}>
                        <span className="branch-stash-message">{message}</span>
                    </Hint>
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
    /** A comparison's ends, whose histories its files open in. */
    comparison?: ComparisonColumnNode
}

/**
 * One list of a column's files, with its reading and failure states and, once files are chosen, how many. It renders
 * again only when what it shows changes, not with each update to its column, such as each diff a diff column reads.
 */
export const FileList = memo(function FileList(
    {
        columnId,
        group,
        label,
        files,
        inspected,
        inspection,
        view,
        root,
        selectable = false,
        menuItems,
        empty,
        staging,
        diffColumn: breaksOut = true,
        comparison,
    }: FileListProps,
) {
    let scope = useTransferScope()
    let { target, props } = useTransferTarget<HTMLDivElement>(scope?.composition, staging)
    let [layout] = useState(() => new FileRowsLayout())
    if (!files)
        return null
    let filter = inspected?.filter
    let listed = files.inventory?.files.filter(file => !file.ignored && (!filter || matchesFilter(filter, file))) ?? []
    let hidden = filter != undefined && files.inventory?.files.some(file => !file.ignored) == true
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
    // A file's history reads from where the list was read; a comparison's file has one at either end.
    let history = historySource(files.source)
    let histories = (file: ChangedFile) =>
        comparison
            ? [{ label: `History in ${comparison.fromName}`, source: comparisonHistorySource(comparison.from), path: file.oldPath ?? file.path }, {
                label: `History in ${comparison.toName}`,
                source: comparisonHistorySource(comparison.to),
                path: file.path,
            }]
            : history
            ? [{ label: "File history", source: history, path: file.path }]
            : []
    let items = (file: ChangedFile) => {
        let own = menuItems?.(file)
        let opened = histories(file)
        return (
            <>
                {opened.map(item => (
                    <MenuItem key={item.label} onAction={() => inspection.openHistory(columnId, item.source, item.path)}>{item.label}</MenuItem>
                ))}
                {opened.length > 0 && own && <Separator />}
                {own}
            </>
        )
    }
    return (
        <div ref={target} {...props} className="change-file-list" data-group={group}>
            <ActiveRow list={target} layout={layout} inspection={inspection} columnId={columnId} group={group} />
            {staging && group == "working-staged" && !listed.length && <p className="staging-hint">Drop files here to stage them</p>}
            {!working && files.loading && !files.inventory && <p className="column-placeholder" role="status">Reading files…</p>}
            {!working && files.error && (
                <p className="column-placeholder" role="alert">
                    {files.error} <Button variant="quiet" onPress={() => inspection.retry(columnId, group)}>Retry</Button>
                </p>
            )}
            {!working && files.inventory && !listed.length && <p className="column-placeholder">{hidden ? "No files match the filter" : empty}</p>}
            {listed.length > 0 && (
                <FileTree
                    label={label}
                    files={listed}
                    view={view}
                    group={group}
                    selected={inspected?.selected ?? []}
                    onSelect={selectable
                        ? (chosenFiles, add) => inspection.select(columnId, group, chosenFiles, add)
                        : undefined}
                    root={root}
                    hideStagedBadge={working}
                    highlight={filter?.text}
                    menuItems={items}
                    leading={leading}
                    inspect={inspect}
                    layout={layout}
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
}, sameList)

// A list shows its column's filter and chosen files, and its open diffs only while the column has no diff column;
// with one, they open there instead.
function sameList({ inspected: before, ...props }: FileListProps, { inspected: after, ...next }: FileListProps) {
    let keys = new Set([...Object.keys(props), ...Object.keys(next)]) as Set<keyof typeof props>
    if ([...keys].some(key => props[key] !== next[key]))
        return false
    if (before == after)
        return true
    return before != undefined && after != undefined && before.filter == after.filter && before.selected == after.selected
        && before.diffColumn?.group == after.diffColumn?.group
        && (before.diffColumn != undefined && after.diffColumn != undefined || before.diffs == after.diffs)
}

/**
 * Marks the row of the file at the top of the column's diff column, and keeps it in view, scrolling only the list's
 * own column. It follows the inspection itself, so the list's rows don't re-render each time the diff column scrolls
 * to another file, and marks rows the Tree draws again, such as an unfolded folder's.
 */
function ActiveRow({ list, layout, inspection, columnId, group }: {
    list: RefObject<HTMLElement | null>
    layout: FileRowsLayout
    inspection: Inspection
    columnId: string
    group: string
}) {
    let shown = useSnapshotValue(inspection, snapshot => {
        let diffColumn = snapshot.columns[columnId]?.diffColumn
        return diffColumn?.group == group ? diffColumn.shown : undefined
    })
    useEffect(() => {
        let element = list.current
        if (!element)
            return
        let mark = () => {
            for (let row of element.querySelectorAll<HTMLElement>(".file-row[data-row-key]")) {
                let active = row.dataset.rowKey == shown
                if (row.hasAttribute("data-active") != active)
                    row.toggleAttribute("data-active", active)
            }
        }
        mark()
        let rows = new MutationObserver(mark)
        rows.observe(element, { childList: true, subtree: true })
        // The Tree redraws its rows a render later, so it waits a frame, by which time a diff that was open under the row has gone.
        let tree = element.querySelector<HTMLElement>(".file-tree")
        let frame = requestAnimationFrame(() => {
            if (tree && shown != undefined)
                revealRow(tree, layout, shown)
        })
        return () => {
            rows.disconnect()
            cancelAnimationFrame(frame)
        }
    }, [list, layout, shown])
    return null
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
            <TooltipTrigger>
                <AriaButton className="icon-button small" aria-label={label}>
                    <TreeIcon />
                </AriaButton>
                <Tooltip>File list view</Tooltip>
            </TooltipTrigger>
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
