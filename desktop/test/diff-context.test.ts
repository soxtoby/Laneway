import { openRepository } from "@laneway/git"
import type { DiffLine, FileDiffPage } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { contextDiff, currentLine, readDiffContext } from "../src/renderer/react/diff-context"

let directories: string[] = []
afterEach(async () => {
    let temporaryRoot = await realpath(tmpdir())
    for (let directory of directories.splice(0)) {
        if (dirname(await realpath(directory)) != temporaryRoot)
            throw new Error(`Unexpected test directory: ${directory}`)
        await rm(directory, { recursive: true, force: true })
    }
})

test("context reads assemble complete paginated files and retain original hunk boundaries", async () => {
    let { api, page, original, current } = await scenario()
    let files = await readDiffContext(api, "fixture", page, new AbortController().signal)
    expect(files.oldFile.contents).toBe(original)
    expect(files.newFile.contents).toBe(current)
    let hydrated = contextDiff(page, files)!
    expect(hydrated.hunks).toHaveLength(2)
    expect(hydrated.hunks.map(hunk => hunk.additionStart)).toEqual([1107, 2107])
    expect(hydrated.additionLines[1109]).toBe("first change\n")

    let partial = { ...page, nextOffset: 3, lines: page.lines.slice(0, 3) }
    let bounded = contextDiff(partial, files)!
    expect(bounded.additionLines.join("")).not.toContain("second change")
    expect(bounded.additionLines).toHaveLength(1108)
})

test("context expansion rejects a source edit made during the full-file read", async () => {
    let { api, page, path } = await scenario()
    let read = api.readFileDiff
    api.readFileDiff = async (...args) => {
        let result = await read(...args)
        if (result.ok && args[2].entireFile && result.page.nextOffset == undefined)
            await writeFile(path, "a newer file\n")
        return result
    }
    await expect(readDiffContext(api, "fixture", page, new AbortController().signal)).rejects.toThrow("source changed")
})

test("an old side's line opens at the line of the file that stands there now", () => {
    // Old lines 4 to 9 with 5 replaced by two lines and 8 deleted, then old lines 20 to 22 with 21 deleted at the hunk's end.
    let lines: DiffLine[] = [
        { id: 0, kind: "hunk", text: "@@ -4,6 +4,6 @@", hunk: 0 },
        { id: 1, kind: "context", text: "four", oldLine: 4, newLine: 4, hunk: 0 },
        { id: 2, kind: "deletion", text: "five", oldLine: 5, hunk: 0 },
        { id: 3, kind: "addition", text: "FIVE", newLine: 5, hunk: 0 },
        { id: 4, kind: "addition", text: "and a half", newLine: 6, hunk: 0 },
        { id: 5, kind: "context", text: "six", oldLine: 6, newLine: 7, hunk: 0 },
        { id: 6, kind: "context", text: "seven", oldLine: 7, newLine: 8, hunk: 0 },
        { id: 7, kind: "deletion", text: "eight", oldLine: 8, hunk: 0 },
        { id: 8, kind: "context", text: "nine", oldLine: 9, newLine: 9, hunk: 0 },
        { id: 9, kind: "hunk", text: "@@ -20,2 +20,1 @@", hunk: 1 },
        { id: 10, kind: "context", text: "twenty", oldLine: 20, newLine: 20, hunk: 1 },
        { id: 11, kind: "deletion", text: "twenty-one", oldLine: 21, hunk: 1 },
    ]

    // Unchanged lines keep their place; a deleted one opens at what replaced or followed it.
    expect([4, 6, 7, 9].map(line => currentLine(lines, line))).toEqual([4, 7, 8, 9])
    expect([5, 8, 21].map(line => currentLine(lines, line))).toEqual([5, 9, 21])
    // Lines outside the hunks, shown from the whole file, move by what the changes above them added and took away.
    expect([2, 15, 30].map(line => currentLine(lines, line))).toEqual([2, 15, 29])
})

