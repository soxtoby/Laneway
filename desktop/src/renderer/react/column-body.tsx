/** @jsxImportSource react */
import type { BranchHistoryCommit, FileListView } from "@laneway/shared"
import { GridList } from "react-aria-components"
import type { ColumnContents, ColumnView } from "./branch-workspace"
import type { CommitComposer } from "./commit-composer"
import { MoreMenu } from "./controls"
import { DenseRow } from "./dense-row"
import { BranchIcon } from "./icons"
import type { ColumnInspection, Inspection } from "./inspection"
import { MenuItem } from "./ui/Menu"
import { StashedChanges, WorkingChanges } from "./working-changes"

interface ColumnBodyProps {
    column: ColumnView
    contents?: ColumnContents
    inspected?: ColumnInspection
    inspection: Inspection
    createComposer(path: string): CommitComposer
    /** Local operations wait for an interrupted worktree removal. */
    blocked: boolean
    view: FileListView
    onViewChange(view: FileListView): void
}

/**
 * A column's Working Changes and stashes, then its branch's commits as the spike drew them until the
 * Commit Trail moves (migration step 5). A missing worktree has no Working Changes.
 */
export function ColumnBody({ column, contents, inspected, inspection, createComposer, blocked, view, onViewChange }: ColumnBodyProps) {
    if (column.kind == "comparison")
        return <p className="column-placeholder">{column.description}</p>
    if (column.kind == "recovery")
        return null
    let path = column.worktree && !column.worktree.missing ? column.worktree.path : undefined
    return (
        <div className="column-body">
            {path
                ? (
                    // A cleared recovery recreates the composer, so its preview runs again.
                    <WorkingChanges
                        key={`${path}:${blocked}`}
                        column={column}
                        path={path}
                        inspected={inspected}
                        inspection={inspection}
                        createComposer={() => createComposer(path)}
                        blocked={blocked}
                        view={view}
                        onViewChange={onViewChange}
                    />
                )
                : column.kind == "branch" && column.branch.markers.length > 0 && (
                    <StashedChanges column={column} inspected={inspected} inspection={inspection} view={view} />
                )}
            {column.kind == "branch" && (
                <>
                    <div className="branch-header">
                        <BranchIcon />
                        <span className="branch-name">{column.branch.name}</span>
                        {column.branch.ahead > 0 && <span className="badge" data-variant="ahead">{`${column.branch.ahead} ahead`}</span>}
                        {column.branch.behind > 0 && <span className="badge">{`${column.branch.behind} behind`}</span>}
                        <span className="spacer" />
                        <MoreMenu label={`Actions for ${column.branch.name}`}>
                            <MenuItem>Rename branch</MenuItem>
                            <MenuItem>Compare with…</MenuItem>
                            <MenuItem>Push</MenuItem>
                        </MoreMenu>
                    </div>
                    <CommitTrail branchName={column.branch.name} commits={contents?.commits ?? []} />
                </>
            )}
        </div>
    )
}

/** The Commit Trail: the same dense rows with a graph gutter. */
function CommitTrail({ branchName, commits }: { branchName: string; commits: BranchHistoryCommit[] }) {
    return (
        <GridList aria-label={`Commits on ${branchName}`} selectionMode="multiple" selectionBehavior="replace" className="dense-list">
            {commits.map((commit, index) => (
                <DenseRow
                    key={commit.objectId}
                    id={commit.objectId}
                    textValue={commit.subject}
                    menu={{ label: `Actions for ${commit.subject}`, items: () => <CommitMenuItems /> }}
                >
                    {({ actions }) => (
                        <div className="row-content commit-content">
                            <span className="graph-cell" aria-hidden>
                                <span className="graph-line" data-first={index == 0 || undefined} data-last={index == commits.length - 1 || undefined} />
                                <span className="graph-dot" data-head={index == 0 || undefined} />
                            </span>
                            <span className="commit-subject">{commit.subject}</span>
                            <span className="commit-time">{relativeTime(commit.authoredAt)}</span>
                            {actions}
                        </div>
                    )}
                </DenseRow>
            ))}
        </GridList>
    )
}

function CommitMenuItems() {
    return (
        <>
            <MenuItem>Reword…</MenuItem>
            <MenuItem>Copy commit ID</MenuItem>
            <MenuItem>Compare with working tree</MenuItem>
            <MenuItem>Undo commit</MenuItem>
        </>
    )
}

let relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" })

function relativeTime(seconds: number) {
    let minutes = Math.round((seconds * 1000 - Date.now()) / 60000)
    if (Math.abs(minutes) < 60)
        return relativeFormat.format(minutes, "minute")
    let hours = Math.round(minutes / 60)
    if (Math.abs(hours) < 24)
        return relativeFormat.format(hours, "hour")
    return relativeFormat.format(Math.round(hours / 24), "day")
}
