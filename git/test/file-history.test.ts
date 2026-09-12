import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { openRepository } from "../src/index"

const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true })
})
function git(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
}
for (const format of ["sha1", "sha256"]) {
    test(`file history follows renames, pages, fixes commit sources, and reads blame (${format})`, async () => {
        const root = await mkdtemp(resolve(tmpdir(), "workbench-history-"))
        roots.push(root)
        git(root, "init", "-q", "--initial-branch=main", `--object-format=${format}`)
        git(root, "config", "user.name", "History Test")
        git(root, "config", "user.email", "history@example.test")
        await writeFile(resolve(root, "before.txt"), "original\nunchanged\n")
        git(root, "add", ".")
        git(root, "commit", "-qm", "created")
        const first = git(root, "rev-parse", "HEAD")
        await rename(resolve(root, "before.txt"), resolve(root, "after.txt"))
        git(root, "add", ".")
        git(root, "commit", "-qm", "renamed")
        for (let index = 0; index < 41; index++) {
            await writeFile(resolve(root, "after.txt"), `version ${index}\nunchanged\n`)
            git(root, "commit", "-qam", `edit ${index}`)
        }
        const api = await openRepository(root)
        const source = { kind: "branch" as const, ref: "refs/heads/main" }
        const page = await api.startReadFileHistory({ source, path: "after.txt" }).result
        expect(page.entries).toHaveLength(40)
        expect(page.cursor).toBeDefined()
        const next = await api.startReadFileHistory({ source, path: "after.txt", cursor: page.cursor }).result
        expect(next.entries.map(entry => entry.subject)).toEqual(["edit 0", "renamed", "created"])
        expect(next.entries[1].previousPath).toBe("before.txt")
        expect(next.entries[2].path).toBe("before.txt")
        const blame = await api.startReadFileHistory({ source, path: "after.txt", blame: { objectId: page.tip!, path: "after.txt" } }).result
        expect(blame.blame?.[1].objectId).toBe(first)
        expect(blame.blame?.[1].path).toBe("before.txt")
        const fixed = await api.startReadFileHistory({ source: { kind: "commit", objectId: first }, path: "before.txt" }).result
        expect(fixed.entries.map(entry => entry.subject)).toEqual(["created"])
        git(root, "checkout", "--detach")
        git(root, "branch", "-D", "main")
        await expect(api.startReadFileHistory({ source, path: "after.txt" }).result).rejects.toThrow("unavailable")
        const worktree = await api.startReadFileHistory({ source: { kind: "worktree", worktreePath: root }, path: "after.txt" }).result
        expect(worktree.entries[0].objectId).toBe(page.tip!)
        await expect(api.startReadFileHistory({ source, path: "../escape" }).result).rejects.toThrow()
    }, 30_000)
}
