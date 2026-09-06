import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
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
        throw new Error(`${args.join(" ")}: ${result.stderr}`)
    return result.stdout.toString().trim()
}
async function repository(format = "sha1", commit = true) {
    const path = await mkdtemp(resolve(tmpdir(), "workbench-diff-"))
    roots.push(path)
    git(path, "init", "-q", "--initial-branch=main", `--object-format=${format}`)
    git(path, "config", "user.name", "Diff Test")
    git(path, "config", "user.email", "diff@example.invalid")
    git(path, "config", "core.autocrlf", "false")
    await writeFile(resolve(path, "file.txt"), "old heading\nunchanged\nold footer\n")
    if (commit) {
        git(path, "add", ".")
        git(path, "commit", "-qm", "initial")
    }
    const api = await openRepository(path)
    return { path, api, source: { kind: "working" as const, worktreePath: path } }
}
const changed = (lines: { kind: string; text: string }[]) =>
    lines.filter(line => ["addition", "deletion"].includes(line.kind)).map(line => [line.kind, line.text])

describe("Working Changes and committed diff reads", () => {
    test("summarizes dirty submodules without changing their index", async () => {
        const { path, api, source } = await repository()
        const child = await repository()
        git(path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child.path, "module")
        git(path, "commit", "-qm", "add submodule")
        await writeFile(resolve(path, "module/file.txt"), "dirty child\n")
        const index = await readFile(resolve(path, ".git/modules/module/index"))
        const inventory = await api.startReadChanges({ source }).result
        expect(inventory.files.find(file => file.path == "module")?.submodule).toBe("S.M.")
        const page = await api.startReadFileDiff({ source, path: "module" }).result
        expect(page.selectable).toBe(false)
        expect(page.summary.some(text => text.startsWith("Submodule"))).toBe(true)
        expect(await readFile(resolve(path, ".git/modules/module/index"))).toEqual(index)
    })

    test("bounds enormous lines and refuses lossy line selections", async () => {
        const { path, api, source } = await repository()
        await writeFile(resolve(path, "long.txt"), "x".repeat(100000))
        const long = await api.startReadFileDiff({ source, path: "long.txt" }).result
        expect(long.selectable).toBe(false)
        expect(long.lines.every(line => line.text.length < 16500)).toBe(true)
        await writeFile(resolve(path, "encoding.txt"), Buffer.from([0x61, 0xff, 0x0a]))
        const encoded = await api.startReadFileDiff({ source, path: "encoding.txt" }).result
        expect(encoded.selectable).toBe(false)
        expect(encoded.summary).toContain("Content is not UTF-8. Line selection is unavailable.")
    })

    test("uses committed attributes and keeps filtered content read-only", async () => {
        const { path, api, source } = await repository()
        await writeFile(resolve(path, ".gitattributes"), "file.txt diff=custom\n")
        await writeFile(resolve(path, "file.txt"), "committed custom\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "custom representation")
        const commit = git(path, "rev-parse", "HEAD")
        await writeFile(resolve(path, ".gitattributes"), "file.txt filter=identity\n")
        git(path, "config", "filter.identity.clean", "cat")
        await writeFile(resolve(path, "file.txt"), "filtered content\n")
        const filtered = await api.startReadFileDiff({ source, path: "file.txt" }).result
        expect(filtered.selectable).toBe(false)
        expect(changed(filtered.lines)).toContainEqual(["addition", "filtered content"])
        const committed = await api.startReadFileDiff({ source: { kind: "commit", objectId: commit }, path: "file.txt" }).result
        expect(committed.lines).toHaveLength(0)
        expect(committed.selectable).toBe(false)
    })

    test("unborn staged additions removed from the worktree have no combined content", async () => {
        const { path, api, source } = await repository("sha1", false)
        git(path, "add", ".")
        await rm(resolve(path, "file.txt"))
        const page = await api.startReadFileDiff({ source, path: "file.txt" }).result
        expect(page.lines).toHaveLength(0)
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "staged" }).result).lines.length).toBeGreaterThan(0)
    })

    for (const format of ["sha1", "sha256"]) {
        test(`${format}: preserves staged intent and index bytes while inspecting combined changes`, async () => {
            const { path, api, source } = await repository(format)
            await writeFile(resolve(path, "file.txt"), "new heading\nunchanged\nold footer\n")
            git(path, "add", "file.txt")
            await writeFile(resolve(path, "file.txt"), "new heading\nunchanged\nnew footer\n")
            await writeFile(resolve(path, ".gitignore"), "ignored.txt\n")
            await writeFile(resolve(path, "ignored.txt"), "ignored")
            await writeFile(resolve(path, "untracked.txt"), "new\r\nno newline")
            const index = await readFile(resolve(path, ".git/index"))
            const refs = git(path, "show-ref")
            const config = await readFile(resolve(path, ".git/config"))
            const inventory = await api.startReadChanges({ source, includeIgnored: true }).result
            expect(inventory.files.find(file => file.path == "file.txt")).toMatchObject({ staged: true, unstaged: true })
            expect(inventory.files.find(file => file.path == "ignored.txt")?.ignored).toBe(true)
            const combined = await api.startReadFileDiff({ source, path: "file.txt" }).result
            const staged = await api.startReadFileDiff({ source, path: "file.txt", view: "staged" }).result
            const unstaged = await api.startReadFileDiff({ source, path: "file.txt", view: "unstaged" }).result
            expect(changed(combined.lines)).toEqual([["deletion", "old heading"], ["addition", "new heading"], ["deletion", "old footer"], [
                "addition",
                "new footer",
            ]])
            expect(changed(staged.lines)).toHaveLength(2)
            expect(changed(unstaged.lines)).toEqual([["deletion", "old footer"], ["addition", "new footer"]])
            expect(staged.selectable).toBe(false)
            const untracked = await api.startReadFileDiff({ source, path: "untracked.txt" }).result
            expect(untracked.lines.some(line => line.text == "new\r")).toBe(true)
            expect(untracked.lines.some(line => line.kind == "notice")).toBe(true)
            expect(await readFile(resolve(path, ".git/index"))).toEqual(index)
            expect(await readFile(resolve(path, ".git/config"))).toEqual(config)
            expect(git(path, "show-ref")).toBe(refs)
        })
    }

    test("keeps index-only differences visible when the worktree matches HEAD", async () => {
        const { path, api, source } = await repository()
        const initial = await readFile(resolve(path, "file.txt"))
        await writeFile(resolve(path, "file.txt"), "staged\n")
        git(path, "add", ".")
        await writeFile(resolve(path, "file.txt"), initial)
        const index = await readFile(resolve(path, ".git/index"))
        expect((await api.startReadChanges({ source }).result).files).toHaveLength(1)
        expect((await api.startReadFileDiff({ source, path: "file.txt" }).result).lines).toHaveLength(0)
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "staged" }).result).lines.length).toBeGreaterThan(0)
        expect(await readFile(resolve(path, ".git/index"))).toEqual(index)
    })

    test("reads renames, executable bits, symlinks, binary files, and unusual paths", async () => {
        const { path, api, source } = await repository()
        await rename(resolve(path, "file.txt"), resolve(path, "name with spaces.txt"))
        await writeFile(resolve(path, "binary.dat"), Buffer.from([0, 1, 2, 3]))
        git(path, "add", "-A")
        git(path, "update-index", "--chmod=+x", "name with spaces.txt")
        const blob = git(path, "hash-object", "-w", "name with spaces.txt")
        git(path, "update-index", "--add", "--cacheinfo", `120000,${blob},link`)
        git(path, "commit", "-qm", "rename and metadata")
        const commit = { kind: "commit" as const, objectId: git(path, "rev-parse", "HEAD") }
        const inventory = await api.startReadChanges({ source: commit }).result
        expect(inventory.files.find(file => file.oldPath == "file.txt")).toMatchObject({ path: "name with spaces.txt", newMode: "100755" })
        expect(inventory.files.find(file => file.path == "link")?.newMode).toBe("120000")
        const executable = await api.startReadFileDiff({ source: commit, path: "name with spaces.txt" }).result
        expect(executable.summary).toContain("Executable")
        expect(executable.summary.join(" ")).not.toMatch(/100644|100755|old mode|new mode/)
        const link = await api.startReadFileDiff({ source: commit, path: "link" }).result
        expect(link.summary).toContain("Symlink added")
        expect(link.summary.join(" ")).not.toContain("120000")
        const binary = await api.startReadFileDiff({ source: commit, path: "binary.dat" }).result
        expect(binary.summary).toContain("Binary content changed.")
        expect(binary.selectable).toBe(false)
        expect((await api.startReadFileDiff({ source: commit, path: "link" }).result).lines.length).toBeGreaterThan(0)
        await expect(api.startReadFileDiff({ source, path: "../outside" }).result).rejects.toThrow("Invalid repository file path")
    })

    test("pins committed inputs and supports root commits and explicit merge parents", async () => {
        const { path, api } = await repository()
        const root = git(path, "rev-parse", "HEAD")
        expect((await api.startReadChanges({ source: { kind: "commit", objectId: root } }).result).parents).toEqual([])
        expect(
            (await api.startReadFileDiff({ source: { kind: "commit", objectId: root }, path: "file.txt" }).result).lines.filter(line =>
                line.kind == "addition"
            ),
        ).toHaveLength(3)
        git(path, "checkout", "-qb", "other")
        await writeFile(resolve(path, "other.txt"), "other\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "other")
        const other = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-q", "main")
        await writeFile(resolve(path, "main.txt"), "main\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "main")
        git(path, "merge", "--no-ff", "-m", "merge", "other")
        const objectId = git(path, "rev-parse", "HEAD")
        const first = await api.startReadChanges({ source: { kind: "commit", objectId } }).result
        const second = await api.startReadChanges({ source: { kind: "commit", objectId, parentId: other } }).result
        expect(first.files.map(file => file.path)).toEqual(["other.txt"])
        expect(second.files.map(file => file.path)).toEqual(["main.txt"])
        await expect(api.startReadChanges({ source: { kind: "commit", objectId, parentId: root } }).result).rejects.toThrow("not a parent")
    })

    test("reads conflict versions without resolving the index", async () => {
        const { path, api, source } = await repository()
        git(path, "checkout", "-qb", "other")
        await writeFile(resolve(path, "file.txt"), "theirs\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "theirs")
        git(path, "checkout", "-q", "main")
        await writeFile(resolve(path, "file.txt"), "ours\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "ours")
        expect(Bun.spawnSync(["git", "merge", "other"], { cwd: path }).exitCode).toBe(1)
        const before = await readFile(resolve(path, ".git/index"))
        expect((await api.startReadChanges({ source }).result).files[0].conflicted).toBe(true)
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "ours" }).result).lines[0].text).toBe("ours")
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "theirs" }).result).lines[0].text).toBe("theirs")
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "base" }).result).lines[0].text).toBe("old heading")
        expect(await readFile(resolve(path, ".git/index"))).toEqual(before)
    })

    test("pages patches with stable coordinates and rejects stale continuation", async () => {
        const { path, api, source } = await repository()
        await writeFile(resolve(path, "large.txt"), Array.from({ length: 2400 }, (_, index) => `line ${index}\n`).join(""))
        const first = await api.startReadFileDiff({ source, path: "large.txt" }).result
        expect(first.lines).toHaveLength(2000)
        expect(first.nextOffset).toBe(2000)
        const next = await api.startReadFileDiff({ source, path: "large.txt", offset: first.nextOffset, expectedVersion: first.version }).result
        expect(next.lines[0].id).toBe(2000)
        expect(next.version).toBe(first.version)
        await writeFile(resolve(path, "large.txt"), "changed\n")
        await expect(api.startReadFileDiff({ source, path: "large.txt", offset: first.nextOffset, expectedVersion: first.version }).result).rejects.toThrow(
            "source changed",
        )
    })

    test("does not execute custom diff/textconv programs and honours line normalization", async () => {
        const { path, api, source } = await repository()
        await writeFile(resolve(path, ".gitattributes"), "file.txt text eol=lf\ncustom.dat diff=custom\n")
        await writeFile(resolve(path, "custom.dat"), "before\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "attributes")
        git(path, "config", "diff.custom.textconv", "must-not-run")
        git(path, "config", "diff.external", "must-not-run")
        await writeFile(resolve(path, "file.txt"), "new heading\r\nunchanged\r\nold footer\r\n")
        await writeFile(resolve(path, "custom.dat"), "after\n")
        const custom = await api.startReadFileDiff({ source, path: "custom.dat" }).result
        expect(custom.selectable).toBe(false)
        expect(custom.summary.join(" ")).toContain("disabled")
        const normal = await api.startReadFileDiff({ source, path: "file.txt" }).result
        expect(changed(normal.lines)).toEqual([["deletion", "old heading"], ["addition", "new heading"]])
    })

    test("inspects unborn HEAD and exact linked worktrees and cancels immediately", async () => {
        const { path, api, source } = await repository("sha1", false)
        git(path, "add", ".")
        await writeFile(resolve(path, "file.txt"), "latest\n")
        expect(changed((await api.startReadFileDiff({ source, path: "file.txt" }).result).lines)).toEqual([["addition", "latest"]])
        git(path, "add", ".")
        git(path, "commit", "-qm", "first")
        const linked = resolve(path, "linked")
        git(path, "worktree", "add", "--detach", linked)
        await writeFile(resolve(linked, "file.txt"), "linked only\n")
        const linkedDiff = await api.startReadFileDiff({ source: { kind: "working", worktreePath: linked }, path: "file.txt" }).result
        expect(changed(linkedDiff.lines)).toContainEqual(["addition", "linked only"])
        const read = api.startReadChanges({ source })
        read.cancel()
        await expect(read.result).rejects.toMatchObject({ code: "git.cancelled" })
    })
})
