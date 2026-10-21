import { connectRepository, readConflictState } from "@laneway/git"
import type { ConflictRequest, ConflictResult, HistoricalEditRequest, HistoricalEditResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { createCompositionFixtures, git, perform, request } from "./composition-fixture"

let { fixture, cleanup } = createCompositionFixtures()
let directories: string[] = []
afterEach(async () => {
    await cleanup()
    for (let path of directories.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})

test("entry preserves staged, unstaged, and untracked changes and detaches the same worktree; a clean return restores them", async () => {
    let { path, greeting, tip } = await stack()
    await writeFile(join(path, "print.txt"), "print loudly\n")
    git(path, "add", "print.txt")
    await writeFile(join(path, "greet.txt"), "hello\nthere\npal\nbye\n")
    await writeFile(join(path, "notes.txt"), "notes\n")
    let before = git(path, "status", "--porcelain")

    let entered = await edit(path, { action: "enter", path, commit: greeting })

    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
    expect(git(path, "status", "--porcelain")).toBe("")
    expect(git(path, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1)
    expect(git(path, "stash", "list", "--format=%gs")).toBe("On feature: Working Changes before Historical Edit")
    expect(entered.sessions.map(s => [s.branch, s.commit, s.state])).toEqual([["refs/heads/feature", greeting, "active"]])
    expect(entered.operation).toBeUndefined()

    await edit(path, { action: "return", path, mode: "clean" })

    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
    expect(git(path, "status", "--porcelain")).toBe(before)
    expect(git(path, "stash", "list")).toBe("")
    expect((await edit(path, { action: "status" })).sessions).toEqual([])
    expect((await history(path)).entries).toEqual([])
}, 60_000)

test("entry refuses a detached worktree, Primary Branch history, populated submodules, and a second session; the worktree cannot switch away", async () => {
    let { path, base, greeting } = await stack()
    git(path, "update-ref", "refs/remotes/origin/main", greeting)

    await expect(edit(path, { action: "enter", path, commit: greeting })).rejects.toThrow("Primary Branch")

    git(path, "update-ref", "refs/remotes/origin/main", base)
    git(path, "switch", "-q", "--detach")

    await expect(edit(path, { action: "enter", path, commit: greeting })).rejects.toThrow("branch checked out")

    git(path, "switch", "-q", "feature")
    let module = await temporaryDirectory()
    git(module, "init", "-q")
    git(module, "commit", "-q", "--allow-empty", "-m", "module")
    git(path, "-c", "protocol.file.allow=always", "submodule", "add", "-q", module, "module")

    await expect(edit(path, { action: "enter", path, commit: greeting })).rejects.toThrow("submodules")

    git(path, "rm", "-q", "-f", "module")
    git(path, "reset", "-q", "--hard")
    await edit(path, { action: "enter", path, commit: greeting })

    await expect(edit(path, { action: "enter", path, commit: greeting })).rejects.toThrow("already in a Historical Edit")
    await expect(executeOperationCommand({ command: "worktree", request: { action: "switch", path, branch: "main", move: false }, noWait: false }, path))
        .rejects.toThrow("Return from the Historical Edit")
    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
}, 60_000)

test("apply rewrites the edited commit with its author and the current committer, restacks descendants, keeps unselected changes, and undoes", async () => {
    let { path, greeting, tip } = await stack()
    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hello, world\nthere\nfriend\n")
    await writeFile(join(path, "draft.txt"), "draft\n")
    git(path, "config", "user.name", "Cora Committer")

    await apply(path, ["greet.txt"])

    let rewritten = git(path, "rev-parse", "HEAD")

    expect(git(path, "show", "-s", "--date=iso-strict", "--format=%an|%ad|%cn|%s", rewritten)).toBe("Test|2026-10-01T09:00:00Z|Cora Committer|Add a greeting")
    expect(git(path, "rev-parse", "feature~2")).toBe(rewritten)
    expect(git(path, "show", "feature:greet.txt")).toBe("hello, world\nthere\npal")
    expect(git(path, "status", "--porcelain")).toBe("?? draft.txt")
    expect(await session(path)).toMatchObject({ commit: rewritten, tip: git(path, "rev-parse", "feature"), state: "active" })

    await executeOperationCommand({ command: "undo", noWait: false }, path)

    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
    expect(git(path, "rev-parse", "feature")).toBe(tip)
    expect(git(path, "status", "--porcelain")).toBe("M greet.txt\n?? draft.txt")
    expect(await session(path)).toMatchObject({ commit: greeting, tip, state: "active" })

    await executeOperationCommand({ command: "redo", noWait: false }, path)

    expect(git(path, "rev-parse", "HEAD")).toBe(rewritten)
}, 90_000)

test("apply runs commit hooks and signing; their failure leaves the session and its changes as they were", async () => {
    let { path, greeting } = await stack()
    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hello, world\nthere\nfriend\n")
    let hook = join(path, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\nexit 1\n")
    await chmod(hook, 0o755)

    await expect(apply(path)).rejects.toThrow("Saved checkout")
    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
    expect(git(path, "status", "--porcelain")).toBe("M greet.txt")

    await rm(hook)
    git(path, "config", "commit.gpgsign", "true")
    git(path, "config", "gpg.program", "laneway-missing-signing-program")

    await expect(apply(path)).rejects.toThrow()
    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
    expect(await session(path)).toMatchObject({ commit: greeting, state: "active" })
}, 60_000)

test("drop returns to the branch tip without the Historical Working Changes, and undo reopens the session with them", async () => {
    let { path, greeting, tip } = await stack()
    await writeFile(join(path, "notes.txt"), "notes\n")
    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hello, world\nthere\nfriend\n")

    let dropped = await edit(path, { action: "return", path, mode: "drop" })

    expect(dropped.operation?.summary).toBe("Drop Historical Working Changes and return to feature")
    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
    expect(git(path, "status", "--porcelain")).toBe("?? notes.txt")

    await executeOperationCommand({ command: "undo", noWait: false }, path)

    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
    expect(git(path, "status", "--porcelain")).toBe("M greet.txt")
    expect(git(path, "stash", "list", "--format=%gs")).toBe("On feature: Working Changes before Historical Edit")
    expect((await session(path))?.state).toBe("active")
}, 60_000)

test("bringing changes that conflict with the tip restores the original changes, then defers the historical ones; keep stashed leaves both apart", async () => {
    let { path, greeting, tip } = await stack()
    await writeFile(join(path, "notes.txt"), "notes\n")
    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hello\nthere\nbuddy\n")

    let brought = await edit(path, { action: "return", path, mode: "bring" })

    let label = `On feature: Historical Working Changes from ${greeting.slice(0, 8)} Add a greeting`
    let working = (await readConflictState(await connectRepository(path))).working

    expect(brought.operation?.summary).toBe("Bring Historical Working Changes to feature")
    expect(brought.message).toContain("Historical Working Changes conflict with feature")
    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
    expect(working).toHaveLength(1)
    expect(git(path, "stash", "list", "--format=%gs")).toBe(label)
    expect(await readFile(join(path, "greet.txt"), "utf8")).toContain("<<<<<<< Current files before restoring stash")
    expect(await readFile(join(path, "notes.txt"), "utf8")).toBe("notes\n")

    await keepStashed(path, working[0]!.id)

    expect(git(path, "status", "--porcelain")).toBe("?? notes.txt")
    expect(git(path, "stash", "list", "--format=%gs")).toBe(label)
}, 90_000)

test("when the original changes conflict on return, the historical ones wait as a labelled stash on the branch", async () => {
    let { path, greeting } = await stack()
    await writeFile(join(path, "greet.txt"), "hi\nthere\npal\n")
    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hey\nthere\nfriend\n")
    await apply(path)
    await writeFile(join(path, "extra.txt"), "extra\n")

    let brought = await edit(path, { action: "return", path, mode: "bring" })

    expect(brought.message).toContain("earlier Working Changes conflict with feature")
    expect((await readConflictState(await connectRepository(path))).working).toHaveLength(1)
    expect(git(path, "stash", "list", "--format=%gs").split("\n").toSorted()).toEqual([
        `On feature: Historical Working Changes from ${git(path, "rev-parse", "feature~2").slice(0, 8)} Add a greeting`,
        "On feature: Working Changes before Historical Edit",
    ])
    expect(await Bun.file(join(path, "extra.txt")).exists()).toBe(false)
}, 90_000)

test("two worktrees hold independent sessions, and applying in one leaves the other current", async () => {
    let { path, base, greeting } = await stack()
    let other = join(await temporaryDirectory(), "other")
    git(path, "worktree", "add", "-q", "-b", "other", other, base)
    let otherCommit = await commit(other, "other.txt", "other\n", "Other work")
    await commit(other, "other.txt", "other\nmore\n", "More other work")
    await edit(path, { action: "enter", path, commit: greeting })
    await edit(other, { action: "enter", path: other, commit: otherCommit })
    await writeFile(join(path, "greet.txt"), "hello, world\nthere\nfriend\n")

    await apply(path)

    let sessions = (await edit(path, { action: "status" })).sessions

    expect(sessions.map(s => [s.branch, s.state]).toSorted()).toEqual([["refs/heads/feature", "active"], ["refs/heads/other", "active"]])
    expect(git(other, "rev-parse", "HEAD")).toBe(otherCommit)
    expect(git(path, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(2)
}, 90_000)

test("a branch moved outside the session makes it stale; composition refuses it until it restarts on the latest tip", async () => {
    let { path, greeting } = await stack()
    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hello, world\nthere\nfriend\n")
    let other = join(await temporaryDirectory(), "other")
    git(path, "worktree", "add", "-q", other, "feature")
    await commit(other, "external.txt", "external\n", "External")
    git(path, "worktree", "remove", other)

    expect(await session(path)).toMatchObject({ state: "stale", reason: "feature moved outside this Historical Edit." })
    await expect(apply(path)).rejects.toThrow("out of date")

    await edit(path, { action: "restart", path })
    await apply(path)

    expect(git(path, "log", "--format=%s", "feature", "-2").split("\n")).toEqual(["External", "Wave goodbye"])
    expect(git(path, "show", "feature:greet.txt")).toBe("hello, world\nthere\npal")
    expect((await session(path))?.state).toBe("active")
}, 90_000)

test("a descendant conflict pauses the session at the rewritten commit until the Unresolved Stack resolves", async () => {
    let { path, greeting } = await stack()
    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hello\nthere\nbuddy\n")

    await apply(path, undefined, true)

    let paused = await session(path)

    expect(paused?.state).toBe("paused")
    expect(git(path, "rev-parse", "HEAD")).toBe(paused!.commit)
    expect(git(path, "show", "HEAD:greet.txt")).toBe("hello\nthere\nbuddy")
    await expect(edit(path, { action: "return", path, mode: "clean" })).rejects.toThrow("Resolve the conflicts on feature")

    let [subject] = (await conflict(path, { action: "list" })).conflicts
    let view = (await conflict(path, { action: "inspect", subject: subject!.id })).view!
    let chosen = await conflict(path, {
        action: "choose",
        subject: subject!.id,
        input: view.subject.input,
        revision: view.candidate.revision,
        file: "greet.txt",
        side: "right",
    })
    await conflict(path, { action: "accept", subject: subject!.id, input: view.subject.input, revision: chosen.view!.candidate.revision })

    expect((await session(path))?.state).toBe("active")
    expect(git(path, "rev-parse", "HEAD")).toBe(paused!.commit)

    await edit(path, { action: "return", path, mode: "clean" })

    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(path, "rev-parse", "feature~2")).toBe(paused!.commit)
}, 120_000)

test("an interrupted entry or return is rolled back by the next Engine run", async () => {
    let { path, greeting } = await stack()
    await writeFile(join(path, "notes.txt"), "notes\n")

    await engine(path, ["edit", "--request", JSON.stringify({ action: "enter", path, commit: greeting }), "--crash-after", "worktrees-committed"], 86)
    await engine(path, ["recover"])

    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(path, "status", "--porcelain")).toBe("?? notes.txt")
    expect(git(path, "stash", "list")).toBe("")
    expect((await edit(path, { action: "status" })).sessions).toEqual([])

    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hello, world\nthere\nfriend\n")
    await engine(path, ["edit", "--request", JSON.stringify({ action: "return", path, mode: "bring" }), "--crash-after", "worktrees-committed"], 86)
    await engine(path, ["recover"])

    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
    expect(git(path, "status", "--porcelain")).toBe("M greet.txt")
    expect((await session(path))?.state).toBe("active")
}, 120_000)

/** A feature branch of three commits on main, with a greeting its later commits build on. */
async function stack() {
    let { path, base } = await fixture()
    let greeting = await commit(path, "greet.txt", "hello\nthere\nfriend\n", "Add a greeting", "2026-10-01T09:00:00Z")
    await commit(path, "print.txt", "print\n", "Print it")
    let tip = await commit(path, "greet.txt", "hello\nthere\npal\n", "Wave goodbye")
    return { path, base, greeting, tip }
}

async function commit(path: string, file: string, content: string, message: string, date?: string) {
    await writeFile(join(path, file), content)
    git(path, "add", "--all")
    let result = Bun.spawnSync(["git", "commit", "-qm", message], { cwd: path, env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date } : {}) } })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return git(path, "rev-parse", "HEAD")
}

function edit(path: string, request: HistoricalEditRequest) {
    return executeOperationCommand({ command: "edit", request, noWait: false }, path) as Promise<HistoricalEditResult>
}

/** The Main Worktree's session, which is the fixture's own worktree. */
async function session(path: string) {
    return (await edit(path, { action: "status" })).sessions.find(s => s.worktreeId == "main")
}

async function apply(path: string, files?: string[], allowConflicts = false) {
    let current = (await session(path))!
    return perform(
        path,
        request({
            source: { kind: "working", worktreePath: path },
            target: { kind: "commit", objectId: current.commit, branch: current.branch },
            files: files?.map(file => ({ path: file })),
            message: "",
            allowConflicts,
        }),
    )
}

async function conflict(path: string, conflictRequest: ConflictRequest) {
    return await executeOperationCommand({ command: "conflict", request: conflictRequest, noWait: false }, path) as ConflictResult
}

async function keepStashed(path: string, subject: string) {
    let view = (await conflict(path, { action: "inspect", subject })).view!
    return conflict(path, { action: "keep-stashed", subject, input: view.subject.input, revision: view.candidate.revision })
}

async function history(path: string) {
    let result = await executeOperationCommand({ command: "history", noWait: false }, path)
    return result as Extract<typeof result, { command: "history" }>
}

async function engine(path: string, args: string[], expected = 0) {
    let child = Bun.spawn([resolve(import.meta.dir, "../bin/lane.exe"), ...args, "--json"], {
        cwd: path,
        env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1" },
        stdout: "pipe",
        stderr: "pipe",
    })
    let [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (exitCode != expected)
        throw new Error(`lane ${args[0]} exited ${exitCode}: ${stderr}`)
}

async function temporaryDirectory() {
    let path = await mkdtemp(join(tmpdir(), "laneway-historical-edit-"))
    directories.push(path)
    return path
}
