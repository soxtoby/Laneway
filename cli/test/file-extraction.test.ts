import { connectRepository } from "@laneway/git"
import type { CompositionRequest, LocalResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { prepareComposition } from "../src/composition/composition"
import { prepareFileExtraction } from "../src/composition/file-extraction"
import { isFileExtraction } from "../src/composition/file-extraction"
import { executeOperationCommand } from "../src/operations/operation-runtime"

let directories: string[] = []
afterEach(async () => {
    for (let path of directories.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})

for (let format of ["sha1", "sha256"]) {
    test(`file extraction scopes recovery and preserves unrelated working edits through undo and redo (${format})`, async () => {
        let { path, git, head, request } = await fixture(format)
        let repo = await connectRepository(path)
        let prepared = await prepareComposition(repo, request)

        expect(isFileExtraction(prepared.preview)).toBe(true)

        let result = await executeOperationCommand({ command: "local", request, token: prepared.preview.token, noWait: false }, path) as LocalResult

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
    let { path, git, request } = await fixture()
    let prepared = await prepareComposition(await connectRepository(path), request)
    await writeFile(join(path, "selected.txt"), "external edit\n")

    await expect(executeOperationCommand({ command: "local", request, token: prepared.preview.token, noWait: false }, path)).rejects.toThrow("changed")

    git("add", "selected.txt")
    git("commit", "-qm", "Descendant edits the selected path")
    let fallback = await prepareComposition(await connectRepository(path), request)

    expect(isFileExtraction(fallback.preview)).toBe(false)
}, 30_000)

test("file extraction leaves shared history, hooks, and staged selected content to the general planner", async () => {
    let { path, git, source, request } = await fixture()
    let repo = await connectRepository(path)
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
    let { path, git, source, head, request } = await fixture()
    git("branch", "shared", source)
    let preview = await executeOperationCommand({ command: "local-transfer", request, noWait: false }, path) as LocalResult

    expect(preview.status).toBe("preview")
    expect(git("rev-parse", "HEAD")).toBe(head)

    git("branch", "-D", "shared")
    let applied = await executeOperationCommand({ command: "local-transfer", request, noWait: false }, path) as LocalResult

    expect(applied.status).toBe("performed")
    expect(git("show", ":selected.txt")).toBe("before")
    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("after\n")
}, 30_000)

test("transfers record their ref and index changes, and both sides stay retained through undo", async () => {
    let { path, git, head, request } = await fixture()
    await executeOperationCommand({ command: "local-transfer", request, noWait: false }, path)
    let after = git("rev-parse", "HEAD")
    let history = () => readFile(join(path, ".git", "laneway", "history.jsonl"), "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line)))
    let initial = (await history())[0].operation

    expect(initial.lifecycle).toBeUndefined()
    expect(initial.checkpoint).toBeUndefined()
    expect(initial.changes).toContainEqual({ type: "ref", ref: "refs/heads/feature", before: head, after })
    expect(initial.changes.filter((change: { type: string }) => change.type == "tree")).toHaveLength(1)

    let retained = async () => {
        let envelope = JSON.parse(await readFile(join(path, ".git", "laneway", "recovery-objects.json"), "utf8"))
        return JSON.parse(envelope.data).operations[initial.id] as string[]
    }

    expect(await retained()).toContain(head)
    expect(await retained()).toContain(after)

    await executeOperationCommand({ command: "undo", noWait: false }, path)

    expect((await history()).at(-1).operation.changes).toContainEqual({ type: "ref", ref: "refs/heads/feature", before: head, after })
    expect(await retained()).toContain(after)

    git("reflog", "expire", "--expire=now", "--all")
    git("gc", "--prune=now")
    await executeOperationCommand({ command: "redo", noWait: false }, path)

    expect(git("rev-parse", "HEAD")).toBe(after)
}, 30_000)

test("journal checkpoints preserve audit bytes, detect historical corruption, and recover appended work", async () => {
    let { path, git } = await fixture()
    let run = (command: Parameters<typeof executeOperationCommand>[0]) => executeOperationCommand(command, path)
    await run({ command: "test-mutation", value: "first", noWait: false })
    let journal = join(path, ".git", "laneway", "journal.jsonl")
    let original = await readFile(journal, "utf8")
    await run({ command: "recover", noWait: false })

    expect(await readFile(journal, "utf8")).toBe(original)

    let checkpoint = join(path, ".git", "laneway", "journal-checkpoint.json")

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

test("compiled file extraction completes an undo or redo that crashed after writing its record", async () => {
    // Reversing before the record is covered once, in composition-conflicts; this keeps the extraction-specific claims.
    let engine = resolve(import.meta.dir, "../bin/lane.exe")
    let { path, git, head, request } = await fixture()
    let requestPath = join(path, ".git", "request.json")
    await writeFile(requestPath, JSON.stringify(request))
    let run = async (args: string[], expected = 0) => {
        let child = Bun.spawn([engine, ...args, "--json"], {
            cwd: path,
            env: { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1" },
            stdout: "pipe",
            stderr: "pipe",
        })
        let [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])

        expect(code, out + err).toBe(expected)

        return out.trim() ? JSON.parse(out.trim().split("\n").at(-1)!) : undefined
    }
    let preview = await run(["local-preview", "--request-file", requestPath])
    await run(["local", "--request-file", requestPath, "--expected", preview.preview.token, "--crash-after", "history-committed"], 86)
    await run(["recover"])

    expect(git("show", ":selected.txt")).toBe("before")

    let moved = git("rev-parse", "HEAD")
    await run(["undo", "--crash-after", "recorded"], 86)
    await run(["recover"])

    expect(git("rev-parse", "HEAD")).toBe(head)
    expect(git("show", ":selected.txt")).toBe("after")

    await run(["redo", "--crash-after", "recorded"], 86)
    await run(["recover"])

    expect(git("rev-parse", "HEAD")).toBe(moved)
    expect(git("show", ":selected.txt")).toBe("before")
    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("after\n")
}, 60_000)
async function fixture(format = "sha1") {
    let path = await mkdtemp(join(tmpdir(), "laneway-extract-"))
    directories.push(path)
    let git = (...args: string[]) => {
        let result = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
    }
    git("init", "-q", "-b", "main", `--object-format=${format}`)
    git("config", "user.name", "Test")
    git("config", "user.email", "test@example.invalid")
    git("config", "commit.gpgsign", "false")
    for (let name of ["selected.txt", "retained.txt", "unrelated.txt"])
        await writeFile(join(path, name), "before\n")
    git("add", ".")
    git("commit", "-qm", "Base")
    git("remote", "add", "origin", "https://example.invalid/fixture.git")
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"))
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    git("checkout", "-qb", "feature")
    for (let name of ["selected.txt", "retained.txt"])
        await writeFile(join(path, name), "after\n")
    git("add", ".")
    git("commit", "-qm", "Selected change")
    let source = git("rev-parse", "HEAD")
    for (let i = 0; i < 3; i++) {
        await writeFile(join(path, `descendant-${i}.txt`), `${i}\n`)
        git("add", ".")
        git("commit", "-qm", `Descendant ${i}`)
    }
    let head = git("rev-parse", "HEAD")
    let request: CompositionRequest = {
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
