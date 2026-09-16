import type { LocalRequest, LocalResult } from "@git-workbench/shared"
import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operation-runtime"

const temporary: string[] = []
afterEach(async () => {
    for (const path of temporary.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})
function git(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
}
async function fixture(initial = true, format = "sha1") {
    const path = await mkdtemp(join(tmpdir(), "workbench-local-test-"))
    temporary.push(path)
    git(path, "init", "-q", "-b", "main", `--object-format=${format}`)
    git(path, "config", "user.name", "Workbench Test")
    git(path, "config", "user.email", "test@example.invalid")
    git(path, "config", "commit.gpgsign", "false")
    await writeFile(join(path, "a.txt"), "base\n")
    if (initial) {
        git(path, "add", ".")
        git(path, "commit", "-qm", "initial")
    }
    return path
}
async function preview(path: string, request: LocalRequest) {
    return (await executeOperationCommand({ command: "local-preview", request, noWait: false }, path) as LocalResult).preview!
}
async function perform(path: string, request: LocalRequest) {
    return await executeOperationCommand({ command: "local", request, token: (await preview(path, request)).token, noWait: false }, path) as LocalResult
}
const transition = (path: string, command: "undo" | "redo") => executeOperationCommand({ command, noWait: false }, path)
test("staged snapshots preserve later edits; commits undo and redo exact trees", async () => {
    const path = await fixture()
    await writeFile(join(path, "a.txt"), "staged\n")
    expect((await perform(path, { action: "stage", path, files: ["a.txt"], unstage: false })).status).toBe("performed")
    await writeFile(join(path, "a.txt"), "later\n")
    expect((await perform(path, { action: "commit", path, title: "staged", message: "body" })).status).toBe("performed")
    const commit = git(path, "rev-parse", "HEAD")
    expect(git(path, "show", "HEAD:a.txt")).toBe("staged")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("later\n")
    await transition(path, "undo")
    expect(git(path, "show", ":a.txt")).toBe("staged")
    expect(git(path, "show", "HEAD:a.txt")).toBe("base")
    await transition(path, "redo")
    expect(git(path, "rev-parse", "HEAD")).toBe(commit)
}, 60_000)

test("SHA-256 commits honor clean filters, staged modes and signing failures", async () => {
    const path = await fixture(true, "sha256")
    git(path, "config", "filter.upper.clean", "tr a-z A-Z")
    git(path, "config", "filter.upper.smudge", "cat")
    await writeFile(join(path, ".gitattributes"), "a.txt filter=upper\n")
    await writeFile(join(path, "a.txt"), "filtered\n")
    await perform(path, { action: "stage", path, unstage: false })
    git(path, "update-index", "--chmod=+x", "a.txt")
    const request: LocalRequest = { action: "commit", path, title: "filtered", message: "body" }
    const original = git(path, "rev-parse", "HEAD")
    git(path, "config", "commit.gpgsign", "true")
    git(path, "config", "gpg.program", "workbench-missing-signing-program")
    expect((await perform(path, request)).status).toBe("failed")
    expect(git(path, "rev-parse", "HEAD")).toBe(original)
    git(path, "config", "commit.gpgsign", "false")
    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "rev-parse", "HEAD")).toHaveLength(64)
    expect(git(path, "show", "HEAD:a.txt")).toBe("FILTERED")
    expect(git(path, "ls-tree", "HEAD", "a.txt")).toStartWith("100755")
    expect(git(path, "log", "-1", "--format=%an <%ae>")).toBe("Workbench Test <test@example.invalid>")
}, 60_000)

