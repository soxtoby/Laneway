import type { BranchGraph, BranchGraphBranchNode, BranchHistoryCommit, ComparisonRef, FileListView } from "@laneway/shared"
import clsx from "clsx"
import { useState } from "react"
import { Button as AriaButton } from "react-aria-components"
import type { ColumnView } from "./branch-workspace"
import { CommitAge } from "./commit-age"
import { authoredBy, authorInitials } from "./commit-authors"
import { ConflictResolution } from "./conflict-resolution"
import type { Conflicts } from "./conflicts"
import { Hint, IconButton, MoreMenu } from "./controls"
import { useRowMenu } from "./dense-row"
import { EditableName } from "./editable-name"
import { copyText } from "./file-paths"
import { BranchIcon, DiffIcon, MoreIcon, WarningIcon } from "./icons"
import { branchStack, type ColumnInspection, type Inspection } from "./inspection"
import { offersPublish, type Publish, publishRef } from "./publish"
import { PublishButton } from "./publish-control"
import { PullButton } from "./pull-control"
import { incoming, type PullLatest } from "./pull-latest"
import type { Reword } from "./reword"
import { TransferGrip, TransferReview, TransferSeam, useTransferScope, useTransferTarget } from "./transfer"
import { Button } from "./ui/Button"
import { ChevronRight } from "./ui/icons"
import { MenuItem, Separator } from "./ui/Menu"
import { Select, SelectItem } from "./ui/Select"
import { TextArea, TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"
import { FileList, FileListViewMenu } from "./working-changes"

export interface CommitTrailProps {
    column: Extract<ColumnView, { kind: "branch" }>
    graph: BranchGraph
    inspected?: ColumnInspection
    inspection: Inspection
    /** The column's worktree, which copied paths start from. */
    root?: string
    view: FileListView
    onViewChange(view: FileListView): void
    /** Renames the column's branch in place; a failure keeps the editor open with its message. */
    renameBranch(name: string): Promise<void>
    createBranchAt(commit: BranchHistoryCommit): void
    reword(branch: BranchGraphBranchNode, commit: BranchHistoryCommit, close: () => void): Reword
    /** Starts a Historical Edit from a commit; only a worktree-backed column outside one can. */
    editFrom?(commit: BranchHistoryCommit): void
    /** Opens the Branch Comparison Column from `from` to `to` beside this column. */
    compare(from: ComparisonRef, to: ComparisonRef): void
    /** Resolves the conflicts that rewrites deferred in the column's commits. */
    conflicts: Conflicts
    /** Publishes a branch's Active Stack from its header. */
    publish: Publish
    /** Pulls the column's Active Stack from its own branch's header. */
    pull: PullLatest
    /** Another operation is running, which can move the stacks. */
    busy: boolean
    repositoryId: string
}

/**
 * A branch column's Commit Trail: its branch's commits, then each base it was built on, which unfold
 * below it. A commit unfolds to its message and files.
 */
export function CommitTrail(props: CommitTrailProps) {
    let { column, graph, inspected } = props
    let [rewording, setRewording] = useState<string>()
    let stack = branchStack(graph, column.branch, inspected?.bases ?? {})
    return (
        <div className="commit-trail">
            {stack.map((branch, index) => (
                <StackBranch
                    key={branch.id}
                    {...props}
                    branch={branch}
                    own={index == 0}
                    above={stack[index - 1]}
                    below={stack[index + 1]}
                    rewording={rewording}
                    onReword={setRewording}
                />
            ))}
        </div>
    )
}

interface StackBranchProps extends CommitTrailProps {
    branch: BranchGraphBranchNode
    /** The column's own branch, whose commits always show; the bases below fold. */
    own: boolean
    /** The branches either side of this one in the stack: the one built on it, and its base. */
    above?: BranchGraphBranchNode
    below?: BranchGraphBranchNode
    /** The commit whose message is being edited, by object ID. */
    rewording?: string
    onReword(objectId?: string): void
}

function StackBranch(props: StackBranchProps) {
    let { branch, own, above, below, column, inspected, inspection } = props
    let history = inspected?.history[branch.id]
    let open = own || history?.open == true
    let publishing = publishRef(props.graph, branch)
    let unresolved = branch.unresolved && (
        <WarningIcon className="branch-conflict" role="img" aria-label={`${branch.name} has unresolved conflicts`} aria-hidden={false} />
    )
    // A local branch takes whole commits and other branches; any but the primary branch can move onto another.
    let scope = useTransferScope()
    let branchTarget = { kind: "branch" as const, branch: branch.preferredRef, tip: branch.tip }
    let { target: heading, props: targetProps } = useTransferTarget<HTMLHeadingElement>(
        scope?.composition,
        scope && !branch.remoteOnly ? { kind: "compose", repositoryId: scope.repositoryId, target: branchTarget } : undefined,
    )
    return (
        <section className={clsx("stack-branch", branch.published && "remote")} aria-label={`Branch ${branch.name}`}>
            {/* The seam at this branch's tip belongs to the branch built on it. */}
            {scope && above && !above.remoteOnly && (
                <TransferSeam
                    composition={scope.composition}
                    repositoryId={scope.repositoryId}
                    target={{ kind: "seam", branch: above.preferredRef, parentId: branch.tip }}
                />
            )}
            <h3 ref={heading} {...targetProps} className="stack-heading">
                {scope && !branch.remoteOnly && !branch.primary && (
                    <TransferGrip
                        composition={scope.composition}
                        selection={{ repositoryId: scope.repositoryId, selectedRemote: scope.selectedRemote, source: branchTarget, label: branch.name }}
                    />
                )}
                {own
                    ? (
                        <span className="stack-title">
                            <BranchIcon className="stack-icon" />
                            {branch.localRefs.length > 0
                                ? <EditableName name={branch.name} label={`branch ${branch.name}`} onCommit={props.renameBranch} />
                                : <span className="stack-name">{branch.name}</span>}
                            {unresolved}
                        </span>
                    )
                    : (
                        <AriaButton className="stack-toggle" aria-expanded={open} data-drags-row onPress={() => inspection.toggleHistory(column.id, branch.id)}>
                            <ChevronRight className="toggle-chevron" />
                            <BranchIcon className="stack-icon" />
                            <span className="stack-name">{branch.name}</span>
                            {unresolved}
                        </AriaButton>
                    )}
                {own && branch.preferredRef.startsWith("refs/heads/") && (
                    <PullButton
                        pull={props.pull}
                        repositoryId={props.repositoryId}
                        branch={branch.preferredRef}
                        name={branch.name}
                        incoming={incoming(props.graph, branch, inspected?.bases ?? {})}
                        remotes={props.graph.availableRemotes.length > 0}
                        busy={props.busy}
                    />
                )}
                {publishing && (
                    <PublishButton
                        publish={props.publish}
                        repositoryId={props.repositoryId}
                        branch={publishing}
                        offered={offersPublish(props.graph, branch, below)}
                        confirms={branch.primary}
                        busy={props.busy}
                    />
                )}
                {/* The branch at the bottom of the stack has no base in the column, so only those above it compare. */}
                {below && (
                    <IconButton
                        label={`Compare ${branch.name} with ${below.name}`}
                        small
                        onPress={() =>
                            props.compare({ kind: "merge-base", ref: below.preferredRef, withRef: branch.preferredRef }, {
                                kind: "branch",
                                ref: branch.preferredRef,
                            })}
                    >
                        <DiffIcon />
                    </IconButton>
                )}
            </h3>
            {scope && <TransferReview composition={scope.composition} repositoryId={scope.repositoryId} target={branchTarget} />}
            {scope && !branch.remoteOnly && (
                <TransferSeam
                    composition={scope.composition}
                    repositoryId={scope.repositoryId}
                    target={{ kind: "seam", branch: branch.preferredRef, parentId: branch.tip }}
                />
            )}
            {open && (
                <div className="stack-commits">
                    {history?.loading && !history.page && <p className="column-placeholder" role="status">Reading commits…</p>}
                    {history?.error && (
                        <p className="column-placeholder" role="alert">
                            {history.error} <Button variant="quiet" onPress={() => inspection.readHistory(column.id, branch.id)}>Retry</Button>
                        </p>
                    )}
                    {history?.page?.commits.filter(commit => !inspected?.conflictsOnly || commit.conflictId).map(commit => (
                        <TrailCommit key={commit.objectId} {...props} commit={commit} />
                    ))}
                    {history?.page?.nextOffset != undefined && (
                        <Button
                            variant="quiet"
                            isDisabled={history.loading}
                            onPress={() => inspection.readHistory(column.id, branch.id, true)}
                        >
                            Load more
                        </Button>
                    )}
                    {history?.page && history.page.nextOffset == undefined && branch.base.status == "ambiguous" && (
                        <BaseChoice {...props} candidates={branch.base.candidates} />
                    )}
                </div>
            )}
        </section>
    )
}

/** An ambiguous base: the history ends here until one of the candidates is chosen to continue it. */
function BaseChoice({ branch, column, inspected, inspection, candidates }: StackBranchProps & { candidates: { branchId: string; name: string }[] }) {
    return (
        <Select
            className="react-aria-Select trail-choice"
            label="Base branch"
            aria-label={`Base branch for ${branch.name}`}
            placeholder="Choose base…"
            selectedKey={inspected?.bases[branch.id] ?? null}
            onSelectionChange={key => inspection.chooseBase(column.id, branch.id, key == "none" ? undefined : String(key))}
        >
            <SelectItem id="none">None</SelectItem>
            {candidates.map(candidate => <SelectItem key={candidate.branchId} id={candidate.branchId}>{candidate.name}</SelectItem>)}
        </Select>
    )
}

function TrailCommit(props: StackBranchProps & { commit: BranchHistoryCommit }) {
    let { commit, branch, below, column, inspected, inspection, view, onViewChange, rewording, onReword } = props
    let files = inspected?.files[commit.objectId]
    let open = files?.open == true
    // Only a local branch's history can be reworded, and merge commits can't be. Historical Edit also leaves the Primary Branch alone.
    let rewordable = !branch.remoteOnly && commit.parentIds.length == 1
    let editFrom = props.editFrom
    let edit = column.worktree?.historicalEdit
    let editing = edit?.commit == commit.objectId
    let menu = {
        label: `Actions for commit ${commit.subject}`,
        items: () => (
            <>
                {editFrom && rewordable && !branch.primary && <MenuItem onAction={() => editFrom(commit)}>Edit from here</MenuItem>}
                {rewordable && <MenuItem onAction={() => onReword(commit.objectId)}>Reword commit…</MenuItem>}
                <MenuItem onAction={() => props.createBranchAt(commit)}>Create branch here…</MenuItem>
                <Separator />
                <CommitCopyItems commit={commit} />
            </>
        ),
    }
    let { row: rowRef, openMenu } = useRowMenu(menu)
    // A commit takes files and other commits, and a pointer near its top or bottom edge inserts beside it.
    let scope = useTransferScope()
    let commitTarget = { kind: "commit" as const, objectId: commit.objectId, branch: branch.preferredRef }
    let parentId = commit.parentIds[0]
    let edges = branch.remoteOnly ? {} : {
        above: { kind: "seam" as const, parentId: commit.objectId, branch: branch.preferredRef },
        below: parentId ? { kind: "seam" as const, parentId, branch: branch.preferredRef } : undefined,
    }
    let { target: targetRef, props: targetProps } = useTransferTarget<HTMLDivElement>(
        scope?.composition,
        scope && { kind: "compose", repositoryId: scope.repositoryId, target: commitTarget },
        edges,
    )
    // The seam below the branch's last commit is its base's tip, which the base's own seam already offers.
    let seamBelow = !branch.remoteOnly && parentId && !(branch.base.status == "known" && branch.base.tip == parentId && below)
    let comparedParent = files?.source.kind == "commit" ? files.source.parentId : undefined
    return (
        <div className="trail-commit" data-expanded={open || undefined} data-remote={commit.remote || undefined} data-editing={editing || undefined}>
            <div
                ref={element => {
                    rowRef.current = element
                    targetRef.current = element
                }}
                {...targetProps}
                className="commit-row"
                onContextMenu={openMenu}
            >
                <span className="commit-node" aria-hidden="true" />
                {scope && (
                    // A single parent also tells composition which seams sit beside the commit.
                    <TransferGrip
                        composition={scope.composition}
                        selection={{
                            repositoryId: scope.repositoryId,
                            selectedRemote: scope.selectedRemote,
                            source: {
                                kind: "commit",
                                objectId: commit.objectId,
                                branch: branch.preferredRef,
                                ...comparedParent ? { parentId: comparedParent } : commit.parentIds.length == 1 ? { parentId } : {},
                            },
                            label: commit.subject,
                        }}
                    />
                )}
                {/* A commit with deferred conflicts opens to resolve them. */}
                {commit.conflictId && (
                    <IconButton
                        label={`Resolve conflicts in ${commit.subject}`}
                        small
                        onPress={() => open || inspection.toggleCommit(column.id, commit.objectId)}
                    >
                        <WarningIcon className="commit-conflict" />
                    </IconButton>
                )}
                <AriaButton className="commit-toggle" aria-expanded={open} data-drags-row onPress={() => inspection.toggleCommit(column.id, commit.objectId)}>
                    <Hint text={commitMessage(commit)}>
                        <span className="commit-subject">{commit.subject}</span>
                    </Hint>
                    {commit.body && !open && <MoreIcon className="message-indicator" role="img" aria-label="Has message body" aria-hidden={false} />}
                    {/* The developer's own commits stay plain, so other people's stand out. */}
                    {!authoredBy(props.graph.authorIdentities, commit.authorEmail) && (
                        <Hint text={`${commit.authorName} <${commit.authorEmail}>`}>
                            <span className="commit-author" role="img" aria-label={`Authored by ${commit.authorName}`}>
                                {authorInitials(commit.authorName, commit.authorEmail)}
                            </span>
                        </Hint>
                    )}
                </AriaButton>
                {editing && <small className="commit-editing">Editing</small>}
                <CommitAge authoredAt={commit.authoredAt} />
                {open && (
                    <IconButton
                        label={`Show full diff for commit ${commit.subject}`}
                        small
                        onPress={() => inspection.openDiffColumn(column.id, commit.objectId, undefined, commit.subject)}
                    >
                        <DiffIcon />
                    </IconButton>
                )}
                {open && <FileListViewMenu label={`File list view for commit ${commit.subject}`} view={view} small onChange={onViewChange} />}
                <span className="row-actions" data-visible={open || undefined}>
                    <MoreMenu label={menu.label}>{menu.items()}</MoreMenu>
                </span>
            </div>
            {rewording == commit.objectId && <RewordForm {...props} close={() => onReword(undefined)} />}
            {/* The Historical Edit banner shows the review of changes applied to the commit it edits. */}
            {scope && !(editing && edit?.branch == branch.preferredRef) && (
                <TransferReview composition={scope.composition} repositoryId={scope.repositoryId} target={commitTarget} />
            )}
            {open && files && (
                <div className="commit-files">
                    {commit.body && <CommitMessage body={commit.body} />}
                    {commit.parentIds.length > 1 && (
                        <Select
                            className="react-aria-Select trail-choice"
                            label="Compare parent"
                            aria-label={`Parent for ${commit.subject}`}
                            selectedKey={files.source.kind == "commit" && files.source.parentId || commit.parentIds[0]}
                            onSelectionChange={key => inspection.chooseParent(column.id, commit.objectId, String(key))}
                        >
                            {commit.parentIds.map((parent, index) => (
                                <SelectItem key={parent} id={parent}>{`Parent ${index + 1} · ${parent.slice(0, 8)}`}</SelectItem>
                            ))}
                        </Select>
                    )}
                    {commit.conflictId
                        ? (
                            <ConflictResolution
                                conflicts={props.conflicts}
                                repositoryId={props.repositoryId}
                                subject={commit.conflictId}
                                path={props.root}
                                files={conflicted => (
                                    <FileList
                                        columnId={column.id}
                                        group={commit.objectId}
                                        label={`Files in commit ${commit.subject}`}
                                        files={conflicted && files.inventory
                                            ? {
                                                ...files,
                                                inventory: { ...files.inventory, files: files.inventory.files.filter(file => !conflicted.includes(file.path)) },
                                            }
                                            : files}
                                        inspected={inspected}
                                        inspection={inspection}
                                        view={view}
                                        root={props.root}
                                        selectable
                                        empty={conflicted ? "" : "No changes against this parent"}
                                    />
                                )}
                            />
                        )
                        : (
                            <FileList
                                columnId={column.id}
                                group={commit.objectId}
                                label={`Files in commit ${commit.subject}`}
                                files={files}
                                inspected={inspected}
                                inspection={inspection}
                                view={view}
                                root={props.root}
                                selectable
                                empty="No changes against this parent"
                            />
                        )}
                </div>
            )}
            {scope && seamBelow && (
                <TransferSeam
                    composition={scope.composition}
                    repositoryId={scope.repositoryId}
                    target={{ kind: "seam", branch: branch.preferredRef, parentId }}
                />
            )}
        </div>
    )
}

/** Copies of the commit's identity and message, at the end of its menu, as a File History entry's are too. */
export function CommitCopyItems({ commit }: { commit: Pick<BranchHistoryCommit, "objectId" | "subject" | "body"> }) {
    return (
        <>
            <MenuItem onAction={() => void copyText(commit.objectId)}>Copy commit hash</MenuItem>
            <MenuItem onAction={() => void copyText(commitMessage(commit))}>Copy commit message</MenuItem>
        </>
    )
}

/** The commit's whole message: its subject, then its body after a blank line. */
function commitMessage(commit: Pick<BranchHistoryCommit, "subject" | "body">) {
    return commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject
}

/** A commit's description, which folds to one line. */
function CommitMessage({ body }: { body: string }) {
    let [expanded, setExpanded] = useState(true)
    return (
        <div className="commit-message">
            <AriaButton
                className="commit-message-toggle"
                aria-label={expanded ? "Collapse commit description" : "Expand commit description"}
                aria-expanded={expanded}
                onPress={() => setExpanded(!expanded)}
            >
                <ChevronRight className="toggle-chevron" />
                {!expanded && <span className="commit-message-preview">{body}</span>}
            </AriaButton>
            {expanded && <p className="commit-message-body">{body}</p>}
        </div>
    )
}

/** Edits a commit's title and message in place, with the commit composer's fields. */
function RewordForm({ branch, commit, reword, close }: StackBranchProps & { commit: BranchHistoryCommit; close(): void }) {
    let [controller] = useState(() => reword(branch, commit, close))
    let state = useSnapshot(controller)
    let composition = state.preview?.composition
    return (
        <section className="reword-form" aria-label={`Reword commit ${commit.subject}`}>
            <TextField
                aria-label="Commit title"
                placeholder="Commit title (required)"
                value={state.title}
                onChange={title => controller.edit({ title })}
                isDisabled={state.busy}
                autoFocus
            />
            <TextArea
                aria-label="Commit message"
                placeholder="Message (optional)"
                value={state.message}
                onChange={message => controller.edit({ message })}
                isDisabled={state.busy}
            />
            {!!composition?.published.length && (
                <p className="reword-warning" role="alert">
                    Rewrites history already published on {composition.published.join(", ")}. The next Publish needs force-with-lease.
                </p>
            )}
            {!!composition?.removed.length && <p>Remove empty commits: {composition.removed.map(objectId => objectId.slice(0, 8)).join(", ")}</p>}
            {!!composition?.branches.length && <p>Affected: {composition.branches.join(", ")}</p>}
            {state.error && <p role="status">{state.error}</p>}
            <div className="commit-actions">
                <Button variant="secondary" isDisabled={state.busy} onPress={close}>Cancel</Button>
                {state.preview
                    ? <Button variant="accent" isDisabled={state.busy} onPress={() => void controller.execute()}>Rewrite history</Button>
                    : (
                        <Button variant="accent" isDisabled={state.busy || !state.title.trim() || !controller.edited()} onPress={() => void controller.apply()}>
                            {state.busy ? "Working…" : "Apply"}
                        </Button>
                    )}
            </div>
        </section>
    )
}