test("a deleted line of a replaced block opens at the added line a split diff draws beside it", () => {
    // Old lines 2 to 4 replaced by one line, 6 by three, and 8 and 9 by two, the last past a missing final newline's notice.
    let lines: DiffLine[] = [
        { id: 0, kind: "hunk", text: "@@ -1,9 +1,9 @@", hunk: 0 },
        { id: 1, kind: "context", text: "a", oldLine: 1, newLine: 1, hunk: 0 },
        { id: 2, kind: "deletion", text: "b1", oldLine: 2, hunk: 0 },
        { id: 3, kind: "deletion", text: "b2", oldLine: 3, hunk: 0 },
        { id: 4, kind: "deletion", text: "b3", oldLine: 4, hunk: 0 },
        { id: 5, kind: "addition", text: "B", newLine: 2, hunk: 0 },
        { id: 6, kind: "context", text: "c", oldLine: 5, newLine: 3, hunk: 0 },
        { id: 7, kind: "deletion", text: "d", oldLine: 6, hunk: 0 },
        { id: 8, kind: "addition", text: "D1", newLine: 4, hunk: 0 },
        { id: 9, kind: "addition", text: "D2", newLine: 5, hunk: 0 },
        { id: 10, kind: "addition", text: "D3", newLine: 6, hunk: 0 },
        { id: 11, kind: "context", text: "e", oldLine: 7, newLine: 7, hunk: 0 },
        { id: 12, kind: "deletion", text: "f1", oldLine: 8, hunk: 0 },
        { id: 13, kind: "deletion", text: "f2", oldLine: 9, hunk: 0 },
        { id: 14, kind: "notice", text: "\\ No newline at end of file", hunk: 0 },
        { id: 15, kind: "addition", text: "F1", newLine: 8, hunk: 0 },
        { id: 16, kind: "addition", text: "F2", newLine: 9, hunk: 0 },
    ]

    // Where fewer lines were added than deleted, the rest of the deleted ones open at the last added.
    expect([2, 3, 4].map(line => currentLine(lines, line))).toEqual([2, 2, 2])
    expect([6, 8, 9].map(line => currentLine(lines, line))).toEqual([4, 8, 9])
})

async function scenario() {
    let root = await mkdtemp(join(await realpath(tmpdir()), "laneway-diff-context-"))
    directories.push(root)
    let git = (...args: string[]) => {
        let result = Bun.spawnSync(["git", ...args], { cwd: root })
        if (result.exitCode != 0)
            throw new Error(result.stderr.toString())
    }
    git("init", "-q")
    git("config", "core.autocrlf", "false")
    let path = join(root, "file.txt")
    let original = Array.from({ length: 2300 }, (_, index) => `line ${index + 1}`).join("\n")
    await writeFile(path, original)
    git("add", ".")
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "original")
    let current = original.replace("line 1110\n", "first change\n").replace("line 2110\n", "second change\n")
    await writeFile(path, current)
    let repository = await openRepository(root)
    let page: FileDiffPage = await repository.startReadFileDiff({ source: { kind: "working", worktreePath: root }, path: "file.txt" }).result
    let reads = new Map<string, ReturnType<typeof repository.startReadFileDiff>>()
    let api: Pick<Window["laneway"], "readFileDiff" | "cancelInspection"> = {
        readFileDiff: async (_repositoryId, requestId, request) => {
            let read = repository.startReadFileDiff(request)
            reads.set(requestId, read)
            try {
                return { ok: true, page: await read.result }
            } catch (error) {
                return { ok: false, error: { code: "git.command-failed", message: error instanceof Error ? error.message : String(error) } }
            } finally {
                reads.delete(requestId)
            }
        },
        cancelInspection: async (_repositoryId, requestId) => {
            reads.get(requestId)?.cancel()
            return true
        },
    }

    return { api, page, path, original, current }
}