test("virtual branch creation remains independently undoable after a failed commit", async () => {
    const path = await fixture()
    git(path, "checkout", "--detach", "-q")
    await writeFile(join(path, "a.txt"), "virtual\n")
    expect((await perform(path, { action: "branch-create", name: "worktree/new", path })).status).toBe("performed")
    const hook = join(path, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\nexit 1\n")
    await chmod(hook, 0o755)
    expect((await perform(path, { action: "commit", path, title: "fails", message: "" })).status).toBe("failed")
    expect(git(path, "branch", "--show-current")).toBe("worktree/new")
    await transition(path, "undo")
    expect(git(path, "diff", "--cached", "--name-only")).toBe("")
    await transition(path, "undo")
    expect(git(path, "branch", "--show-current")).toBe("")
    expect(git(path, "branch", "--list", "worktree/new")).toBe("")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("virtual\n")
}, 60_000)
test("first commit includes untracked files and stale preview refuses external edits", async () => {
    const path = await fixture(false)
    const request: LocalRequest = { action: "commit", path, title: "initial", message: "" }
    const old = await preview(path, request)
    await writeFile(join(path, "a.txt"), "new\n")
    await expect(executeOperationCommand({ command: "local", request, token: old.token, noWait: false }, path)).rejects.toThrow("changed")
    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "show", "HEAD:a.txt")).toBe("new")
    await transition(path, "undo")
    expect(git(path, "status", "--porcelain")).toContain("?? a.txt")
}, 60_000)
test("rename preserves upstream; delete detaches dirty worktree and undo reattaches", async () => {
    const path = await fixture()
    git(path, "config", "branch.main.remote", "origin")
    git(path, "config", "branch.main.merge", "refs/heads/main")
    expect((await perform(path, { action: "branch-rename", name: "main", newName: "renamed" })).status).toBe("performed")
    expect(git(path, "config", "branch.renamed.merge")).toBe("refs/heads/main")
    await writeFile(join(path, "a.txt"), "dirty\n")
    expect((await perform(path, { action: "branch-delete", name: "renamed", confirmed: false })).status).toBe("failed")
    expect((await perform(path, { action: "branch-delete", name: "renamed", confirmed: true })).status).toBe("performed")
    expect(git(path, "branch", "--show-current")).toBe("")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("dirty\n")
    await transition(path, "undo")
    expect(git(path, "branch", "--show-current")).toBe("renamed")
}, 60_000)
test("stash apply consumes stash, undo restores it, conflicts keep stash and marked Working Changes", async () => {
    const path = await fixture()
    await writeFile(join(path, "a.txt"), "stashed\n")
    expect((await perform(path, { action: "stash-create", path, label: "saved" })).status).toBe("performed")
    const objectId = git(path, "rev-parse", "refs/stash")
    const request: LocalRequest = { action: "stash-apply", path, objectId }
    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "stash", "list")).toBe("")
    await transition(path, "undo")
    expect(git(path, "rev-parse", "refs/stash")).toBe(objectId)
    await writeFile(join(path, "a.txt"), "conflicting\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "conflict")
    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "ls-files", "--unmerged")).toBe("")
    const marked = await readFile(join(path, "a.txt"), "utf8")
    expect(marked).toContain("<<<<<<< Current files before restoring stash at")
    expect(marked).toContain(`>>>>>>> Stashed changes ${objectId.slice(0, 8)}`)
    expect(git(path, "rev-parse", "refs/stash")).toBe(objectId)
}, 60_000)
test("hook changes request review; failed hooks preserve draft content without creating a commit", async () => {
    const path = await fixture()
    const hook = join(path, ".git", "hooks", "pre-commit")
    await writeFile(hook, '#!/bin/sh\nprintf "formatted\\n" > a.txt\ngit add a.txt\n')
    await chmod(hook, 0o755)
    await writeFile(join(path, "a.txt"), "input\n")
    const request: LocalRequest = { action: "commit", path, title: "hook", message: "" }
    const result = await perform(path, request)
    expect(result.status).toBe("hook-review")
    expect(result.changedFiles).toContain("a.txt")
    expect((await perform(path, { ...request, acceptHooks: result.hookToken })).status).toBe("performed")
    expect(git(path, "show", "HEAD:a.txt")).toBe("formatted")
    const original = git(path, "rev-parse", "HEAD")
    await writeFile(hook, "#!/bin/sh\nexit 1\n")
    await writeFile(join(path, "a.txt"), "another\n")
    expect((await perform(path, request)).status).toBe("failed")
    expect(git(path, "rev-parse", "HEAD")).toBe(original)
}, 60_000)
