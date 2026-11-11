import { connectRepository } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { mutateComposition, prepareComposition } from "../src/composition/composition"
import { ChangeRecorder } from "../src/operations/change-recorder"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { createCompositionFixtures, git, perform, preview, request } from "./composition-fixture"

let { fixture, cleanup } = createCompositionFixtures()
afterEach(cleanup)

// Ignored files are expendable, as they are to git checkout: a transfer writes over one in its way and leaves its
// ignored siblings alone, rather than scanning every ignored path for a collision first.
test("moving a committed file into its own Working Changes preserves the file and undo after GC without recovery refs", async () => {
    let { path } = await fixture()
    await writeFile(join(path, "selected.txt"), "keep these bytes\n")
    await writeFile(join(path, "retained.txt"), "still committed\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "source")
    let original = git(path, "rev-parse", "HEAD")
    await perform(
        path,
        request({
            source: { kind: "commit", objectId: original, branch: "feature" },
            target: { kind: "working", worktreePath: path },
            files: [{ path: "selected.txt" }],
        }),
    )

    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("keep these bytes\n")
    expect(git(path, "status", "--porcelain")).toBe("?? selected.txt")
    expect(git(path, "for-each-ref", "--format=%(refname)", "refs/laneway/recovery")).toBe("")

    git(path, "-c", "gc.reflogExpire=never", "-c", "gc.reflogExpireUnreachable=never", "gc", "--prune=now")
    await executeOperationCommand({ command: "undo", noWait: false }, path)

    expect(git(path, "rev-parse", "HEAD")).toBe(original)
    expect(git(path, "status", "--porcelain")).toBe("")

    await executeOperationCommand({ command: "redo", noWait: false }, path)

    expect(git(path, "status", "--porcelain")).toBe("?? selected.txt")
}, 60_000)

test("cancellation and stale preflight leave refs, files and staging unchanged", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "a.txt"), "selected\n")
    git(path, "add", "a.txt")
    let repo = await connectRepository(path),
        r = request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "seam", branch: "feature", parentId: base },
            files: [{ path: "a.txt" }],
        })
    let p = (await prepareComposition(repo, r)).preview

    await expect(mutateComposition(repo, r, p, new ChangeRecorder(repo), () => true)).rejects.toThrow("cancelled")
    expect(git(path, "rev-parse", "HEAD")).toBe(base)
    expect(git(path, "show", ":a.txt")).toBe("selected")

    await writeFile(join(path, "a.txt"), "external\n")

    await expect(executeOperationCommand({ command: "local", request: r, token: p.token, noWait: false }, path)).rejects.toThrow("changed")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("external\n")
}, 60_000)

test("a verified preview reuses its plan; corrupt or pruned plans rebuild safely", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "a.txt"), "changed\n")
    let repo = await connectRepository(path)
    let r = request({
        source: { kind: "working", worktreePath: path },
        target: { kind: "seam", branch: "feature", parentId: base },
        files: [{ path: "a.txt" }],
    })
    let p = await prepareComposition(repo, r)
    let original = repo.startReadBranchGraph.bind(repo)
    let reads = 0
    repo.startReadBranchGraph = options => {
        reads++
        return original(options)
    }

    expect((await prepareComposition(repo, r, p.preview.token)).preview).toEqual(p.preview)
    expect(reads).toBe(0)

    await writeFile(join(path, ".git", "laneway", "composition-preview.json"), "damaged")
    await prepareComposition(repo, r, p.preview.token)

    expect(reads).toBe(1)

    git(path, "gc", "--prune=now")
    await prepareComposition(repo, r, p.preview.token)

    expect(reads).toBe(2)
}, 60_000)

test("copying an already-present commit is a no-op, including operation history", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "new.txt"), "new\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "new")
    let source = git(path, "rev-parse", "HEAD")
    git(path, "branch", "destination", base)
    let make = () =>
        request({
            mode: "copy",
            source: { kind: "commit", objectId: source },
            target: { kind: "branch", branch: "destination", tip: git(path, "rev-parse", "destination") },
        })
    await perform(path, make())
    let before = await executeOperationCommand({ command: "history", noWait: false }, path)

    expect((await preview(path, make())).composition?.noop).toBe(true)

    await perform(path, make())

    expect(await executeOperationCommand({ command: "history", noWait: false }, path)).toEqual(before)
}, 120_000)

