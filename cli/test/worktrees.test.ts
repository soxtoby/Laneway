import { connectRepository, pathExists, previewWorktree, readRegisteredWorktrees } from "@laneway/git"
import type { WorktreeRequest } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"

let temporary: string[] = []
afterEach(async () => {
    for (let path of temporary.splice(0))
        await rm(path, { recursive: true, force: true })
})

test("create, dirty transfer, undo and redo preserve both worktrees and the index", async () => {
    let path = await fixture()
    await perform(path, { action: "create", branch: "feature", move: false })
    let linked = join(`${path}.worktrees`, "feature")
    await writeFile(join(linked, "a.txt"), "staged\n")
    git(linked, "add", "a.txt")
    await writeFile(join(linked, "a.txt"), "unstaged\n")
    await writeFile(join(linked, "new.txt"), "untracked\n")
    let binary = Buffer.from([0, 255, 10, 13, 128])
    await writeFile(join(linked, "δ space.bin"), binary)
    await writeFile(join(path, "a.txt"), "main edits\n")
    await perform(path, { action: "switch", path, branch: "feature", move: true })

    expect(git(path, "branch", "--show-current")).toBe("feature")
    expect(git(linked, "branch", "--show-current")).toBe("")
    expect(git(path, "stash", "list").split("\n")).toHaveLength(2)

    await transition(path, "undo")

    expect(await readFile(join(linked, "a.txt"), "utf8")).toBe("unstaged\n")
    expect(git(linked, "show", ":a.txt")).toBe("staged")
    expect(await readFile(join(linked, "new.txt"), "utf8")).toBe("untracked\n")
    expect(await readFile(join(linked, "δ space.bin"))).toEqual(binary)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("main edits\n")
    expect(git(linked, "branch", "--show-current")).toBe("feature")

    await transition(path, "redo")

    expect(git(path, "branch", "--show-current")).toBe("feature")
}, 60_000)

test("removal restores exact discarded Git state, excludes ignored files, and guards external changes", async () => {
    let path = await fixture()
    await perform(path, { action: "create", branch: "feature", move: false })
    let linked = join(`${path}.worktrees`, "feature")
    await writeFile(join(linked, "new.txt"), "keep for undo\n")
    await writeFile(join(linked, "ignored.txt"), "outside undo\n")

    await expect(perform(path, { action: "remove", path: linked, preserve: false, allowIgnoredLoss: false })).rejects.toThrow("ignored")

    await perform(path, { action: "remove", path: linked, preserve: false, allowIgnoredLoss: true })

    expect(await Bun.file(join(linked, "new.txt")).exists()).toBe(false)

    await transition(path, "undo")

    expect(await readFile(join(linked, "new.txt"), "utf8")).toBe("keep for undo\n")
    expect(await Bun.file(join(linked, "ignored.txt")).exists()).toBe(false)

    await transition(path, "redo")
    await transition(path, "undo")
    await writeFile(join(linked, "new.txt"), "external\n")

    await expect(transition(path, "redo")).rejects.toThrow("outside Laneway")
    expect(await readFile(join(linked, "new.txt"), "utf8")).toBe("external\n")
}, 60_000)

test("rename retains registration identity; locked/main protections and preview freshness", async () => {
    let path = await fixture()
    let repository = await connectRepository(path)
    await perform(path, { action: "create", branch: "feature", move: false })
    let linked = join(`${path}.worktrees`, "feature")
    let id = (await readRegisteredWorktrees(repository))[1]!.id
    git(path, "worktree", "lock", "--reason", "external drive", linked)

    await expect(perform(path, { action: "rename", path: linked, basename: "renamed" })).rejects.toThrow("Unlock")

    await perform(path, { action: "unlock", path: linked })
    await writeFile(join(linked, "ignored.txt"), "keep through rename\n")
    await perform(path, { action: "rename", path: linked, basename: "renamed" })

    expect((await readRegisteredWorktrees(repository))[1]!.id).toBe(id)

    await transition(path, "undo")

    expect(await readFile(join(linked, "ignored.txt"), "utf8")).toBe("keep through rename\n")
    expect((await readRegisteredWorktrees(repository))[1]!.path).toBe(resolve(linked))
    await expect(perform(path, { action: "remove", path, preserve: true, allowIgnoredLoss: false })).rejects.toThrow("Main Worktree")

    let request: WorktreeRequest = { action: "switch", path, branch: "feature", move: true }
    let preview = await previewWorktree(repository, request)
    await writeFile(join(linked, "a.txt"), "external\n")

    await expect(executeOperationCommand({ command: "worktree", request, token: preview.token, noWait: false }, path)).rejects.toThrow("after preview")
}, 60_000)

