import { describe, expect, test } from "bun:test"
import { columnDropTarget } from "../src/renderer/react/column-drag"

describe("column drag", () => {
    // A 500px column with a 300px one after it, then a 300px one after that.
    let spans = [{ id: "wide", left: 0, right: 500 }, { id: "narrow", left: 500, right: 800 }, { id: "last", left: 800, right: 1100 }]

    test("a narrower column held over the part of a wider one it wouldn't cover stays put", () => {
        expect(columnDropTarget(spans, "narrow", 400)).toBeUndefined()
    })

    test("a narrower column takes a wider one's place once the pointer is where it would land", () => {
        expect(columnDropTarget(spans, "narrow", 250)).toBe("wide")
    })

    test("a wider column takes a narrower one's place as soon as the pointer is over it", () => {
        expect(columnDropTarget(spans, "wide", 510)).toBe("narrow")
    })

    test("a column over its own place stays there", () => {
        expect(columnDropTarget(spans, "narrow", 600)).toBeUndefined()
    })

    test("a column dragged past either end of the row moves to that end", () => {
        expect(columnDropTarget(spans, "narrow", 1500)).toBe("last")
        expect(columnDropTarget(spans, "narrow", -20)).toBe("wide")
    })
})
