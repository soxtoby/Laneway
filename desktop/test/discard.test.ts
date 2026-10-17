import { openRepository } from "@laneway/git"
import type { DiffLine } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { discardLines, WorkingDiscards } from "../src/main/discard"

let directories: string[] = []

afterEach(async () => {
    for (let directory of directories.splice(0)) {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
})

test("unstaged file discards return the index content and undo renames the original back", async () => {
    let fixture = await repository()
    await writeFile(join(fixture.path, "keep.txt"), "a\nB\n")
    let discards = new WorkingDiscards(() => fixture.git)

    let result = await discards.apply("repo", { kind: "files", worktreePath: fixture.path, view: "unstaged", files: [{ path: "keep.txt", untracked: false }] })
    expect(result).toMatchObject({ ok: true, undoable: true })
    expect(await readFile(join(fixture.path, "keep.txt"), "utf8")).toBe("a\nb\n")
    expect(fixture.status()).toBe("")
    let held = await readdir(join(fixture.path, ".git", "laneway", "discard"))
    expect(held).toHaveLength(1)
    expect(await readFile(join(fixture.path, ".git", "laneway", "discard", held[0], "keep.txt"), "utf8")).toBe("a\nB\n")

    expect(await discards.undo("repo", (result as { id: string }).id)).toEqual({ ok: true, kept: [] })
    expect(await readFile(join(fixture.path, "keep.txt"), "utf8")).toBe("a\nB\n")
    expect(fixture.status()).toBe(" M keep.txt")
    expect(await readdir(join(fixture.path, ".git", "laneway", "discard"))).toEqual([])
    expect(await discards.undo("repo", (result as { id: string }).id)).toMatchObject({ ok: false })
})

test("untracked files move aside without Git and settle for good", async () => {
    let fixture = await repository()
    await mkdir(join(fixture.path, "dir"))
    await writeFile(join(fixture.path, "dir", "new.txt"), "fresh\n")
    let discards = new WorkingDiscards(() => fixture.git)

    let result = await discards.apply("repo", {
        kind: "files",
        worktreePath: fixture.path,
        view: "unstaged",
        files: [{ path: "dir/new.txt", untracked: true }],
    })
    expect(result).toMatchObject({ ok: true, undoable: true })
    expect(await stat(join(fixture.path, "dir", "new.txt")).catch(() => undefined)).toBeUndefined()
    expect(fixture.status()).toBe("")

    await discards.settle("repo", (result as { id: string }).id)
    expect(await readdir(join(fixture.path, ".git", "laneway", "discard"))).toEqual([])
    expect(await discards.undo("repo", (result as { id: string }).id)).toMatchObject({ ok: false })
})

test("staged discards return index and worktree to HEAD, and undo stages the restored files again", async () => {
    let fixture = await repository()
    await writeFile(join(fixture.path, "added.txt"), "new\n")
    fixture.run("add", "added.txt")
    fixture.run("mv", "old.txt", "renamed.txt")
    await writeFile(join(fixture.path, "keep.txt"), "a\nB\n")
    fixture.run("add", "keep.txt")
    expect(fixture.status().split("\n").sort()).toEqual(["A  added.txt", "M  keep.txt", "R  old.txt -> renamed.txt"])
    let discards = new WorkingDiscards(() => fixture.git)

    let result = await discards.apply("repo", {
        kind: "files",
        worktreePath: fixture.path,
        view: "staged",
        files: [{ path: "added.txt", untracked: false }, { path: "renamed.txt", oldPath: "old.txt", untracked: false }, { path: "keep.txt", untracked: false }],
    })
    expect(result).toMatchObject({ ok: true, undoable: true })
    expect(fixture.status()).toBe("")
    expect(await readFile(join(fixture.path, "old.txt"), "utf8")).toBe("x\n")
    expect(await stat(join(fixture.path, "renamed.txt")).catch(() => undefined)).toBeUndefined()

    expect(await discards.undo("repo", (result as { id: string }).id)).toEqual({ ok: true, kept: [] })
    expect(fixture.status().split("\n").sort()).toEqual(["A  added.txt", "M  keep.txt", "R  old.txt -> renamed.txt"])
    expect(await readFile(join(fixture.path, "keep.txt"), "utf8")).toBe("a\nB\n")
})

test("line discards rewrite only the selected lines and verify the file against the diff", async () => {
    let fixture = await repository()
    await writeFile(join(fixture.path, "keep.txt"), "first\nb\nlast\n")
    let page = await fixture.git.startReadFileDiff({ source: { kind: "working", worktreePath: fixture.path }, path: "keep.txt", view: "unstaged" }).result
    let discards = new WorkingDiscards(() => fixture.git)
    let deletion = page.lines.find(line => line.kind == "deletion")!
    let additions = page.lines.filter(line => line.kind == "addition")
    expect(deletion.text).toBe("a")
    expect(additions.map(line => line.text)).toEqual(["first", "last"])

    // Putting the deletion back, in the order the diff shows it, and removing the last addition.
    let result = await discards.apply("repo", {
        kind: "lines",
        worktreePath: fixture.path,
        path: "keep.txt",
        lines: page.lines,
        lineIds: [deletion.id, additions[1].id],
    })
    expect(result).toMatchObject({ ok: true, undoable: true })
    expect(await readFile(join(fixture.path, "keep.txt"), "utf8")).toBe("a\nfirst\nb\n")

    let stale = await discards.apply("repo", { kind: "lines", worktreePath: fixture.path, path: "keep.txt", lines: page.lines, lineIds: [additions[0].id] })
    expect(stale).toMatchObject({ ok: false, error: { message: expect.stringContaining("changed since") } })
    expect(await readFile(join(fixture.path, "keep.txt"), "utf8")).toBe("a\nfirst\nb\n")

    expect(await discards.undo("repo", (result as { id: string }).id)).toEqual({ ok: true, kept: [] })
    expect(await readFile(join(fixture.path, "keep.txt"), "utf8")).toBe("first\nb\nlast\n")
})

test("undo keeps a file edited after the discard and leaves its original for the sweep", async () => {
    let fixture = await repository()
    await writeFile(join(fixture.path, "keep.txt"), "a\nB\n")
    let discards = new WorkingDiscards(() => fixture.git)

    let result = await discards.apply("repo", { kind: "files", worktreePath: fixture.path, view: "unstaged", files: [{ path: "keep.txt", untracked: false }] })
    await writeFile(join(fixture.path, "keep.txt"), "edited again\n")
    let later = new Date(Date.now() + 5_000)
    await utimes(join(fixture.path, "keep.txt"), later, later)

    expect(await discards.undo("repo", (result as { id: string }).id)).toEqual({ ok: true, kept: ["keep.txt"] })
    expect(await readFile(join(fixture.path, "keep.txt"), "utf8")).toBe("edited again\n")
    expect(await readdir(join(fixture.path, ".git", "laneway", "discard"))).toHaveLength(1)
})

test("a failed discard puts held files back", async () => {
    let fixture = await repository()
    await writeFile(join(fixture.path, "keep.txt"), "a\nB\n")
    let discards = new WorkingDiscards(() => fixture.git)

    let result = await discards.apply("repo", {
        kind: "files",
        worktreePath: fixture.path,
        view: "unstaged",
        files: [{ path: "keep.txt", untracked: false }, { path: "missing.txt", untracked: false }],
    })
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining("missing.txt") } })
    expect(await readFile(join(fixture.path, "keep.txt"), "utf8")).toBe("a\nB\n")
    expect(await readdir(join(fixture.path, ".git", "laneway", "discard"))).toEqual([])

    expect(await discards.apply("repo", { kind: "files", worktreePath: fixture.path, view: "unstaged", files: [{ path: "../outside.txt", untracked: true }] }))
        .toMatchObject({ ok: false })
    expect(
        await discards.apply("repo", {
            kind: "files",
            worktreePath: join(fixture.path, "..", "elsewhere"),
            view: "unstaged",
            files: [{ path: "a", untracked: true }],
        }),
    )
        .toMatchObject({ ok: false })
})

