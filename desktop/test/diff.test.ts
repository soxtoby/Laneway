import { expect, test } from "bun:test"
import { pierrePatch } from "../src/renderer/react/diff-patch"
import { inspectionScenario } from "./renderer-fixtures"

test("Pierre receives loaded hunk counts and original line numbers", () => {
    let { page } = inspectionScenario()
    let partial = {
        ...page,
        nextOffset: 3,
        lines: [{ id: 0, kind: "hunk" as const, text: "@@ -42,10 +70,12 @@ function example", hunk: 0 }, {
            id: 1,
            kind: "deletion" as const,
            text: "old",
            oldLine: 42,
            hunk: 0,
        }, { id: 2, kind: "addition" as const, text: "new", newLine: 70, hunk: 0 }],
    }
    let diff = pierrePatch(partial)!

    expect(diff.hunks[0]).toMatchObject({ deletionStart: 42, additionStart: 70, deletionCount: 1, additionCount: 1 })

    let loaded = pierrePatch({
        ...partial,
        nextOffset: undefined,
        lines: [...partial.lines, { id: 3, kind: "addition", text: "more", newLine: 71, hunk: 0 }],
    })!

    expect(loaded.hunks[0]).toMatchObject({ deletionCount: 1, additionCount: 2 })
    expect(loaded.additionLines.join("")).toContain("more")
})

test("Pierre preserves missing newlines and treats filenames as data", () => {
    let { page } = inspectionScenario()
    page.file = { ...page.file, path: "src/<unsafe>\nname.ts", oldPath: "old.ts" }
    page.lines.push({ id: 3, kind: "notice", text: "\\ No newline at end of file", hunk: 0 })

    let diff = pierrePatch(page)!

    expect(diff.name).toBe(page.file.path)
    expect(diff.prevName).toBe("old.ts")
    expect(diff.additionLines.at(-1)?.endsWith("\n")).toBe(false)
})

test("Pierre supports a read-only content page without patch headers", () => {
    let { page } = inspectionScenario()
    let diff = pierrePatch({ ...page, selectable: false, lines: [{ id: 0, kind: "context", text: "current", newLine: 1, hunk: -1 }] })!
    expect(diff.additionLines.join("")).toBe("current\n")
})

test("A file renamed without changes has no lines for Pierre to draw", () => {
    let { page } = inspectionScenario()
    let renamed = { ...page, file: { ...page.file, oldPath: "old.ts" }, lines: [] }

    expect(pierrePatch(renamed)).toBeUndefined()
})
