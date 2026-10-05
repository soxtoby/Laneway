import { connectRepository, readConflictState } from "@laneway/git"
import type { ConflictRequest, ConflictResult, LocalRequest, LocalResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { conflictResult } from "../src/conflict-operations"
import { executeOperationCommand } from "../src/operation-runtime"

let fixtures: string[] = []
afterEach(async () => {
    for (let path of fixtures.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})
test("rewrite completes with committed markers, explicit durable resolution, undo and redo", async () => {
    let { path, base, before } = await fixture()
    let result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })

    expect(result.conflicts).toHaveLength(1)

    let subject = result.conflicts[0].id

    expect(git(path, "symbolic-ref", "--short", "HEAD")).toStartWith("laneway/unresolved/topic/")
    expect(git(path, "rev-parse", "topic")).toBe(before)
    expect(git(path, "status", "--porcelain")).toBe("")

    let marked = await readFile(join(path, "a.txt"), "utf8")

    expect(marked).toContain("<<<<<<< Before this commit at")
    expect(marked).toContain(">>>>>>> This commit")
    expect(await readFile(join(path, "b.txt"), "utf8")).toBe("later\n")
    expect((await conflict(path, { action: "publish-check", branches: ["topic"] })).publishable).toBe(false)
    expect((await conflict(path, { action: "publish-check", branches: ["main"] })).publishable).toBe(true)
    await expect(accept(path, subject)).rejects.toThrow("Resolve every")

    let chosen = await choose(path, subject, "right", 0)

    expect(chosen.view!.ready).toBe(true)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe(marked)
    expect((await conflict(path, { action: "inspect", subject })).view!.candidate).toEqual(chosen.view!.candidate)
    expect((await accept(path, subject)).conflicts).toHaveLength(0)
    expect(git(path, "branch", "--show-current")).toBe("topic")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("topic\n")
    expect(git(path, "branch", "--list", "laneway/*")).toBe("")

    await transition(path, "undo")

    expect((await conflict(path, { action: "list" })).conflicts).toHaveLength(1)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe(marked)

    await transition(path, "redo")

    expect(git(path, "branch", "--show-current")).toBe("topic")
}, 120_000)

test("edited conflict candidates preserve partial markers, exact inputs and worktree isolation", async () => {
    let { path, base } = await fixture()
    let result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    let subject = result.conflicts[0].id
    let view = (await conflict(path, { action: "inspect", subject })).view!
    let marked = await readFile(join(path, "a.txt"), "utf8")
    let request = { action: "edit" as const, subject, input: view.subject.input, revision: view.candidate.revision, file: "a.txt" }
    let partial = await conflict(path, { ...request, content: marked.replace("<".repeat(view.subject.markerSize), "") })

    expect(partial.view!.ready).toBe(false)
    expect(partial.view!.files[0].resolved).toBe(false)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe(marked)
    await expect(conflict(path, { ...request, content: "stale\n" })).rejects.toThrow()

    let edited = await conflict(path, { ...request, revision: partial.view!.candidate.revision, content: "Custom merged result\n" })

    expect(edited.view!.ready).toBe(true)
    expect(edited.view!.files[0].resultText).toBe("Custom merged result\n")
    expect((await conflict(path, { action: "inspect", subject })).view!.candidate).toEqual(edited.view!.candidate)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe(marked)

    await accept(path, subject)

    expect(git(path, "show", "HEAD:a.txt")).toBe("Custom merged result")
}, 120_000)

test("accepting a descendant first reopens changed inputs after upstream resolution", async () => {
    let { path, base } = await fixture()
    git(path, "reset", "--hard", "HEAD^")
    await commit(path, "a.txt", "downstream\n", "downstream conflict")
    let result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })

    expect(result.conflicts).toHaveLength(2)

    let [upstream, downstream] = result.conflicts.map(c => c.id)
    await choose(path, downstream, "right")
    await accept(path, downstream)

    expect((await conflict(path, { action: "list" })).conflicts.map(c => c.id)).toEqual([upstream])

    await choose(path, upstream, "left")
    await accept(path, upstream)
    let reopened = (await conflict(path, { action: "inspect", subject: downstream })).view!

    expect(reopened.ready).toBe(false)
    expect(reopened.files[0].suggestionText).toBe("downstream\n")

    await choose(path, downstream, "right")
    await accept(path, downstream)

    expect(git(path, "show", "HEAD:a.txt")).toBe("downstream")
}, 120_000)

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

