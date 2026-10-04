import type { BranchGraph, WorkspaceColumn } from "@laneway/shared"
import { expect, test } from "bun:test"
import { branchNodeFor, localIdentities, reconcileWorktreeColumns, workspaceGraph } from "../src/renderer/src/worktree-columns"
import { branchGraph } from "./renderer-fixtures"

test("equivalent refs retain separate branch-only columns and worktree identity", () => {
    const graph = branchGraph("repo")
    const main = graph.branches[0]!
    main.localRefs.push("refs/heads/new")
    main.refs.push("refs/heads/new")
    const expanded = workspaceGraph(graph)
    expect(expanded.branches.find(branch => branch.id == "branch:refs/heads/new")).toMatchObject({ name: "new", checkedOut: [] })
    expect(graph.branches.some(branch => branch.id == "branch:refs/heads/new")).toBe(false)
    expect(
        reconcileWorktreeColumns([{ id: "branch:refs/heads/new", kind: "branch", ref: "refs/heads/new", lastSeenObjectId: main.tip, width: 380 }], graph)
            .columns,
    )
        .toMatchObject([{ id: "branch:refs/heads/new", ref: "refs/heads/new", worktreePath: undefined }])
})

test("branches sharing a tip keep their own identities, led by the node's preferred ref", () => {
    const graph = branchGraph("repo")
    const feature = graph.branches[1]!
    Object.assign(feature, {
        localRefs: ["refs/heads/a-sibling", "refs/heads/feature/laneway"],
        remoteRefs: ["refs/remotes/origin/feature/laneway"],
        refs: ["refs/heads/a-sibling", "refs/heads/feature/laneway", "refs/remotes/origin/feature/laneway"],
        tags: ["v1"],
    })
    const [lead, sibling] = localIdentities(graph, feature)
    expect([lead?.id, sibling?.id]).toEqual(["branch:refs/heads/feature/laneway", "branch:refs/heads/a-sibling"])
    expect(lead).toMatchObject({ aliases: ["feature/laneway", "origin/feature/laneway"], remoteRefs: ["refs/remotes/origin/feature/laneway"], tags: ["v1"] })
    expect(sibling).toMatchObject({ name: "a-sibling", aliases: ["a-sibling"], remoteRefs: [], tags: [], tip: feature.tip, base: feature.base })
    expect(branchNodeFor(graph, sibling!.id)).toBe(feature)
    expect(branchNodeFor(graph, lead!.id)).toBe(feature)
})

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
