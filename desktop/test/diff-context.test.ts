import { openRepository } from "@laneway/git"
import type { FileDiffPage } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { contextDiff, readDiffContext } from "../src/renderer/react/diff-context"

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