test("an unborn branch discards staged additions by unstaging them", async () => {
    let fixture = await repository(false)
    await writeFile(join(fixture.path, "first.txt"), "one\n")
    fixture.run("add", "first.txt")
    let discards = new WorkingDiscards(() => fixture.git)

    let result = await discards.apply("repo", { kind: "files", worktreePath: fixture.path, view: "staged", files: [{ path: "first.txt", untracked: false }] })
    expect(result).toMatchObject({ ok: true, undoable: true })
    expect(fixture.status()).toBe("")

    expect(await discards.undo("repo", (result as { id: string }).id)).toEqual({ ok: true, kept: [] })
    expect(fixture.status()).toBe("A  first.txt")
})

test("a linked worktree holds its originals under its own git directory", async () => {
    let fixture = await repository()
    let linked = join(fixture.root, "linked")
    fixture.run("worktree", "add", "-q", "-b", "linked", linked)
    await writeFile(join(linked, "scratch.txt"), "scratch\n")
    let discards = new WorkingDiscards(() => fixture.git)

    let result = await discards.apply("repo", { kind: "files", worktreePath: linked, view: "unstaged", files: [{ path: "scratch.txt", untracked: true }] })
    expect(result).toMatchObject({ ok: true, undoable: true })
    expect(await readdir(join(fixture.path, ".git", "worktrees", "linked", "laneway", "discard"))).toHaveLength(1)

    expect(await discards.undo("repo", (result as { id: string }).id)).toEqual({ ok: true, kept: [] })
    expect(await readFile(join(linked, "scratch.txt"), "utf8")).toBe("scratch\n")
})

