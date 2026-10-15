import { describe, expect, test } from "bun:test"
import { fileName, fullPath } from "../src/renderer/src/inspection/file-paths"

describe("file paths", () => {
    test("joins repository-relative paths onto the worktree root with its own separator", () => {
        expect(fullPath("D:\\Source\\laneway", "src/app/main.ts")).toBe("D:\\Source\\laneway\\src\\app\\main.ts")
        expect(fullPath("D:\\Source\\laneway\\", "README.md")).toBe("D:\\Source\\laneway\\README.md")
        expect(fullPath("/home/user/laneway", "src/app/main.ts")).toBe("/home/user/laneway/src/app/main.ts")
        expect(fullPath("/home/user/laneway/", "README.md")).toBe("/home/user/laneway/README.md")
    })

    test("takes the file name from the last path segment", () => {
        expect(fileName("src/app/main.ts")).toBe("main.ts")
        expect(fileName("README.md")).toBe("README.md")
    })
})
