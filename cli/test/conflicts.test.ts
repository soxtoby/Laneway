import { connectRepository, readConflictState } from "@git-workbench/git"
import type { ConflictRequest, ConflictResult, LocalRequest, LocalResult } from "@git-workbench/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operation-runtime"

const fixtures: string[] = []
afterEach(async () => {
    for (const path of fixtures.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})
function git(path: string, ...args: string[]) {
    const p = Bun.spawnSync(["git", ...args], { cwd: path, stderr: "pipe", stdout: "pipe" })
    if (p.exitCode)
        throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
}
async function commit(path: string, file: string, content: string | Buffer, message: string) {
    await writeFile(join(path, file), content)
    git(path, "add", "--all")
    git(path, "commit", "-qm", message)
    return git(path, "rev-parse", "HEAD")
}
async function fixture(format = "sha1") {
    const path = await mkdtemp(join(tmpdir(), "workbench-conflict-test-"))
    fixtures.push(path)
    git(path, "init", "-q", "-b", "main", `--object-format=${format}`)
    git(path, "config", "user.name", "Conflict Test")
    git(path, "config", "user.email", "conflict@example.invalid")
    git(path, "config", "commit.gpgsign", "false")
    await commit(path, "a.txt", "base\n", "base")
    git(path, "switch", "-qc", "topic")
    const original = await commit(path, "a.txt", "topic\n", "topic")
    await commit(path, "b.txt", "later\n", "later")
    git(path, "switch", "main")
    const base = await commit(path, "a.txt", "main\n", "new main")
    git(path, "switch", "topic")
    return { path, original, base, before: git(path, "rev-parse", "topic") }
}
const conflict = async (path: string, request: ConflictRequest) =>
    await executeOperationCommand({ command: "conflict", request, noWait: false }, path) as ConflictResult
const transition = (path: string, command: "undo" | "redo") => executeOperationCommand({ command, noWait: false }, path)
async function local(path: string, request: LocalRequest) {
    const preview = await executeOperationCommand({ command: "local-preview", request, noWait: false }, path) as LocalResult
    return executeOperationCommand({ command: "local", request, token: preview.preview!.token, noWait: false }, path) as Promise<LocalResult>
}
async function choose(path: string, subject: string, side: "left" | "right", hunk?: number) {
    const view = (await conflict(path, { action: "inspect", subject })).view!
    return conflict(path, { action: "choose", subject, input: view.subject.input, revision: view.candidate.revision, file: view.files[0].path, side, hunk })
}
async function accept(path: string, subject: string) {
    const view = (await conflict(path, { action: "inspect", subject })).view!
    return conflict(path, { action: "accept", subject, input: view.subject.input, revision: view.candidate.revision })
}
test("rewrite completes with committed markers, explicit durable resolution, undo and redo", async () => {
    const { path, base, before } = await fixture()
    const result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    expect(result.conflicts).toHaveLength(1)
    const subject = result.conflicts[0].id
    expect(git(path, "symbolic-ref", "--short", "HEAD")).toStartWith("git-workbench/unresolved/topic/")
    expect(git(path, "rev-parse", "topic")).toBe(before)
    expect(git(path, "status", "--porcelain")).toBe("")
    const marked = await readFile(join(path, "a.txt"), "utf8")
    expect(marked).toContain("<<<<<<< Updated stack")
    expect(await readFile(join(path, "b.txt"), "utf8")).toBe("later\n")
    expect((await conflict(path, { action: "publish-check", branches: ["topic"] })).publishable).toBe(false)
    expect((await conflict(path, { action: "publish-check", branches: ["main"] })).publishable).toBe(true)
    await expect(accept(path, subject)).rejects.toThrow("Resolve every")
    const chosen = await choose(path, subject, "right", 0)
    expect(chosen.view!.ready).toBe(true)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe(marked)
    expect((await conflict(path, { action: "inspect", subject })).view!.candidate).toEqual(chosen.view!.candidate)
    expect((await accept(path, subject)).conflicts).toHaveLength(0)
    expect(git(path, "branch", "--show-current")).toBe("topic")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("topic\n")
    expect(git(path, "branch", "--list", "git-workbench/*")).toBe("")
    await transition(path, "undo")
    expect((await conflict(path, { action: "list" })).conflicts).toHaveLength(1)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe(marked)
    await transition(path, "redo")
    expect(git(path, "branch", "--show-current")).toBe("topic")
}, 120_000)

test("accepting a descendant first reopens changed inputs after upstream resolution", async () => {
    const { path, base } = await fixture()
    git(path, "reset", "--hard", "HEAD^")
    await commit(path, "a.txt", "downstream\n", "downstream conflict")
    const result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    expect(result.conflicts).toHaveLength(2)
    const [upstream, downstream] = result.conflicts.map(c => c.id)
    await choose(path, downstream, "right")
    await accept(path, downstream)
    expect((await conflict(path, { action: "list" })).conflicts.map(c => c.id)).toEqual([upstream])
    await choose(path, upstream, "left")
    await accept(path, upstream)
    const reopened = (await conflict(path, { action: "inspect", subject: downstream })).view!
    expect(reopened.ready).toBe(false)
    expect(reopened.files[0].suggestionText).toBe("downstream\n")
    await choose(path, downstream, "right")
    await accept(path, downstream)
    expect(git(path, "show", "HEAD:a.txt")).toBe("downstream")
}, 120_000)

test("empty rewrites fast-forward cleanly and missing temporary branches restore explicitly", async () => {
    const { path, base } = await fixture()
    git(path, "switch", "-qc", "empty", "main^")
    expect((await conflict(path, { action: "rewrite", branches: ["empty"], base, path })).conflicts).toHaveLength(0)
    expect(git(path, "rev-parse", "empty")).toBe(base)
    git(path, "switch", "topic")
    const result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    const temporary = git(path, "branch", "--show-current")
    git(path, "switch", "main")
    git(path, "branch", "-D", temporary)
    const recovery = (await conflict(path, { action: "list" })).recovery[0]
    expect(recovery.message).toContain("missing")
    await conflict(path, { action: "restore", stack: recovery.stack })
    expect((await conflict(path, { action: "list" })).conflicts[0].id).toBe(result.conflicts[0].id)
    expect(git(path, "branch", "--show-current")).toBe("main")
}, 120_000)

test("Use current file is explicit and keeps unrelated later Working Changes", async () => {
    const { path, base } = await fixture("sha256")
    const subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    await writeFile(join(path, "a.txt"), "chosen in editor\n")
    await writeFile(join(path, "b.txt"), "staged edits\n")
    git(path, "add", "b.txt")
    await writeFile(join(path, "b.txt"), "later edits\n")
    const before = (await conflict(path, { action: "inspect", subject })).view!
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
    const { path, base } = await fixture()
    const subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    git(path, "branch", "copied")
    git(path, "reset", "--hard", "HEAD^")
    await commit(path, "alternative.txt", "current child\n", "alternative child")
    await choose(path, subject, "right")
    await accept(path, subject)
    expect(git(path, "show", "HEAD:alternative.txt")).toBe("current child")
    expect(git(path, "log", "--format=%s")).not.toContain("later commit")
    expect((await conflict(path, { action: "publish-check", branches: ["copied"] })).publishable).toBe(false)
    expect((await conflict(path, { action: "publish-check", branches: ["topic"] })).publishable).toBe(true)
    const repo = await connectRepository(path)
    const graph = await repo.startReadBranchGraph({ authorIdentities: { primary: "conflict@example.invalid", secondary: [] }, remotePatterns: [] }).result
    expect(graph.branches.find(b => b.name == "copied")!.unresolved).toBeDefined()
}, 120_000)

test("switching follows the unresolved branch and suspends Working Changes conflicts", async () => {
    const { path, base } = await fixture()
    await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    const temporary = git(path, "branch", "--show-current")
    await executeOperationCommand({ command: "worktree", request: { action: "switch", path, branch: "main", move: false }, noWait: false }, path)
    await executeOperationCommand({ command: "worktree", request: { action: "switch", path, branch: "topic", move: false }, noWait: false }, path)
    expect(git(path, "branch", "--show-current")).toBe(temporary)
    const subject = (await conflict(path, { action: "list" })).conflicts[0].id
    await choose(path, subject, "right")
    await accept(path, subject)
    await writeFile(join(path, "a.txt"), "stashed\n")
    await local(path, { action: "stash-create", path, label: "saved" })
    const stash = git(path, "rev-parse", "refs/stash")
    await commit(path, "a.txt", "another edit\n", "advance")
    await local(path, { action: "stash-apply", path, objectId: stash })
    const working = (await conflict(path, { action: "list" })).conflicts[0].id
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
    const engine = resolve(import.meta.dir, "../bin/workbench-engine.exe")
    async function run(path: string, args: string[], expected = 0) {
        const child = Bun.spawn([engine, ...args, "--json"], {
            cwd: path,
            env: { ...process.env, WORKBENCH_ENABLE_TEST_COMMANDS: "1" },
            stdout: "pipe",
            stderr: "pipe",
        })
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect(code, out + err).toBe(expected)
    }
    for (const phase of ["intent", "worktrees-committed"]) {
        const { path, base, before } = await fixture()
        await run(path, ["conflict", "--request", JSON.stringify({ action: "rewrite", branches: ["topic"], base, path }), "--crash-after", phase], 86)
        await run(path, ["recover"])
        expect(git(path, "rev-parse", "topic")).toBe(before)
        if (phase == "intent") {
            expect((await conflict(path, { action: "list" })).conflicts).toHaveLength(0)
            continue
        }
        const subject = (await conflict(path, { action: "list" })).conflicts[0].id
        const view = (await choose(path, subject, "right")).view!
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
}, 180_000)

test("a moving base does not change resolution; external provisional descendants survive", async () => {
    const { path, base } = await fixture()
    const result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    const subject = result.conflicts[0].id
    const originalView = (await conflict(path, { action: "inspect", subject })).view!
    await commit(path, "external.txt", "external\n", "external child")
    git(path, "branch", "-f", "main", "topic")
    await choose(path, subject, "right")
    await accept(path, subject)
    expect(git(path, "show", "HEAD:external.txt")).toBe("external")
    expect(git(path, "log", "--oneline")).toContain("external child")
    expect(originalView.subject.leftLabel).toContain(base.slice(0, 8))
}, 120_000)

test("exact-input candidates survive explicit updates; changed inputs preserve suggestions", async () => {
    const { path, base } = await fixture()
    const subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    await choose(path, subject, "right")
    const chosen = (await conflict(path, { action: "inspect", subject })).view!
    await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    expect((await conflict(path, { action: "inspect", subject })).view!.candidate.revision).toBe(chosen.candidate.revision)
    const temporary = git(path, "branch", "--show-current")
    git(path, "switch", "main")
    const newer = await commit(path, "a.txt", "newer main\n", "new base")
    git(path, "switch", temporary)
    await conflict(path, { action: "rewrite", branches: ["topic"], base: newer, path })
    const changed = (await conflict(path, { action: "inspect", subject })).view!
    expect(changed.ready).toBe(false)
    expect(changed.subject.input).not.toBe(chosen.subject.input)
    expect(changed.files[0].suggestionText).toBe("topic\n")
    await expect(conflict(path, { action: "accept", subject, input: chosen.subject.input, revision: chosen.candidate.revision })).rejects.toThrow(
        "inputs changed",
    )
}, 120_000)

test("configured external tool edits temporary files, failure and restart retain results", async () => {
    const { path, base } = await fixture()
    const subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    git(path, "config", "merge.tool", "workbench-test")
    git(path, "config", "mergetool.workbench-test.cmd", 'printf "tool result\\n" > "$MERGED"; exit 1')
    git(path, "config", "mergetool.workbench-test.trustExitCode", "true")
    const view = (await conflict(path, { action: "inspect", subject })).view!
    const request = { action: "tool" as const, subject, input: view.subject.input, revision: view.candidate.revision, file: "a.txt" }
    await expect(conflict(path, request)).rejects.toThrow("Saved edits remain")
    git(path, "config", "mergetool.workbench-test.cmd", 'test "$(cat "$MERGED")" = "tool result"')
    const result = await conflict(path, request)
    expect(result.view!.files[0].resultText).toBe("tool result\n")
    expect(await readFile(join(path, "a.txt"), "utf8")).toContain("<<<<<<<")
    await accept(path, subject)
    expect(git(path, "show", "HEAD:a.txt")).toBe("tool result")
}, 120_000)

test("multiple branch boundaries and a dependent stack restack together", async () => {
    const { path, original, base, before } = await fixture()
    git(path, "branch", "lower", original)
    git(path, "switch", "-qc", "sibling", original)
    await commit(path, "sibling.txt", "sibling\n", "sibling")
    git(path, "switch", "topic")
    const first = await conflict(path, { action: "rewrite", branches: ["lower", "topic"], base, path })
    const repo = await connectRepository(path)
    const state = await readConflictState(repo)
    const provisionalBase = state.stacks[0].branches[0].current
    await conflict(path, { action: "rewrite", branches: ["sibling"], base: provisionalBase })
    const graph = await repo.startReadBranchGraph({ authorIdentities: { primary: "conflict@example.invalid", secondary: [] }, remotePatterns: [] }).result
    expect(graph.branches.some(b => b.name.startsWith("git-workbench/"))).toBe(false)
    expect(graph.branches.find(b => b.name == "topic")!.tip).not.toBe(before)
    expect(graph.branches.find(b => b.name == "lower")!.unresolved).toBeDefined()
    const comparison = await repo.startReadChanges({ source: { kind: "branches", fromRef: "refs/heads/main", toRef: "refs/heads/topic" } }).result
    expect(comparison.source).toEqual({ kind: "comparison", fromObjectId: base, toObjectId: graph.branches.find(b => b.name == "topic")!.tip })
    await choose(path, first.conflicts[0].id, "right")
    await accept(path, first.conflicts[0].id)
    const remaining = await readConflictState(repo)
    for (const stack of remaining.stacks) {
        for (const step of stack.steps) {
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
    const { path } = await fixture()
    await writeFile(join(path, "a.txt"), "stashed\n")
    await local(path, { action: "stash-create", path, label: "saved" })
    const stash = git(path, "rev-parse", "refs/stash")
    await commit(path, "a.txt", "changed again\n", "move")
    expect((await local(path, { action: "stash-apply", path, objectId: stash })).status).toBe("performed")
    const result = await conflict(path, { action: "list" })
    expect(result.conflicts[0].kind).toBe("working")
    expect(git(path, "ls-files", "--unmerged")).toBe("")
    const subject = result.conflicts[0].id
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
