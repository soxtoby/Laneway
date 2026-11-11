import { expect, test } from "bun:test"
import { incoming, staysBehind } from "../src/renderer/react/pull-latest"
import { branchGraph } from "./renderer-fixtures"

test("lists each upstream with new commits and each branch behind its Base, down to the Active Stack's Base", () => {
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

    expect(incoming({ ...graph, branches: [local, tip] }, tip, {})).toEqual([
        "origin/feature/laneway has 2 new commits",
        "feature/laneway is behind main",
        "origin/main has 1 new commit",
    ])

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
    let restacked = { ...tip, ahead: 3, upstreamIncoming: false }
    expect(incoming({ ...graph, branches: [main!, restacked] }, restacked, {})).toEqual(["feature/laneway is behind main"])
})

test("a branch that is published, or has a published branch built on it, waits behind the Primary Branch for Restack", () => {
    let graph = branchGraph("repo")
    let [main, feature] = graph.branches
    let base = (branch: typeof main) => ({ status: "known" as const, branchId: branch!.id, name: branch!.name, ref: branch!.preferredRef, tip: branch!.tip })
    let published = { upstreamRef: "refs/remotes/origin/feature/laneway", upstreamTip: "9".repeat(40) }
    let behind = { ...feature!, behindBase: true }
    let child = {
        ...feature!,
        id: "branch:refs/heads/child",
        name: "child",
        preferredRef: "refs/heads/child",
        localRefs: ["refs/heads/child"],
        base: base(behind),
    }

    // Its own upstream's commits still arrive.
    let own = { ...behind, ...published, behind: 1, upstreamIncoming: true }
    expect(incoming({ ...graph, branches: [main!, own] }, own, {})).toEqual(["origin/feature/laneway has 1 new commit"])
    // A published branch built on it holds it too, whichever column is asking.
    let above = { ...child, ...published }
    expect(incoming({ ...graph, branches: [main!, behind, above] }, behind, {})).toEqual([])
    expect(staysBehind({ ...graph, branches: [main!, behind, above] }, behind, main!)).toBe(true)
    // Within the stack a branch still follows the one below it, and an upstream that is gone publishes nothing.
    let lagging = { ...above, behindBase: true }
    expect(incoming({ ...graph, branches: [main!, behind, lagging] }, lagging, {})).toEqual(["child is behind feature/laneway"])
    let gone = { ...behind, upstreamRef: published.upstreamRef }
    expect(incoming({ ...graph, branches: [main!, gone, child] }, gone, {})).toEqual(["feature/laneway is behind main"])
    // Only the Primary Branch stays a Base however far it moves on.
    let integration = { ...main!, primary: false }
    expect(staysBehind({ ...graph, branches: [integration, own] }, own, integration)).toBe(false)
})
