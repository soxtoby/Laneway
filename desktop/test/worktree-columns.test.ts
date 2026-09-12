import type { BranchGraph, WorkspaceColumn } from "@git-workbench/shared"
import { expect, test } from "bun:test"
import { reconcileWorktreeColumns } from "../src/renderer/src/worktree-columns"
import { branchGraph } from "./renderer-fixtures"

test("external checkout keeps the worktree column position and removes an existing branch-only duplicate", () => {
    const graph: BranchGraph = branchGraph("repo")
    const [main, feature] = graph.branches
    feature!.checkedOut = [{ id: "main", path: "D:/repo", name: "repo", main: true, head: feature!.tip, branchRef: feature!.preferredRef }]
    const columns: WorkspaceColumn[] = [{
        kind: "branch",
        id: main!.id,
        ref: main!.preferredRef,
        lastSeenObjectId: main!.tip,
        worktreeId: "main",
        worktreePath: "D:/repo",
        width: 440,
        collapsed: true,
    }, { kind: "branch", id: feature!.id, ref: feature!.preferredRef, lastSeenObjectId: feature!.tip, width: 390 }]
    const result = reconcileWorktreeColumns(columns, graph, feature!.id)
    expect(result.columns).toHaveLength(1)
    expect(result.columns[0]).toMatchObject({ id: feature!.id, width: 440, collapsed: true, worktreeId: "main" })
    expect(result.focused).toBe(feature!.id)
})

test("external worktree rename retains a detached column by registration identity", () => {
    const graph: BranchGraph = branchGraph("repo")
    graph.virtualBranches = [{
        kind: "virtual",
        id: "virtual:new",
        name: "renamed",
        objectId: "1".repeat(40),
        tooltip: "detached",
        worktree: { id: "linked", path: "D:/renamed", name: "renamed", main: false, head: "1".repeat(40) },
    }]
    const result = reconcileWorktreeColumns(
        [{ kind: "virtual", id: "virtual:old", worktreeId: "linked", worktreePath: "D:/old", lastSeenObjectId: "1".repeat(40), width: 460 }],
        graph,
        "virtual:old",
    )
    expect(result.columns[0]).toMatchObject({ id: "virtual:new", worktreePath: "D:/renamed", width: 460 })
    expect(result.focused).toBe("virtual:new")
})