test("missing worktrees can be located, repaired, removed and recovered without pruning neighbors", async () => {
    let path = await fixture()
    await perform(path, { action: "create", branch: "feature", move: false })
    let linked = join(`${path}.worktrees`, "feature")
    let moved = join(`${path}.worktrees`, "moved")
    await rename(linked, moved)
    await perform(path, { action: "repair", path: linked, destination: moved })

    expect(git(moved, "rev-parse", "--show-toplevel").replaceAll("\\", "/")).toBe(moved.replaceAll("\\", "/"))

    await rm(moved, { recursive: true })
    await perform(path, { action: "remove", path: moved, preserve: true, allowIgnoredLoss: false })

    expect(git(path, "worktree", "list", "--porcelain")).not.toContain("moved")

    await transition(path, "undo")

    expect(git(path, "worktree", "list", "--porcelain")).toContain("moved")
}, 60_000)

test("dirty populated submodules survive preserving removal and undo", async () => {
    let module = await fixture()
    let path = await fixture()
    git(path, "-c", "protocol.file.allow=always", "submodule", "add", module, "module")
    git(path, "commit", "-qam", "add submodule")
    git(path, "branch", "-f", "feature", "HEAD")
    await perform(path, { action: "create", branch: "feature", move: false })
    let linked = join(`${path}.worktrees`, "feature")
    git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init")
    git(join(linked, "module"), "config", "user.name", "Laneway Test")
    git(join(linked, "module"), "config", "user.email", "test@example.invalid")
    await writeFile(join(linked, "module", "a.txt"), "module edits\n")

    await expect(perform(path, { action: "rename", path: linked, basename: "no" })).rejects.toThrow("populated submodules")

    await perform(path, { action: "remove", path: linked, preserve: true, allowIgnoredLoss: false })
    await transition(path, "undo")

    expect(await readFile(join(linked, "module", "a.txt"), "utf8")).toBe("module edits\n")
    expect(git(join(linked, "module"), "status", "--porcelain")).toContain("a.txt")

    await transition(path, "redo")
    await transition(path, "undo")

    expect(await readFile(join(linked, "module", "a.txt"), "utf8")).toBe("module edits\n")
}, 120_000)

test("removal undo accepts an alternate basename without overwriting an occupied original path", async () => {
    let path = await fixture()
    await perform(path, { action: "create", branch: "feature", move: false })
    let linked = join(`${path}.worktrees`, "feature")
    await perform(path, { action: "remove", path: linked, preserve: true, allowIgnoredLoss: false })
    await mkdir(linked)
    await writeFile(join(linked, "unrelated.txt"), "do not overwrite")

    await expect(transition(path, "undo")).rejects.toThrow("occupied")

    await executeOperationCommand({ command: "undo", noWait: false, worktreeBasename: "restored" }, path)
    let restored = join(`${path}.worktrees`, "restored")

    expect(git(restored, "branch", "--show-current")).toBe("feature")
    expect(await readFile(join(linked, "unrelated.txt"), "utf8")).toBe("do not overwrite")

    await transition(path, "redo")

    expect(await Bun.file(join(restored, ".git")).exists()).toBe(false)

    await transition(path, "undo")

    expect(git(restored, "branch", "--show-current")).toBe("feature")
}, 60_000)

