import { connectRepository, readConflictState } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { conflictResult } from "../src/conflicts/conflict-operations"
import { conflict, git } from "./composition-fixture"
import { accept, choose, createConflictFixtures, transition } from "./conflicts-fixture"

let { fixture, cleanup } = createConflictFixtures()
afterEach(cleanup)

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
