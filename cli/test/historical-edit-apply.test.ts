import { afterEach, expect, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { git } from "./composition-fixture"
import { acceptSide, apply, commit, createHistoricalEditFixtures, edit, externalCommit, session } from "./historical-edit-fixture"

let { stack, temporaryDirectory, cleanup } = createHistoricalEditFixtures()
afterEach(cleanup)

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

test("a signing failure leaves the session as it was; pre-commit checks the applied result in the session's worktree", async () => {
    let { path, greeting } = await stack()
    await edit(path, { action: "enter", path, commit: greeting })
    await writeFile(join(path, "greet.txt"), "hello, world\nthere\nfriend\n")
    git(path, "config", "commit.gpgsign", "true")
    git(path, "config", "gpg.program", "laneway-missing-signing-program")

    await expect(apply(path)).rejects.toThrow()
    expect(git(path, "rev-parse", "HEAD")).toBe(greeting)
    expect(git(path, "status", "--porcelain")).toBe("M greet.txt")
    expect(await session(path)).toMatchObject({ commit: greeting, state: "active" })

    git(path, "config", "commit.gpgsign", "false")
    let hook = join(path, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\ngrep -q friend greet.txt && echo 'no friends allowed' >&2 && exit 1\nexit 0\n")
    await chmod(hook, 0o755)

    let applied = await apply(path)

    expect(applied.hookFailure?.output).toBe("no friends allowed")
    expect(git(path, "show", "HEAD:greet.txt")).toBe("hello, world\nthere\nfriend")
}, 60_000)

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

    let pinned = git(path, "rev-parse", "feature")
    git(path, "update-ref", "refs/heads/feature", externalCommit(path, pinned))

    expect((await session(path))?.state).toBe("stale")

    git(path, "update-ref", "refs/heads/feature", pinned)
    await acceptSide(path)
    let accepted = git(path, "rev-parse", "feature")

    expect((await session(path))?.state).toBe("active")
    expect(git(path, "rev-parse", "HEAD")).toBe(paused!.commit)

    git(path, "update-ref", "refs/heads/feature", externalCommit(path, accepted))

    expect((await session(path))?.state).toBe("stale")

    git(path, "update-ref", "refs/heads/feature", accepted)
    await edit(path, { action: "return", path, mode: "clean" })

    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(path, "rev-parse", "feature~2")).toBe(paused!.commit)
}, 120_000)

test("accepting a conflict before another session's commit on the same branch moves that session with its changes, or refuses staged overlaps", async () => {
    let { path, greeting } = await stack()
    let later = await commit(path, "extra.txt", "extra\n", "Add extra")
    await edit(path, { action: "enter", path, commit: greeting })
    let other = join(await temporaryDirectory(), "other")
    git(path, "worktree", "add", "-q", other, "feature")
    await edit(other, { action: "enter", path: other, commit: later })
    await writeFile(join(other, "draft.txt"), "draft\n")
    await writeFile(join(path, "greet.txt"), "hello\nthere\nbuddy\n")
    await apply(path, undefined, true)
    let paused = git(other, "rev-parse", "HEAD")
    await writeFile(join(other, "greet.txt"), "hello\nthere\nmate\n")
    git(other, "add", "greet.txt")
    git(other, "restore", "--source=HEAD", "--worktree", "greet.txt")

    await expect(acceptSide(path, "left")).rejects.toThrow("overlap this resolution")

    expect(git(other, "rev-parse", "HEAD")).toBe(paused)
    expect(git(other, "show", ":greet.txt")).toBe("hello\nthere\nmate")

    git(other, "restore", "--staged", "greet.txt")
    await acceptSide(path, "left")

    let tip = git(path, "rev-parse", "feature")
    let sessions = (await edit(path, { action: "status" })).sessions

    expect(sessions.map(s => s.state)).toEqual(["active", "active"])
    expect(sessions.find(s => s.worktreeId != "main")?.commit).toBe(tip)
    expect(git(other, "rev-parse", "HEAD")).toBe(tip)
    expect(await readFile(join(other, "draft.txt"), "utf8")).toBe("draft\n")
}, 120_000)
