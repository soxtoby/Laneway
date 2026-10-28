import { expect, test } from "bun:test"
import { incoming } from "../src/renderer/react/pull-latest"
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
    let local = { ...main!, upstreamRef: "refs/remotes/origin/main", behind: 1, behindBase: true }
    let tip = { ...feature!, upstreamRef: "refs/remotes/origin/feature/laneway", behind: 2, behindBase: true }

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
})
