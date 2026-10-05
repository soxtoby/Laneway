import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { startChangesRead, startFileDiffRead } from "../src/changes"
import { openRepository } from "../src/index"

let roots: string[] = []
afterEach(async () => {
    for (let root of roots.splice(0))
        await rm(root, { recursive: true, force: true })
})
let changed = (lines: { kind: string; text: string }[]) =>
    lines.filter(line => ["addition", "deletion"].includes(line.kind)).map(line => [line.kind, line.text])

describe("branch tip comparisons", () => {
    for (let format of ["sha1", "sha256"]) {
        test(`compares ordered diverged tips and freezes each read, ${format}`, async () => {
            let { path, api } = await repository(format)
            git(path, "checkout", "-qb", "feature")
            await writeFile(resolve(path, "file.txt"), "feature\n")
            git(path, "commit", "-qam", "feature change")
            git(path, "checkout", "main")
            await writeFile(resolve(path, "file.txt"), "main\n")
            git(path, "commit", "-qam", "main change")

            let source = { kind: "branches" as const, fromRef: "refs/heads/main", toRef: "refs/heads/feature" }
            let inventory = await api.startReadChanges({ source }).result
            expect(inventory.source.kind).toBe("comparison")
            let page = await api.startReadFileDiff({ source: inventory.source, inventoryVersion: inventory.version, path: "file.txt" }).result
            expect(changed(page.lines)).toEqual([["deletion", "main"], ["addition", "feature"]])
            expect(page.selectable).toBe(false)

            let reversed = await api.startReadFileDiff({ source: { ...source, fromRef: source.toRef, toRef: source.fromRef }, path: "file.txt" }).result
            expect(changed(reversed.lines)).toEqual([["deletion", "feature"], ["addition", "main"]])

            await writeFile(resolve(path, "file.txt"), "new main\n")
            git(path, "commit", "-qam", "advance")
            let frozen = await api.startReadFileDiff({ source: inventory.source, path: "file.txt" }).result
            expect(changed(frozen.lines)).toEqual(changed(page.lines))

            let fresh = await api.startReadFileDiff({ source, path: "file.txt" }).result
            expect(changed(fresh.lines)[0]).toEqual(["deletion", "new main"])

            git(path, "branch", "-D", "feature")
            await expect(api.startReadChanges({ source }).result).rejects.toThrow("unavailable")
        })
    }

    test("pages file inventory, preserves rename and binary evidence, and ignores Working Changes", async () => {
        let { path, api } = await repository()
        git(path, "branch", "before")
        await rename(resolve(path, "file.txt"), resolve(path, "renamed.txt"))
        await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(resolve(path, `item-${index}.txt`), "added\n")))
        await writeFile(resolve(path, "binary.bin"), Buffer.from([0, 1, 2]))
        git(path, "add", ".")
        git(path, "commit", "-qm", "many files")
        await writeFile(resolve(path, "untracked.txt"), "working only\n")
        let status = git(path, "status", "--porcelain=v2")

        let source = { kind: "branches" as const, fromRef: "refs/heads/before", toRef: "refs/heads/main" }
        let first = await api.startReadChanges({ source }).result
        expect(first.files).toHaveLength(200)
        expect(first.nextOffset).toBe(200)

        let second = await api.startReadChanges({ source: first.source, offset: first.nextOffset }).result
        expect(second.files).toHaveLength(3)
        expect(second.nextOffset).toBeUndefined()
        expect(second.files.find(file => file.path == "renamed.txt")?.oldPath).toBe("file.txt")

        let binary = await api.startReadFileDiff({ source: first.source, path: "binary.bin" }).result
        expect(binary.summary).toContain("Binary content changed.")
        expect(git(path, "status", "--porcelain=v2")).toBe(status)

        let empty = await api.startReadChanges({ source: { ...source, fromRef: source.toRef } }).result
        expect(empty.files).toEqual([])
        await expect(api.startReadChanges({ source: { ...source, fromRef: "refs/heads/main~1" } }).result).rejects.toThrow()
    })
})