test("moving a commit forward removes its old position even when the destination inherited its change", async () => {
    for (let kind of ["commit", "branch"] as const) {
        let { path } = await fixture()
        await writeFile(join(path, "first.txt"), "first\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "first")
        let first = git(path, "rev-parse", "HEAD")
        await writeFile(join(path, "last.txt"), "last\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "last")
        let last = git(path, "rev-parse", "HEAD")
        let target = kind == "commit" ? { kind, objectId: last, branch: "feature" } : { kind, tip: last, branch: "feature" }
        await perform(path, request({ source: { kind: "commit", objectId: first }, target }))

        expect(git(path, "ls-tree", "--name-only", "HEAD")).toBe("a.txt\nfirst.txt\nlast.txt")
        expect(git(path, "log", "--format=%s", "main..HEAD")).toBe(kind == "commit" ? "last" : "first\nlast")
    }
}, 120_000)

test("moving untracked additions removes them from the source and leaves incoming changes unstaged", async () => {
    let { path } = await fixture()
    let destination = join(path, "linked")
    git(path, "worktree", "add", "-qb", "destination", destination, "main")
    await writeFile(join(path, "untracked.txt"), "transfer\n")
    await writeFile(join(destination, "staged.txt"), "staged\n")
    git(destination, "add", "staged.txt")
    await perform(
        path,
        request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "working", worktreePath: destination },
            files: [{ path: "untracked.txt" }],
        }),
    )

    expect(await Bun.file(join(path, "untracked.txt")).exists()).toBe(false)
    expect(await readFile(join(destination, "untracked.txt"), "utf8")).toBe("transfer\n")
    expect(git(destination, "diff", "--cached", "--name-only")).toBe("staged.txt")
}, 120_000)

test("composition honors filters and preserves author; signing failure leaves source untouched", async () => {
    let { path, base } = await fixture("sha256")
    git(path, "config", "filter.upper.clean", "tr a-z A-Z")
    git(path, "config", "filter.upper.smudge", "cat")
    await writeFile(join(path, ".gitattributes"), "a.txt filter=upper\n")
    await writeFile(join(path, "a.txt"), "filtered\n")
    let r = request({
        source: { kind: "working", worktreePath: path },
        target: { kind: "seam", branch: "feature", parentId: base },
        files: [{ path: "a.txt" }, { path: ".gitattributes" }],
    })
    git(path, "config", "commit.gpgsign", "true")
    git(path, "config", "gpg.program", "laneway-missing-signing-program")

    await expect(perform(path, r)).rejects.toThrow()
    expect(git(path, "rev-parse", "HEAD")).toBe(base)

    git(path, "config", "commit.gpgsign", "false")
    await perform(path, r)

    expect(git(path, "show", "HEAD:a.txt")).toBe("FILTERED")

    let source = git(path, "rev-parse", "HEAD")
    git(path, "branch", "destination", base)
    git(path, "config", "user.name", "New committer")
    await perform(path, request({ mode: "copy", source: { kind: "commit", objectId: source }, target: { kind: "branch", branch: "destination", tip: base } }))

    expect(git(path, "show", "-s", "--format=%an|%cn", "destination")).toBe("Test|New committer")
}, 180_000)