test("detached unique commits are protected before switching, and an external prune blocks undo", async () => {
    let path = await fixture()
    let head = git(path, "rev-parse", "HEAD")
    await perform(path, { action: "create", commit: head, move: false })
    let linked = join(`${path}.worktrees`, `detached-${head.slice(0, 8)}`)
    await writeFile(join(linked, "a.txt"), "unique commit\n")
    git(linked, "commit", "-qam", "detached work")
    let unique = git(linked, "rev-parse", "HEAD")
    git(path, "worktree", "lock", "--reason", "keep registration", linked)
    await perform(path, { action: "switch", path: linked, branch: "feature", move: false })

    expect(git(path, "branch", "--contains", unique)).toContain("worktree/")

    await transition(path, "undo")

    expect(git(linked, "rev-parse", "HEAD")).toBe(unique)

    await perform(path, { action: "unlock", path: linked })
    await rm(linked, { recursive: true })
    git(path, "worktree", "prune", "--expire", "now")

    await expect(transition(path, "undo")).rejects.toThrow("outside Laneway")
}, 60_000)

test("compiled engine recovers worktree apply and undo at durable journal boundaries", async () => {
    let executable = resolve(import.meta.dir, "../bin/lane.exe")
    for (let phase of ["intent", "recovery-retained", "preconditions-verified", "worktrees-committed", "refs-committed", "history-committed"]) {
        let path = await fixture()
        await engine(path, ["worktree", "--request", JSON.stringify({ action: "create", branch: "feature" }), "--crash-after", phase], 86)
        await engine(path, ["recover"])
        let linked = join(`${path}.worktrees`, "feature")
        if (phase != "history-committed")
            expect(await Bun.file(join(linked, ".git")).exists()).toBe(false)
        else {
            expect(git(linked, "branch", "--show-current")).toBe("feature")

            await engine(path, ["undo", "--crash-after", "preconditions-verified"], 86)
            await engine(path, ["recover"])

            expect(git(linked, "branch", "--show-current")).toBe("feature")

            await engine(path, ["undo"])

            expect(await Bun.file(join(linked, ".git")).exists()).toBe(false)

            await engine(path, ["redo"])

            expect(git(linked, "branch", "--show-current")).toBe("feature")
        }
    }
    async function engine(path: string, args: string[], expected = 0) {
        let child = Bun.spawn([executable, ...args, "--json"], {
            cwd: path,
            env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1", LANEWAY_SETTINGS_PATH: join(path, "settings.json") },
            stdout: "pipe",
            stderr: "pipe",
        })
        let [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])

        expect(code, output + error).toBe(expected)
    }
}, 180_000)

test("interrupted removal is inspectable and recovery preserves leftovers and unrelated refs", async () => {
    let { path, linked, operationId } = await interruptedRemoval()
    git(path, "branch", "unrelated")
    let status = await executeOperationCommand({ command: "recovery-status", noWait: false }, path)

    expect(status).toMatchObject({ command: "recovery-status", worktrees: [{ operationId, path: linked, message: expect.stringContaining("directory") }] })

    await executeOperationCommand({ command: "recover", noWait: false, request: { operationId, action: "restore" } }, path)

    expect(git(linked, "branch", "--show-current")).toBe("feature")
    expect(git(linked, "show", ":a.txt")).toBe("staged")
    expect(await readFile(join(linked, "a.txt"), "utf8")).toBe("unstaged\n")
    expect(await readFile(join(linked, "new.txt"), "utf8")).toBe("saved untracked\n")
    expect(await readFile(join(`${linked}.laneway-recovery-${operationId}`, "leftover.txt"), "utf8")).toBe("preserve leftover\n")

    temporary.push(`${linked}.laneway-recovery-${operationId}`)

    expect(git(path, "rev-parse", "unrelated")).toBe(git(path, "rev-parse", "main"))
    expect(await executeOperationCommand({ command: "recovery-status", noWait: false }, path)).toMatchObject({ worktrees: [] })
}, 30_000)

