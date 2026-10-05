import { expect, test } from "bun:test"
import { selectedText } from "../src/composition-source"

test("literal line selections preserve CRLF, omit only chosen deletions, and honor final newlines", () => {
    let lines = [{ id: 0, kind: "hunk" as const, text: "@@ -1,2 +1,2 @@", hunk: 0 }, { id: 1, kind: "deletion" as const, text: "old\r", oldLine: 1, hunk: 0 }, {
        id: 2,
        kind: "addition" as const,
        text: "new\r",
        newLine: 1,
        hunk: 0,
    }, { id: 3, kind: "context" as const, text: "last", oldLine: 2, newLine: 2, hunk: 0 }]

    expect(selectedText("old\r\nlast", lines, [1])).toBe("last")
    expect(selectedText("old\r\nlast", lines, [2])).toBe("old\r\nnew\r\nlast")
    expect(selectedText("old\r\nlast", lines, [1, 2])).toBe("new\r\nlast")
    expect(
        selectedText("", [{ id: 0, kind: "hunk", text: "@@ -0,0 +1 @@", hunk: 0 }, { id: 1, kind: "addition", text: "only", hunk: 0 }, {
            id: 2,
            kind: "notice",
            text: "\\ No newline at end of file",
            hunk: 0,
        }], [1]),
    ).toBe("only")
    expect(() => selectedText("old", lines, [3])).toThrow()
})
