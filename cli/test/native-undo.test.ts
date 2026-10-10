import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { createRepository, enginePath, parseNdjson, runEngineAt, runGitAt, waitForFile } from "./engine-fixture"

let directories: string[] = []
afterEach(async () => {
    for (let directory of directories.splice(0)) {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
})

test("commit undo and redo preserve subsequent index and file edits in every worktree", async () => {
    let path = await repository()
    let linked = `${path}-linked`
    directories.push(linked)
    git(path, "worktree", "add", "-b", "other", linked)
    let old = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "README.md"), "committed\n")
    await lane(path, "commit", "-am", "Commit")
    let committed = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "README.md"), "new staged edit\n")
    git(path, "add", "README.md")
    await writeFile(join(path, "README.md"), "new unstaged edit\n")
    await writeFile(join(linked, "README.md"), "other worktree\n")
    git(path, "branch", "unrelated")

    await lane(path, "undo")
    expect(git(path, "rev-parse", "HEAD")).toBe(old)
    expect(git(path, "show", ":README.md")).toBe("new staged edit")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("new unstaged edit\n")
    expect(await readFile(join(linked, "README.md"), "utf8")).toBe("other worktree\n")
    await lane(path, "redo")
    expect(git(path, "rev-parse", "HEAD")).toBe(committed)
    expect(git(path, "show", ":README.md")).toBe("new staged edit")
    expect(git(path, "rev-parse", "unrelated")).toBe(committed)
})

test("amend undo restores the replaced commit and rejects a subsequently moved ref", async () => {
    let path = await repository()
    let old = git(path, "rev-parse", "HEAD")
    await lane(path, "commit", "--amend", "-m", "Amended")
    let amended = git(path, "rev-parse", "HEAD")
    await lane(path, "undo")
    expect(git(path, "rev-parse", "HEAD")).toBe(old)
    await lane(path, "redo")
    expect(git(path, "rev-parse", "HEAD")).toBe(amended)
    git(path, "commit", "--allow-empty", "-m", "External")
    let external = git(path, "rev-parse", "HEAD")
    let undo = await runEngineAt(path, ["undo"])
    expect(undo.exitCode).not.toBe(0)
    expect(undo.stderr).toContain("changed outside Laneway")
    expect(git(path, "rev-parse", "HEAD")).toBe(external)
})

test("initial commit undo restores an unborn branch and redo survives garbage collection", async () => {
    let path = await mkdtemp(join(tmpdir(), "lane-initial-"))
    directories.push(path)
    git(path, "init", "-q")
    git(path, "config", "user.name", "Test")
    git(path, "config", "user.email", "test@example.invalid")
    await writeFile(join(path, "first.txt"), "first\n")
    git(path, "add", ".")
    await lane(path, "commit", "-m", "First")
    let first = git(path, "rev-parse", "HEAD")
    await lane(path, "undo")
    expect(runGitAt(path, "rev-parse", "--verify", "HEAD").exitCode).not.toBe(0)
    expect(git(path, "show", ":first.txt")).toBe("first")
    git(path, "reflog", "expire", "--expire=now", "--all")
    git(path, "gc", "--prune=now")
    await lane(path, "redo")
    expect(git(path, "rev-parse", "HEAD")).toBe(first)
})

test("detached commit undo moves only that worktree HEAD", async () => {
    let path = await repository()
    let branch = git(path, "branch", "--show-current")
    let old = git(path, "rev-parse", "HEAD")
    git(path, "switch", "--detach")
    await lane(path, "commit", "--allow-empty", "-m", "Detached")
    let next = git(path, "rev-parse", "HEAD")
    await lane(path, "undo")
    expect(git(path, "rev-parse", "HEAD")).toBe(old)
    await lane(path, "redo")
    expect(git(path, "rev-parse", "HEAD")).toBe(next)
    expect(git(path, "rev-parse", branch)).toBe(old)
    expect(git(path, "branch", "--show-current")).toBe("")
})

test("branch rename and deletion undo preserve configuration and reflogs without touching files", async () => {
    let path = await repository()
    let branch = git(path, "branch", "--show-current")
    git(path, "config", `branch.${branch}.description`, "Description")
    let log = git(path, "reflog", "show", "--format=%H %gs", branch)
    await lane(path, "branch", "-m", "renamed")
    await writeFile(join(path, "README.md"), "keep edit\n")
    git(path, "config", "branch.unrelated.description", "Keep")
    await lane(path, "undo")
    expect(git(path, "branch", "--show-current")).toBe(branch)
    expect(git(path, "config", `branch.${branch}.description`)).toBe("Description")
    expect(git(path, "reflog", "show", "--format=%H %gs", branch)).toBe(log)
    expect(git(path, "config", "branch.unrelated.description")).toBe("Keep")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("keep edit\n")
    await lane(path, "redo")
    expect(git(path, "branch", "--show-current")).toBe("renamed")
    git(path, "branch", "topic")
    git(path, "config", "branch.topic.description", "Deleted branch")
    await lane(path, "branch", "-d", "topic")
    await lane(path, "undo")
    expect(git(path, "config", "branch.topic.description")).toBe("Deleted branch")
})