test("composed commits run no commit hooks; pre-commit then checks each checked-out branch whose content changed", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "feature.txt"), "feature\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "feature")
    for (let name of ["prepare-commit-msg", "commit-msg"])
        await writeFile(join(path, ".git", "hooks", name), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    let hook = join(path, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\nprintf 'checked\\n' > checked.txt\necho 'lint failed' >&2\nexit 1\n")
    await chmod(hook, 0o755)

    // A reword leaves every file as it was, so there is nothing for pre-commit to check.
    let reworded = await perform(path, { action: "reword", objectId: git(path, "rev-parse", "HEAD"), branch: "feature", title: "Renamed", message: "" })

    expect(reworded.hookFailure).toBeUndefined()
    expect(git(path, "log", "-1", "--format=%s", "feature")).toBe("Renamed")
    expect(git(path, "status", "--porcelain")).toBe("")

    // Moving the commit away changes the checked-out feature branch; the destination has no worktree to check.
    git(path, "branch", "destination", base)
    let moved = await perform(
        path,
        request({
            source: { kind: "commit", objectId: git(path, "rev-parse", "feature"), branch: "feature" },
            target: { kind: "branch", branch: "destination", tip: base },
        }),
    )

    expect(git(path, "log", "-1", "--format=%s", "destination")).toBe("Renamed")
    expect(git(path, "rev-parse", "feature")).toBe(base)
    expect(moved.hookFailure).toEqual({ message: expect.stringContaining(path), output: "lint failed" })
    expect(moved.message).toContain(moved.hookFailure!.message)
    expect(git(path, "status", "--porcelain")).toBe("?? checked.txt")

    // The hook's edits belong to the operation, so Undo reverses them with it.
    await executeOperationCommand({ command: "undo", noWait: false }, path)

    expect(git(path, "log", "-1", "--format=%s", "feature")).toBe("Renamed")
    expect(git(path, "rev-parse", "destination")).toBe(base)
    expect(git(path, "status", "--porcelain")).toBe("")
}, 120_000)

test("working files become a new commit, preserving remaining files and exact undo/redo", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "a.txt"), "ONE\ntwo\nthree\n")
    await writeFile(join(path, "other.txt"), "untracked\n")
    let r = request({
        source: { kind: "working", worktreePath: path },
        target: { kind: "seam", branch: "feature", parentId: base },
        files: [{ path: "a.txt" }],
    })
    let p = await preview(path, r)

    expect(p.composition?.conflicts).toEqual([])

    await perform(path, r)

    expect(git(path, "show", "HEAD:a.txt")).toBe("ONE\ntwo\nthree")
    expect(git(path, "status", "--porcelain")).toBe("?? other.txt")

    let tip = git(path, "rev-parse", "HEAD")
    await executeOperationCommand({ command: "undo", noWait: false }, path)

    expect(git(path, "rev-parse", "HEAD")).toBe(base)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("ONE\ntwo\nthree\n")

    await executeOperationCommand({ command: "redo", noWait: false }, path)

    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
}, 120_000)

test("moves one commit across branches and restacks closed descendants", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "moved.txt"), "move me\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "moved")
    let moved = git(path, "rev-parse", "HEAD")
    git(path, "branch", "destination", base)
    git(path, "checkout", "-qb", "child")
    await writeFile(join(path, "child.txt"), "child\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "child")
    await perform(
        path,
        request({ source: { kind: "commit", objectId: moved, branch: "feature" }, target: { kind: "branch", branch: "destination", tip: base } }),
    )

    expect(git(path, "rev-parse", "feature")).toBe(base)
    expect(git(path, "ls-tree", "--name-only", "child")).toBe("a.txt\nchild.txt")
    expect(git(path, "show", "destination:moved.txt")).toBe("move me")
    expect(git(path, "branch", "--show-current")).toBe("child")
    expect(git(path, "status", "--porcelain")).toBe("")
}, 120_000)

test("staged line selection preserves later edits and rejects stale selections", async () => {
    let { path, base } = await fixture("sha256")
    await writeFile(join(path, "a.txt"), "ONE\ntwo\nthree\n")
    git(path, "add", ".")
    await writeFile(join(path, "a.txt"), "LATER\ntwo\nthree\n")
    let repo = await connectRepository(path)
    let source = { kind: "working" as const, worktreePath: path }
    let page = await repo.startReadFileDiff({ source, path: "a.txt", view: "staged" }).result
    let r = request({
        source,
        target: { kind: "seam", branch: "feature", parentId: base },
        view: "staged",
        files: [{ path: "a.txt", version: page.version, lineIds: page.lines.filter(l => ["addition", "deletion"].includes(l.kind)).map(l => l.id) }],
    })
    await perform(path, r)

    expect(git(path, "show", "HEAD:a.txt")).toBe("ONE\ntwo\nthree")
    expect(git(path, "show", ":a.txt")).toBe("ONE\ntwo\nthree")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("LATER\ntwo\nthree\n")
    await expect(preview(path, r)).rejects.toThrow()
}, 120_000)

