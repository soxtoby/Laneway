import { connectRepository, readConflictState } from "@laneway/git"
import type { CompositionRequest, ConflictRequest, ConflictResult, LocalResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { mutateComposition, prepareComposition } from "../src/composition"
import { executeOperationCommand } from "../src/operation-runtime"

const temporary: string[] = []
afterEach(async () => {
    for (const path of temporary.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})
function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (r.exitCode)
        throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
}
async function fixture(format = "sha1") {
    const path = await mkdtemp(join(tmpdir(), "laneway-compose-test-"))
    temporary.push(path)
    git(path, "init", "-q", "-b", "main", `--object-format=${format}`)
    git(path, "config", "user.name", "Test")
    git(path, "config", "user.email", "test@example.invalid")
    git(path, "config", "commit.gpgsign", "false")
    await writeFile(join(path, "a.txt"), "one\ntwo\nthree\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "base")
    const base = git(path, "rev-parse", "HEAD")
    git(path, "remote", "add", "origin", "https://example.invalid/repo.git")
    git(path, "update-ref", "refs/remotes/origin/main", base)
    git(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    git(path, "checkout", "-qb", "feature")
    return { path, base }
}
const request = (r: Pick<CompositionRequest, "source" | "target"> & Partial<CompositionRequest>): CompositionRequest => ({
    action: "compose",
    mode: "move",
    view: "combined",
    message: "Composed",
    descendants: true,
    allowConflicts: false,
    ...r,
})
async function preview(path: string, request: CompositionRequest) {
    return (await executeOperationCommand({ command: "local-preview", request, noWait: false }, path) as LocalResult).preview!
}
async function perform(path: string, request: CompositionRequest) {
    const p = await preview(path, request)
    const r = await executeOperationCommand({ command: "local", request, token: p.token, noWait: false }, path) as LocalResult
    if (r.status == "failed")
        throw new Error(r.message)
    return r
}
const conflict = async (path: string, request: ConflictRequest) =>
    await executeOperationCommand({ command: "conflict", request, noWait: false }, path) as ConflictResult

test("cancellation and stale preflight leave refs, files and staging unchanged", async () => {
    const { path, base } = await fixture()
    await writeFile(join(path, "a.txt"), "selected\n")
    git(path, "add", "a.txt")
    const repo = await connectRepository(path),
        r = request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "seam", branch: "feature", parentId: base },
            files: [{ path: "a.txt" }],
        })
    const p = (await prepareComposition(repo, r)).preview
    await expect(mutateComposition(repo, r, p, new Map(), () => true)).rejects.toThrow("cancelled")
    expect(git(path, "rev-parse", "HEAD")).toBe(base)
    expect(git(path, "show", ":a.txt")).toBe("selected")
    await writeFile(join(path, "a.txt"), "external\n")
    await expect(executeOperationCommand({ command: "local", request: r, token: p.token, noWait: false }, path)).rejects.toThrow("changed")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("external\n")
}, 60_000)