test("stage undo retains split-index contents while preserving subsequent working edits", async () => {
    let path = await repository()
    await writeFile(join(path, "README.md"), "old staged\n")
    git(path, "add", ".")
    git(path, "update-index", "--split-index")
    await writeFile(join(path, "README.md"), "new staged\n")
    await lane(path, "stage", "README.md")
    await writeFile(join(path, "README.md"), "working\n")
    git(path, "gc", "--prune=now")
    await lane(path, "undo")
    expect(git(path, "show", ":README.md")).toBe("old staged")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("working\n")
    await lane(path, "redo")
    expect(git(path, "show", ":README.md")).toBe("new staged")
})

test("Git staging and commit work during an ordinary merge", async () => {
    let path = await repository()
    let branch = git(path, "branch", "--show-current")
    git(path, "switch", "-c", "topic")
    await writeFile(join(path, "README.md"), "topic\n")
    git(path, "commit", "-am", "Topic")
    git(path, "switch", branch)
    await writeFile(join(path, "README.md"), "main\n")
    git(path, "commit", "-am", "Main")
    let old = git(path, "rev-parse", "HEAD")
    expect(runGitAt(path, "merge", "topic").exitCode).toBe(1)
    let unmerged = git(path, "ls-files", "--unmerged")
    await writeFile(join(path, "README.md"), "resolved\n")
    await lane(path, "stage", "README.md")
    await lane(path, "undo")
    expect(git(path, "ls-files", "--unmerged")).toBe(unmerged)
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("resolved\n")
    await lane(path, "redo")
    await lane(path, "commit", "-m", "Merge")
    expect(git(path, "rev-parse", "HEAD^2")).toBe(git(path, "rev-parse", "topic"))
    await lane(path, "undo")
    expect(git(path, "rev-parse", "HEAD")).toBe(old)
    expect(git(path, "show", ":README.md")).toBe("resolved")
})

test("stash undo restores only affected files, including explicitly stashed ignored files", async () => {
    let path = await repository()
    await writeFile(join(path, ".gitignore"), "ignored.txt\n")
    git(path, "add", ".gitignore")
    git(path, "commit", "-m", "Ignore")
    await writeFile(join(path, "README.md"), "stash me\n")
    await writeFile(join(path, "ignored.txt"), "ignored\n")
    await lane(path, "stash", "push", "--all")
    await writeFile(join(path, "unrelated.txt"), "keep\n")
    await lane(path, "undo")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("stash me\n")
    expect(await readFile(join(path, "ignored.txt"), "utf8")).toBe("ignored\n")
    expect(await readFile(join(path, "unrelated.txt"), "utf8")).toBe("keep\n")
    await lane(path, "redo")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("initial\n")
    expect(await readFile(join(path, "unrelated.txt"), "utf8")).toBe("keep\n")
    await lane(path, "stash", "pop")
    expect(await readFile(join(path, "ignored.txt"), "utf8")).toBe("ignored\n")
    await lane(path, "undo")
    expect(await Bun.file(join(path, "ignored.txt")).exists()).toBe(false)
    expect(await readFile(join(path, "unrelated.txt"), "utf8")).toBe("keep\n")
})

test("native Git executes while another Laneway operation holds the mutation lock", async () => {
    let path = await repository()
    let directory = join(path, ".git", "laneway")
    await mkdir(directory)
    let lock = join(directory, "mutation.lock")
    await writeFile(lock, JSON.stringify({ token: "fixture", pid: process.pid }))
    let marker = join(path, "hook-ran")
    await writeFile(join(path, ".git", "hooks", "pre-commit"), "#!/bin/sh\nprintf 'ran' > hook-ran\n", { mode: 0o755 })
    let child = Bun.spawn([enginePath, "commit", "--allow-empty", "-m", "Unlocked Git"], {
        cwd: path,
        env: { ...process.env, LANEWAY_SETTINGS_PATH: join(path, "missing-settings.json") },
        stdout: "pipe",
        stderr: "pipe",
    })
    try {
        await waitForFile(marker)
    } finally {
        await rm(lock, { force: true })
        await child.exited
    }
    expect(child.exitCode).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
    let history = await lane(path, "history", "--json")
    expect(parseNdjson(history.stdout).at(-1)).toMatchObject({ total: 1 })
    await lane(path, "undo")
    expect(git(path, "show", "-s", "--format=%s", "HEAD")).toBe("Initial")
})

