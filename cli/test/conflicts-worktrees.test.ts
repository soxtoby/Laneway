import { connectRepository } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { conflict, git, perform } from "./composition-fixture"
import { accept, choose, commit, createConflictFixtures, transition } from "./conflicts-fixture"

let { fixture, cleanup } = createConflictFixtures()
afterEach(cleanup)

test("empty rewrites fast-forward cleanly and missing temporary branches restore explicitly", async () => {
    let { path, base } = await fixture()
    git(path, "switch", "-qc", "empty", "main^")

    expect((await conflict(path, { action: "rewrite", branches: ["empty"], base, path })).conflicts).toHaveLength(0)
    expect(git(path, "rev-parse", "empty")).toBe(base)

    git(path, "switch", "topic")
    let result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    let temporary = git(path, "branch", "--show-current")
    git(path, "switch", "main")
    git(path, "branch", "-D", temporary)
    let recovery = (await conflict(path, { action: "list" })).recovery[0]

    expect(recovery.message).toContain("missing")

    await conflict(path, { action: "restore", stack: recovery.stack })

    expect((await conflict(path, { action: "list" })).conflicts[0].id).toBe(result.conflicts[0].id)
    expect(git(path, "branch", "--show-current")).toBe("main")
}, 120_000)

test("follows the current temporary child and keeps externally copied conflicts blocked", async () => {
    let { path, base } = await fixture()
    let subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    git(path, "branch", "copied")
    git(path, "reset", "--hard", "HEAD^")
    await commit(path, "alternative.txt", "current child\n", "alternative child")
    await choose(path, subject, "right")
    await accept(path, subject)

    expect(git(path, "show", "HEAD:alternative.txt")).toBe("current child")
    expect(git(path, "log", "--format=%s")).not.toContain("later commit")
    expect((await conflict(path, { action: "publish-check", branches: ["copied"] })).publishable).toBe(false)
    expect((await conflict(path, { action: "publish-check", branches: ["topic"] })).publishable).toBe(true)

    let repo = await connectRepository(path)
    let graph = await repo.startReadBranchGraph({ authorIdentities: { primary: "conflict@example.invalid", secondary: [] }, remotePatterns: [] }).result

    expect(graph.branches.find(b => b.name == "copied")!.unresolved).toBeDefined()
}, 120_000)

test("switching follows the unresolved branch and suspends Working Changes conflicts", async () => {
    let { path, base } = await fixture()
    await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    let temporary = git(path, "branch", "--show-current")
    await executeOperationCommand({ command: "worktree", request: { action: "switch", path, branch: "main", move: false }, noWait: false }, path)
    await executeOperationCommand({ command: "worktree", request: { action: "switch", path, branch: "topic", move: false }, noWait: false }, path)

    expect(git(path, "branch", "--show-current")).toBe(temporary)

    let subject = (await conflict(path, { action: "list" })).conflicts[0].id
    await choose(path, subject, "right")
    await accept(path, subject)
    await writeFile(join(path, "a.txt"), "stashed\n")
    await perform(path, { action: "stash-create", path, label: "saved" })
    let stash = git(path, "rev-parse", "refs/stash")
    await commit(path, "a.txt", "another edit\n", "advance")
    await perform(path, { action: "stash-apply", path, objectId: stash })
    let working = (await conflict(path, { action: "list" })).conflicts[0].id
    await executeOperationCommand({ command: "worktree", request: { action: "switch", path, branch: "main", move: false }, noWait: false }, path)

    expect((await conflict(path, { action: "list" })).conflicts[0].suspended).toBe(true)
    expect(git(path, "status", "--porcelain")).toBe("")

    await executeOperationCommand({ command: "worktree", request: { action: "switch", path, branch: "topic", move: false }, noWait: false }, path)
    await conflict(path, { action: "resume-working", subject: working, path })

    expect(await readFile(join(path, "a.txt"), "utf8")).toContain("<<<<<<<")

    await choose(path, working, "right")
    await accept(path, working)

    expect(git(path, "stash", "list")).toBe("")
}, 180_000)

test("compiled recovery survives an acceptance crash with GC retaining candidates", async () => {
    // Rolling back at each journal boundary is covered once, in composition-conflicts; this keeps the conflict-specific claim.
    let engine = resolve(import.meta.dir, "../bin/lane.exe")
    let { path, base } = await fixture()
    await run(path, ["conflict", "--request", JSON.stringify({ action: "rewrite", branches: ["topic"], base, path })])
    let subject = (await conflict(path, { action: "list" })).conflicts[0].id
    let view = (await choose(path, subject, "right")).view!
    git(path, "gc", "--prune=now")
    await run(path, [
        "conflict",
        "--request",
        JSON.stringify({ action: "accept", subject, input: view.subject.input, revision: view.candidate.revision }),
        "--crash-after",
        "history-committed",
    ], 86)
    await run(path, ["recover"])

    expect(git(path, "branch", "--show-current")).toBe("topic")

    await run(path, ["undo"])

    expect((await conflict(path, { action: "inspect", subject })).view!.ready).toBe(true)

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

test("stash conflicts are uncommitted and keep-stashed/accept undo to unresolved state", async () => {
    let { path } = await fixture()
    await writeFile(join(path, "a.txt"), "stashed\n")
    await perform(path, { action: "stash-create", path, label: "saved" })
    let stash = git(path, "rev-parse", "refs/stash")
    await commit(path, "a.txt", "changed again\n", "move")

    expect((await perform(path, { action: "stash-apply", path, objectId: stash })).status).toBe("performed")

    let result = await conflict(path, { action: "list" })

    expect(result.conflicts[0].kind).toBe("working")
    expect(git(path, "ls-files", "--unmerged")).toBe("")

    let subject = result.conflicts[0].id
    let view = (await conflict(path, { action: "inspect", subject })).view!
    await conflict(path, { action: "keep-stashed", subject, input: view.subject.input, revision: view.candidate.revision })

    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("changed again\n")
    expect(git(path, "rev-parse", "refs/stash")).toBe(stash)

    await transition(path, "undo")
    view = (await choose(path, subject, "right")).view!
    await accept(path, subject)

    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("stashed\n")
    expect(git(path, "show", "HEAD:a.txt")).toBe("changed again")
    expect(git(path, "stash", "list")).toBe("")

    await transition(path, "undo")

    expect((await conflict(path, { action: "list" })).conflicts[0].kind).toBe("working")
    expect(git(path, "rev-parse", "refs/stash")).toBe(stash)
}, 120_000)
