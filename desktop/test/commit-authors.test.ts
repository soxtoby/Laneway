import { describe, expect, test } from "bun:test"
import { authorInitials } from "../src/renderer/react/commit-authors"

describe("authorInitials", () => {
    test("a name of several words gives the initials of its first and last words", () => {
        expect(authorInitials("mary ann smith", "mary@example.test")).toBe("MS")
    })

    test("a one-word name gives its initial", () => {
        expect(authorInitials("priya", "priya@example.test")).toBe("P")
    })

    test("an empty name gives the initial of the email", () => {
        expect(authorInitials("", "sam@example.test")).toBe("S")
    })
})