test("native commands and their undo leave pending workflow recovery alone", async () => {
    let path = await repository()
    let interrupted = await runEngineAt(path, ["test-mutation", "--value", "pending", "--crash-after", "intent", "--json"], {
        LANEWAY_ENABLE_TEST_COMMANDS: "1",
    })
    expect(interrupted.exitCode).toBe(86)
    let journalPath = join(path, ".git", "laneway", "journal.jsonl")
    let journal = await readFile(journalPath, "utf8")
    await lane(path, "commit", "--allow-empty", "-m", "Native")
    await lane(path, "undo")
    await lane(path, "redo")
    expect(await readFile(journalPath, "utf8")).toBe(journal)
    expect(git(path, "show", "-s", "--format=%s", "HEAD")).toBe("Native")
})

test("stash branch undo restores a detached HEAD and keeps unrelated edits", async () => {
    let path = await repository()
    git(path, "switch", "--detach")
    let head = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "README.md"), "stashed\n")
    git(path, "stash", "push")
    expect((await runEngineAt(path, ["stash", "branch", "from-stash"])).exitCode).toBe(0)
    await writeFile(join(path, "unrelated.txt"), "keep\n")
    await lane(path, "undo")
    expect(git(path, "branch", "--show-current")).toBe("")
    expect(git(path, "rev-parse", "HEAD")).toBe(head)
    expect(git(path, "stash", "list")).not.toBe("")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("initial\n")
    await lane(path, "redo")
    expect(git(path, "branch", "--show-current")).toBe("from-stash")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("stashed\n")
    expect(await readFile(join(path, "unrelated.txt"), "utf8")).toBe("keep\n")
})

test("unstage with explicit --worktree retains the files that Git restores", async () => {
    let path = await repository()
    await writeFile(join(path, "README.md"), "staged\n")
    git(path, "add", ".")
    await writeFile(join(path, "README.md"), "working\n")
    await lane(path, "unstage", "--worktree", "README.md")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("initial\n")
    await lane(path, "undo")
    expect(git(path, "show", ":README.md")).toBe("staged")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("working\n")
})

test("stash file/directory replacements preserve unrelated files and refuse an occupied target", async () => {
    let path = await repository()
    await writeFile(join(path, "item"), "file\n")
    git(path, "add", "item")
    git(path, "commit", "-m", "File")
    await rm(join(path, "item"))
    await mkdir(join(path, "item"))
    await writeFile(join(path, "item", "nested.txt"), "nested\n")
    await lane(path, "stash", "push", "-u")
    expect(await readFile(join(path, "item"), "utf8")).toBe("file\n")
    await lane(path, "undo")
    expect(await readFile(join(path, "item", "nested.txt"), "utf8")).toBe("nested\n")
    await writeFile(join(path, "item", "unrelated.txt"), "keep\n")
    expect((await runEngineAt(path, ["redo"])).exitCode).not.toBe(0)
    expect(await readFile(join(path, "item", "nested.txt"), "utf8")).toBe("nested\n")
    expect(await readFile(join(path, "item", "unrelated.txt"), "utf8")).toBe("keep\n")
    await rm(join(path, "item", "unrelated.txt"))
    await lane(path, "redo")
    expect(await readFile(join(path, "item"), "utf8")).toBe("file\n")
})

test("a Git index lock prevents stash undo before any files or stash entries change", async () => {
    let path = await repository()
    await writeFile(join(path, "README.md"), "saved\n")
    await lane(path, "stash", "push")
    let stash = git(path, "stash", "list")
    let lock = join(path, ".git", "index.lock")
    await writeFile(lock, "held")
    expect((await runEngineAt(path, ["undo"])).exitCode).not.toBe(0)
    expect(git(path, "stash", "list")).toBe(stash)
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("initial\n")
    expect(await readFile(lock, "utf8")).toBe("held")
    await rm(lock)
    await lane(path, "undo")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("saved\n")
})

async function repository() {
    let path = await createRepository()
    directories.push(path)
    return path
}

async function lane(path: string, ...args: string[]) {
    let result = await runEngineAt(path, args)
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    return result
}

function git(path: string, ...args: string[]) {
    let result = runGitAt(path, ...args)
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
}