test("finishing interrupted removal deletes leftovers and retains the saved Git state for undo after GC", async () => {
    let { path, linked, operationId } = await interruptedRemoval()
    let result = await executeOperationCommand({ command: "recover", noWait: false, request: { operationId, action: "remove" } }, path)
    temporary.push(`${linked}.laneway-recovery-${operationId}`)

    expect(result).toMatchObject({ command: "recover", backupPath: undefined })
    expect(await pathExists(linked)).toBe(false)
    expect(await pathExists(`${linked}.laneway-recovery-${operationId}`)).toBe(false)
    expect((await readRegisteredWorktrees(await connectRepository(path))).some(w => w.path == linked)).toBe(false)
    expect(await executeOperationCommand({ command: "history", noWait: false }, path)).toMatchObject({
        entries: [expect.objectContaining({ id: operationId, kind: "worktree.remove", isNextUndo: true }), expect.anything()],
    })

    git(path, "reflog", "expire", "--expire=now", "--all")
    git(path, "gc", "--prune=now")
    await transition(path, "undo")

    expect(git(linked, "show", ":a.txt")).toBe("staged")
    expect(await readFile(join(linked, "a.txt"), "utf8")).toBe("unstaged\n")
    expect(await readFile(join(linked, "new.txt"), "utf8")).toBe("saved untracked\n")
    expect(await Bun.file(join(linked, "leftover.txt")).exists()).toBe(false)
}, 30_000)

test("recovery actions can retry after interruption without replacing their backup or automatically recreating a removed worktree", async () => {
    for (let action of ["restore", "remove"] as const) {
        let { path, linked, operationId } = await interruptedRemoval()
        temporary.push(`${linked}.laneway-recovery-${operationId}`)
        await interruptRecovery(path, operationId, action)
        if (action == "remove") {
            await expect(
                executeOperationCommand({ command: "local-preview", noWait: false, request: { action: "stage", path, unstage: false, files: [] } }, path),
            ).rejects.toMatchObject({ code: "operation.recovery-blocked" })
        }
        await executeOperationCommand({ command: "recover", noWait: false, request: { operationId, action } }, path)
        if (action == "restore")
            expect(await readFile(join(`${linked}.laneway-recovery-${operationId}`, "leftover.txt"), "utf8")).toBe("preserve leftover\n")
        else
            expect(await Bun.file(join(`${linked}.laneway-recovery-${operationId}`, "leftover.txt")).exists()).toBe(false)

        expect((await readRegisteredWorktrees(await connectRepository(path))).some(w => w.path == linked)).toBe(action == "restore")
        expect(await executeOperationCommand({ command: "recovery-status", noWait: false }, path)).toMatchObject({ worktrees: [] })
    }
}, 30_000)

test("Remove after interrupted recovery deletes its leftover backup and still supports Undo", async () => {
    let { path, linked, operationId } = await interruptedRemoval()
    let backup = `${linked}.laneway-recovery-${operationId}`
    temporary.push(backup)
    await interruptRecovery(path, operationId, "restore")

    expect(await pathExists(backup)).toBe(true)

    await executeOperationCommand({ command: "recover", noWait: false, request: { operationId, action: "remove" } }, path)

    expect(await pathExists(linked)).toBe(false)
    expect(await pathExists(backup)).toBe(false)

    await transition(path, "undo")

    expect(git(linked, "show", ":a.txt")).toBe("staged")
    expect(await readFile(join(linked, "a.txt"), "utf8")).toBe("unstaged\n")
    expect(await readFile(join(linked, "new.txt"), "utf8")).toBe("saved untracked\n")
    expect(await Bun.file(join(linked, "leftover.txt")).exists()).toBe(false)
}, 30_000)

test("Remove refuses an unrelated worktree occupying the recovery backup", async () => {
    let { path, linked, operationId } = await interruptedRemoval()
    let backup = `${linked}.laneway-recovery-${operationId}`
    temporary.push(backup)
    git(path, "worktree", "add", "--detach", backup, "main")

    await expect(executeOperationCommand({ command: "recover", noWait: false, request: { operationId, action: "remove" } }, path)).rejects.toThrow(
        "Another worktree occupies the recovery backup",
    )
    expect(git(backup, "rev-parse", "HEAD")).toBe(git(path, "rev-parse", "main"))
    expect(await readFile(join(linked, "leftover.txt"), "utf8")).toBe("preserve leftover\n")
}, 30_000)

