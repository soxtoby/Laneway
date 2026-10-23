import { connectRepository, readConflictState } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { conflict, createCompositionFixtures, git, perform, preview, request } from "./composition-fixture"

let { fixture, cleanup } = createCompositionFixtures()
afterEach(cleanup)

test("incoming Working Changes conflicts preserve staging and can be accepted or kept stashed", async () => {
    for (let action of ["accept", "keep-stashed"] as const) {
        let { path } = await fixture()
        await writeFile(join(path, "a.txt"), "incoming\ntwo\nthree\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "incoming")
        let source = git(path, "rev-parse", "HEAD")
        git(path, "checkout", "-qb", "destination", "main")
        await writeFile(join(path, "a.txt"), "existing\ntwo\nthree\n")
        git(path, "add", "a.txt")
        await perform(
            path,
            request({ mode: "copy", source: { kind: "commit", objectId: source }, target: { kind: "working", worktreePath: path }, allowConflicts: true }),
        )
        let repo = await connectRepository(path), working = (await readConflictState(repo)).working[0]

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
    let engine = resolve(import.meta.dir, "../bin/lane.exe")
    for (let phase of ["intent", "recorded", "history-committed"]) {
        let { path, base } = await fixture()
        await writeFile(join(path, "a.txt"), "composed\n")
        let r = request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "seam", branch: "feature", parentId: base },
            files: [{ path: "a.txt" }],
        })
        let p = await preview(path, r), requestPath = join(path, ".git", "composition-request.json")
        await writeFile(requestPath, JSON.stringify(r))
        await run(path, ["local", "--request-file", requestPath, "--expected", p.token, "--crash-after", phase], 86)
        await run(path, ["recover"])
        if (phase == "intent")
            expect(git(path, "rev-parse", "HEAD")).toBe(base)
        else {
            expect(git(path, "rev-parse", "HEAD")).not.toBe(base)

            git(path, "reflog", "expire", "--expire=now", "--all")
            git(path, "gc", "--prune=now")
            await run(path, ["undo"])

            expect(git(path, "rev-parse", "HEAD")).toBe(base)

            await run(path, ["redo"])

            expect(git(path, "show", "HEAD:a.txt")).toBe("composed")
        }

        expect(await readFile(join(path, "a.txt"), "utf8")).toBe("composed\n")
    }
    async function run(path: string, args: string[], expected = 0) {
        let child = Bun.spawn([engine, ...args, "--json"], {
            cwd: path,
            env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1" },
            stdout: "pipe",
            stderr: "pipe",
        })
        let [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])

        expect(code, out + err).toBe(expected)
    }
}, 180_000)

test("clean same-file transfers preserve conflict progress and survive acceptance and undo", async () => {
    let { path, base } = await fixture()
    let initial = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n"
    await writeFile(join(path, "a.txt"), initial)
    git(path, "add", ".")
    git(path, "commit", "-qm", "long")
    let common = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "a.txt"), initial.replace("one", "source"))
    git(path, "add", ".")
    git(path, "commit", "-qm", "source")
    let source = git(path, "rev-parse", "HEAD")
    git(path, "checkout", "-qb", "destination", common)
    await writeFile(join(path, "a.txt"), initial.replace("one", "destination"))
    git(path, "add", ".")
    git(path, "commit", "-qm", "destination")
    let destination = git(path, "rev-parse", "HEAD")
    await perform(
        path,
        request({
            mode: "copy",
            source: { kind: "commit", objectId: source },
            target: { kind: "branch", branch: "destination", tip: destination },
            allowConflicts: true,
        }),
    )
    let repo = await connectRepository(path)
    let stack = (await readConflictState(repo)).stacks[0], subject = stack.steps.find(s => s.conflict)!.conflict!.id
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
    let { path, base } = await fixture()
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
    let destination = git(path, "rev-parse", "HEAD")
    git(path, "switch", "child")
    await conflict(path, { action: "rewrite", branches: ["feature", "child"], base: destination, path })
    let repo = await connectRepository(path), original = (await readConflictState(repo)).stacks[0]
    let subject = original.steps.find(s => s.conflict)!.conflict!.id
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

test("preflight conflicts leave files unchanged until explicitly continued", async () => {
    let { path, base } = await fixture()
    await writeFile(join(path, "a.txt"), "source\ntwo\nthree\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "source")
    let source = git(path, "rev-parse", "HEAD")
    git(path, "checkout", "-qb", "destination", base)
    await writeFile(join(path, "a.txt"), "destination\ntwo\nthree\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "destination")
    let destination = git(path, "rev-parse", "HEAD")
    let r = request({ mode: "copy", source: { kind: "commit", objectId: source }, target: { kind: "branch", branch: "destination", tip: destination } })

    expect((await preview(path, r)).composition?.conflicts.length).toBeGreaterThan(0)
    expect(git(path, "rev-parse", "HEAD")).toBe(destination)

    await perform(path, { ...r, allowConflicts: true })

    expect(git(path, "branch", "--show-current")).toStartWith("laneway/unresolved/")
    expect(git(path, "rev-parse", "destination")).toBe(destination)
    expect(git(path, "ls-files", "--unmerged")).toBe("")

    let result = await executeOperationCommand({ command: "conflict", request: { action: "list" }, noWait: false }, path)

    expect("conflicts" in result && result.conflicts.length).toBe(1)
}, 120_000)
