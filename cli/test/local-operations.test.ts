import type { LocalRequest, LocalResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"

let temporary: string[] = []
afterEach(async () => {
    for (let path of temporary.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})
test("staged snapshots preserve later edits; commits undo and redo exact trees", async () => {
    let path = await fixture()
    await writeFile(join(path, "a.txt"), "staged\n")

    expect((await perform(path, { action: "stage", path, files: ["a.txt"], unstage: false })).status).toBe("performed")

    await writeFile(join(path, "a.txt"), "later\n")

    expect((await perform(path, { action: "commit", path, title: "staged", message: "body" })).status).toBe("performed")

    let commit = git(path, "rev-parse", "HEAD")

    expect(git(path, "show", "HEAD:a.txt")).toBe("staged")
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("later\n")

    await transition(path, "undo")

    expect(git(path, "show", ":a.txt")).toBe("staged")
    expect(git(path, "show", "HEAD:a.txt")).toBe("base")

    await transition(path, "redo")

    expect(git(path, "rev-parse", "HEAD")).toBe(commit)
}, 60_000)

test("amend replaces the last commit on its parents with its author kept, and undo restores it", async () => {
    let path = await fixture()
    let base = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "a.txt"), "first\n")
    git(path, "commit", "-qam", "Subject that\nwraps\n\nOriginal body", "--author", "Other Author <other@example.invalid>", "--date", "2001-02-03T04:05:06Z")
    let original = git(path, "rev-parse", "HEAD")
    await writeFile(join(path, "b.txt"), "added\n")
    let request: LocalRequest = { action: "commit", path, title: "Amended", message: "New body", amend: true }

    expect((await preview(path, request)).lastCommit).toEqual({ objectId: original, title: "Subject that wraps", message: "Original body" })
    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "rev-parse", "HEAD^")).toBe(base)
    expect(git(path, "log", "-1", "--format=%an <%ae> %aI")).toBe("Other Author <other@example.invalid> 2001-02-03T04:05:06Z")
    expect(git(path, "log", "-1", "--format=%B")).toBe("Amended\n\nNew body")
    expect(git(path, "show", "HEAD:a.txt")).toBe("first")
    expect(git(path, "show", "HEAD:b.txt")).toBe("added")

    await transition(path, "undo")

    expect(git(path, "rev-parse", "HEAD")).toBe(original)
}, 60_000)

test("SHA-256 commits honor clean filters, staged modes and signing failures", async () => {
    let path = await fixture(true, "sha256")
    git(path, "config", "filter.upper.clean", "tr a-z A-Z")
    git(path, "config", "filter.upper.smudge", "cat")
    await writeFile(join(path, ".gitattributes"), "a.txt filter=upper\n")
    await writeFile(join(path, "a.txt"), "filtered\n")
    await perform(path, { action: "stage", path, unstage: false })
    git(path, "update-index", "--chmod=+x", "a.txt")
    let request: LocalRequest = { action: "commit", path, title: "filtered", message: "body" }
    let original = git(path, "rev-parse", "HEAD")
    git(path, "config", "commit.gpgsign", "true")
    git(path, "config", "gpg.program", "laneway-missing-signing-program")

    expect((await perform(path, request)).status).toBe("failed")
    expect(git(path, "rev-parse", "HEAD")).toBe(original)

    git(path, "config", "commit.gpgsign", "false")

    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "rev-parse", "HEAD")).toHaveLength(64)
    expect(git(path, "show", "HEAD:a.txt")).toBe("FILTERED")
    expect(git(path, "ls-tree", "HEAD", "a.txt")).toStartWith("100755")
    expect(git(path, "log", "-1", "--format=%an <%ae>")).toBe("Laneway Test <test@example.invalid>")
}, 60_000)

