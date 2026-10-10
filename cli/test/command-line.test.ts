import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { createRepository, enginePath, parseNdjson, runEngineAt, runGitAt } from "./engine-fixture"

let directories: string[] = []
afterEach(async () => {
    for (let directory of directories.splice(0)) {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
})

test("help is usable outside a repository, including workflow and wrapper help", async () => {
    let cwd = await mkdtemp(join(tmpdir(), "lane-help-"))
    directories.push(cwd)
    for (let args of [[], ["--help"], ["help", "move"], ["reword", "--help"], ["worktree", "--help"], ["conflict", "choose", "--help"], ["commit", "--help"]]) {
        let result = await runEngineAt(cwd, args)
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("lane")
        expect(result.stderr).toBe("")
    }
})

test("Git commit keeps staged-only semantics, arguments, and undo/redo", async () => {
    let path = await repository()
    await writeFile(join(path, "README.md"), "staged\n")
    expect((await lane(path, "stage", "--", "README.md")).exitCode).toBe(0)
    await writeFile(join(path, "README.md"), "unstaged\n")
    let before = git(path, "rev-parse", "HEAD")

    let commit = await lane(path, "commit", "-m", "Native message", "-m", "Body")
    expect(commit.exitCode).toBe(0)
    expect(commit.stdout).toContain("Native message")
    expect(git(path, "show", "HEAD:README.md")).toBe("staged")
    expect(git(path, "show", "-s", "--format=%B", "HEAD")).toBe("Native message\n\nBody")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("unstaged\n")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect(git(path, "rev-parse", "HEAD")).toBe(before)
    expect(git(path, "show", ":README.md")).toBe("staged")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("unstaged\n")
    expect((await lane(path, "redo")).exitCode).toBe(0)
    expect(git(path, "show", "HEAD:README.md")).toBe("staged")
})

test("unstage and filenames after -- preserve ordinary Git path handling", async () => {
    let path = await repository()
    await writeFile(join(path, "--json"), "literal option filename\n")
    expect((await lane(path, "stage", "--", "--json")).exitCode).toBe(0)
    expect(git(path, "diff", "--cached", "--name-only")).toBe("--json")
    expect((await lane(path, "unstage", "--", "--json")).exitCode).toBe(0)
    expect(git(path, "diff", "--cached", "--name-only")).toBe("")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect(git(path, "diff", "--cached", "--name-only")).toBe("--json")
})

test("Git wrappers preserve stdin for commit messages", async () => {
    let path = await repository()
    let child = Bun.spawn([enginePath, "commit", "--allow-empty", "-F", "-"], {
        cwd: path,
        env: { ...process.env, LANEWAY_SETTINGS_PATH: join(path, "missing-settings.json") },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    })
    child.stdin.write("Message from stdin\n")
    await child.stdin.end()
    let [code, , diagnostics] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(diagnostics).toBe("")
    expect(code).toBe(0)
    expect(git(path, "show", "-s", "--format=%s", "HEAD")).toBe("Message from stdin")
})

test("branch flags, stash apply versus pop, and journal no-ops match Git", async () => {
    let path = await repository()
    expect((await lane(path, "branch", "topic")).exitCode).toBe(0)
    expect((await lane(path, "branch", "-m", "topic", "renamed")).exitCode).toBe(0)
    expect((await lane(path, "undo")).exitCode).toBe(0)
    let listed = await lane(path, "branch", "--list", "topic")
    expect(listed.stdout).toContain("topic")
    expect((await lane(path, "redo")).exitCode).toBe(0)
    expect(git(path, "branch", "--list", "renamed")).toContain("renamed")

    await writeFile(join(path, "README.md"), "stashed\n")
    expect((await lane(path, "stash", "push", "-m", "Saved")).exitCode).toBe(0)
    expect((await lane(path, "stash", "apply")).exitCode).toBe(0)
    expect(git(path, "stash", "list")).toContain("Saved")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect((await lane(path, "stash", "pop")).exitCode).toBe(0)
    expect(git(path, "stash", "list")).toBe("")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect(git(path, "stash", "list")).toContain("Saved")
}, 120_000)

test("native failures retain Git diagnostics and do not consume undo history", async () => {
    let path = await repository()
    await writeFile(join(path, "README.md"), "not staged\n")
    let result = await lane(path, "--json", "commit", "-m", "Nothing")
    expect(result.exitCode).toBe(1)
    expect(parseNdjson(result.stdout).at(-1)).toMatchObject({ command: "git", gitCommand: "commit", exitCode: 1 })
    let history = await lane(path, "history", "--json")
    expect(parseNdjson(history.stdout).at(-1)).toMatchObject({ total: 0 })
    expect(git(path, "show", "HEAD:README.md")).toBe("initial")
})

test("native hook failures preserve hook edits without creating a commit undo entry", async () => {
    let path = await repository()
    await writeFile(join(path, ".git", "hooks", "pre-commit"), "#!/bin/sh\nprintf 'hook edit\\n' > README.md\nexit 1\n", { mode: 0o755 })
    let result = await lane(path, "commit", "--allow-empty", "-m", "Rejected")
    expect(result.exitCode).toBe(1)
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("hook edit\n")
    let history = await lane(path, "history", "--json")
    expect(parseNdjson(history.stdout).at(-1)).toMatchObject({ total: 0 })
})

test("a conflicting native stash pop preserves the unmerged index across undo and redo", async () => {
    let path = await repository()
    await writeFile(join(path, "README.md"), "stashed side\n")
    git(path, "stash", "push")
    await writeFile(join(path, "README.md"), "current side\n")
    git(path, "commit", "-am", "Current")
    await writeFile(join(path, "untracked.txt"), "untracked\n")
    await writeFile(join(path, "staged.txt"), "staged\n")
    git(path, "add", "staged.txt")
    await writeFile(join(path, "staged.txt"), "later edits\n")
    let pop = await lane(path, "stash", "pop")
    expect(pop.exitCode).toBe(1)
    let index = git(path, "ls-files", "--unmerged")
    let status = git(path, "status", "--porcelain")
    let conflicted = await readFile(join(path, "README.md"), "utf8")
    expect(index).not.toBe("")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect(git(path, "ls-files", "--unmerged")).toBe("")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("current side\n")
    let redo = await lane(path, "redo")
    expect(redo.stderr).toBe("")
    expect(redo.exitCode).toBe(0)
    expect(git(path, "ls-files", "--unmerged")).toBe(index)
    expect(git(path, "status", "--porcelain")).toBe(status)
    expect(await readFile(join(path, "untracked.txt"), "utf8")).toBe("untracked\n")
    expect(git(path, "show", ":staged.txt")).toBe("staged")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe(conflicted)
    await writeFile(join(path, "README.md"), "resolved\n")
    expect((await lane(path, "stage", "--all")).exitCode).toBe(0)
    expect(git(path, "ls-files", "--unmerged")).toBe("")
    git(path, "gc", "--prune=now")
    let restored = await lane(path, "undo")
    expect(restored.stderr).toBe("")
    expect(restored.exitCode).toBe(0)
    expect(git(path, "ls-files", "--unmerged")).toBe(index)
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("resolved\n")
    expect(git(path, "show", ":staged.txt")).toBe("staged")
    expect(await readFile(join(path, "staged.txt"), "utf8")).toBe("later edits\n")
}, 120_000)

test("remote-tracking branch deletion through Git is undoable", async () => {
    let path = await repository()
    git(path, "update-ref", "refs/remotes/origin/topic", "HEAD")
    expect((await lane(path, "branch", "-rd", "origin/topic")).exitCode).toBe(0)
    expect(git(path, "branch", "-r")).toBe("")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect(git(path, "branch", "-r")).toContain("origin/topic")
})

test("reword resolves revisions, previews, restacks, and supports undo", async () => {
    let path = await repository()
    git(path, "commit", "--allow-empty", "-m", "Second")
    let old = git(path, "rev-parse", "HEAD")
    expect((await lane(path, "reword", "HEAD", "-m", "Renamed", "--preview")).stdout).toContain("Branches:")
    expect(git(path, "rev-parse", "HEAD")).toBe(old)
    expect((await lane(path, "reword", "HEAD", "-m", "Renamed")).exitCode).toBe(0)
    expect(git(path, "show", "-s", "--format=%s", "HEAD")).toBe("Renamed")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect(git(path, "rev-parse", "HEAD")).toBe(old)
})

test("composition uses named endpoints and worktree-relative file selections", async () => {
    let path = await repository()
    git(path, "commit", "--allow-empty", "-m", "Target")
    await writeFile(join(path, "README.md"), "composed\n")
    let file = process.platform == "win32" ? ".\\README.md" : "./README.md"
    let result = await lane(path, "move", "--from", "working", "--to", "commit:HEAD", "--file", file)
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(git(path, "show", "HEAD:README.md")).toBe("composed")
    expect(git(path, "status", "--porcelain")).toBe("")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect(git(path, "show", "HEAD:README.md")).toBe("initial")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("composed\n")
})

test("worktree workflows and Git wrappers honor -C and linked worktrees", async () => {
    let path = await repository()
    directories.push(`${path}.worktrees`)
    git(path, "branch", "topic")
    expect((await lane(path, "worktree", "create", "topic")).exitCode).toBe(0)
    let linked = join(`${path}.worktrees`, "topic")
    let subdir = join(linked, "nested")
    await mkdir(subdir)
    await writeFile(join(subdir, "file.txt"), "nested\n")
    expect((await lane(path, "-C", subdir, "stage", "file.txt")).exitCode).toBe(0)
    expect(git(linked, "diff", "--cached", "--name-only")).toBe("nested/file.txt")
    expect((await lane(path, "-C", linked, "commit", "-m", "Linked commit")).exitCode).toBe(0)
    expect(git(path, "show", "-s", "--format=%s", "topic")).toBe("Linked commit")
    expect(git(path, "show", "-s", "--format=%s", "HEAD")).toBe("Initial")
    expect((await lane(path, "undo")).exitCode).toBe(0)
    expect(git(linked, "diff", "--cached", "--name-only")).toBe("nested/file.txt")
})

test("workflow usage errors and empty conflict output are readable", async () => {
    let path = await repository()
    for (let args of [["move", "--from", "working"], ["worktree", "remove"], ["reword", "HEAD"], ["pull", "--typo"], ["undo", "extra"]])
        expect((await lane(path, ...args)).exitCode).toBe(2)
    expect((await lane(path, "conflict", "list")).stdout).toBe("No unresolved conflicts.\n")
    expect((await lane(path, "pull")).stdout).toContain("Add a remote")
})

test("conflict workflows resolve candidates without JSON inputs or version tokens", async () => {
    let path = await repository()
    let main = git(path, "branch", "--show-current")
    git(path, "switch", "-c", "topic")
    await writeFile(join(path, "README.md"), "topic\n")
    git(path, "commit", "-am", "Topic")
    git(path, "switch", main)
    await writeFile(join(path, "README.md"), "base\n")
    git(path, "commit", "-am", "Base")
    git(path, "switch", "topic")

    let rewrite = await lane(path, "conflict", "rewrite", "topic", "--onto", main, "--path", ".", "--json")
    expect(rewrite.stderr).toBe("")
    expect(rewrite.exitCode).toBe(0)
    let result = JSON.parse(rewrite.stdout)
    let subject = result.conflicts[0].id
    expect((await lane(path, "conflict", "inspect", subject)).stdout).toContain("README.md")
    let file = process.platform == "win32" ? ".\\README.md" : "./README.md"
    let chosen = await lane(path, "conflict", "choose", subject, file, "--side", "right")
    expect(chosen.stderr).toBe("")
    expect(chosen.exitCode).toBe(0)
    expect((await lane(path, "conflict", "accept", subject)).exitCode).toBe(0)
    expect(git(path, "branch", "--show-current")).toBe("topic")
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("topic\n")
}, 120_000)

test("pull defaults to the current stack and synchronizes a real remote", async () => {
    let upstream = await repository()
    let local = await mkdtemp(join(tmpdir(), "lane-pull-cli-"))
    directories.push(local)
    git(local, "clone", "-q", upstream, ".")
    git(local, "config", "user.name", "Laneway Test")
    git(local, "config", "user.email", "laneway@example.invalid")
    await writeFile(join(upstream, "README.md"), "upstream\n")
    git(upstream, "commit", "-am", "Upstream")
    let result = await lane(local, "pull", "--json")
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(git(local, "rev-parse", "HEAD")).toBe(git(upstream, "rev-parse", "HEAD"))
    expect((await lane(local, "undo")).exitCode).toBe(0)
    expect(await readFile(join(local, "README.md"), "utf8")).toBe("initial\n")
}, 120_000)

test("rebase accepts branch names and retains descendant branch membership", async () => {
    let path = await repository()
    let main = git(path, "branch", "--show-current")
    git(path, "switch", "-c", "topic")
    await writeFile(join(path, "topic.txt"), "topic\n")
    git(path, "add", "topic.txt")
    git(path, "commit", "-m", "Topic")
    git(path, "switch", "-c", "child")
    await writeFile(join(path, "child.txt"), "child\n")
    git(path, "add", "child.txt")
    git(path, "commit", "-m", "Child")
    git(path, "switch", main)
    await writeFile(join(path, "base.txt"), "base\n")
    git(path, "add", "base.txt")
    git(path, "commit", "-m", "Base")

    let result = await lane(path, "rebase", "topic", "--onto", main)
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(git(path, "rev-parse", "topic^")).toBe(git(path, "rev-parse", main))
    expect(git(path, "rev-parse", "child^")).toBe(git(path, "rev-parse", "topic"))
}, 120_000)

async function repository() {
    let path = await createRepository()
    directories.push(path)
    return path
}

function lane(path: string, ...args: string[]) {
    return runEngineAt(path, args)
}

function git(path: string, ...args: string[]) {
    let result = runGitAt(path, ...args)
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
}