describe("Working Changes and committed diff reads", () => {
    test("entire-file context includes both ends and remains paged and version checked", async () => {
        let { path, api, source } = await repository()
        let lines = Array.from({ length: 2100 }, (_, index) => `line ${index + 1}\n`)
        await writeFile(resolve(path, "file.txt"), lines.join(""))
        git(path, "add", ".")
        git(path, "commit", "-qm", "long file")
        lines[1050] = "changed\n"
        await writeFile(resolve(path, "file.txt"), lines.join(""))
        let compact = await api.startReadFileDiff({ source, path: "file.txt" }).result

        expect(compact.lines.some(line => line.text == "line 1")).toBe(false)

        let first = await api.startReadFileDiff({ source, path: "file.txt", entireFile: true }).result
        expect(first.entireFile).toBe(true)
        expect(first.lines).toHaveLength(2000)
        expect(first.lines[1]).toMatchObject({ text: "line 1", kind: "context", oldLine: 1, newLine: 1 })
        expect(changed(first.lines)).toEqual(changed(compact.lines))

        let last = await api.startReadFileDiff({ source, path: "file.txt", entireFile: true, offset: first.nextOffset, expectedVersion: first.version })
            .result
        expect(last.lines.at(-1)).toMatchObject({ text: "line 2100", oldLine: 2100, newLine: 2100 })
        expect(last.nextOffset).toBeUndefined()
        await expect(api.startReadFileDiff({ source, path: "file.txt", expectedVersion: first.version }).result).rejects.toThrow()

        git(path, "add", ".")
        git(path, "commit", "-qm", "change middle")
        let committed = await api.startReadFileDiff({
            source: { kind: "commit", objectId: git(path, "rev-parse", "HEAD") },
            path: "file.txt",
            entireFile: true,
        }).result
        expect(committed.lines).toEqual(first.lines)
    })

    test("validates source edits even when Git normalizes them to the same displayed patch", async () => {
        let { path, api, source } = await repository()
        await writeFile(resolve(path, ".gitattributes"), "file.txt text eol=lf\n")
        git(path, "add", ".gitattributes")
        git(path, "commit", "-qm", "normalize line endings")
        await writeFile(resolve(path, "file.txt"), "working\n")
        let inventory = await api.startReadChanges({ source }).result
        let request = { source, path: "file.txt", inventoryVersion: inventory.version }
        let preview = await api.startReadFileDiff(request).result

        await writeFile(resolve(path, "file.txt"), "working\r\n")
        let current = await api.startReadFileDiff({ source, path: "file.txt" }).result
        expect(changed(current.lines)).toEqual(changed(preview.lines))
        await expect(api.startReadFileDiff({ ...request, expectedVersion: preview.version }).result).rejects.toThrow("source changed")
    })

    test("expands snapshots with one Git read and validates freshness only when requested", async () => {
        let { path, api, source } = await repository()
        await writeFile(resolve(path, "file.txt"), "working\n")
        let commands: string[][] = []
        let editDuringRead = false
        let start: Parameters<typeof startFileDiffRead>[1] = (cwd, args, onOutput, input) => {
            commands.push(args)
            let child = Bun.spawn([api.descriptor.git.path, "-c", "diff.autoRefreshIndex=false", ...args], {
                cwd,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_NO_LAZY_FETCH: "1" },
                stdout: "pipe",
                stderr: "pipe",
                stdin: "pipe",
            })
            if (input != undefined)
                child.stdin.write(input)
            child.stdin.end()
            let cancelled = false
            let result = Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()])
                .then(async ([exitCode, stdout, stderr]) => {
                    onOutput?.(Buffer.from(stdout))
                    if (editDuringRead && args[0] == "diff")
                        await writeFile(resolve(path, "file.txt"), "changed during read\n")
                    return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) }
                })
            return {
                result,
                cancel() {
                    cancelled = true
                    child.kill()
                },
                wasCancelled: () => cancelled,
            }
        }
        let cache = new Map()

        let inventory = await startChangesRead(api.descriptor, start, { source }, cache).result
        commands.length = 0
        let request = { source, path: "file.txt", inventoryVersion: inventory.version }
        let page = await startFileDiffRead(api.descriptor, start, request, cache).result
        expect(changed(page.lines)).toContainEqual(["addition", "working"])
        expect(commands.map(args => args[0])).toEqual(["diff"])

        let validated = await startFileDiffRead(api.descriptor, start, { ...request, expectedVersion: page.version }, cache).result
        expect(validated.version).toBe(page.version)

        editDuringRead = true
        await expect(startFileDiffRead(api.descriptor, start, { ...request, expectedVersion: page.version }, cache).result).rejects.toThrow("source changed")
        editDuringRead = false
        await expect(startFileDiffRead(api.descriptor, start, { ...request, expectedVersion: page.version }, cache).result).rejects.toThrow("source changed")
        let commit = { kind: "commit" as const, objectId: git(path, "rev-parse", "HEAD") }

        let committed = await startChangesRead(api.descriptor, start, { source: commit }, cache).result
        commands.length = 0
        await startFileDiffRead(api.descriptor, start, { source: committed.source, path: "file.txt", inventoryVersion: committed.version }, cache).result
        expect(commands.map(args => args[0])).toEqual(["diff-tree"])
    })

    test("summarizes dirty submodules without changing their index", async () => {
        let { path, api, source } = await repository()
        let child = await repository()
        git(path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child.path, "module")
        git(path, "commit", "-qm", "add submodule")
        await writeFile(resolve(path, "module/file.txt"), "dirty child\n")
        let index = await readFile(resolve(path, ".git/modules/module/index"))
        let inventory = await api.startReadChanges({ source }).result
        expect(inventory.files.find(file => file.path == "module")?.submodule).toBe("S.M.")

        let page = await api.startReadFileDiff({ source, path: "module" }).result
        expect(page.selectable).toBe(false)
        expect(page.summary.some(text => text.startsWith("Submodule"))).toBe(true)
        expect(await readFile(resolve(path, ".git/modules/module/index"))).toEqual(index)
    })

    test("bounds enormous lines and refuses lossy line selections", async () => {
        let { path, api, source } = await repository()
        await writeFile(resolve(path, "long.txt"), "x".repeat(100000))
        let long = await api.startReadFileDiff({ source, path: "long.txt" }).result
        expect(long.selectable).toBe(false)
        expect(long.lines.every(line => line.text.length < 16500)).toBe(true)

        await writeFile(resolve(path, "encoding.txt"), Buffer.from([0x61, 0xff, 0x0a]))
        let encoded = await api.startReadFileDiff({ source, path: "encoding.txt" }).result
        expect(encoded.selectable).toBe(false)
        expect(encoded.summary).toContain("Content is not UTF-8. Line selection is unavailable.")
    })

    test("uses committed attributes and keeps filtered content read-only", async () => {
        let { path, api, source } = await repository()
        await writeFile(resolve(path, ".gitattributes"), "file.txt diff=custom\n")
        await writeFile(resolve(path, "file.txt"), "committed custom\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "custom representation")
        let commit = git(path, "rev-parse", "HEAD")
        await writeFile(resolve(path, ".gitattributes"), "file.txt filter=identity\n")
        git(path, "config", "filter.identity.clean", "cat")
        await writeFile(resolve(path, "file.txt"), "filtered content\n")
        let filtered = await api.startReadFileDiff({ source, path: "file.txt" }).result
        expect(filtered.selectable).toBe(false)
        expect(changed(filtered.lines)).toContainEqual(["addition", "filtered content"])

        let committed = await api.startReadFileDiff({ source: { kind: "commit", objectId: commit }, path: "file.txt" }).result
        expect(committed.lines).toHaveLength(0)
        expect(committed.selectable).toBe(false)
    })

    test("unborn staged additions removed from the worktree have no combined content", async () => {
        let { path, api, source } = await repository("sha1", false)
        git(path, "add", ".")
        await rm(resolve(path, "file.txt"))
        let page = await api.startReadFileDiff({ source, path: "file.txt" }).result
        expect(page.lines).toHaveLength(0)
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "staged" }).result).lines.length).toBeGreaterThan(0)
    })

    for (let format of ["sha1", "sha256"]) {
        test(`${format}: preserves staged intent and index bytes while inspecting combined changes`, async () => {
            let { path, api, source } = await repository(format)
            await writeFile(resolve(path, "file.txt"), "new heading\nunchanged\nold footer\n")
            git(path, "add", "file.txt")
            await writeFile(resolve(path, "file.txt"), "new heading\nunchanged\nnew footer\n")
            await writeFile(resolve(path, ".gitignore"), "ignored.txt\n")
            await writeFile(resolve(path, "ignored.txt"), "ignored")
            await writeFile(resolve(path, "untracked.txt"), "new\r\nno newline")
            let index = await readFile(resolve(path, ".git/index"))
            let refs = git(path, "show-ref")
            let config = await readFile(resolve(path, ".git/config"))
            let inventory = await api.startReadChanges({ source, includeIgnored: true }).result
            expect(inventory.files.find(file => file.path == "file.txt")).toMatchObject({ staged: true, unstaged: true })
            expect(inventory.files.find(file => file.path == "ignored.txt")?.ignored).toBe(true)
            let combined = await api.startReadFileDiff({ source, path: "file.txt" }).result
            let staged = await api.startReadFileDiff({ source, path: "file.txt", view: "staged" }).result
            let unstaged = await api.startReadFileDiff({ source, path: "file.txt", view: "unstaged" }).result
            expect(changed(combined.lines)).toEqual([["deletion", "old heading"], ["addition", "new heading"], ["deletion", "old footer"], [
                "addition",
                "new footer",
            ]])
            expect(changed(staged.lines)).toHaveLength(2)
            expect(changed(unstaged.lines)).toEqual([["deletion", "old footer"], ["addition", "new footer"]])
            expect(staged.selectable).toBe(true)
            let untracked = await api.startReadFileDiff({ source, path: "untracked.txt" }).result
            expect(untracked.lines.some(line => line.text == "new\r")).toBe(true)
            expect(untracked.lines.some(line => line.kind == "notice")).toBe(true)
            expect(await readFile(resolve(path, ".git/index"))).toEqual(index)
            expect(await readFile(resolve(path, ".git/config"))).toEqual(config)
            expect(git(path, "show-ref")).toBe(refs)
        })
    }

    test("keeps index-only differences visible when the worktree matches HEAD", async () => {
        let { path, api, source } = await repository()
        let initial = await readFile(resolve(path, "file.txt"))
        await writeFile(resolve(path, "file.txt"), "staged\n")
        git(path, "add", ".")
        await writeFile(resolve(path, "file.txt"), initial)
        let index = await readFile(resolve(path, ".git/index"))
        expect((await api.startReadChanges({ source }).result).files).toHaveLength(1)
        expect((await api.startReadFileDiff({ source, path: "file.txt" }).result).lines).toHaveLength(0)
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "staged" }).result).lines.length).toBeGreaterThan(0)
        expect(await readFile(resolve(path, ".git/index"))).toEqual(index)
    })

    test("reads renames, executable bits, symlinks, binary files, and unusual paths", async () => {
        let { path, api, source } = await repository()
        await rename(resolve(path, "file.txt"), resolve(path, "name with spaces.txt"))
        await writeFile(resolve(path, "binary.dat"), Buffer.from([0, 1, 2, 3]))
        git(path, "add", "-A")
        git(path, "update-index", "--chmod=+x", "name with spaces.txt")
        let blob = git(path, "hash-object", "-w", "name with spaces.txt")
        git(path, "update-index", "--add", "--cacheinfo", `120000,${blob},link`)
        git(path, "commit", "-qm", "rename and metadata")
        let commit = { kind: "commit" as const, objectId: git(path, "rev-parse", "HEAD") }
        let inventory = await api.startReadChanges({ source: commit }).result
        expect(inventory.files.find(file => file.oldPath == "file.txt")).toMatchObject({ path: "name with spaces.txt", newMode: "100755" })
        expect(inventory.files.find(file => file.path == "link")?.newMode).toBe("120000")
        let executable = await api.startReadFileDiff({ source: commit, path: "name with spaces.txt" }).result
        expect(executable.summary).toContain("Executable")
        expect(executable.summary.join(" ")).not.toMatch(/100644|100755|old mode|new mode/)
        let link = await api.startReadFileDiff({ source: commit, path: "link" }).result
        expect(link.summary).toContain("Symlink added")
        expect(link.summary.join(" ")).not.toContain("120000")
        let binary = await api.startReadFileDiff({ source: commit, path: "binary.dat" }).result
        expect(binary.summary).toContain("Binary content changed.")
        expect(binary.selectable).toBe(false)
        expect((await api.startReadFileDiff({ source: commit, path: "link" }).result).lines.length).toBeGreaterThan(0)
        await expect(api.startReadFileDiff({ source, path: "../outside" }).result).rejects.toThrow("Invalid repository file path")
    })

    test("pins committed inputs and supports root commits and explicit merge parents", async () => {
        let { path, api } = await repository()
        let root = git(path, "rev-parse", "HEAD")
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
        let other = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-q", "main")
        await writeFile(resolve(path, "main.txt"), "main\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "main")
        git(path, "merge", "--no-ff", "-m", "merge", "other")
        let objectId = git(path, "rev-parse", "HEAD")
        let first = await api.startReadChanges({ source: { kind: "commit", objectId } }).result
        let second = await api.startReadChanges({ source: { kind: "commit", objectId, parentId: other } }).result
        expect(first.files.map(file => file.path)).toEqual(["other.txt"])
        expect(second.files.map(file => file.path)).toEqual(["main.txt"])
        await expect(api.startReadChanges({ source: { kind: "commit", objectId, parentId: root } }).result).rejects.toThrow("not a parent")
    })

    test("reads conflict versions without resolving the index", async () => {
        let { path, api, source } = await repository()
        git(path, "checkout", "-qb", "other")
        await writeFile(resolve(path, "file.txt"), "theirs\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "theirs")
        git(path, "checkout", "-q", "main")
        await writeFile(resolve(path, "file.txt"), "ours\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "ours")
        expect(Bun.spawnSync(["git", "merge", "other"], { cwd: path }).exitCode).toBe(1)
        let before = await readFile(resolve(path, ".git/index"))
        expect((await api.startReadChanges({ source }).result).files[0].conflicted).toBe(true)
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "ours" }).result).lines[0].text).toBe("ours")
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "theirs" }).result).lines[0].text).toBe("theirs")
        expect((await api.startReadFileDiff({ source, path: "file.txt", view: "base" }).result).lines[0].text).toBe("old heading")
        expect(await readFile(resolve(path, ".git/index"))).toEqual(before)
    })

    test("pages patches with stable coordinates and rejects stale continuation", async () => {
        let { path, api, source } = await repository()
        await writeFile(resolve(path, "large.txt"), Array.from({ length: 2400 }, (_, index) => `line ${index}\n`).join(""))
        let first = await api.startReadFileDiff({ source, path: "large.txt" }).result
        expect(first.lines).toHaveLength(2000)
        expect(first.nextOffset).toBe(2000)
        let next = await api.startReadFileDiff({ source, path: "large.txt", offset: first.nextOffset, expectedVersion: first.version }).result
        expect(next.lines[0].id).toBe(2000)
        expect(next.version).toBe(first.version)
        await writeFile(resolve(path, "large.txt"), "changed\n")
        await expect(api.startReadFileDiff({ source, path: "large.txt", offset: first.nextOffset, expectedVersion: first.version }).result).rejects.toThrow(
            "source changed",
        )
    })

    test("does not execute custom diff/textconv programs and honours line normalization", async () => {
        let { path, api, source } = await repository()
        await writeFile(resolve(path, ".gitattributes"), "file.txt text eol=lf\ncustom.dat diff=custom\n")
        await writeFile(resolve(path, "custom.dat"), "before\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "attributes")
        git(path, "config", "diff.custom.textconv", "must-not-run")
        git(path, "config", "diff.external", "must-not-run")
        await writeFile(resolve(path, "file.txt"), "new heading\r\nunchanged\r\nold footer\r\n")
        await writeFile(resolve(path, "custom.dat"), "after\n")
        let custom = await api.startReadFileDiff({ source, path: "custom.dat" }).result
        expect(custom.selectable).toBe(false)
        expect(custom.summary.join(" ")).toContain("disabled")

        let normal = await api.startReadFileDiff({ source, path: "file.txt" }).result
        expect(changed(normal.lines)).toEqual([["deletion", "old heading"], ["addition", "new heading"]])
    })

    test("inspects unborn HEAD and exact linked worktrees and cancels immediately", async () => {
        let { path, api, source } = await repository("sha1", false)
        git(path, "add", ".")
        await writeFile(resolve(path, "file.txt"), "latest\n")
        expect(changed((await api.startReadFileDiff({ source, path: "file.txt" }).result).lines)).toEqual([["addition", "latest"]])

        git(path, "add", ".")
        git(path, "commit", "-qm", "first")
        let linked = resolve(path, "linked")
        git(path, "worktree", "add", "--detach", linked)
        await writeFile(resolve(linked, "file.txt"), "linked only\n")
        let linkedDiff = await api.startReadFileDiff({ source: { kind: "working", worktreePath: linked }, path: "file.txt" }).result
        expect(changed(linkedDiff.lines)).toContainEqual(["addition", "linked only"])

        let read = api.startReadChanges({ source })
        read.cancel()
        await expect(read.result).rejects.toMatchObject({ code: "git.cancelled" })
    })
})
async function repository(format = "sha1", commit = true) {
    let path = await mkdtemp(resolve(tmpdir(), "laneway-diff-"))
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
    let api = await openRepository(path)
    return { path, api, source: { kind: "working" as const, worktreePath: path } }
}
function git(cwd: string, ...args: string[]) {
    let result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(`${args.join(" ")}: ${result.stderr}`)
    return result.stdout.toString().trim()
}
