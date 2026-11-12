import { describe, expect, test } from "bun:test"
import { sharedSnapshot } from "../src/renderer/react/shared-snapshot"

describe("sharedSnapshot", () => {
    test("a snapshot built again with the same values is the previous snapshot", () => {
        let graph = { branches: [] }
        let previous = { graph, columns: [{ id: "a", width: 380 }], view: { shown: true } }

        let result = sharedSnapshot(previous, { graph, columns: [{ id: "a", width: 380 }], view: { shown: true } })

        expect(result).toBe(previous)
    })

    test("a changed part is new, and the parts beside it keep their previous objects", () => {
        let previous = { columns: [{ id: "a", width: 380 }, { id: "b", width: 380 }], view: { shown: true } }

        let result = sharedSnapshot(previous, { columns: [{ id: "a", width: 380 }, { id: "b", width: 500 }], view: { shown: true } })

        expect(result).toEqual({ columns: [{ id: "a", width: 380 }, { id: "b", width: 500 }], view: { shown: true } })
        expect(result.columns[0]).toBe(previous.columns[0]!)
        expect(result.view).toBe(previous.view)
    })

    test("an object that isn't plain data is the same only if it is the same object", () => {
        let previous = { chosen: new Set(["a"]) }

        let result = sharedSnapshot(previous, { chosen: new Set(["a"]) })

        expect(result == previous).toBe(false)
    })

    test("a part added or removed makes a new snapshot", () => {
        let previous: { focused?: string; width: number } = { width: 380 }

        expect(sharedSnapshot(previous, { focused: "a", width: 380 }) == previous).toBe(false)
        expect(sharedSnapshot({ focused: "a", width: 380 }, previous)).toBe(previous)
    })
})
