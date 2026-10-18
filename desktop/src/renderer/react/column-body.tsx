/** @jsxImportSource react */
import type { BranchHistoryCommit, ChangedFile } from "@laneway/shared"
import { GridList } from "react-aria-components"
import type { ColumnContents, ColumnView } from "./branch-workspace"
import { IconButton, MoreMenu } from "./controls"
import { DenseRow } from "./dense-row"
import { AddIcon, ArchiveIcon, BranchIcon, CloseIcon, DeletedIcon, ModifiedIcon, OpenColumnIcon, TreeIcon } from "./icons"
import type { Notice } from "./notice"
import { Button } from "./ui/Button"
import { Checkbox } from "./ui/Checkbox"
import { Disclosure, DisclosureHeader, DisclosurePanel } from "./ui/Disclosure"
import { MenuItem } from "./ui/Menu"

/**
 * A column's Working Changes, stashes, and commits as the spike drew them, standing in until Working
 * Changes and the Commit Trail move (migration steps 4 and 5). A missing worktree has no Working Changes.
 */
export function ColumnBody({ column, contents, notify }: { column: ColumnView; contents?: ColumnContents; notify(notice: Notice): void }) {
    if (column.kind == "comparison")
        return <p className="column-placeholder">{column.description}</p>
    if (column.kind == "recovery")
        return null
    let changes = contents?.changes
    return (
        <div className="column-body">
            {column.kind == "branch" && column.branch.markers.filter(marker => marker.kind == "stash").map(stash => (
                <div key={stash.id} className="stash-row">
                    <ArchiveIcon />
                    <span className="stash-label">{stash.label}</span>
                    <Button variant="secondary">Apply</Button>
                    <IconButton label="Drop stash">
                        <CloseIcon />
                    </IconButton>
                </div>
            ))}
            {column.worktree && !column.worktree.missing && (
                changes && "error" in changes
                    ? <p className="column-placeholder">Working Changes unavailable: {changes.error}</p>
                    : <WorkingChanges files={changes?.files} notify={notify} />
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

function WorkingChanges({ files, notify }: { files?: ChangedFile[]; notify(notice: Notice): void }) {
    let title = !files ? "Reading Working Changes…" : files.length == 0 ? "No Working Changes" : `Working Changes (${files.length})`
    return (
        <div className="working-changes">
            <Disclosure defaultExpanded>
                <div className="changes-header">
                    <DisclosureHeader>{title}</DisclosureHeader>
                    <IconButton label="Show as tree">
                        <TreeIcon />
                    </IconButton>
                    <IconButton label="Open in a column">
                        <OpenColumnIcon />
                    </IconButton>
                </div>
                <DisclosurePanel>
                    {files && files.length > 0 && <FileList files={files} notify={notify} />}
                    <div className="commit-bar">
                        <Button variant="accent" isDisabled={!files?.length}>Commit…</Button>
                    </div>
                </DisclosurePanel>
            </Disclosure>
        </div>
    )
}

/** Changed files at Laneway's density, with the kit's Checkbox for selection. */
function FileList({ files, notify }: { files: ChangedFile[]; notify(notice: Notice): void }) {
    return (
        <GridList aria-label="Working Changes" selectionMode="multiple" className="dense-list">
            {files.map(file => {
                let slash = file.path.lastIndexOf("/") + 1
                return (
                    <DenseRow
                        key={file.path}
                        id={file.path}
                        textValue={file.path}
                        className="compact"
                        menu={{ label: `Actions for ${file.path}`, items: () => <FileMenuItems path={file.path} notify={notify} /> }}
                    >
                        {({ actions }) => (
                            <div className="row-content file-content">
                                <Checkbox slot="selection" />
                                <FileStatus file={file} />
                                <span className="file-path">
                                    <span className="file-directory">{file.path.slice(0, slash)}</span>
                                    {file.path.slice(slash)}
                                </span>
                                {actions}
                            </div>
                        )}
                    </DenseRow>
                )
            })}
        </GridList>
    )
}

// The undo window replaces a confirmation dialog. The spike's discard only shows the notices.
function FileMenuItems({ path, notify }: { path: string; notify(notice: Notice): void }) {
    let discard = () =>
        notify({
            code: "discard.applied",
            message: `Discarded changes to ${path}.`,
            transient: true,
            duration: 6_000,
            action: { label: "Undo", run: () => notify({ code: "discard.undone", message: `Restored ${path}.`, transient: true }) },
        })
    return (
        <>
            <MenuItem onAction={discard}>Discard changes</MenuItem>
            <MenuItem>Copy path</MenuItem>
            <MenuItem>Show history</MenuItem>
        </>
    )
}

function FileStatus({ file }: { file: ChangedFile }) {
    if (file.untracked || file.status.startsWith("A"))
        return <AddIcon className="file-status" data-status="added" aria-label="Added" />
    if (file.status.includes("D"))
        return <DeletedIcon className="file-status" data-status="deleted" aria-label="Deleted" />
    return <ModifiedIcon className="file-status" data-status="modified" aria-label="Modified" />
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
