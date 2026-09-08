import { expect, test } from "bun:test"
import { graphHistory } from "../src/graph-history"

test("omits intermediate merges of a branch whose head is merged later", () => {
    const points = graphHistory([
        { objectId: "main", parentIndexes: [1] },
        { objectId: "merged-head", parentIndexes: [3, 2] },
        { objectId: "feature", parentIndexes: [4] },
        { objectId: "old-merge", parentIndexes: [5, 4] },
        { objectId: "old-feature", parentIndexes: [6] },
        { objectId: "main-work", parentIndexes: [6] },
        { objectId: "base", parentIndexes: [] },
    ], [{ objectId: "main", lineId: "main" }, { objectId: "feature", lineId: "feature" }])
    expect(points.map(point => point.objectId)).toEqual(["main", "merged-head", "feature", "base"])
})

test("connects an older branch head through an intermediate merge", () => {
    const points = graphHistory([
        { objectId: "main", parentIndexes: [4, 2] },
        { objectId: "newer-branch-head", parentIndexes: [2] },
        { objectId: "intermediate", parentIndexes: [5, 3] },
        { objectId: "feature", parentIndexes: [5] },
        { objectId: "main-work", parentIndexes: [5] },
        { objectId: "base", parentIndexes: [] },
    ], [{ objectId: "main", lineId: "main" }, { objectId: "newer-branch-head", lineId: "hidden" }, { objectId: "feature", lineId: "feature" }])
    expect(points.find(point => point.objectId == "main")?.parentIds).toEqual(["base", "feature"])
})

test("connects open and merged branches and keeps tags on their history", () => {
    // main: tip -> merge -> tagged -> base; merged: merge -> feature -> base.
    const commits = [
        { objectId: "open", parentIndexes: [4] },
        { objectId: "tip", parentIndexes: [2] },
        { objectId: "merge", parentIndexes: [4, 3] },
        { objectId: "feature", parentIndexes: [5] },
        { objectId: "tagged", parentIndexes: [5] },
        { objectId: "base", parentIndexes: [] },
    ]
    const points = graphHistory(commits, [
        { objectId: "tip", lineId: "main" },
        { objectId: "open", lineId: "open" },
        { objectId: "feature", lineId: "merged" },
        { objectId: "tagged", lineId: "tag" },
    ])
    expect(points).toEqual([
        { objectId: "open", lineId: "open", parentIds: ["tagged"] },
        { objectId: "tip", lineId: "main", parentIds: ["merge"] },
        { objectId: "merge", lineId: "main", parentIds: ["tagged", "feature"] },
        { objectId: "feature", lineId: "merged", parentIds: ["base"] },
        { objectId: "tagged", lineId: "main", parentIds: ["base"] },
        { objectId: "base", lineId: "main", parentIds: [] },
    ])
})

test("compresses ordinary commits and omits merges without a retained side line", () => {
    const commits = [
        { objectId: "tip", parentIndexes: [1, 2] },
        { objectId: "main-work", parentIndexes: [3] },
        { objectId: "hidden-work", parentIndexes: [3] },
        { objectId: "base", parentIndexes: [] },
    ]
    expect(graphHistory(commits, [{ objectId: "tip", lineId: "main" }])).toEqual([{ objectId: "tip", lineId: "main", parentIds: ["base"] }, {
        objectId: "base",
        lineId: "main",
        parentIds: [],
    }])
})

test("fast-forwarded heads and tags stay on the existing line", () => {
    const commits = [{ objectId: "tip", parentIndexes: [1] }, { objectId: "feature", parentIndexes: [2] }, { objectId: "base", parentIndexes: [] }]
    const points = graphHistory(commits, [{ objectId: "tip", lineId: "main" }, { objectId: "feature", lineId: "feature" }, {
        objectId: "feature",
        lineId: "tag",
    }])
    expect(points.map(point => point.lineId)).toEqual(["main", "main", "main"])
    expect(points.map(point => point.parentIds)).toEqual([["feature"], ["base"], []])
})
