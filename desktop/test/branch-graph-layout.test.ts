import type { BranchGraph } from "@laneway/shared"
import { expect, test } from "bun:test"
import { layoutBranchGraph } from "../src/renderer/src/branch-graph-layout"
import { branchGraph } from "./renderer-fixtures"

test("draws a merged branch off the main rail and reconnects at its base", () => {
    const graph: BranchGraph = branchGraph("test")
    const [main, feature] = graph.branches
    graph.branches = [main, feature]
    graph.history = [{ objectId: main.tip, lineId: main.id, parentIds: ["base", feature.tip] }, {
        objectId: feature.tip,
        lineId: feature.id,
        parentIds: ["base"],
    }, { objectId: "base", lineId: main.id, parentIds: [] }]
    const { rows } = layoutBranchGraph(graph, graph.branches)
    expect(rows.map(row => row.node.id)).toEqual([main.id, feature.id])
    expect(rows[1].x).not.toBe(rows[0].x)
    expect(rows[1].color).not.toBe(rows[0].color)
    expect(rows[0].paths).toContainEqual({ d: `M ${rows[0].x} 20 C ${rows[0].x} 32 ${rows[1].x} 28 ${rows[1].x} 40`, color: rows[1].color })
    expect(rows[1].paths).toContainEqual({ d: `M ${rows[1].x} 20 C ${rows[1].x} 23 ${rows[0].x} 22 ${rows[0].x} 25`, color: rows[1].color })
    // The main rail ends where feature rejoins it, not at the unlisted base commit below.
    expect(rows[1].paths).toContainEqual({ d: `M ${rows[0].x} 0 V 25`, color: rows[0].color })
    expect(layoutBranchGraph(graph, [main]).rows.some(row => row.node.id == feature.id)).toBe(false)
})

test("draws nothing on the Primary lane above its tip until a line joins it", () => {
    const graph: BranchGraph = branchGraph("test")
    const [main, feature, other] = graph.branches
    const primaryLane = (path: { d: string }) => path.d.startsWith("M 13 ")
    // feature starts from older Primary history, so no line reaches Primary's tip from above.
    graph.history = [{ objectId: feature.tip, lineId: feature.id, parentIds: ["base"] }, { objectId: main.tip, lineId: main.id, parentIds: ["base"] }, {
        objectId: "base",
        lineId: main.id,
        parentIds: [],
    }]
    const separate = layoutBranchGraph(graph, [main, feature]).rows
    expect(separate.map(row => row.node.id)).toEqual([feature.id, main.id])
    expect(separate[0].paths.some(primaryLane)).toBe(false)
    expect(separate[1].paths.some(path => path.d.startsWith("M 13 0 "))).toBe(false)
    // other starts at Primary's tip, so the lane is drawn from where it joins down to the tip.
    graph.history = [{ objectId: other.tip, lineId: other.id, parentIds: [main.tip] }, { objectId: main.tip, lineId: main.id, parentIds: ["base"] }, {
        objectId: "base",
        lineId: main.id,
        parentIds: [],
    }]
    const joined = layoutBranchGraph(graph, [main, other]).rows
    expect(joined[0].paths.some(path => path.d.endsWith(" 13 40"))).toBe(true)
    expect(joined[0].paths.some(path => path.d.startsWith("M 13 0 "))).toBe(false)
    expect(joined[1].paths.some(path => path.d.startsWith("M 13 0 "))).toBe(true)
})

test("ends the lines below the last row once the visible branches have met", () => {
    const graph: BranchGraph = branchGraph("test")
    const [main, feature] = graph.branches
    // A lone rail leading on to unlisted commits is not drawn at all.
    graph.history = [{ objectId: main.tip, lineId: main.id, parentIds: ["base"] }, { objectId: "base", lineId: main.id, parentIds: [] }]
    expect(layoutBranchGraph(graph, [main]).rows[0].paths).toEqual([])
    // feature meets the main rail at an unlisted base; the rail stops at that join.
    graph.history = [{ objectId: main.tip, lineId: main.id, parentIds: ["base"] }, { objectId: feature.tip, lineId: feature.id, parentIds: ["base"] }, {
        objectId: "base",
        lineId: main.id,
        parentIds: ["older"],
    }, { objectId: "older", lineId: main.id, parentIds: [] }]
    const rows = layoutBranchGraph(graph, [main, feature]).rows
    const join = rows[1].paths.find(path => path.d.includes(" C "))!.d.split(" ").at(-1)
    expect(rows[1].paths).toContainEqual({ d: `M 13 0 V ${join}`, color: rows[0].color })
    expect(rows[1].paths.every(path => Number(path.d.split(" ").at(-1)) <= Number(join))).toBe(true)
})

test("orders tags by topology and draws uninterrupted rails through tag rows", () => {
    const graph: BranchGraph = branchGraph("test")
    const [main, feature] = graph.branches
    graph.branches = [main, feature]
    graph.tags = ["a-old", "z-new", "same-commit"].map((name, index) => ({
        kind: "tag",
        id: name,
        name,
        objectId: index == 0 ? "old" : "new",
        parentBranchId: feature.id,
        tooltip: name,
    }))
    graph.history = [{ objectId: feature.tip, lineId: feature.id, parentIds: ["new"] }, { objectId: "new", lineId: feature.id, parentIds: ["old"] }, {
        objectId: "old",
        lineId: feature.id,
        parentIds: [main.tip],
    }, { objectId: main.tip, lineId: main.id, parentIds: [] }]
    const { rows } = layoutBranchGraph(graph, graph.branches)
    expect(rows.map(row => row.node.id)).toEqual([feature.id, "z-new", "same-commit", "a-old", main.id])
    expect(rows[0].x).not.toBe(rows.at(-1)!.x)
    for (const row of rows.filter(row => row.node.kind == "tag")) {
        expect(row.x).toBe(rows[0].x)
        expect(row.color).toBe(rows[0].color)
        expect(row.paths.some(path => path.color == row.color && (path.d == `M ${row.x} 0 V 40` || path.d == `M ${row.x} 0 V 20`))).toBe(true)
        expect(row.paths.some(path => path.color == row.color && (path.d == `M ${row.x} 0 V 40` || path.d.startsWith(`M ${row.x} 20 `)))).toBe(true)
    }
})

