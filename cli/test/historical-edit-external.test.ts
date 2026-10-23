import { afterEach, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { git } from "./composition-fixture"
import { apply, commit, createHistoricalEditFixtures, edit, engine, session } from "./historical-edit-fixture"

let { stack, temporaryDirectory, cleanup } = createHistoricalEditFixtures()
afterEach(cleanup)

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

test("return after an external rewrite replaced the edited commit refuses only commits made on top of it", async () => {
    let { path, base, greeting, tip } = await stack()
    await writeFile(join(path, "notes.txt"), "notes\n")
    await edit(path, { action: "enter", path, commit: greeting })
    let squashed = git(path, "commit-tree", `${tip}^{tree}`, "-p", base, "-m", "Squashed")
    git(path, "update-ref", "refs/heads/feature", squashed)
    await commit(path, "new.txt", "new\n", "New work")

    await expect(edit(path, { action: "return", path, mode: "clean" })).rejects.toThrow("Create a branch")

    git(path, "reset", "-q", "--hard", greeting)
    await edit(path, { action: "return", path, mode: "clean" })

    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(path, "rev-parse", "HEAD")).toBe(squashed)
    expect(await readFile(join(path, "notes.txt"), "utf8")).toBe("notes\n")
}, 90_000)

test("an interrupted entry or return is reversed before its record and completed after it, keeping later edits", async () => {
    let { path, greeting, tip } = await stack()
    await writeFile(join(path, "notes.txt"), "notes\n")

    await engine(path, ["edit", "--request", JSON.stringify({ action: "enter", path, commit: greeting }), "--crash-after", "intent"], 86)
    await engine(path, ["recover"])

    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(path, "status", "--porcelain")).toBe("?? notes.txt")
    expect(git(path, "stash", "list")).toBe("")
    expect((await edit(path, { action: "status" })).sessions).toEqual([])

    await engine(path, ["edit", "--request", JSON.stringify({ action: "enter", path, commit: greeting }), "--crash-after", "recorded"], 86)
    await writeFile(join(path, "draft.txt"), "draft\n")
    await engine(path, ["recover"])

    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
    expect(await readFile(join(path, "draft.txt"), "utf8")).toBe("draft\n")
    expect(git(path, "stash", "list", "--format=%gs")).toBe("On feature: Working Changes before Historical Edit")
    expect((await session(path))?.state).toBe("active")

    await rm(join(path, "draft.txt"))
    await writeFile(join(path, "greet.txt"), "hello, world\nthere\nfriend\n")
    await engine(path, ["edit", "--request", JSON.stringify({ action: "return", path, mode: "bring" }), "--crash-after", "recorded"], 86)
    await engine(path, ["recover"])

    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
    expect(await readFile(join(path, "greet.txt"), "utf8")).toBe("hello, world\nthere\npal\n")
    expect(await readFile(join(path, "notes.txt"), "utf8")).toBe("notes\n")
    expect((await edit(path, { action: "status" })).sessions).toEqual([])
}, 120_000)