test("virtual branch creation remains independently undoable after a failed commit", async () => {
    let path = await fixture()
    git(path, "checkout", "--detach", "-q")
    await writeFile(join(path, "a.txt"), "virtual\n")

    expect((await perform(path, { action: "branch-create", name: "worktree/new", path })).status).toBe("performed")

    let hook = join(path, ".git", "hooks", "pre-commit")
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
    let path = await fixture(false)
    let request: LocalRequest = { action: "commit", path, title: "initial", message: "" }
    let old = await preview(path, request)
    await writeFile(join(path, "a.txt"), "new\n")

    await expect(executeOperationCommand({ command: "local", request, token: old.token, noWait: false }, path)).rejects.toThrow("changed")
    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "show", "HEAD:a.txt")).toBe("new")

    await transition(path, "undo")

    expect(git(path, "status", "--porcelain")).toContain("?? a.txt")
}, 60_000)
test("rename preserves upstream; delete detaches dirty worktree and undo reattaches", async () => {
    let path = await fixture()
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
    let path = await fixture()
    await writeFile(join(path, "a.txt"), "stashed\n")

    expect((await perform(path, { action: "stash-create", path, label: "saved" })).status).toBe("performed")

    let objectId = git(path, "rev-parse", "refs/stash")
    let request: LocalRequest = { action: "stash-apply", path, objectId }

    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "stash", "list")).toBe("")

    await transition(path, "undo")

    expect(git(path, "rev-parse", "refs/stash")).toBe(objectId)

    await writeFile(join(path, "a.txt"), "conflicting\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "conflict")

    expect((await perform(path, request)).status).toBe("performed")
    expect(git(path, "ls-files", "--unmerged")).toBe("")

    let marked = await readFile(join(path, "a.txt"), "utf8")

    expect(marked).toContain("<<<<<<< Current files before restoring stash at")
    expect(marked).toContain(`>>>>>>> Stashed changes ${objectId.slice(0, 8)}`)
    expect(git(path, "rev-parse", "refs/stash")).toBe(objectId)
}, 60_000)
test("hook changes request review; failed hooks preserve draft content without creating a commit", async () => {
    let path = await fixture()
    let hook = join(path, ".git", "hooks", "pre-commit")
    await writeFile(hook, '#!/bin/sh\nprintf "formatted\\n" > a.txt\ngit add a.txt\n')
    await chmod(hook, 0o755)
    await writeFile(join(path, "a.txt"), "input\n")
    let request: LocalRequest = { action: "commit", path, title: "hook", message: "" }
    let result = await perform(path, request)

    expect(result.status).toBe("hook-review")
    expect(result.changedFiles).toContain("a.txt")
    expect((await perform(path, { ...request, acceptHooks: result.hookToken })).status).toBe("performed")
    expect(git(path, "show", "HEAD:a.txt")).toBe("formatted")

    let original = git(path, "rev-parse", "HEAD")
    await writeFile(hook, "#!/bin/sh\nexit 1\n")
    await writeFile(join(path, "a.txt"), "another\n")

    expect((await perform(path, request)).status).toBe("failed")
    expect(git(path, "rev-parse", "HEAD")).toBe(original)
}, 60_000)
test("move into base advances the base to the branch's own commits, unchanged, and undo moves it back", async () => {
    let path = await fixture()
    let baseTip = git(path, "rev-parse", "main")
    git(path, "checkout", "-qb", "feature")
    await commitFile(path, "a.txt", "one")
    await commitFile(path, "a.txt", "two")
    let tip = git(path, "rev-parse", "feature")

    let result = await perform(path, moveIntoBase("refs/heads/feature", tip, baseTip))

    expect(result.message).toBe("Moved 2 commits into main.")
    expect([git(path, "rev-parse", "main"), git(path, "rev-parse", "feature")]).toEqual([tip, tip])

    await transition(path, "undo")

    expect(git(path, "rev-parse", "main")).toBe(baseTip)
}, 60_000)
test("move into base brings the worktree holding the base along with its Working Changes kept", async () => {
    let path = await fixture()
    await commitFile(path, "b.txt", "base")
    let baseTip = git(path, "rev-parse", "main")
    let linked = join(await mkdtemp(join(tmpdir(), "laneway-local-linked-")), "feature")
    temporary.push(resolve(linked, ".."))
    git(path, "worktree", "add", "-q", "-b", "feature", linked)
    await commitFile(linked, "a.txt", "moved")
    let tip = git(linked, "rev-parse", "HEAD")
    await writeFile(join(path, "b.txt"), "dirty\n")

    await perform(path, moveIntoBase("refs/heads/feature", tip, baseTip))

    expect(git(path, "rev-parse", "HEAD")).toBe(tip)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("moved\n")
    expect(git(path, "status", "--porcelain")).toBe("M b.txt")

    await transition(path, "undo")

    expect(git(path, "rev-parse", "HEAD")).toBe(baseTip)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("base\n")
    expect(await readFile(join(path, "b.txt"), "utf8")).toBe("dirty\n")
}, 60_000)
test("move into base leaves the base where it was when the holding worktree's changes would be overwritten", async () => {
    let path = await fixture()
    let baseTip = git(path, "rev-parse", "main")
    let linked = join(await mkdtemp(join(tmpdir(), "laneway-local-linked-")), "feature")
    temporary.push(resolve(linked, ".."))
    git(path, "worktree", "add", "-q", "-b", "feature", linked)
    await commitFile(linked, "a.txt", "moved")
    await writeFile(join(path, "a.txt"), "dirty\n")

    let result = await perform(path, moveIntoBase("refs/heads/feature", git(linked, "rev-parse", "HEAD"), baseTip))

    expect(result.status).toBe("failed")
    expect(git(path, "rev-parse", "main")).toBe(baseTip)
    expect(await readFile(join(path, "a.txt"), "utf8")).toBe("dirty\n")
}, 60_000)
test("move into base refuses a base that moved on after the branch forked", async () => {
    let path = await fixture()
    git(path, "checkout", "-qb", "feature")
    await commitFile(path, "a.txt", "feature")
    let tip = git(path, "rev-parse", "feature")
    git(path, "checkout", "-q", "main")
    await commitFile(path, "b.txt", "main")

    await expect(preview(path, moveIntoBase("refs/heads/feature", tip, git(path, "rev-parse", "main"))))
        .rejects.toThrow("main has commits feature doesn't. Rebase feature onto main first.")
}, 60_000)
test("a tag goes on the commit here and on the remote, annotated when it has a message", async () => {
    let path = await fixture()
    let remote = await bareRemote(path)
    let commit = git(path, "rev-parse", "HEAD")

    let light = await perform(path, { action: "tag-create", name: "v1", commit, message: "", remote: "origin" })
    await perform(path, { action: "tag-create", name: "v2", commit, message: "Second release", remote: "origin" })

    expect(light.message).toBe("Created tag v1 here and on origin.")
    expect([git(path, "cat-file", "-t", "v1"), git(path, "cat-file", "-t", "v2")]).toEqual(["commit", "tag"])
    expect(git(path, "tag", "-l", "--format=%(contents:subject)", "v2")).toBe("Second release")
    expect(git(remote, "for-each-ref", "--format=%(refname) %(objectname)", "refs/tags"))
        .toBe(`refs/tags/v1 ${commit}
refs/tags/v2 ${git(path, "rev-parse", "v2")}`)
}, 60_000)
test("a tag the remote refuses isn't created here either", async () => {
    let path = await fixture()
    await bareRemote(path)
    let first = git(path, "rev-parse", "HEAD")
    await commitFile(path, "a.txt", "later")
    git(path, "push", "-q", "origin", "HEAD:refs/tags/v1")

    let result = await perform(path, { action: "tag-create", name: "v1", commit: first, message: "", remote: "origin" })

    expect(result).toMatchObject({ status: "failed", message: "origin already has a tag named v1." })
    expect(git(path, "tag", "-l")).toBe("")
    expect(git(path, "for-each-ref", "refs/remotes")).toBe("")
}, 60_000)
test("a tag needs an unused name and, with remotes, the remote to go to", async () => {
    let path = await fixture()
    let commit = git(path, "rev-parse", "HEAD")
    git(path, "tag", "v1")

    await expect(preview(path, { action: "tag-create", name: "v1", commit, message: "" })).rejects.toThrow("There's already a tag named v1.")
    await expect(preview(path, { action: "tag-create", name: "bad..name", commit, message: "" })).rejects.toThrow("bad..name isn't a valid tag name.")
    await bareRemote(path)
    await expect(preview(path, { action: "tag-create", name: "v2", commit, message: "" }))
        .rejects.toThrow("Choose a remote in the Branch Graph's settings to create the tag on.")
}, 60_000)
test("a tag in a repository without remotes stays here, and undo removes it", async () => {
    let path = await fixture()

    let result = await perform(path, { action: "tag-create", name: "v1", commit: git(path, "rev-parse", "HEAD"), message: "" })

    expect(result.message).toBe("Created tag v1.")
    await transition(path, "undo")
    expect(git(path, "tag", "-l")).toBe("")
}, 60_000)
async function bareRemote(path: string) {
    let remote = await mkdtemp(join(tmpdir(), "laneway-local-remote-"))
    temporary.push(remote)
    git(remote, "init", "-q", "--bare")
    git(path, "remote", "add", "origin", remote)
    return remote
}
async function commitFile(path: string, file: string, content: string) {
    await writeFile(join(path, file), `${content}\n`)
    git(path, "add", file)
    git(path, "commit", "-qm", content)
}
function moveIntoBase(branch: string, tip: string, baseTip: string): LocalRequest {
    return { action: "move-into-base", branch, tip, base: "refs/heads/main", baseTip }
}
async function fixture(initial = true, format = "sha1") {
    let path = await mkdtemp(join(tmpdir(), "laneway-local-test-"))
    temporary.push(path)
    git(path, "init", "-q", "-b", "main", `--object-format=${format}`)
    git(path, "config", "user.name", "Laneway Test")
    git(path, "config", "user.email", "test@example.invalid")
    git(path, "config", "commit.gpgsign", "false")
    await writeFile(join(path, "a.txt"), "base\n")
    if (initial) {
        git(path, "add", ".")
        git(path, "commit", "-qm", "initial")
    }
    return path
}
function git(cwd: string, ...args: string[]) {
    let result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
}
async function perform(path: string, request: LocalRequest) {
    return await executeOperationCommand({ command: "local", request, token: (await preview(path, request)).token, noWait: false }, path) as LocalResult
}
async function preview(path: string, request: LocalRequest) {
    return (await executeOperationCommand({ command: "local-preview", request, noWait: false }, path) as LocalResult).preview!
}

function transition(path: string, command: "undo" | "redo") {
    return executeOperationCommand({ command, noWait: false }, path)
}