test("Recover refuses a changed branch while Remove preserves the new branch tip through Undo", async () => {
    let { path, linked, operationId } = await interruptedRemoval()
    await writeFile(join(path, "a.txt"), "later branch state\n")
    git(path, "commit", "-qam", "Later work")
    let later = git(path, "rev-parse", "HEAD")
    git(path, "branch", "-f", "feature", later)

    await expect(executeOperationCommand({ command: "recover", noWait: false, request: { operationId, action: "restore" } }, path)).rejects.toThrow(
        "saved branch has changed",
    )
    expect(await readFile(join(linked, "leftover.txt"), "utf8")).toBe("preserve leftover\n")

    await executeOperationCommand({ command: "recover", noWait: false, request: { operationId, action: "remove" } }, path)
    temporary.push(`${linked}.laneway-recovery-${operationId}`)
    await transition(path, "undo")

    expect(git(path, "rev-parse", "feature")).toBe(later)
    expect(Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd: linked, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(1)
}, 30_000)
async function transition(path: string, command: "undo" | "redo") {
    return executeOperationCommand({ command, noWait: false }, path)
}

async function interruptedRemoval() {
    let path = await fixture()
    await perform(path, { action: "create", branch: "feature", move: false })
    let linked = join(`${path}.worktrees`, "feature")
    await writeFile(join(linked, "a.txt"), "staged\n")
    git(linked, "add", "a.txt")
    await writeFile(join(linked, "a.txt"), "unstaged\n")
    await writeFile(join(linked, "new.txt"), "saved untracked\n")
    let child = Bun.spawn([
        process.execPath,
        resolve(import.meta.dir, "../src/main.ts"),
        "worktree",
        "--request",
        JSON.stringify({
            action: "remove",
            path: linked,
            preserve: true,
            allowIgnoredLoss: true,
        }),
        "--crash-after",
        "intent",
        "--json",
    ], {
        cwd: path,
        env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1", LANEWAY_SETTINGS_PATH: join(path, "settings.json") },
        stdout: "pipe",
        stderr: "pipe",
    })

    expect(await child.exited, await new Response(child.stderr).text()).toBe(86)

    let intent = (await readFile(join(path, ".git/laneway/journal.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).at(-1)
    git(path, "worktree", "remove", "--force", linked)
    await mkdir(linked)
    await writeFile(join(linked, "leftover.txt"), "preserve leftover\n")
    return { path, linked, operationId: intent.operationId as string }
}
async function fixture() {
    let path = await mkdtemp(join(tmpdir(), "worktree-lifecycle-"))
    temporary.push(path, `${path}.worktrees`)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Laneway Test")
    git(path, "config", "user.email", "test@example.invalid")
    await writeFile(join(path, "a.txt"), "base\n")
    await writeFile(join(path, ".gitignore"), "ignored.txt\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "initial")
    git(path, "branch", "feature")
    return path
}
function git(cwd: string, ...args: string[]) {
    let result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
}
async function perform(path: string, request: WorktreeRequest) {
    return executeOperationCommand({ command: "worktree", request, noWait: false }, path)
}

async function interruptRecovery(path: string, operationId: string, action: "restore" | "remove") {
    let child = Bun.spawn([
        process.execPath,
        resolve(import.meta.dir, "../src/main.ts"),
        "recover",
        "--request",
        JSON.stringify({ operationId, action }),
        "--crash-after",
        "worktrees-committed",
        "--json",
    ], {
        cwd: path,
        env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1", LANEWAY_SETTINGS_PATH: join(path, "settings.json") },
        stdout: "pipe",
        stderr: "pipe",
    })

    expect(await child.exited, await new Response(child.stderr).text()).toBe(86)
}