test("transfers selected lines from an entire-file diff", async () => {
    let { path } = await fixture()
    let lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`)
    await writeFile(join(path, "a.txt"), lines.join(""))
    git(path, "add", ".")
    git(path, "commit", "-qm", "long file")
    let base = git(path, "rev-parse", "HEAD")
    lines[15] = "replacement\n"
    await writeFile(join(path, "a.txt"), lines.join(""))
    let repo = await connectRepository(path)
    let source = { kind: "working" as const, worktreePath: path }
    let page = await repo.startReadFileDiff({ source, path: "a.txt", entireFile: true }).result
    await perform(
        path,
        request({
            source,
            target: { kind: "seam", branch: "feature", parentId: base },
            files: [{
                path: "a.txt",
                version: page.version,
                entireFile: page.entireFile,
                lineIds: page.lines.filter(line => line.kind == "addition" || line.kind == "deletion").map(line => line.id),
            }],
        }),
    )

    expect(git(path, "show", "HEAD:a.txt")).toBe(lines.join("").trim())
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe(lines.join(""))
    expect(git(path, "status", "--porcelain")).toBe("")
}, 120_000)

test("moving a commit onto another commit combines their messages and keeps the destination author", async () => {
    for (let mode of ["move", "copy"] as const) {
        let { path } = await fixture()
        await writeFile(join(path, "first.txt"), "first\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "first")
        let first = git(path, "rev-parse", "HEAD")
        git(path, "config", "user.name", "Other")
        await writeFile(join(path, "last.txt"), "last\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "last\n\nlast body")
        let last = git(path, "rev-parse", "HEAD")
        git(path, "config", "user.name", "Test")
        await perform(
            path,
            request({ mode, source: { kind: "commit", objectId: last, branch: "feature" }, target: { kind: "commit", branch: "feature", objectId: first } }),
        )
        // The emptied source disappears whether moved or copied; only a move brings its message along.

        expect(git(path, "log", "--format=%s", "main..HEAD")).toBe("first")
        expect(git(path, "show", "-s", "--format=%B", "HEAD")).toBe(mode == "move" ? "first\n\nlast\n\nlast body" : "first")
        expect(git(path, "show", "-s", "--format=%an|%cn", "HEAD")).toBe("Test|Test")
        expect(git(path, "ls-tree", "--name-only", "HEAD")).toBe("a.txt\nfirst.txt\nlast.txt")
    }
}, 120_000)

test("a whole commit moves onto a seam without a message and is not offered its own seams", async () => {
    let { path, base } = await fixture()
    let commits: string[] = []
    for (let name of ["first", "second", "third"]) {
        if (name == "third")
            git(path, "config", "user.name", "Other")
        await writeFile(join(path, `${name}.txt`), `${name}\n`)
        git(path, "add", ".")
        git(path, "commit", "-qm", name)
        commits.push(git(path, "rev-parse", "HEAD"))
    }
    git(path, "config", "user.name", "Test")
    let third = commits[2]
    let seam = (parentId: string) => ({ kind: "seam" as const, branch: "feature", parentId })
    let whole = (objectId: string) => ({ kind: "commit" as const, objectId, branch: "feature" })
    let moving = request({ message: "", source: whole(third), target: seam(base) })

    expect((await preview(path, moving)).composition).toMatchObject({ removed: [], conflicts: [], published: [] })

    await perform(path, moving)

    expect(git(path, "log", "--format=%s", "main..HEAD")).toBe("second\nfirst\nthird")
    expect(git(path, "show", "-s", "--format=%an|%cn", "HEAD~2")).toBe("Other|Test")
    expect(git(path, "ls-tree", "--name-only", "HEAD")).toBe("a.txt\nfirst.txt\nsecond.txt\nthird.txt")

    let moved = git(path, "rev-parse", "HEAD~2")

    await expect(preview(path, request({ message: "", source: whole(moved), target: seam(base) }))).rejects.toThrow("already in that position")
    await expect(preview(path, request({ message: "", source: whole(moved), target: seam(moved) }))).rejects.toThrow("already in that position")
    // Selected files still compose a new commit that needs its own message.
    await expect(preview(path, request({ message: "", source: whole(moved), files: [{ path: "third.txt" }], target: seam(git(path, "rev-parse", "HEAD")) })))
        .rejects.toThrow("commit message")
}, 120_000)