test("seams on either side of a branch boundary retain their explicit owner", async () => {
    for (const owner of ["feature", "child"]) {
        const { path, base } = await fixture()
        await writeFile(join(path, "feature.txt"), "feature\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "feature")
        const feature = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-qb", "child")
        await writeFile(join(path, "child.txt"), "child\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "child")
        await writeFile(join(path, "new.txt"), "new\n")
        await perform(
            path,
            request({
                source: { kind: "working", worktreePath: path },
                target: { kind: "seam", branch: owner, parentId: feature },
                files: [{ path: "new.txt" }],
            }),
        )
        expect(git(path, "rev-parse", "feature") == feature).toBe(owner == "child")
        expect(git(path, "show", "child:new.txt")).toBe("new")
        expect(git(path, "rev-parse", "main")).toBe(base)
    }
}, 120_000)

test("the seam at Primary Branch's tip can prepend a local branch without rewriting Primary", async () => {
    const { path, base } = await fixture()
    await writeFile(join(path, "feature.txt"), "feature\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "feature")
    await writeFile(join(path, "new.txt"), "new\n")
    await perform(
        path,
        request({ source: { kind: "working", worktreePath: path }, target: { kind: "seam", branch: "feature", parentId: base }, files: [{ path: "new.txt" }] }),
    )
    expect(git(path, "log", "--format=%s", "main..feature")).toBe("feature\nComposed")
    expect(git(path, "rev-parse", "main")).toBe(base)
}, 120_000)

test("branch rebase restacks descendants by default and can leave them on old history", async () => {
    for (const descendants of [true, false]) {
        const { path, base } = await fixture()
        await writeFile(join(path, "feature.txt"), "feature\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "feature")
        const feature = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-qb", "child")
        await writeFile(join(path, "child.txt"), "child\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "child")
        const child = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-qb", "destination", base)
        await writeFile(join(path, "destination.txt"), "destination\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "destination")
        const destination = git(path, "rev-parse", "HEAD")
        const r = request({
            source: { kind: "branch", branch: "feature", tip: feature },
            target: { kind: "branch", branch: "destination", tip: destination },
            descendants,
        })
        await perform(path, r)
        expect(git(path, "rev-parse", "feature^1")).toBe(destination)
        expect(git(path, "rev-parse", "child") == child).toBe(!descendants)
        expect(git(path, "rev-parse", "destination")).toBe(destination)
    }
}, 120_000)

test("copying an already-present commit is a no-op, including operation history", async () => {
    const { path, base } = await fixture()
    await writeFile(join(path, "new.txt"), "new\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "new")
    const source = git(path, "rev-parse", "HEAD")
    git(path, "branch", "destination", base)
    const make = () =>
        request({
            mode: "copy",
            source: { kind: "commit", objectId: source },
            target: { kind: "branch", branch: "destination", tip: git(path, "rev-parse", "destination") },
        })
    await perform(path, make())
    const before = await executeOperationCommand({ command: "history", noWait: false }, path)
    expect((await preview(path, make())).composition?.noop).toBe(true)
    await perform(path, make())
    expect(await executeOperationCommand({ command: "history", noWait: false }, path)).toEqual(before)
}, 120_000)

test("moving a commit forward removes its old position even when the destination inherited its change", async () => {
    for (const kind of ["commit", "branch"] as const) {
        const { path } = await fixture()
        await writeFile(join(path, "first.txt"), "first\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "first")
        const first = git(path, "rev-parse", "HEAD")
        await writeFile(join(path, "last.txt"), "last\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "last")
        const last = git(path, "rev-parse", "HEAD")
        const target = kind == "commit" ? { kind, objectId: last, branch: "feature" } : { kind, tip: last, branch: "feature" }
        await perform(path, request({ source: { kind: "commit", objectId: first }, target }))
        expect(git(path, "ls-tree", "--name-only", "HEAD")).toBe("a.txt\nfirst.txt\nlast.txt")
        expect(git(path, "log", "--format=%s", "main..HEAD")).toBe(kind == "commit" ? "last" : "first\nlast")
    }
}, 120_000)

test("copy reports partly duplicated files and moving published Primary history is reported for confirmation", async () => {
    const { path, base } = await fixture()
    await writeFile(join(path, "first.txt"), "first\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "first")
    const first = git(path, "rev-parse", "HEAD")
    git(path, "branch", "destination")
    await writeFile(join(path, "last.txt"), "last\n")
    git(path, "add", ".")
    git(path, "commit", "--amend", "--no-edit", "-q")
    const source = git(path, "rev-parse", "HEAD")
    const r = request({ mode: "copy", source: { kind: "commit", objectId: source }, target: { kind: "branch", branch: "destination", tip: first } })
    expect((await preview(path, r)).composition?.skipped).toEqual(["first.txt"])
    await perform(path, r)
    git(path, "branch", "-f", "main", source)
    git(path, "update-ref", "refs/remotes/origin/main", source)
    const move = { ...r, mode: "move" as const, target: { kind: "branch" as const, branch: "destination", tip: git(path, "rev-parse", "destination") } }
    expect((await preview(path, move)).composition?.published).toEqual(["main"])
    await perform(path, move)
    expect(git(path, "log", "--format=%s", "origin/main..main")).toBe("")
    expect(git(path, "rev-parse", "main")).toBe(base)
    expect(git(path, "rev-parse", "origin/main")).toBe(source)
}, 120_000)

test("published Primary history can be combined and reordered once the rewrite is confirmed", async () => {
    const { path, base } = await fixture()
    git(path, "checkout", "-q", "main")
    await writeFile(join(path, "first.txt"), "first\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "first")
    const first = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "second.txt"), "second\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "second")
    const second = git(path, "rev-parse", "HEAD")
    git(path, "update-ref", "refs/remotes/origin/main", second)
    const squash = request({ source: { kind: "commit", objectId: second, branch: "main" }, target: { kind: "commit", branch: "main", objectId: first } })
    expect((await preview(path, squash)).composition).toMatchObject({ published: ["main"], removed: [], conflicts: [] })
    await perform(path, squash)
    expect(git(path, "log", "--format=%s", `${base}..main`)).toBe("first")
    expect(git(path, "log", "--format=%B", "-1", "main").trim()).toBe("first\n\nsecond")
    expect(git(path, "ls-tree", "--name-only", "main")).toBe("a.txt\nfirst.txt\nsecond.txt")
    expect(git(path, "rev-parse", "origin/main")).toBe(second)
    await writeFile(join(path, "seam.txt"), "seam\n")
    const insert = request({
        source: { kind: "working", worktreePath: path },
        target: { kind: "seam", branch: "main", parentId: base },
        files: [{ path: "seam.txt" }],
    })
    expect((await preview(path, insert)).composition?.published).toEqual(["main"])
    await perform(path, insert)
    expect(git(path, "log", "--format=%s", `${base}..main`)).toBe("first\nComposed")
    expect(git(path, "rev-parse", "origin/main")).toBe(second)
}, 120_000)

test("unpublished commits on the local Primary Branch remain editable", async () => {
    const { path, base } = await fixture()
    git(path, "checkout", "-q", "main")
    await writeFile(join(path, "first.txt"), "first\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "first")
    const first = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "second.txt"), "second\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "second")
    await writeFile(join(path, "extra.txt"), "extra\n")
    await perform(
        path,
        request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "commit", branch: "main", objectId: first },
            files: [{ path: "extra.txt" }],
        }),
    )
    expect(git(path, "log", "--format=%s", "origin/main..main")).toBe("second\nfirst")
    expect(git(path, "ls-tree", "--name-only", "main~1")).toBe("a.txt\nextra.txt\nfirst.txt")
    await writeFile(join(path, "seam.txt"), "seam\n")
    await perform(
        path,
        request({ source: { kind: "working", worktreePath: path }, target: { kind: "seam", branch: "main", parentId: base }, files: [{ path: "seam.txt" }] }),
    )
    expect(git(path, "log", "--format=%s", "origin/main..main")).toBe("second\nfirst\nComposed")
    expect(git(path, "rev-parse", "origin/main")).toBe(base)
}, 120_000)

test("moving untracked additions removes them from the source and leaves incoming changes unstaged", async () => {
    const { path } = await fixture()
    const destination = join(path, "linked")
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

test("composition honors filters and preserves author; signing and hook failure leave source untouched", async () => {
    const { path, base } = await fixture("sha256")
    git(path, "config", "filter.upper.clean", "tr a-z A-Z")
    git(path, "config", "filter.upper.smudge", "cat")
    await writeFile(join(path, ".gitattributes"), "a.txt filter=upper\n")
    await writeFile(join(path, "a.txt"), "filtered\n")
    const r = request({
        source: { kind: "working", worktreePath: path },
        target: { kind: "seam", branch: "feature", parentId: base },
        files: [{ path: "a.txt" }, { path: ".gitattributes" }],
    })
    const hook = join(path, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\nexit 1\n")
    await chmod(hook, 0o755)
    const before = git(path, "status", "--porcelain")
    await expect(perform(path, r)).rejects.toThrow("Saved checkout")
    expect(git(path, "rev-parse", "HEAD")).toBe(base)
    expect(git(path, "status", "--porcelain")).toBe(before)
    await rm(hook)
    git(path, "config", "commit.gpgsign", "true")
    git(path, "config", "gpg.program", "laneway-missing-signing-program")
    await expect(perform(path, r)).rejects.toThrow()
    expect(git(path, "rev-parse", "HEAD")).toBe(base)
    git(path, "config", "commit.gpgsign", "false")
    await perform(path, r)
    expect(git(path, "show", "HEAD:a.txt")).toBe("FILTERED")
    const source = git(path, "rev-parse", "HEAD")
    git(path, "branch", "destination", base)
    git(path, "config", "user.name", "New committer")
    await perform(path, request({ mode: "copy", source: { kind: "commit", objectId: source }, target: { kind: "branch", branch: "destination", tip: base } }))
    expect(git(path, "show", "-s", "--format=%an|%cn", "destination")).toBe("Test|New committer")
}, 180_000)

test("incoming Working Changes conflicts preserve staging and can be accepted or kept stashed", async () => {
    for (const action of ["accept", "keep-stashed"] as const) {
        const { path } = await fixture()
        await writeFile(join(path, "a.txt"), "incoming\ntwo\nthree\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "incoming")
        const source = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-qb", "destination", "main")
        await writeFile(join(path, "a.txt"), "existing\ntwo\nthree\n")
        git(path, "add", "a.txt")
        await perform(
            path,
            request({ mode: "copy", source: { kind: "commit", objectId: source }, target: { kind: "working", worktreePath: path }, allowConflicts: true }),
        )
        const repo = await connectRepository(path), working = (await readConflictState(repo)).working[0]
        expect(git(path, "ls-files", "--unmerged")).toBe("")
        expect(git(path, "show", ":a.txt")).toBe("existing\ntwo\nthree")
        let view = (await conflict(path, { action: "inspect", subject: working.id })).view!
        if (action == "accept") {
            await conflict(path, {
                action: "choose",
                subject: working.id,
                input: view.subject.input,
                revision: view.candidate.revision,
                file: "a.txt",
                side: "right",
            })
            view = (await conflict(path, { action: "inspect", subject: working.id })).view!
        }
        await conflict(path, { action, subject: working.id, input: view.subject.input, revision: view.candidate.revision })
        expect(await readFile(join(path, "a.txt"), "utf8")).toBe(`${action == "accept" ? "incoming" : "existing"}\ntwo\nthree\n`)
        expect(git(path, "show", ":a.txt")).toBe("existing\ntwo\nthree")
        if (action == "keep-stashed")
            expect(git(path, "rev-list", "--parents", "-1", "stash@{0}").split(" ")).toHaveLength(3)
        if (action == "keep-stashed")
            expect(git(path, "show", "stash@{0}:a.txt")).toBe("incoming\ntwo\nthree")
        await executeOperationCommand({ command: "undo", noWait: false }, path)
        expect((await readConflictState(repo)).working).toHaveLength(1)
    }
}, 180_000)

test("compiled composition recovers across journal boundaries and remains undoable after GC", async () => {
    const engine = resolve(import.meta.dir, "../bin/lane.exe")
    async function run(path: string, args: string[], expected = 0) {
        const child = Bun.spawn([engine, ...args, "--json"], {
            cwd: path,
            env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1" },
            stdout: "pipe",
            stderr: "pipe",
        })
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect(code, out + err).toBe(expected)
    }
    for (const phase of ["intent", "worktrees-committed"]) {
        const { path, base } = await fixture()
        await writeFile(join(path, "a.txt"), "composed\n")
        const r = request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "seam", branch: "feature", parentId: base },
            files: [{ path: "a.txt" }],
        })
        const p = await preview(path, r), requestPath = join(path, ".git", "composition-request.json")
        await writeFile(requestPath, JSON.stringify(r))
        await run(path, ["local", "--request-file", requestPath, "--expected", p.token, "--crash-after", phase], 86)
        await run(path, ["recover"])
        if (phase == "intent")
            expect(git(path, "rev-parse", "HEAD")).toBe(base)
        else {
            expect(git(path, "rev-parse", "HEAD")).not.toBe(base)
            // Ordinary reflog expiry is an external-history boundary; retain it
            // here to isolate object retention and crash recovery.
            git(path, "-c", "gc.reflogExpire=never", "-c", "gc.reflogExpireUnreachable=never", "gc", "--prune=now")
            await run(path, ["undo"])
            expect(git(path, "rev-parse", "HEAD")).toBe(base)
            await run(path, ["redo"])
            expect(git(path, "show", "HEAD:a.txt")).toBe("composed")
        }
        expect(await readFile(join(path, "a.txt"), "utf8")).toBe("composed\n")
    }
}, 180_000)

test("clean same-file transfers preserve conflict progress and survive acceptance and undo", async () => {
    const { path, base } = await fixture()
    const initial = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
    await writeFile(join(path, "a.txt"), initial)
    git(path, "add", ".")
    git(path, "commit", "-qm", "long")
    const common = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "a.txt"), initial.replace("one", "source"))
    git(path, "add", ".")
    git(path, "commit", "-qm", "source")
    const source = git(path, "rev-parse", "HEAD")
    git(path, "checkout", "-qb", "destination", common)
    await writeFile(join(path, "a.txt"), initial.replace("one", "destination"))
    git(path, "add", ".")
    git(path, "commit", "-qm", "destination")
    const destination = git(path, "rev-parse", "HEAD")
    await perform(
        path,
        request({
            mode: "copy",
            source: { kind: "commit", objectId: source },
            target: { kind: "branch", branch: "destination", tip: destination },
            allowConflicts: true,
        }),
    )
    const repo = await connectRepository(path)
    const stack = (await readConflictState(repo)).stacks[0], subject = stack.steps.find(s => s.conflict)!.conflict!.id
    let view = (await conflict(path, { action: "inspect", subject })).view!
    await conflict(path, { action: "choose", subject, input: view.subject.input, revision: view.candidate.revision, file: "a.txt", side: "right", hunk: 0 })
    await writeFile(join(path, "a.txt"), (await readFile(join(path, "a.txt"), "utf8")).replace("ten\n", "TEN\n"))
    await perform(
        path,
        request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "commit", branch: "destination", objectId: stack.steps.at(-1)!.current },
            files: [{ path: "a.txt" }],
        }),
    )
    view = (await conflict(path, { action: "inspect", subject })).view!
    await conflict(path, { action: "accept", subject, input: view.subject.input, revision: view.candidate.revision })
    expect(git(path, "show", "destination:a.txt")).toBe(initial.replace("one", "source").replace("ten\n", "TEN\n").trim())
    await executeOperationCommand({ command: "undo", noWait: false }, path)
    expect((await readConflictState(repo)).stacks.length).toBeGreaterThan(0)
    expect(git(path, "rev-parse", "main")).toBe(base)
}, 180_000)

test("editing a descendant retains every branch boundary in an existing unresolved stack", async () => {
    const { path, base } = await fixture()
    await writeFile(join(path, "a.txt"), "feature\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "feature")
    git(path, "checkout", "-qb", "child")
    await writeFile(join(path, "child.txt"), "child\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "child")
    git(path, "checkout", "-qb", "destination", base)
    await writeFile(join(path, "a.txt"), "destination\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "destination")
    const destination = git(path, "rev-parse", "HEAD")
    git(path, "switch", "child")
    await conflict(path, { action: "rewrite", branches: ["feature", "child"], base: destination, path })
    const repo = await connectRepository(path), original = (await readConflictState(repo)).stacks[0]
    const subject = original.steps.find(s => s.conflict)!.conflict!.id
    await writeFile(join(path, "extra.txt"), "extra\n")
    await perform(
        path,
        request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "commit", branch: "child", objectId: original.steps.at(-1)!.current },
            files: [{ path: "extra.txt" }],
        }),
    )
    expect((await readConflictState(repo)).stacks.flatMap(s => s.branches.map(b => b.ref)).sort()).toEqual(["refs/heads/child", "refs/heads/feature"])
    let view = (await conflict(path, { action: "inspect", subject })).view!
    await conflict(path, { action: "choose", subject, input: view.subject.input, revision: view.candidate.revision, file: "a.txt", side: "right" })
    view = (await conflict(path, { action: "inspect", subject })).view!
    await conflict(path, { action: "accept", subject, input: view.subject.input, revision: view.candidate.revision })
    expect((await readConflictState(repo)).stacks).toHaveLength(0)
    expect(git(path, "show", "child:extra.txt")).toBe("extra")
    expect(git(path, "show", "feature:a.txt")).toBe("feature")
}, 180_000)
test("working files become a new commit, preserving remaining files and exact undo/redo", async () => {
    const { path, base } = await fixture()
    await writeFile(join(path, "a.txt"), "ONE\ntwo\nthree\n")
    await writeFile(join(path, "other.txt"), "untracked\n")
    const r = request({
        source: { kind: "working", worktreePath: path },
        target: { kind: "seam", branch: "feature", parentId: base },
        files: [{ path: "a.txt" }],
    })
    const p = await preview(path, r)
    expect(p.composition?.conflicts).toEqual([])
    await perform(path, r)
    expect(git(path, "show", "HEAD:a.txt")).toBe("ONE\ntwo\nthree")
    expect(git(path, "status", "--porcelain")).toBe("?? other.txt")
    const tip = git(path, "rev-parse", "HEAD")
    await executeOperationCommand({ command: "undo", noWait: false }, path)
    expect(git(path, "rev-parse", "HEAD")).toBe(base)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("ONE\ntwo\nthree\n")
    await executeOperationCommand({ command: "redo", noWait: false }, path)
    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
}, 120_000)

test("moves one commit across branches and restacks closed descendants", async () => {
    const { path, base } = await fixture()
    await writeFile(join(path, "moved.txt"), "move me\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "moved")
    const moved = git(path, "rev-parse", "HEAD")
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
    const { path, base } = await fixture("sha256")
    await writeFile(join(path, "a.txt"), "ONE\ntwo\nthree\n")
    git(path, "add", ".")
    await writeFile(join(path, "a.txt"), "LATER\ntwo\nthree\n")
    const repo = await connectRepository(path)
    const source = { kind: "working" as const, worktreePath: path }
    const page = await repo.startReadFileDiff({ source, path: "a.txt", view: "staged" }).result
    const r = request({
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

test("preflight conflicts leave files unchanged until explicitly continued", async () => {
    const { path, base } = await fixture()
    await writeFile(join(path, "a.txt"), "source\ntwo\nthree\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "source")
    const source = git(path, "rev-parse", "HEAD")
    git(path, "checkout", "-qb", "destination", base)
    await writeFile(join(path, "a.txt"), "destination\ntwo\nthree\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "destination")
    const destination = git(path, "rev-parse", "HEAD")
    const r = request({ mode: "copy", source: { kind: "commit", objectId: source }, target: { kind: "branch", branch: "destination", tip: destination } })
    expect((await preview(path, r)).composition?.conflicts.length).toBeGreaterThan(0)
    expect(git(path, "rev-parse", "HEAD")).toBe(destination)
    await perform(path, { ...r, allowConflicts: true })
    expect(git(path, "branch", "--show-current")).toStartWith("laneway/unresolved/")
    expect(git(path, "rev-parse", "destination")).toBe(destination)
    expect(git(path, "ls-files", "--unmerged")).toBe("")
    const result = await executeOperationCommand({ command: "conflict", request: { action: "list" }, noWait: false }, path)
    expect("conflicts" in result && result.conflicts.length).toBe(1)
}, 120_000)

test("moving a commit onto another commit combines their messages and keeps the destination author", async () => {
    for (const mode of ["move", "copy"] as const) {
        const { path } = await fixture()
        await writeFile(join(path, "first.txt"), "first\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "first")
        const first = git(path, "rev-parse", "HEAD")
        git(path, "config", "user.name", "Other")
        await writeFile(join(path, "last.txt"), "last\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "last\n\nlast body")
        const last = git(path, "rev-parse", "HEAD")
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
    const { path, base } = await fixture()
    const commits: string[] = []
    for (const name of ["first", "second", "third"]) {
        if (name == "third")
            git(path, "config", "user.name", "Other")
        await writeFile(join(path, `${name}.txt`), `${name}\n`)
        git(path, "add", ".")
        git(path, "commit", "-qm", name)
        commits.push(git(path, "rev-parse", "HEAD"))
    }
    git(path, "config", "user.name", "Test")
    const third = commits[2]
    const seam = (parentId: string) => ({ kind: "seam" as const, branch: "feature", parentId })
    const whole = (objectId: string) => ({ kind: "commit" as const, objectId, branch: "feature" })
    const moving = request({ message: "", source: whole(third), target: seam(base) })
    expect((await preview(path, moving)).composition).toMatchObject({ removed: [], conflicts: [], published: [] })
    await perform(path, moving)
    expect(git(path, "log", "--format=%s", "main..HEAD")).toBe("second\nfirst\nthird")
    expect(git(path, "show", "-s", "--format=%an|%cn", "HEAD~2")).toBe("Other|Test")
    expect(git(path, "ls-tree", "--name-only", "HEAD")).toBe("a.txt\nfirst.txt\nsecond.txt\nthird.txt")
    const moved = git(path, "rev-parse", "HEAD~2")
    await expect(preview(path, request({ message: "", source: whole(moved), target: seam(base) }))).rejects.toThrow("already in that position")
    await expect(preview(path, request({ message: "", source: whole(moved), target: seam(moved) }))).rejects.toThrow("already in that position")
    // Selected files still compose a new commit that needs its own message.
    await expect(preview(path, request({ message: "", source: whole(moved), files: [{ path: "third.txt" }], target: seam(git(path, "rev-parse", "HEAD")) })))
        .rejects.toThrow("commit message")
}, 120_000)
