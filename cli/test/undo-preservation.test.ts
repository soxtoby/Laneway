import { connectRepository, readConflictState } from "@laneway/git"
import type { LocalRequest, LocalResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"

let temporary: string[] = []
afterEach(async () => {
    for (let path of temporary.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})

test("undoing a stash keeps edits made since on other paths and restores the stashed file", async () => {
    let path = await fixture()
    await writeFile(join(path, "a.txt"), "stashed\n")

    expect((await perform(path, { action: "stash-create", path, label: "saved" })).status).toBe("performed")

    await writeFile(join(path, "b.txt"), "written after the stash\n")
    await transition(path, "undo")

    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("stashed\n")
    expect(await readFile(join(path, "b.txt"), "utf8")).toBe("written after the stash\n")
    expect(git(path, "stash", "list")).toBe("")
    expect((await readConflictState(await connectRepository(path))).working).toHaveLength(0)
}, 60_000)

test("undoing a stash over a colliding edit keeps the edit as a Working Changes Conflict", async () => {
    let path = await fixture()
    await writeFile(join(path, "a.txt"), "stashed\n")

    expect((await perform(path, { action: "stash-create", path, label: "saved" })).status).toBe("performed")

    await writeFile(join(path, "a.txt"), "edited after the stash\n")
    await transition(path, "undo")

    let marked = await readFile(join(path, "a.txt"), "utf8")

    expect(marked).toContain("<<<<<<<")
    expect(marked).toContain("stashed")
    expect(marked).toContain("edited after the stash")
    expect((await readConflictState(await connectRepository(path))).working).toHaveLength(1)
    expect(git(path, "stash", "list")).toContain("Working Changes kept through undo")
}, 60_000)

test("undoing a stash leaves stashes pushed since in the list", async () => {
    let path = await fixture()
    await writeFile(join(path, "a.txt"), "first\n")

    expect((await perform(path, { action: "stash-create", path, label: "first" })).status).toBe("performed")

    await writeFile(join(path, "a.txt"), "second\n")
    git(path, "stash", "push", "-m", "pushed outside Laneway")
    let outside = git(path, "rev-parse", "refs/stash")
    await transition(path, "undo")

    expect(git(path, "stash", "list", "--format=%H").split("\n")).toEqual([outside])
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("first\n")
}, 60_000)

test("undoing a commit after the branch moved on is unavailable and names the branch", async () => {
    let path = await fixture()
    await writeFile(join(path, "a.txt"), "committed\n")

    expect((await perform(path, { action: "commit", path, title: "committed", message: "" })).status).toBe("performed")

    await writeFile(join(path, "a.txt"), "later\n")
    git(path, "commit", "-qam", "later")

    await expect(transition(path, "undo")).rejects.toMatchObject({
        code: "operation.precondition-failed",
        details: { reason: "ref-changed", ref: "refs/heads/main" },
    })
    expect(await executeOperationCommand({ command: "history", noWait: false }, path)).toMatchObject({ undo: { available: false, reason: "ref-changed" } })
}, 60_000)

async function fixture() {
    let path = await mkdtemp(join(tmpdir(), "laneway-undo-test-"))
    temporary.push(path)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Laneway Test")
    git(path, "config", "user.email", "test@example.invalid")
    git(path, "config", "commit.gpgsign", "false")
    await writeFile(join(path, "a.txt"), "base\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "initial")
    return path
}
function git(cwd: string, ...args: string[]) {
    let result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
}
async function perform(path: string, request: LocalRequest) {
    let preview = (await executeOperationCommand({ command: "local-preview", request, noWait: false }, path) as LocalResult).preview!
    return await executeOperationCommand({ command: "local", request, token: preview.token, noWait: false }, path) as LocalResult
}
function transition(path: string, command: "undo" | "redo") {
    return executeOperationCommand({ command, noWait: false }, path)
}
