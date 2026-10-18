/** @jsxImportSource react */
import type { BranchGraph, FileListView } from "@laneway/shared"
import type { AppController } from "./app-controller"
import type { ColumnView } from "./branch-workspace"
import { CommitTrail } from "./commit-trail"
import type { ColumnInspection } from "./inspection"
import { TransferScopeContext } from "./transfer"
import { StashedChanges, WorkingChanges } from "./working-changes"

interface ColumnBodyProps {
    controller: AppController
    repositoryId: string
    /** The active repository's Branch Graph, with each local branch as its own node. */
    graph: BranchGraph
    column: ColumnView
    inspected?: ColumnInspection
    /** Local operations wait for an interrupted worktree removal. */
    blocked: boolean
    view: FileListView
    onViewChange(view: FileListView): void
}

/** A column's Working Changes and stashes, then its branch's Commit Trail. A missing worktree has no Working Changes. */
export function ColumnBody({ controller, repositoryId, graph, column, inspected, blocked, view, onViewChange }: ColumnBodyProps) {
    if (column.kind == "comparison")
        return <p className="column-placeholder">{column.description}</p>
    if (column.kind == "recovery")
        return null
    let { inspection, branches, composition } = controller
    let path = column.worktree && !column.worktree.missing ? column.worktree.path : undefined
    let scope = { composition, repositoryId, selectedRemote: graph.selectedRemote, branch: column.kind == "branch" ? column.branch.preferredRef : undefined }
    return (
        <TransferScopeContext value={scope}>
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
                            createComposer={() => controller.composer(repositoryId, column.id, path, blocked)}
                            blocked={blocked}
                            view={view}
                            onViewChange={onViewChange}
                        />
                    )
                    : column.kind == "branch" && column.branch.markers.length > 0 && (
                        <StashedChanges column={column} inspected={inspected} inspection={inspection} view={view} />
                    )}
                {column.kind == "branch" && (
                    <CommitTrail
                        column={column}
                        graph={graph}
                        inspected={inspected}
                        inspection={inspection}
                        root={path}
                        view={view}
                        onViewChange={onViewChange}
                        renameBranch={newName => branches.perform(repositoryId, { action: "branch-rename", name: column.branch.name, newName })}
                        createBranchAt={commit => branches.createAt(repositoryId, commit.objectId)}
                        reword={(branch, commit, close) => controller.reword(repositoryId, branch.preferredRef, commit, close)}
                    />
                )}
            </div>
        </TransferScopeContext>
    )
}