test("Use current file is explicit and keeps unrelated later Working Changes", async () => {
    let { path, base } = await fixture("sha256")
    let subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    await writeFile(join(path, "a.txt"), "chosen in editor\n")
    await writeFile(join(path, "b.txt"), "staged edits\n")
    git(path, "add", "b.txt")
    await writeFile(join(path, "b.txt"), "later edits\n")
    let before = (await conflict(path, { action: "inspect", subject })).view!

    expect(before.ready).toBe(false)

    await conflict(path, { action: "use-file", subject, input: before.subject.input, revision: before.candidate.revision, file: "a.txt", path })
    await accept(path, subject)

    expect(git(path, "branch", "--show-current")).toBe("topic")
    expect(git(path, "show", "HEAD:a.txt")).toBe("chosen in editor")
    expect(git(path, "show", "HEAD:b.txt")).toBe("later")
    expect(git(path, "show", ":b.txt")).toBe("staged edits")
    expect(await readFile(join(path, "b.txt"), "utf8")).toBe("later edits\n")
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
    await local(path, { action: "stash-create", path, label: "saved" })
    let stash = git(path, "rev-parse", "refs/stash")
    await commit(path, "a.txt", "another edit\n", "advance")
    await local(path, { action: "stash-apply", path, objectId: stash })
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

test("compiled recovery survives rewrite and acceptance crashes with GC retaining candidates", async () => {
    let engine = resolve(import.meta.dir, "../bin/lane.exe")
    for (let phase of ["intent", "worktrees-committed", "history-committed"]) {
        let { path, base, before } = await fixture()
        await run(path, ["conflict", "--request", JSON.stringify({ action: "rewrite", branches: ["topic"], base, path }), "--crash-after", phase], 86)
        await run(path, ["recover"])

        expect(git(path, "rev-parse", "topic")).toBe(before)

        if (phase != "history-committed") {
            expect((await conflict(path, { action: "list" })).conflicts).toHaveLength(0)

            continue
        }
        let subject = (await conflict(path, { action: "list" })).conflicts[0].id
        let view = (await choose(path, subject, "right")).view!
        git(path, "gc", "--prune=now")
        await run(path, [
            "conflict",
            "--request",
            JSON.stringify({ action: "accept", subject, input: view.subject.input, revision: view.candidate.revision }),
            "--crash-after",
            phase,
        ], 86)
        await run(path, ["recover"])

        expect(git(path, "branch", "--show-current")).toBe("topic")

        await run(path, ["undo"])

        expect((await conflict(path, { action: "inspect", subject })).view!.ready).toBe(true)
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

test("a moving base does not change resolution; external provisional descendants survive", async () => {
    let { path, base } = await fixture()
    let result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    let subject = result.conflicts[0].id
    let originalView = (await conflict(path, { action: "inspect", subject })).view!
    await commit(path, "external.txt", "external\n", "external child")
    git(path, "branch", "-f", "main", "topic")
    await choose(path, subject, "right")
    await accept(path, subject)

    expect(git(path, "show", "HEAD:external.txt")).toBe("external")
    expect(git(path, "log", "--oneline")).toContain("external child")
    expect(originalView.subject.leftLabel).toContain(base.slice(0, 8))
}, 120_000)

test("exact-input candidates survive explicit updates; changed inputs preserve suggestions", async () => {
    let { path, base } = await fixture()
    let subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    await choose(path, subject, "right")
    let chosen = (await conflict(path, { action: "inspect", subject })).view!
    await conflict(path, { action: "rewrite", branches: ["topic"], base, path })

    expect((await conflict(path, { action: "inspect", subject })).view!.candidate.revision).toBe(chosen.candidate.revision)

    let temporary = git(path, "branch", "--show-current")
    git(path, "switch", "main")
    let newer = await commit(path, "a.txt", "newer main\n", "new base")
    git(path, "switch", temporary)
    await conflict(path, { action: "rewrite", branches: ["topic"], base: newer, path })
    let changed = (await conflict(path, { action: "inspect", subject })).view!

    expect(changed.ready).toBe(false)
    expect(changed.subject.input).not.toBe(chosen.subject.input)
    expect(changed.files[0].suggestionText).toBe("topic\n")
    await expect(conflict(path, { action: "accept", subject, input: chosen.subject.input, revision: chosen.candidate.revision })).rejects.toThrow(
        "inputs changed",
    )
}, 120_000)

test("configured external tool edits temporary files, failure and restart retain results", async () => {
    let { path, base } = await fixture()
    let subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    git(path, "config", "merge.tool", "laneway-test")
    git(path, "config", "mergetool.laneway-test.cmd", 'printf "tool result\\n" > "$MERGED"; exit 1')
    git(path, "config", "mergetool.laneway-test.trustExitCode", "true")
    let view = (await conflict(path, { action: "inspect", subject })).view!
    let request = { action: "tool" as const, subject, input: view.subject.input, revision: view.candidate.revision, file: "a.txt" }

    await expect(conflict(path, request)).rejects.toThrow("Saved edits remain")

    git(path, "config", "mergetool.laneway-test.cmd", 'test "$(cat "$MERGED")" = "tool result"')
    let result = await conflict(path, request)

    expect(result.view!.files[0].resultText).toBe("tool result\n")
    expect(await readFile(join(path, "a.txt"), "utf8")).toContain("<<<<<<<")

    await accept(path, subject)

    expect(git(path, "show", "HEAD:a.txt")).toBe("tool result")
}, 120_000)

test("multiple branch boundaries and a dependent stack restack together", async () => {
    let { path, original, base, before } = await fixture()
    git(path, "branch", "lower", original)
    git(path, "switch", "-qc", "sibling", original)
    await commit(path, "sibling.txt", "sibling\n", "sibling")
    git(path, "switch", "topic")
    let first = await conflict(path, { action: "rewrite", branches: ["lower", "topic"], base, path })
    let repo = await connectRepository(path)
    let state = await readConflictState(repo)
    let provisionalBase = state.stacks[0].branches[0].current
    await conflict(path, { action: "rewrite", branches: ["sibling"], base: provisionalBase })
    let graph = await repo.startReadBranchGraph({ authorIdentities: { primary: "conflict@example.invalid", secondary: [] }, remotePatterns: [] }).result

    expect(graph.branches.some(b => b.name.startsWith("laneway/"))).toBe(false)
    expect(graph.branches.find(b => b.name == "topic")!.tip).not.toBe(before)
    expect(graph.branches.find(b => b.name == "lower")!.unresolved).toBeDefined()

    let comparison = await repo.startReadChanges({ source: { kind: "branches", fromRef: "refs/heads/main", toRef: "refs/heads/topic" } }).result

    expect(comparison.source).toEqual({ kind: "comparison", fromObjectId: base, toObjectId: graph.branches.find(b => b.name == "topic")!.tip })

    await choose(path, first.conflicts[0].id, "right")
    await accept(path, first.conflicts[0].id)
    let remaining = await readConflictState(repo)
    for (let stack of remaining.stacks) {
        for (let step of stack.steps) {
            if (step.conflict) {
                await choose(path, step.conflict.id, "right")
                await accept(path, step.conflict.id)
            }
        }
    }

    expect(git(path, "show", "sibling:sibling.txt")).toBe("sibling")
    expect(git(path, "merge-base", "lower", "topic")).toBe(git(path, "rev-parse", "lower"))
}, 180_000)

test("stash conflicts are uncommitted and keep-stashed/accept undo to unresolved state", async () => {
    let { path } = await fixture()
    await writeFile(join(path, "a.txt"), "stashed\n")
    await local(path, { action: "stash-create", path, label: "saved" })
    let stash = git(path, "rev-parse", "refs/stash")
    await commit(path, "a.txt", "changed again\n", "move")

    expect((await local(path, { action: "stash-apply", path, objectId: stash })).status).toBe("performed")

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

test("conflict inventory avoids tree construction and unopened file content", async () => {
    let { path, base } = await fixture()
    let rewritten = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    let subject = rewritten.conflicts[0].id
    let repo = await connectRepository(path)
    let commands: string[][] = []
    let command = repo.command.bind(repo)
    repo.command = async (...args) => {
        commands.push(args[1])
        return command(...args)
    }
    let state = await readConflictState(repo)
    let stack = state.stacks[0]
    state.stacks.length = 0

    expect((await readConflictState(repo)).stacks).toHaveLength(1)

    commands.length = 0
    let history = await repo.startReadBranchHistory({ branchRef: stack.branches[0].ref, tip: stack.branches[0].current, baseTips: [stack.base] }).result

    expect(history.commits.some(commit => commit.conflictId == subject)).toBe(true)
    expect(commands.filter(args => args[0] == "for-each-ref")).toHaveLength(2)
    expect(commands.some(args => args[0] == "show" || args[0] == "rev-parse")).toBe(false)

    commands.length = 0
    let inventory = (await conflictResult(repo, subject, [])).view!

    expect(inventory.files).toHaveLength(1)
    expect(inventory.files[0].loaded).toBe(false)
    expect(inventory.files[0].resolved).toBe(false)
    expect(inventory.ready).toBe(false)
    expect(commands.filter(args => ["read-tree", "write-tree", "update-index", "cat-file", "diff"].includes(args[0]))).toEqual([])

    commands.length = 0
    let detail = (await conflictResult(repo, subject, ["a.txt"])).view!

    expect(detail.files[0].resultText).toContain("<<<<<<<")
    expect(commands.some(args => ["read-tree", "write-tree", "diff"].includes(args[0]))).toBe(false)

    await choose(path, subject, "right")
    let resolved = (await conflictResult(repo, subject, [])).view!

    expect(resolved.files[0].resolved).toBe(true)
    expect(resolved.ready).toBe(true)

    let review = (await conflictResult(repo, subject, ["a.txt"])).view!

    expect(review.files[0].diff).toContain("+topic")
}, 60_000)
async function fixture(format = "sha1") {
    let path = await mkdtemp(join(tmpdir(), "laneway-conflict-test-"))
    fixtures.push(path)
    git(path, "init", "-q", "-b", "main", `--object-format=${format}`)
    git(path, "config", "user.name", "Conflict Test")
    git(path, "config", "user.email", "conflict@example.invalid")
    git(path, "config", "commit.gpgsign", "false")
    await commit(path, "a.txt", "base\n", "base")
    git(path, "switch", "-qc", "topic")
    let original = await commit(path, "a.txt", "topic\n", "topic")
    await commit(path, "b.txt", "later\n", "later")
    git(path, "switch", "main")
    let base = await commit(path, "a.txt", "main\n", "new main")
    git(path, "switch", "topic")
    return { path, original, base, before: git(path, "rev-parse", "topic") }
}
async function commit(path: string, file: string, content: string | Buffer, message: string) {
    await writeFile(join(path, file), content)
    git(path, "add", "--all")
    git(path, "commit", "-qm", message)
    return git(path, "rev-parse", "HEAD")
}
function git(path: string, ...args: string[]) {
    let p = Bun.spawnSync(["git", ...args], { cwd: path, stderr: "pipe", stdout: "pipe" })
    if (p.exitCode)
        throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
}
async function local(path: string, request: LocalRequest) {
    let preview = await executeOperationCommand({ command: "local-preview", request, noWait: false }, path) as LocalResult
    return executeOperationCommand({ command: "local", request, token: preview.preview!.token, noWait: false }, path) as Promise<LocalResult>
}
async function choose(path: string, subject: string, side: "left" | "right", hunk?: number) {
    let view = (await conflict(path, { action: "inspect", subject })).view!
    return conflict(path, { action: "choose", subject, input: view.subject.input, revision: view.candidate.revision, file: view.files[0].path, side, hunk })
}
async function accept(path: string, subject: string) {
    let view = (await conflict(path, { action: "inspect", subject })).view!
    return conflict(path, { action: "accept", subject, input: view.subject.input, revision: view.candidate.revision })
}

async function conflict(path: string, request: ConflictRequest) {
    return await executeOperationCommand({ command: "conflict", request, noWait: false }, path) as ConflictResult
}

function transition(path: string, command: "undo" | "redo") {
    return executeOperationCommand({ command, noWait: false }, path)
}