test("stretches a commit's node across consecutive rows of branches sharing its tip", () => {
    const graph: BranchGraph = branchGraph("test")
    const [main, feature] = graph.branches
    const sibling = (name: string) => ({ ...feature, id: `branch:refs/heads/${name}`, name })
    const { rows } = layoutBranchGraph(graph, [main, feature, sibling("second"), sibling("third")])
    expect(rows.map(row => row.node.id)).toEqual([feature.id, "branch:refs/heads/second", "branch:refs/heads/third", main.id])
    expect(rows.map(row => row.sameCommit)).toEqual([{ above: false, below: true }, { above: true, below: true }, { above: true, below: false }, {
        above: false,
        below: false,
    }])
    expect(new Set(rows.slice(0, 3).map(row => `${row.x}:${row.color}`)).size).toBe(1)
    // The rail still runs straight through the shared commit's rows.
    expect(rows[0].paths).toContainEqual({ d: `M ${rows[0].x} 20 V 40`, color: rows[0].color })
    expect(rows[1].paths).toContainEqual({ d: `M ${rows[0].x} 0 V 40`, color: rows[0].color })
    expect(rows[2].paths).toContainEqual({ d: `M ${rows[0].x} 0 V 20`, color: rows[0].color })
})

test("keeps early labels close to the rail when later history gets wider", () => {
    const graph: BranchGraph = branchGraph("test")
    const [main, feature, other] = graph.branches
    graph.tags = [{ kind: "tag", id: "tag", name: "tag", objectId: "tag", parentBranchId: main.id, tooltip: "tag" }]
    graph.history = [
        { objectId: main.tip, lineId: main.id, parentIds: ["tag"] },
        { objectId: "tag", lineId: main.id, parentIds: ["base", feature.tip, other.tip] },
        { objectId: feature.tip, lineId: feature.id, parentIds: ["base"] },
        { objectId: other.tip, lineId: other.id, parentIds: ["base"] },
        { objectId: "base", lineId: main.id, parentIds: [] },
    ]
    const { rows, width } = layoutBranchGraph(graph, graph.branches)
    expect(width).toBeGreaterThan(26)
    expect(rows[0].width).toBe(26)
    expect(rows[0].paths).toEqual([{ d: "M 13 20 V 40", color: rows[0].color }])
})

test("keeps a visible branch merged through a filtered-out intermediate branch", () => {
    const graph: BranchGraph = branchGraph("test")
    const [main, feature] = graph.branches
    graph.history = [
        { objectId: main.tip, lineId: main.id, parentIds: ["base", "hidden"] },
        { objectId: "hidden", lineId: "filtered-out", parentIds: ["base", feature.tip] },
        { objectId: feature.tip, lineId: feature.id, parentIds: ["base"] },
        { objectId: "base", lineId: main.id, parentIds: [] },
    ]
    const { rows } = layoutBranchGraph(graph, [main, feature])
    expect(rows.map(row => row.node.id)).toEqual([main.id, feature.id])
    expect(rows[0].paths.some(path => path.d.includes(` ${rows[1].x} 40`))).toBe(true)
})

test("only shows tag waypoints belonging to visible branch lines", () => {
    const graph: BranchGraph = branchGraph("test")
    const [main, feature] = graph.branches
    graph.tags = [{ kind: "tag", id: "unassigned", name: "unassigned", objectId: "outside", tooltip: "outside branch history" }, {
        kind: "tag",
        id: "filtered",
        name: "filtered",
        objectId: "hidden",
        parentBranchId: feature.id,
        tooltip: "hidden branch",
    }]
    expect(layoutBranchGraph(graph, [main]).rows.map(row => row.node.id)).toEqual([main.id])
})

test("reuses colors after a branch joins its base", () => {
    const graph = branchGraph("test")
    const [main, feature, other] = graph.branches
    graph.history = [{ objectId: feature.tip, lineId: feature.id, parentIds: [main.tip] }, { objectId: other.tip, lineId: other.id, parentIds: [main.tip] }, {
        objectId: main.tip,
        lineId: main.id,
        parentIds: [],
    }]
    const { rows } = layoutBranchGraph(graph, graph.branches)
    expect(rows[0].color).toBe(rows[1].color)
    expect(rows[0].color).not.toBe(rows[2].color)
})

test("keeps every parallel rail distinct even with many branches", () => {
    const graph = branchGraph("test")
    const [main, feature] = graph.branches
    const features = Array.from({ length: 12 }, (_, index) => ({ ...feature, id: `feature-${index}`, tip: `tip-${index}` }))
    graph.branches = [main, ...features]
    graph.history = [
        { objectId: main.tip, lineId: main.id, parentIds: ["base", ...features.map(branch => branch.tip)] },
        ...features.map(branch => ({ objectId: branch.tip, lineId: branch.id, parentIds: ["base"] })),
        { objectId: "base", lineId: main.id, parentIds: [] },
    ]
    const { rows } = layoutBranchGraph(graph, graph.branches)
    expect(new Set(rows.map(row => row.color)).size).toBe(graph.branches.length)
    expect(new Set(rows[1].paths.filter(path => path.d.endsWith("V 40")).map(path => path.color)).size).toBe(features.length)
})
