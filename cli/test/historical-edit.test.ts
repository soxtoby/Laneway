import { connectRepository, readConflictState } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { git } from "./composition-fixture"
import { apply, commit, createHistoricalEditFixtures, edit, history, keepStashed, session } from "./historical-edit-fixture"

let { stack, temporaryDirectory, cleanup } = createHistoricalEditFixtures()
afterEach(cleanup)

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
    expect(git(path, "show", ":print.txt")).toBe("print loudly")
    expect(await readFile(join(path, "print.txt"), "utf8")).toBe("print loudly\n")
    expect(git(path, "show", ":greet.txt")).toBe("hello\nthere\npal")
    expect(await readFile(join(path, "greet.txt"), "utf8")).toBe("hello\nthere\npal\nbye\n")
    expect(await readFile(join(path, "notes.txt"), "utf8")).toBe("notes\n")
    expect(git(path, "stash", "list")).toBe("")
    expect((await edit(path, { action: "status" })).sessions).toEqual([])
    expect((await history(path)).entries).toEqual([])
}, 60_000)

test("the Branch Graph keeps a session's worktree in its original branch's column, with the session and its stash marker", async () => {
    let { path, greeting } = await stack()
    await writeFile(join(path, "notes.txt"), "notes\n")
    await edit(path, { action: "enter", path, commit: greeting })

    let graph = await (await connectRepository(path)).startReadBranchGraph({ authorIdentities: { secondary: [] }, remotePatterns: [] }).result

    let feature = graph.branches.find(branch => branch.name == "feature")!
    let worktree = feature.checkedOut[0]!
    expect(graph.virtualBranches).toEqual([])
    expect(feature.checkedOut.map(w => [w.branchRef, w.head, w.historicalEdit?.subject, w.historicalEdit?.state])).toEqual([[
        "refs/heads/feature",
        greeting,
        "Add a greeting",
        "active",
    ]])
    expect(feature.markers.map(marker => marker.objectId)).toEqual([worktree.historicalEdit!.stash!])
}, 60_000)

test("the Branch Graph gives a session its own column once another worktree checks out its branch, whose stash marker stays", async () => {
    let { path, greeting } = await stack()
    await writeFile(join(path, "notes.txt"), "notes\n")
    await edit(path, { action: "enter", path, commit: greeting })
    git(path, "worktree", "add", "-q", join(await temporaryDirectory(), "other"), "feature")

    let graph = await (await connectRepository(path)).startReadBranchGraph({ authorIdentities: { secondary: [] }, remotePatterns: [] }).result

    let feature = graph.branches.find(branch => branch.name == "feature")!
    expect(feature.checkedOut.map(w => [w.main, w.historicalEdit?.state])).toEqual([[false, undefined]])
    expect(graph.virtualBranches.map(virtual => [virtual.worktree.main, virtual.worktree.historicalEdit?.state])).toEqual([[true, "active"]])
    expect(feature.markers.map(marker => marker.objectId)).toEqual([graph.virtualBranches[0]!.worktree.historicalEdit!.stash!])
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
