import { expect, test } from "bun:test"
import { incoming } from "../src/renderer/react/pull-latest"
import { branchGraph } from "./renderer-fixtures"

test("lists each upstream with new commits and each branch behind a Base other than the Primary Branch, down to the Active Stack's Base", () => {
    let graph = branchGraph("repo")
    let [main, feature] = graph.branches
    let remoteMain = {
        ...main!,
        id: "branch:refs/remotes/origin/main",
        name: "origin/main",
        preferredRef: "refs/remotes/origin/main",
        localRefs: [],
        primary: false,
        remoteOnly: true,
        behind: 4,
    }
    let local = { ...main!, upstreamRef: "refs/remotes/origin/main", behind: 1, upstreamIncoming: true, behindBase: true }
    let tip = { ...feature!, upstreamRef: "refs/remotes/origin/feature/laneway", behind: 2, upstreamIncoming: true, behindBase: true }

    expect(incoming({ ...graph, branches: [local, tip] }, tip, {})).toEqual(["origin/feature/laneway has 2 new commits", "origin/main has 1 new commit"])

    // A remote Base ends the stack, and has no upstream of its own.
    let onRemote = {
        ...tip,
        base: { status: "known" as const, branchId: remoteMain.id, name: remoteMain.name, ref: remoteMain.preferredRef, tip: remoteMain.tip },
    }
    let below = { ...remoteMain, base: { status: "known" as const, branchId: local.id, name: "main", ref: local.preferredRef, tip: local.tip } }

    expect(incoming({ ...graph, branches: [local, below, onRemote] }, onRemote, {})).toEqual([
        "origin/feature/laneway has 2 new commits",
        "feature/laneway is behind origin/main",
    ])
    expect(incoming(graph, feature!, {})).toEqual([])

    // A restacked branch is behind its upstream only by the commits it replaced; it has publication pending instead.
    let restacked = { ...onRemote, ahead: 3, upstreamIncoming: false }
    expect(incoming({ ...graph, branches: [local, below, restacked] }, restacked, {})).toEqual(["feature/laneway is behind origin/main"])
})

test("a branch behind the Primary Branch waits there for Restack, though its upstream's commits still arrive", () => {
    let graph = branchGraph("repo")
    let [main, feature] = graph.branches
    let behind = { ...feature!, behindBase: true }
    let child = {
        ...feature!,
        id: "branch:refs/heads/child",
        name: "child",
        preferredRef: "refs/heads/child",
        localRefs: ["refs/heads/child"],
        base: { status: "known" as const, branchId: behind.id, name: behind.name, ref: behind.preferredRef, tip: behind.tip },
    }

    expect(incoming({ ...graph, branches: [main!, behind] }, behind, {})).toEqual([])
    let own = { ...behind, upstreamRef: "refs/remotes/origin/feature/laneway", behind: 1, upstreamIncoming: true }
    expect(incoming({ ...graph, branches: [main!, own] }, own, {})).toEqual(["origin/feature/laneway has 1 new commit"])
    // Within the stack a branch still follows the one below it, and so does one on a Base other than the Primary Branch.
    let lagging = { ...child, behindBase: true }
    expect(incoming({ ...graph, branches: [main!, behind, lagging] }, lagging, {})).toEqual(["child is behind feature/laneway"])
    let integration = { ...main!, primary: false }
    expect(incoming({ ...graph, branches: [integration, behind] }, behind, {})).toEqual(["feature/laneway is behind main"])
})
