import { connectRepository } from "@laneway/git"
import type { CompositionRequest, LocalResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { prepareComposition } from "../src/composition"
import { prepareFileExtraction } from "../src/file-extraction"
import { executeOperationCommand } from "../src/operation-runtime"

const directories: string[] = []
afterEach(async () => {
    for (const path of directories.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})
async function fixture(format = "sha1") {
    const path = await mkdtemp(join(tmpdir(), "laneway-extract-"))
    directories.push(path)
    const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
    }
    git("init", "-q", "-b", "main", `--object-format=${format}`)
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.invalid")
    git("config", "commit.gpgsign", "false")
    for (const name of ["selected.txt", "retained.txt", "unrelated.txt"])
        await writeFile(join(path, name), "before\n")
    git("add", ".")
    git("commit", "-qm", "Base")
    git("remote", "add", "origin", "https://example.invalid/fixture.git")
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"))
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    git("checkout", "-qb", "feature")
    for (const name of ["selected.txt", "retained.txt"])
        await writeFile(join(path, name), "after\n")
    git("add", ".")
    git("commit", "-qm", "Selected change")
    const source = git("rev-parse", "HEAD")
    for (let i = 0; i < 3; i++) {
        await writeFile(join(path, `descendant-${i}.txt`), `${i}\n`)
        git("add", ".")
        git("commit", "-qm", `Descendant ${i}`)
    }
    const head = git("rev-parse", "HEAD")
    const request: CompositionRequest = {
        action: "compose",
        source: { kind: "commit", objectId: source, branch: "feature" },
        target: { kind: "working", worktreePath: path },
        mode: "move",
        files: [{ path: "selected.txt" }],
        view: "combined",
        descendants: true,
        message: "",
        allowConflicts: false,
    }
    return { path, git, head, source, request }
}

for (const format of ["sha1", "sha256"]) {
    test(`file extraction scopes recovery and preserves unrelated working edits through undo and redo (${format})`, async () => {
        const { path, git, head, request } = await fixture(format)
        const repo = await connectRepository(path)
        const prepared = await prepareComposition(repo, request)
        expect(prepared.before.worktrees.find(worktree => worktree.path == path)?.scope).toEqual(["selected.txt"])
        const result = await executeOperationCommand({ command: "local", request, token: prepared.preview.token, noWait: false }, path) as LocalResult
        expect(result.status).toBe("performed")
        expect(git("show", "HEAD:selected.txt")).toBe("before")
        expect(git("show", ":selected.txt")).toBe("before")
        expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("after\n")
        expect(git("diff", "--name-only", head, "HEAD")).toBe("selected.txt")
        expect(git("log", "--format=%an|%ae|%aI|%B", "main..HEAD")).toBe(git("log", "--format=%an|%ae|%aI|%B", `main..${head}`))
        expect(git("for-each-ref", "--format=%(refname)", "refs/laneway")).toBe("")
        await writeFile(join(path, "unrelated.txt"), "external edit after transfer\n")
        git("-c", "gc.reflogExpire=never", "-c", "gc.reflogExpireUnreachable=never", "gc", "--prune=now")
        await executeOperationCommand({ command: "undo", noWait: false }, path)
        expect(git("rev-parse", "HEAD")).toBe(head)
        expect(await readFile(join(path, "unrelated.txt"), "utf8")).toBe("external edit after transfer\n")
        await executeOperationCommand({ command: "redo", noWait: false }, path)
        expect(git("show", ":selected.txt")).toBe("before")
        expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("after\n")
        expect(await readFile(join(path, "unrelated.txt"), "utf8")).toBe("external edit after transfer\n")
    }, 30_000)
}

test("file extraction rejects a stale selected file and falls back when descendants touch it", async () => {
    const { path, git, request } = await fixture()
    const prepared = await prepareComposition(await connectRepository(path), request)
    await writeFile(join(path, "selected.txt"), "external edit\n")
    await expect(executeOperationCommand({ command: "local", request, token: prepared.preview.token, noWait: false }, path)).rejects.toThrow("changed")
    git("add", "selected.txt")
    git("commit", "-qm", "Descendant edits the selected path")
    const fallback = await prepareComposition(await connectRepository(path), request)
    expect(fallback.before.worktrees.find(worktree => worktree.path == path)?.scope).toBeUndefined()
}, 30_000)

test("file extraction leaves shared history, hooks, and staged selected content to the general planner", async () => {
    const { path, git, source, request } = await fixture()
    const repo = await connectRepository(path)
    git("branch", "shared", source)
    expect(await prepareFileExtraction(repo, request)).toBeUndefined()
    git("branch", "-D", "shared")
    git("config", "core.hooksPath", ".hooks")
    expect(await prepareFileExtraction(repo, request)).toBeUndefined()
    git("config", "--unset", "core.hooksPath")
    await writeFile(join(path, "selected.txt"), "already staged\n")
    git("add", "selected.txt")
    expect(await prepareFileExtraction(repo, request)).toBeUndefined()
    expect(git("show", ":selected.txt")).toBe("already staged")
}, 30_000)

test("one-shot transfer applies eligible extraction but returns a preview for shared history", async () => {
    const { path, git, source, head, request } = await fixture()
    git("branch", "shared", source)
    const preview = await executeOperationCommand({ command: "local-transfer", request, noWait: false }, path) as LocalResult
    expect(preview.status).toBe("preview")
    expect(git("rev-parse", "HEAD")).toBe(head)
    git("branch", "-D", "shared")
    const applied = await executeOperationCommand({ command: "local-transfer", request, noWait: false }, path) as LocalResult
    expect(applied.status).toBe("performed")
    expect(git("show", ":selected.txt")).toBe("before")
    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("after\n")
}, 30_000)

test("transfers retain only the starting checkpoint and capture redo when undo runs", async () => {
    const { path, git, head, request } = await fixture()
    await executeOperationCommand({ command: "local-transfer", request, noWait: false }, path)
    const after = git("rev-parse", "HEAD")
    const history = () => readFile(join(path, ".git", "laneway", "history.jsonl"), "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line)))
    const initial = (await history())[0].operation
    expect(initial.lifecycle).toBeUndefined()
    expect(initial.checkpoint.restore.refs["refs/heads/feature"]).toBe(head)
    expect(initial.checkpoint.restore.worktrees[0].stash).toBeUndefined()
    expect(initial.checkpoint.expected.worktrees[0].stash).toBeUndefined()
    const retained = async () => {
        const envelope = JSON.parse(await readFile(join(path, ".git", "laneway", "recovery-objects.json"), "utf8"))
        return JSON.parse(envelope.data).operations[initial.id] as string[]
    }
    expect(await retained()).toContain(head)
    expect(await retained()).not.toContain(after)
    await executeOperationCommand({ command: "undo", noWait: false }, path)
    expect((await history()).at(-1).operation.checkpoint.restore.refs["refs/heads/feature"]).toBe(after)
    expect(await retained()).toContain(after)
    git("reflog", "expire", "--expire=now", "--all")
    git("gc", "--prune=now")
    await executeOperationCommand({ command: "redo", noWait: false }, path)
    expect(git("rev-parse", "HEAD")).toBe(after)
}, 30_000)

test("journal checkpoints preserve audit bytes, detect historical corruption, and recover appended work", async () => {
    const { path, git } = await fixture()
    const run = (command: Parameters<typeof executeOperationCommand>[0]) => executeOperationCommand(command, path)
    await run({ command: "test-mutation", value: "first", noWait: false })
    const journal = join(path, ".git", "laneway", "journal.jsonl")
    const original = await readFile(journal, "utf8")
    await run({ command: "recover", noWait: false })
    expect(await readFile(journal, "utf8")).toBe(original)
    const checkpoint = join(path, ".git", "laneway", "journal-checkpoint.json")
    expect(JSON.parse(await readFile(checkpoint, "utf8")).data).toBeTruthy()
    await writeFile(checkpoint, "damaged checkpoint")
    await run({ command: "recover", noWait: false })
    await writeFile(journal, original.replace('"summary":', '"damaged":'))
    await expect(run({ command: "recover", noWait: false })).rejects.toMatchObject({ code: "operation.journal-corrupt" })
    await writeFile(journal, original + original.split("\n")[0] + "\n")
    await expect(run({ command: "recover", noWait: false })).rejects.toThrow("duplicate intent")
    await writeFile(journal, original)
    await run({ command: "test-mutation", value: "second", noWait: false })
    await run({ command: "recover", noWait: false })
    expect(git("show", "refs/laneway/test/fixture")).toBe("second")
    expect((await readFile(journal, "utf8")).startsWith(original)).toBe(true)
}, 30_000)

test("compiled file extraction rolls back interruption until history commits", async () => {
    const engine = resolve(import.meta.dir, "../bin/lane.exe")
    for (const phase of ["intent", "worktrees-committed", "history-committed"]) {
        const { path, git, head, request } = await fixture()
        const requestPath = join(path, ".git", "request.json")
        await writeFile(requestPath, JSON.stringify(request))
        const run = async (args: string[], expected = 0) => {
            const child = Bun.spawn([engine, ...args, "--json"], {
                cwd: path,
                env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1" },
                stdout: "pipe",
                stderr: "pipe",
            })
            const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
            expect(code, out + err).toBe(expected)
            return out.trim() ? JSON.parse(out.trim().split("\n").at(-1)!) : undefined
        }
        if (phase == "intent")
            await run(["local-transfer", "--request-file", requestPath, "--crash-after", phase], 86)
        else {
            const preview = await run(["local-preview", "--request-file", requestPath])
            await run(["local", "--request-file", requestPath, "--expected", preview.preview.token, "--crash-after", phase], 86)
        }
        await run(["recover"])
        if (phase != "history-committed")
            expect(git("rev-parse", "HEAD")).toBe(head)
        else {
            expect(git("show", ":selected.txt")).toBe("before")
            const moved = git("rev-parse", "HEAD")
            await run(["undo", "--crash-after", "refs-committed"], 86)
            await run(["recover"])
            expect(git("rev-parse", "HEAD")).toBe(moved)
            expect(git("show", ":selected.txt")).toBe("before")
            await run(["undo"])
            expect(git("rev-parse", "HEAD")).toBe(head)
            await run(["redo", "--crash-after", "refs-committed"], 86)
            await run(["recover"])
            expect(git("rev-parse", "HEAD")).toBe(head)
            expect(git("show", ":selected.txt")).toBe("after")
            await run(["redo"])
            expect(git("show", ":selected.txt")).toBe("before")
        }
        expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("after\n")
    }
}, 60_000)
