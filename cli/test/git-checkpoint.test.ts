import { connectRepository, normalize } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { captureGitCheckpoint, checkpointMatches, restoreGitCheckpoint, retainCheckpoint } from "../src/git-checkpoint"

let directories: string[] = []
afterEach(async () => {
    for (let path of directories.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep + "laneway-checkpoint-"))
            throw new Error("Invalid disposable fixture path")
        await rm(path, { recursive: true, force: true })
    }
})

for (let format of ["sha1", "sha256"]) {
    test(`commit checkpoints restore selected index entries without touching working files (${format})`, async () => {
        let { path, git, repo } = await fixture(true, format)
        let before = await captureGitCheckpoint(repo, [path], undefined, undefined, new Map([[normalize(path), ["selected.txt"]]]))

        expect(before.worktrees[0].stash).toBeUndefined()

        await writeFile(join(path, "selected.txt"), "new commit\n")
        git("commit", "-qam", "Next")
        let head = git("rev-parse", "HEAD")
        await writeFile(join(path, "other.txt"), "unrelated staged edit\n")
        git("add", "other.txt")
        let departing = await captureGitCheckpoint(repo, [path], before)
        await retainCheckpoint(repo, "fixture", before, departing)
        await restoreGitCheckpoint(repo, departing, before)

        expect(git("show", ":selected.txt")).toBe("base")
        expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("new commit\n")
        expect(git("show", ":other.txt")).toBe("unrelated staged edit")

        git("reflog", "expire", "--expire=now", "--all")
        git("gc", "--prune=now")
        let undone = await captureGitCheckpoint(repo, [path], before)
        await restoreGitCheckpoint(repo, undone, departing)

        expect(git("rev-parse", "HEAD")).toBe(head)
        expect(git("show", ":selected.txt")).toBe("new commit")
        expect(git("for-each-ref", "--format=%(refname)", "refs/laneway")).toBe("")
    }, 30_000)
}

test("stashes preserve staged, unstaged, binary and untracked content without clearing visible changes", async () => {
    let { path, git, repo } = await fixture()
    await writeFile(join(path, "selected.txt"), "staged\n")
    git("add", "selected.txt")
    await writeFile(join(path, "selected.txt"), "unstaged\n")
    let binary = Buffer.from([0, 255, 13, 10, 128])
    await writeFile(join(path, "new binary.bin"), binary)
    let before = await captureGitCheckpoint(repo, [path])

    expect(before.worktrees[0].stash).toBeTruthy()
    expect(git("stash", "list")).toBe("")
    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("unstaged\n")
    expect(await checkpointMatches(repo, before)).toBe(true)

    git("reset", "--hard", "HEAD")
    git("clean", "-fd")
    let clean = await captureGitCheckpoint(repo, [path])
    await restoreGitCheckpoint(repo, clean, before)

    expect(git("show", ":selected.txt")).toBe("staged")
    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("unstaged\n")
    expect(await readFile(join(path, "new binary.bin"))).toEqual(binary)
    expect(await checkpointMatches(repo, before)).toBe(true)
}, 30_000)

test("checkpoints restore worktree creation, removal and rename through Git", async () => {
    let { root, path, git, repo } = await fixture()
    let linked = join(root, "feature"), moved = join(root, "renamed")
    git("branch", "feature")
    let before = await captureGitCheckpoint(repo, [linked])
    git("worktree", "add", "--quiet", linked, "feature")
    let created = await captureGitCheckpoint(repo, [linked], before)
    await restoreGitCheckpoint(repo, created, before)

    expect(await Bun.file(join(linked, ".git")).exists()).toBe(false)

    let removed = await captureGitCheckpoint(repo, [linked], before)
    await restoreGitCheckpoint(repo, removed, created)

    expect(await Bun.file(join(linked, ".git")).exists()).toBe(true)

    let original = await captureGitCheckpoint(repo, [linked])
    git("worktree", "move", linked, moved)
    let renamed = await captureGitCheckpoint(repo, [linked], original)
    await restoreGitCheckpoint(repo, renamed, original)

    expect(await Bun.file(join(linked, ".git")).exists()).toBe(true)
    expect(git("worktree", "list", "--porcelain")).not.toContain(moved)
    expect(git("rev-parse", "--show-toplevel").replaceAll("\\", "/")).toBe(path.replaceAll("\\", "/"))
}, 30_000)

test("unborn checkpoints retain untracked files and notice external changes", async () => {
    let { path, git, repo } = await fixture(false)
    let before = await captureGitCheckpoint(repo, [path])
    await writeFile(join(path, "selected.txt"), "external\n")

    expect(await checkpointMatches(repo, before)).toBe(false)

    git("add", ".")
    git("commit", "-qm", "First")
    let after = await captureGitCheckpoint(repo, [path])
    await restoreGitCheckpoint(repo, after, before)

    expect(git("ls-files")).toBe("")
    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("base\n")
}, 30_000)

test("unborn checkpoints preserve distinct staged and unstaged content", async () => {
    let { path, git, repo } = await fixture(false)
    git("add", "selected.txt")
    await writeFile(join(path, "selected.txt"), "later edit\n")
    let before = await captureGitCheckpoint(repo, [path])
    git("add", ".")
    git("commit", "-qm", "First")
    let after = await captureGitCheckpoint(repo, [path])
    await restoreGitCheckpoint(repo, after, before)

    expect(git("show", ":selected.txt")).toBe("base")
    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("later edit\n")
}, 30_000)

test("restoration refuses external edits and occupied worktree destinations", async () => {
    let { root, path, git, repo } = await fixture()
    let before = await captureGitCheckpoint(repo, [path])
    await writeFile(join(path, "selected.txt"), "external edit\n")

    await expect(restoreGitCheckpoint(repo, before, before)).rejects.toThrow("outside Laneway")
    expect(await readFile(join(path, "selected.txt"), "utf8")).toBe("external edit\n")

    let linked = join(root, "feature")
    git("worktree", "add", "-b", "feature", linked)
    let created = await captureGitCheckpoint(repo, [linked])
    git("worktree", "remove", linked)
    let absent = await captureGitCheckpoint(repo, [linked], created)
    await mkdir(linked)
    await writeFile(join(linked, "keep.txt"), "unrelated\n")

    await expect(restoreGitCheckpoint(repo, absent, created)).rejects.toThrow("occupied")
    expect(await readFile(join(linked, "keep.txt"), "utf8")).toBe("unrelated\n")
}, 30_000)
async function fixture(initial = true, format = "sha1") {
    let root = await mkdtemp(join(tmpdir(), "laneway-checkpoint-")), path = join(root, "repo")
    directories.push(root)
    await mkdir(path)
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
    await writeFile(join(path, "selected.txt"), "base\n")
    await writeFile(join(path, "other.txt"), "base\n")
    if (initial) {
        git("add", ".")
        git("commit", "-qm", "Base")
    }
    return { root, path, git, repo: await connectRepository(path) }
}
