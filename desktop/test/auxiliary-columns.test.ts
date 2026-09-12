import { expect, test } from "bun:test"
import { AuxiliaryColumns } from "../src/renderer/src/auxiliary-columns"

test("keeps newest sibling subtrees beside their source and reuses only the same parent's identity", () => {
    const tree = new AuxiliaryColumns<string>()
    tree.addRoot("workspace")
    tree.addRoot("other")
    const create = (value: string) => () => ({ value, dispose() {} })
    const first = tree.open("workspace", "history", create("first"))
    const child = tree.open(first.id, "commit", create("child"))
    const second = tree.open("workspace", "comparison", create("second"))
    expect(tree.descendants("workspace").map(column => column.id)).toEqual([second.id, first.id, child.id])
    expect(tree.open("workspace", "history", () => {
        throw new Error("Should reuse")
    })).toBe(first)
    expect(tree.focusedId).toBe(first.id)
    expect(tree.descendants("workspace").map(column => column.id)).toEqual([second.id, first.id, child.id])
    expect(tree.open("other", "history", create("other")).id).not.toBe(first.id)
})

test("closing a source disposes descendants once, restores focus, and leaves siblings alive", () => {
    const tree = new AuxiliaryColumns<string>()
    const disposed: string[] = []
    const create = (value: string) => () => ({
        value,
        dispose() {
            disposed.push(value)
        },
    })
    tree.addRoot("workspace")
    const sibling = tree.open("workspace", "sibling", create("sibling"))
    const parent = tree.open("workspace", "parent", create("parent"))
    tree.open(parent.id, "child", create("child"))
    tree.close(parent.id)
    expect(disposed).toEqual(["child", "parent"])
    expect(tree.focusedId).toBe("workspace")
    expect(tree.descendants("workspace")).toEqual([sibling])
    tree.close(parent.id)
    tree.close("workspace")
    expect(disposed).toEqual(["child", "parent", "sibling"])
    expect(tree.descendants("workspace")).toEqual([])
    expect(() => tree.open("workspace", "missing", create("missing"))).toThrow("source is unavailable")
})
