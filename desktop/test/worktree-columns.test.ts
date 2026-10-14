import type { BranchGraph, WorkspaceColumn } from "@laneway/shared"
import { expect, test } from "bun:test"
import { branchNodeFor, localIdentities, reconcileWorktreeColumns, workspaceGraph } from "../src/renderer/src/worktrees/worktree-columns"
import { branchGraph } from "./renderer-fixtures"

test("equivalent refs retain separate branch-only columns and worktree identity", () => {
    let graph = branchGraph("repo")
    let main = graph.branches[0]!
    main.localRefs.push("refs/heads/new")
    main.refs.push("refs/heads/new")

    let expanded = workspaceGraph(graph)
    expect(expanded.branches.find(branch => branch.id == "branch:refs/heads/new")).toMatchObject({ name: "new", checkedOut: [] })
    expect(graph.branches.some(branch => branch.id == "branch:refs/heads/new")).toBe(false)
    expect(
        reconcileWorktreeColumns([{ id: "branch:refs/heads/new", kind: "branch", ref: "refs/heads/new", lastSeenObjectId: main.tip, width: 380 }], graph)
            .columns,
    )
        .toMatchObject([{ id: "branch:refs/heads/new", ref: "refs/heads/new", worktreePath: undefined }])
})

test("branches sharing a tip keep their own identities, led by the node's preferred ref", () => {
    let graph = branchGraph("repo")
    let feature = graph.branches[1]!
    Object.assign(feature, {
        localRefs: ["refs/heads/a-sibling", "refs/heads/feature/laneway"],
        remoteRefs: ["refs/remotes/origin/feature/laneway"],
        refs: ["refs/heads/a-sibling", "refs/heads/feature/laneway", "refs/remotes/origin/feature/laneway"],
        tags: ["v1"],
    })

    let [lead, sibling] = localIdentities(graph, feature)
    expect([lead?.id, sibling?.id]).toEqual(["branch:refs/heads/feature/laneway", "branch:refs/heads/a-sibling"])
    expect(lead).toMatchObject({ aliases: ["feature/laneway", "origin/feature/laneway"], remoteRefs: ["refs/remotes/origin/feature/laneway"], tags: ["v1"] })
    expect(sibling).toMatchObject({ name: "a-sibling", aliases: ["a-sibling"], remoteRefs: [], tags: [], tip: feature.tip, base: feature.base })
    expect(branchNodeFor(graph, sibling!.id)).toBe(feature)
    expect(branchNodeFor(graph, lead!.id)).toBe(feature)
})

test("external checkout keeps the worktree column position and removes an existing branch-only duplicate", () => {
    let graph: BranchGraph = branchGraph("repo")
    let [main, feature] = graph.branches
    feature!.checkedOut = [{ id: "main", path: "D:/repo", name: "repo", main: true, head: feature!.tip, branchRef: feature!.preferredRef }]
    let columns: WorkspaceColumn[] = [{
        kind: "branch",
        id: main!.id,
        ref: main!.preferredRef,
        lastSeenObjectId: main!.tip,
        worktreeId: "main",
        worktreePath: "D:/repo",
        width: 440,
        collapsed: true,
    }, { kind: "branch", id: feature!.id, ref: feature!.preferredRef, lastSeenObjectId: feature!.tip, width: 390 }]
    let result = reconcileWorktreeColumns(columns, graph, feature!.id)
    expect(result.columns).toHaveLength(1)
    expect(result.columns[0]).toMatchObject({ id: feature!.id, width: 440, collapsed: true, worktreeId: "main" })
    expect(result.focused).toBe(feature!.id)
})

test("external worktree rename retains a detached column by registration identity", () => {
    let graph: BranchGraph = branchGraph("repo")
    graph.virtualBranches = [{
        kind: "virtual",
        id: "virtual:new",
        name: "renamed",
        objectId: "1".repeat(40),
        tooltip: "detached",
        worktree: { id: "linked", path: "D:/renamed", name: "renamed", main: false, head: "1".repeat(40) },
    }]
    let result = reconcileWorktreeColumns(
        [{ kind: "virtual", id: "virtual:old", worktreeId: "linked", worktreePath: "D:/old", lastSeenObjectId: "1".repeat(40), width: 460 }],
        graph,
        "virtual:old",
    )
    expect(result.columns[0]).toMatchObject({ id: "virtual:new", worktreePath: "D:/renamed", width: 460 })
    expect(result.focused).toBe("virtual:new")
})

test("interrupted removal retains column presentation without a Git registration and disappears only after resolution", () => {
    let graph: BranchGraph = branchGraph("repo")
    let branch = graph.branches[1]!
    let recovery = {
        operationId: "interrupted",
        worktreeId: "linked",
        path: "D:/removed",
        head: branch.tip,
        branchRef: branch.preferredRef,
        message: "Files remain in the directory.",
    }
    let oldColumn: WorkspaceColumn = {
        kind: "branch",
        id: branch.id,
        ref: branch.preferredRef,
        worktreePath: recovery.path,
        worktreeId: "linked",
        lastSeenObjectId: branch.tip,
        width: 460,
        collapsed: true,
        diffLayout: "split",
    }
    let pending = reconcileWorktreeColumns([oldColumn], graph, branch.id, [recovery])
    expect(pending).toMatchObject({
        focused: "recovery:interrupted",
        columns: [{ id: "recovery:interrupted", width: 460, collapsed: true, diffLayout: "split" }],
    })
    expect(reconcileWorktreeColumns(pending.columns, graph, pending.focused, [recovery]).columns).toEqual(pending.columns)
    expect(reconcileWorktreeColumns([], graph, undefined, [recovery]).columns).toHaveLength(1)
    expect(reconcileWorktreeColumns(pending.columns, graph).columns).toEqual([])
    branch.checkedOut = [{ id: "linked", path: recovery.path, name: "removed", main: false, head: branch.tip }]
    expect(reconcileWorktreeColumns(pending.columns, graph, pending.focused)).toMatchObject({ focused: branch.id, columns: [{ id: branch.id, width: 460 }] })
    branch.checkedOut[0]!.id = "recreated-registration"
    expect(reconcileWorktreeColumns(pending.columns, graph, pending.focused)).toMatchObject({
        focused: branch.id,
        columns: [{ id: branch.id, worktreeId: "recreated-registration", width: 460, collapsed: true, diffLayout: "split" }],
    })
})

test("comparison columns keep their place and refs through reconciliation", () => {
    let graph = branchGraph("repo")
    let [main, feature] = graph.branches
    let comparison: WorkspaceColumn = {
        kind: "comparison",
        id: "comparison:main..feature",
        from: { kind: "merge-base", ref: main.preferredRef, withRef: feature.preferredRef },
        to: { kind: "branch", ref: feature.preferredRef },
        width: 400,
        diffLayout: "split",
    }
    let result = reconcileWorktreeColumns(
        [{ kind: "branch", id: main.id, ref: main.preferredRef, lastSeenObjectId: main.tip, width: 380 }, comparison, {
            kind: "branch",
            id: feature.id,
            ref: feature.preferredRef,
            lastSeenObjectId: feature.tip,
            width: 380,
        }],
        graph,
        comparison.id,
    )

    expect(result.columns.map(column => column.id)).toEqual([main.id, comparison.id, feature.id])
    expect(result.columns[1]).toEqual(comparison)
    expect(result.focused).toBe(comparison.id)
})
