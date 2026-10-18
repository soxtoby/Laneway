/** @jsxImportSource react */
import type { BranchGraph, BranchGraphBranchNode, BranchHistoryCommit, FileListView } from "@laneway/shared"
import clsx from "clsx"
import { useState } from "react"
import { Button as AriaButton } from "react-aria-components"
import type { ColumnView } from "./branch-workspace"
import { MoreMenu } from "./controls"
import { useRowMenu } from "./dense-row"
import { EditableName } from "./editable-name"
import { BranchIcon, MoreIcon, WarningIcon } from "./icons"
import { branchStack, type ColumnInspection, type Inspection } from "./inspection"
import type { Reword } from "./reword"
import { Button } from "./ui/Button"
import { ChevronRight } from "./ui/icons"
import { MenuItem } from "./ui/Menu"
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
                <StackBranch key={branch.id} {...props} branch={branch} own={index == 0} rewording={rewording} onReword={setRewording} />
            ))}
        </div>
    )
}

interface StackBranchProps extends CommitTrailProps {
    branch: BranchGraphBranchNode
    /** The column's own branch, whose commits always show; the bases below fold. */
    own: boolean
    /** The commit whose message is being edited, by object ID. */
    rewording?: string
    onReword(objectId?: string): void
}

function StackBranch(props: StackBranchProps) {
    let { branch, own, column, inspected, inspection } = props
    let history = inspected?.history[branch.id]
    let open = own || history?.open == true
    let unresolved = branch.unresolved && (
        <WarningIcon className="branch-conflict" role="img" aria-label={`${branch.name} has unresolved conflicts`} aria-hidden={false} />
    )
    return (
        <section className={clsx("stack-branch", branch.published && "remote")} aria-label={`Branch ${branch.name}`}>
            <h3 className="stack-heading">
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
                        <AriaButton className="stack-toggle" aria-expanded={open} onPress={() => inspection.toggleHistory(column.id, branch.id)}>
                            <ChevronRight className="toggle-chevron" />
                            <BranchIcon className="stack-icon" />
                            <span className="stack-name">{branch.name}</span>
                            {unresolved}
                        </AriaButton>
                    )}
            </h3>
            {open && (
                <div className="stack-commits">
                    {history?.loading && !history.page && <p className="column-placeholder" role="status">Reading commits…</p>}
                    {history?.error && (
                        <p className="column-placeholder" role="alert">
                            {history.error} <Button variant="quiet" onPress={() => inspection.readHistory(column.id, branch.id)}>Retry</Button>
                        </p>
                    )}
                    {history?.page?.commits.map(commit => <TrailCommit key={commit.objectId} {...props} commit={commit} />)}
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
    let { commit, branch, column, inspected, inspection, view, onViewChange, rewording, onReword } = props
    let files = inspected?.files[commit.objectId]
    let open = files?.open == true
    // Only a local branch's history can be reworded, and merge commits can't be.
    let rewordable = !branch.remoteOnly && commit.parentIds.length == 1
    let menu = {
        label: `Actions for commit ${commit.subject}`,
        items: () => (
            <>
                {rewordable && <MenuItem onAction={() => onReword(commit.objectId)}>Reword commit…</MenuItem>}
                <MenuItem onAction={() => props.createBranchAt(commit)}>Create branch here…</MenuItem>
            </>
        ),
    }
    let { row, openMenu } = useRowMenu(menu)
    return (
        <div className="trail-commit" data-expanded={open || undefined} data-remote={commit.remote || undefined}>
            <div ref={row} className="commit-row" title={commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject} onContextMenu={openMenu}>
                <span className="commit-node" aria-hidden="true" />
                <AriaButton className="commit-toggle" aria-expanded={open} onPress={() => inspection.toggleCommit(column.id, commit.objectId)}>
                    <span className="commit-subject">{commit.subject}</span>
                    {commit.body && !open && <MoreIcon className="message-indicator" role="img" aria-label="Has message body" aria-hidden={false} />}
                </AriaButton>
                {open && <FileListViewMenu label={`File list view for commit ${commit.subject}`} view={view} onChange={onViewChange} />}
                <span className="row-actions" data-visible={open || undefined}>
                    <MoreMenu label={menu.label}>{menu.items()}</MoreMenu>
                </span>
            </div>
            {rewording == commit.objectId && <RewordForm {...props} close={() => onReword(undefined)} />}
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
                    <FileList
                        columnId={column.id}
                        group={commit.objectId}
                        label={`Files in commit ${commit.subject}`}
                        files={files}
                        inspected={inspected}
                        inspection={inspection}
                        view={view}
                        root={props.root}
                        empty="No changes against this parent"
                    />
                </div>
            )}
        </div>
    )
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