test("discardLines removes selected additions, restores selected deletions, and rejects stale text", () => {
    let lines: DiffLine[] = [
        { id: 0, kind: "hunk", text: "@@ -1,3 +1,3 @@", hunk: 0 },
        { id: 1, kind: "context", text: "a", oldLine: 1, newLine: 1, hunk: 0 },
        { id: 2, kind: "deletion", text: "b", oldLine: 2, hunk: 0 },
        { id: 3, kind: "addition", text: "B", newLine: 2, hunk: 0 },
        { id: 4, kind: "deletion", text: "c", oldLine: 3, hunk: 0 },
        { id: 5, kind: "addition", text: "C", newLine: 3, hunk: 0 },
        { id: 6, kind: "notice", text: "\\ No newline at end of file", hunk: 0 },
    ]
    expect(discardLines("a\nB\nC", lines, [2, 3])).toBe("a\nb\nC")
    expect(discardLines("a\nB\nC", lines, [5])).toBe("a\nB\n")
    expect(discardLines("a\nB\nC", lines, [4])).toBe("a\nB\nc\nC")
    expect(discardLines("a\nB\nC", lines, [2, 3, 4, 5])).toBe("a\nb\nc\n")
    expect(() => discardLines("a\nX\nC", lines, [3])).toThrow("changed since")
    expect(() => discardLines("a\nB\nC", lines, [1])).toThrow("selected diff lines changed")
})

async function repository(commit = true) {
    let root = await realpath(await mkdtemp(join(tmpdir(), "laneway-discard-")))
    directories.push(root)
    let path = join(root, "repository")
    await mkdir(path)
    let run = (...args: string[]) => {
        let result = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
        return result.stdout.toString()
    }
    run("init", "-q", "-b", "main")
    run("config", "user.name", "Discard Test")
    run("config", "user.email", "test@example.invalid")
    run("config", "commit.gpgsign", "false")
    run("config", "core.autocrlf", "false")
    if (commit) {
        await writeFile(join(path, "keep.txt"), "a\nb\n")
        await writeFile(join(path, "old.txt"), "x\n")
        run("add", ".")
        run("commit", "-q", "-m", "init")
    }
    let git = await openRepository(path)
    return { root, path, git, run, status: () => run("status", "--porcelain=v1").replace(/\r?\n$/, "") }
}
