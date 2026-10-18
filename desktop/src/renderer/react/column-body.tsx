/** @jsxImportSource react */
import type { BranchGraph, DiffLayout, FileListView } from "@laneway/shared"
import type { ReactNode } from "react"
import type { AppController } from "./app-controller"
import type { ColumnView } from "./branch-workspace"
import { CommitTrail } from "./commit-trail"
import { DiffScopeContext } from "./diff-panel"
import type { ColumnInspection } from "./inspection"
import { TransferScopeContext } from "./transfer"
import { FileList, StashedChanges, WorkingChanges } from "./working-changes"

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
    if (column.kind == "recovery")
        return null
    let { inspection, branches } = controller
    // A comparison only reads, so its files can't be chosen to move or discard.
    if (column.kind == "comparison") {
        return (
            <ColumnScopes controller={controller} repositoryId={repositoryId} graph={graph} column={column}>
                <div className="column-body">
                    <section className="branch-comparison" aria-label={column.description}>
                        <FileList
                            columnId={column.id}
                            group="comparison"
                            label={`Files changed in ${column.name}`}
                            files={inspected?.files.comparison}
                            inspected={inspected}
                            inspection={inspection}
                            view={view}
                            comparison={column.comparison}
                            empty="No differences"
                        />
                    </section>
                </div>
            </ColumnScopes>
        )
    }
    let path = columnRoot(column)
    return (
        <ColumnScopes controller={controller} repositoryId={repositoryId} graph={graph} column={column}>
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
                        compare={(from, to) => controller.columns.openComparison(column.id, from, to)}
                    />
                )}
            </div>
        </ColumnScopes>
    )
}

/**
 * What a column's lists and diffs share: where their changes move from, and how their diffs lay out. The
 * column's auxiliary columns share them too.
 */
export function ColumnScopes({ controller, repositoryId, graph, column, children }: {
    controller: AppController
    repositoryId: string
    graph: BranchGraph
    column: ColumnView
    children: ReactNode
}) {
    let scope = {
        composition: controller.composition,
        repositoryId,
        selectedRemote: graph.selectedRemote,
        branch: column.kind == "branch" ? column.branch.preferredRef : undefined,
    }
    let diffs = { layout: column.diffLayout, setLayout: (layout: DiffLayout) => controller.columns.setDiffLayout(column.id, layout) }
    return (
        <TransferScopeContext value={scope}>
            <DiffScopeContext value={diffs}>{children}</DiffScopeContext>
        </TransferScopeContext>
    )
}

/** The worktree a column's files live in, while it is on disk. */
export function columnRoot(column: ColumnView) {
    return column.worktree && !column.worktree.missing ? column.worktree.path : undefined
}
