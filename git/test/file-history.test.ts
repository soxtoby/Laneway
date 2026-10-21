import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { startFileHistoryRead } from "../src/file-history"
import { openRepository } from "../src/index"

let roots: string[] = []
test("sparse file history batches metadata and stops at a bounded revision window without loading diffs", async () => {
    let root = await mkdtemp(resolve(tmpdir(), "laneway-history-sparse-"))
    roots.push(root)
    git(root, "init", "-q", "--initial-branch=main")
    git(root, "config", "log.showRoot", "false")
    let commits = Array.from(
        { length: 2205 },
        (_, index) =>
            `commit refs/heads/main\ncommitter History Test <history@example.test> ${1700000000 + index} +0000\ndata ${
                `commit ${index}`.length
            }\ncommit ${index}\n`
            + (index == 0 ? "M 100644 inline sparse[1].txt\ndata 5\nfile\n" : "")
            + "\n",
    ).join("")

    let imported = Bun.spawnSync(["git", "fast-import", "--quiet"], { cwd: root, stdin: Buffer.from(commits), stderr: "pipe" })
    expect(imported.exitCode).toBe(0)
    let api = await openRepository(root)

    let calls: string[][] = []
    let start = (cwd: string, args: string[]) => {
        calls.push(args)
        // A process per scanned commit is the regression, regardless of machine speed.
        if (calls.length > 6)
            throw new Error("History exceeded its metadata command budget")
        expect(args).not.toContain("--find-copies-harder")
        expect(args).not.toContain("--patch")
        let child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
        return {
            result: Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()])
                .then(([exitCode, stdout, stderr]) => ({ exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) })),
            cancel() {
                child.kill()
            },
        }
    }
    let request = { source: { kind: "commit" as const, objectId: git(root, "rev-parse", "HEAD") }, path: "sparse[1].txt" }
    let page = await startFileHistoryRead(api.descriptor, start, request).result

    expect(page.entries).toEqual([])
    expect(page.cursor).toBeDefined()

    calls.length = 0
    let next = await startFileHistoryRead(api.descriptor, start, { ...request, cursor: page.cursor }).result
    expect(next.entries).toEqual([])
    expect(next.cursor).toBeDefined()

    calls.length = 0
    let last = await startFileHistoryRead(api.descriptor, start, { ...request, cursor: next.cursor }).result
    expect(last.entries.map(entry => entry.subject)).toEqual(["commit 0"])
    expect(last.cursor).toBeUndefined()
})
test("copy ties require a validated choice; related evidence is ranked and Primary history is protected", async () => {
    let root = await mkdtemp(resolve(tmpdir(), "laneway-history-evidence-"))
    roots.push(root)
    git(root, "init", "-q", "--initial-branch=main")
    git(root, "config", "user.name", "History Test")
    git(root, "config", "user.email", "history@example.test")
    let content = "a substantial common line of code\nanother substantial common line\n"
    for (let path of ["a.txt", "b.txt"])
        await writeFile(resolve(root, path), content)
    git(root, "add", ".")
    git(root, "commit", "-qm", "primary")
    let primaryTip = git(root, "rev-parse", "HEAD")

    git(root, "checkout", "-qb", "feature")
    await writeFile(resolve(root, "copy.txt"), content)
    await writeFile(resolve(root, "similar.txt"), content + "additional content\n")
    await writeFile(resolve(root, "unrelated.txt"), "unrelated\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "copy")
    let tip = git(root, "rev-parse", "HEAD")

    let api = await openRepository(root)
    let source = { kind: "branch" as const, ref: "refs/heads/feature" }
    let request = { source, path: "copy.txt", composition: { tip, primaryTip } }
    let page = await api.startReadFileHistory(request).result

    expect(page.entries).toHaveLength(1)
    expect(page.entries[0].candidates).toEqual(["a.txt", "b.txt"])
    expect(page.entries[0].previousPath).toBeUndefined()
    expect(page.entries[0].composable).toBe(true)

    let chosen = await api.startReadFileHistory({ ...request, choices: [{ objectId: tip, path: "copy.txt", previousPath: "b.txt" }] }).result
    expect(chosen.entries[0].previousPath).toBe("b.txt")
    expect(chosen.entries[1].path).toBe("b.txt")
    expect(chosen.entries[1].composable).toBe(false)

    let stale = await api.startReadFileHistory({ ...request, choices: [{ objectId: tip, path: "copy.txt", previousPath: "missing.txt" }] }).result
    expect(stale.entries).toHaveLength(1)

    let related = await api.startReadFileHistory({ source, path: "copy.txt", related: { objectId: tip, path: "copy.txt" } }).result
    expect(related.related?.some(file => file.evidence == "rename/copy")).toBe(true)
    expect(related.related?.find(file => file.path == "similar.txt")?.evidence).toBe("shared lines")
    expect(related.related?.at(-1)?.path).toBe("unrelated.txt")

    let pending = api.startReadFileHistory(request)
    pending.cancel()
    await expect(pending.result).rejects.toThrow("cancelled")

    git(root, "checkout", "main")
    git(root, "merge", "--no-ff", "feature", "-m", "merge feature")
    let merged = await api.startReadFileHistory({ source: { kind: "branch", ref: "refs/heads/main" }, path: "copy.txt" }).result
    expect(merged.entries[0].parentIds).toEqual([primaryTip, tip])
    expect(merged.entries[0].followedParent).toBe(primaryTip)
}, 30_000)
afterEach(async () => {
    for (let root of roots.splice(0))
        await rm(root, { recursive: true, force: true })
})
for (let format of ["sha1", "sha256"]) {
    test(`file history follows renames, pages, fixes commit sources, and reads blame (${format})`, async () => {
        let root = await mkdtemp(resolve(tmpdir(), "laneway-history-"))
        roots.push(root)
        git(root, "init", "-q", "--initial-branch=main", `--object-format=${format}`)
        git(root, "config", "user.name", "History Test")
        git(root, "config", "user.email", "history@example.test")
        await writeFile(resolve(root, "before.txt"), "original\nunchanged\n")
        git(root, "add", ".")
        git(root, "commit", "-qm", "created")
        let first = git(root, "rev-parse", "HEAD")

        await rename(resolve(root, "before.txt"), resolve(root, "after.txt"))
        git(root, "add", ".")
        git(root, "commit", "-qm", "renamed", "-m", "Moved for clarity.\nNothing else changed.", "-m", "Second paragraph.")
        for (let index = 0; index < 41; index++) {
            await writeFile(resolve(root, "after.txt"), `version ${index}\nunchanged\n`)
            git(root, "commit", "-qam", `edit ${index}`)
        }

        let api = await openRepository(root)
        let source = { kind: "branch" as const, ref: "refs/heads/main" }
        let page = await api.startReadFileHistory({ source, path: "after.txt" }).result
        let small = await api.startReadFileHistory({ source, path: "after.txt", limit: 2 }).result
        expect(small.entries.map(entry => entry.subject)).toEqual(["edit 40", "edit 39"])
        expect(small.cursor?.objectId).toBe(page.entries[2].objectId)
        expect(page.entries).toHaveLength(40)
        expect(page.cursor).toBeDefined()

        let next = await api.startReadFileHistory({ source, path: "after.txt", cursor: page.cursor }).result
        expect(next.entries.map(entry => entry.subject)).toEqual(["edit 0", "renamed", "created"])
        expect(next.entries.map(entry => entry.body)).toEqual(["", "Moved for clarity.\nNothing else changed.\n\nSecond paragraph.", ""])
        expect(next.entries[1].previousPath).toBe("before.txt")
        expect(next.entries[2].path).toBe("before.txt")

        let blame = await api.startReadFileHistory({ source, path: "after.txt", blame: { objectId: page.tip!, path: "after.txt" } }).result
        expect(blame.blame?.[1].objectId).toBe(first)
        expect(blame.blame?.[1].path).toBe("before.txt")

        let fixed = await api.startReadFileHistory({ source: { kind: "commit", objectId: first }, path: "before.txt" }).result
        expect(fixed.entries.map(entry => entry.subject)).toEqual(["created"])

        git(root, "checkout", "--detach")
        git(root, "branch", "-D", "main")
        await expect(api.startReadFileHistory({ source, path: "after.txt" }).result).rejects.toThrow("unavailable")

        let worktree = await api.startReadFileHistory({ source: { kind: "worktree", worktreePath: root }, path: "after.txt" }).result
        expect(worktree.entries[0].objectId).toBe(page.tip!)
        await expect(api.startReadFileHistory({ source, path: "../escape" }).result).rejects.toThrow()
    }, 30_000)
}
function git(cwd: string, ...args: string[]) {
    let result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
}
