import type { BranchGraph } from "@git-workbench/shared"
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
    expect(rows[0].paths).toContain(`M ${rows[0].x} 20 C ${rows[0].x} 32 ${rows[1].x} 28 ${rows[1].x} 40`)
    expect(rows[1].paths).toContain(`M ${rows[1].x} 20 C ${rows[1].x} 23 ${rows[0].x} 22 ${rows[0].x} 25`)
    expect(rows[1].paths).toContain(`M ${rows[0].x} 0 V 30`)
    expect(layoutBranchGraph(graph, [main]).rows.some(row => row.node.id == feature.id)).toBe(false)
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
        expect(row.paths.some(path => path == `M ${row.x} 0 V 40` || path == `M ${row.x} 0 V 20`)).toBe(true)
        expect(row.paths.some(path => path == `M ${row.x} 0 V 40` || path.startsWith(`M ${row.x} 20 `))).toBe(true)
    }
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
    expect(rows[0].paths).toEqual(["M 13 20 V 40"])
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
    expect(rows[0].paths.some(path => path.includes(` ${rows[1].x} 40`))).toBe(true)
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
