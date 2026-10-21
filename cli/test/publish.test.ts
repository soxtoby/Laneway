import type { ConflictResult, LocalResult, PublishRequest, PublishResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"

let fixtures: string[] = []
afterEach(async () => {
    for (let path of fixtures.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})

test(
    "publishes the focused stack's changed branches atomically, creating upstreams and force-with-lease updates, never its Base or unrelated branches",
    async () => {
        let { origin, local } = await fixture()
        let before = { main: tip(origin, "main"), other: tip(origin, "other") }
        git(local, "switch", "-q", "one")
        await commit(local, "one.txt", "one advanced\n", "one advanced")
        git(local, "switch", "-q", "two")
        git(local, "commit", "-q", "--amend", "-m", "two rewritten")
        git(local, "switch", "-qc", "three")
        await commit(local, "three.txt", "three\n", "three")
        git(local, "switch", "-q", "main")
        await commit(local, "base.txt", "local base\n", "unpublished base")
        git(local, "switch", "-q", "other")
        await commit(local, "other.txt", "unrelated\n", "unrelated")

        let planned = await publish(local, { action: "plan", branch: "refs/heads/three" })

        expect(planned.status).toBe("planned")
        expect(planned.message).toBe("Force publish one, two, three to origin.")
        expect(planned.plan?.stack).toEqual(["main", "one", "two", "three"])
        expect(planned.plan?.updates.map(update => [update.branch, update.kind, update.setUpstream])).toEqual([["one", "update", false], [
            "two",
            "force",
            false,
        ], ["three", "create", true]])

        let result = await publish(local, { action: "publish", branch: "refs/heads/three", token: planned.plan!.token })

        expect(result.status).toBe("published")
        expect(result.receipt?.mode).toBe("atomic")
        for (let branch of ["one", "two", "three"])
            expect(tip(origin, branch)).toBe(git(local, "rev-parse", branch))
        expect(tip(origin, "main")).toBe(before.main)
        expect(tip(origin, "other")).toBe(before.other)
        expect(git(local, "rev-parse", "three@{upstream}")).toBe(git(local, "rev-parse", "three"))
        expect(git(local, "config", "branch.three.merge")).toBe("refs/heads/three")
        expect((await publish(local, { action: "plan", branch: "refs/heads/three" })).status).toBe("nothing")
    },
    120_000,
)

test("a local operation stays undoable after Publish records an upstream, and undo keeps that upstream", async () => {
    let { origin, local } = await fixture()
    git(local, "switch", "-qc", "solo", "main")
    let original = await commit(local, "solo.txt", "solo\n", "solo")
    let reword = await executeOperationCommand(
        { command: "local-transfer", request: { action: "reword", objectId: original, branch: "solo", title: "Solo work", message: "" }, noWait: false },
        local,
    ) as LocalResult
    expect(reword.status).toBe("performed")

    let result = await publish(local, { action: "publish", branch: "refs/heads/solo" })

    expect(result.status).toBe("published")
    expect(tip(origin, "solo")).toBe(git(local, "rev-parse", "solo"))
    expect((await history(local)).undo.available).toBe(true)

    await executeOperationCommand({ command: "undo", noWait: false }, local)

    expect(git(local, "rev-parse", "solo")).toBe(original)
    expect(git(local, "config", "branch.solo.merge")).toBe("refs/heads/solo")
}, 120_000)

test("an atomic publish refused by the remote publishes nothing, and Resume completes it once the remote accepts", async () => {
    let { origin, local } = await fixture()
    await refuseOnRemote(origin, "two")
    let before = tip(origin, "one")
    await advance(local, "one", "two")

    let result = await publish(local, { action: "publish", branch: "refs/heads/two" })

    expect(result.status).toBe("failed")
    expect(result.receipt?.mode).toBe("atomic")
    expect(result.receipt?.updates.map(update => update.status)).toEqual(["failed", "failed"])
    expect(result.receipt?.updates[1]?.message).toContain("two is frozen")
    expect(tip(origin, "one")).toBe(before)

    await rm(join(origin, "hooks", "pre-receive"))
    let resumed = await publish(local, { action: "resume", receipt: result.receipt!.id })

    expect(resumed.status).toBe("published")
    expect(tip(origin, "one")).toBe(git(local, "rev-parse", "one"))
    expect(tip(origin, "two")).toBe(git(local, "rev-parse", "two"))
}, 120_000)

test(
    "a remote without atomic push publishes from the lowest branch, stops at the first failure keeping earlier branches, and resumes from the receipt",
    async () => {
        let { origin, local } = await fixture()
        git(origin, "config", "receive.advertiseAtomic", "false")
        await refuseOnRemote(origin, "two")
        git(local, "switch", "-qc", "three", "two")
        await commit(local, "three.txt", "three\n", "three")
        git(local, "push", "-q", "-u", "origin", "three")
        let before = { two: tip(origin, "two"), three: tip(origin, "three") }
        await advance(local, "one", "two", "three")

        let result = await publish(local, { action: "publish", branch: "refs/heads/three" })

        expect(result.status).toBe("partial")
        expect(result.receipt?.mode).toBe("sequential")
        expect(result.receipt?.updates.map(update => [update.branch, update.status])).toEqual([["one", "published"], ["two", "failed"], ["three", "pending"]])
        expect(tip(origin, "one")).toBe(git(local, "rev-parse", "one"))
        expect(tip(origin, "two")).toBe(before.two)
        expect(tip(origin, "three")).toBe(before.three)
        expect((await publish(local, { action: "plan", branch: "refs/heads/three" })).plan?.receipt?.id).toBe(result.receipt!.id)
        // As if the push of two reached the remote but its outcome was lost: Resume verifies it rather than pushing again.

        await rm(join(origin, "hooks", "pre-receive"))
        git(local, "push", "-q", "--force", "origin", `${git(local, "rev-parse", "two")}:refs/heads/two`)
        let resumed = await publish(local, { action: "resume", receipt: result.receipt!.id })

        expect(resumed.status).toBe("published")
        expect(tip(origin, "three")).toBe(git(local, "rev-parse", "three"))
    },
    120_000,
)

test("a stale lease aborts the whole publish and points to Pull latest", async () => {
    let { origin, other, local } = await fixture()
    let before = tip(origin, "two")
    await advance(local, "one", "two")
    git(other, "switch", "-qc", "one", "origin/one")
    await commit(other, "colleague.txt", "colleague\n", "colleague on one")
    git(other, "push", "-q", "origin", "one")
    let colleague = tip(origin, "one")

    let result = await publish(local, { action: "publish", branch: "refs/heads/two" })

    expect(result.status).toBe("stale")
    expect(result.message).toBe("Nothing was published. origin/one changed since the last pull. Pull latest, then publish again.")
    expect(tip(origin, "one")).toBe(colleague)
    expect(tip(origin, "two")).toBe(before)
}, 120_000)

test("a failing pre-push hook publishes nothing, and Resume completes the publish afterwards", async () => {
    let { origin, local } = await fixture()
    await writeHook(join(local, ".git", "hooks", "pre-push"), 'echo "lint failed" >&2\nexit 1')
    await advance(local, "one")

    let result = await publish(local, { action: "publish", branch: "refs/heads/one" })

    expect(result.status).toBe("failed")
    expect(result.receipt?.updates[0]?.message).toContain("lint failed")
    expect(tip(origin, "one")).not.toBe(git(local, "rev-parse", "one"))

    await rm(join(local, ".git", "hooks", "pre-push"))
    let resumed = await publish(local, { action: "resume", receipt: result.receipt!.id })

    expect(resumed.status).toBe("published")
    expect(tip(origin, "one")).toBe(git(local, "rev-parse", "one"))
}, 120_000)

test("restoration force-publishes the earlier remote tips under leases and deletes branches the publish created", async () => {
    let { origin, local } = await fixture()
    let before = tip(origin, "one")
    await advance(local, "one")
    git(local, "switch", "-qc", "three", "two")
    await commit(local, "three.txt", "three\n", "three")
    let published = await publish(local, { action: "publish", branch: "refs/heads/three" })
    expect(published.status).toBe("published")

    let result = await publish(local, { action: "restore", receipt: published.receipt!.id })

    expect(result.status).toBe("published")
    expect(result.receipt).toMatchObject({ kind: "restore", restores: published.receipt!.id })
    expect(result.receipt?.updates.map(update => [update.branch, update.kind])).toEqual([["one", "force"], ["three", "delete"]])
    expect(tip(origin, "one")).toBe(before)
    expect(tip(origin, "three")).toBeNull()
}, 120_000)

test("an Unresolved Stack cannot publish", async () => {
    let { local } = await fixture()
    git(local, "switch", "-q", "main")
    let base = await commit(local, "one.txt", "conflicting\n", "conflicting base")
    let rewrite = await executeOperationCommand(
        { command: "conflict", request: { action: "rewrite", branches: ["one", "two"], base }, noWait: false },
        local,
    ) as ConflictResult
    expect(rewrite.conflicts.length).toBe(1)

    let result = await publish(local, { action: "plan", branch: "refs/heads/two" })

    expect(result.status).toBe("blocked")
    expect(result.message).toBe("Resolve this stack's conflicts before publishing.")
}, 120_000)

// A bare "origin" seeded by a contributor clone, and the local clone under test with main, an unrelated
// branch, and a two-branch stack, all published.
async function fixture() {
    let root = await mkdtemp(join(tmpdir(), "laneway-publish-test-"))
    fixtures.push(root)
    let origin = join(root, "origin.git"), other = join(root, "other"), local = join(root, "local")
    git(root, "init", "-q", "--bare", "-b", "main", origin)
    git(root, "init", "-q", "-b", "main", other)
    configure(other)
    await commit(other, "base.txt", "base\n", "base")
    git(other, "remote", "add", "origin", origin)
    git(other, "push", "-q", "-u", "origin", "main")
    git(root, "clone", "-q", origin, local)
    configure(local)
    git(local, "switch", "-qc", "one")
    await commit(local, "one.txt", "one\n", "one")
    git(local, "switch", "-qc", "two")
    await commit(local, "two.txt", "two\n", "two")
    git(local, "switch", "-qc", "other", "main")
    await commit(local, "other.txt", "other\n", "other")
    git(local, "push", "-q", "-u", "origin", "one", "two", "other")
    git(local, "switch", "-q", "main")
    git(other, "fetch", "-q", "origin")
    return { origin, other, local }
}

function configure(path: string) {
    git(path, "config", "user.name", "Publish Test")
    git(path, "config", "user.email", "publish@example.invalid")
    git(path, "config", "commit.gpgsign", "false")
}

// Adds an unpublished commit to each branch in turn, so each stays based on the one before.
async function advance(path: string, ...branches: string[]) {
    for (let branch of branches) {
        git(path, "switch", "-q", branch)
        if (branch != branches[0])
            git(path, "rebase", "-q", branches[branches.indexOf(branch) - 1]!)
        await commit(path, `${branch}-next.txt`, `${branch} next\n`, `${branch} next`)
    }
    git(path, "switch", "-q", "main")
}

function refuseOnRemote(origin: string, branch: string) {
    return writeHook(
        join(origin, "hooks", "pre-receive"),
        `while read old new ref; do\n  if [ "$ref" = refs/heads/${branch} ]; then echo "${branch} is frozen"; exit 1; fi\ndone`,
    )
}

function writeHook(path: string, body: string) {
    return writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

async function commit(path: string, file: string, content: string, message: string) {
    await writeFile(join(path, file), content)
    git(path, "add", "--all")
    git(path, "commit", "-qm", message)
    return git(path, "rev-parse", "HEAD")
}

function tip(repository: string, branch: string) {
    let result = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repository, stdout: "pipe" })
    return result.exitCode ? null : result.stdout.toString().trim()
}

function git(path: string, ...args: string[]) {
    let p = Bun.spawnSync(["git", ...args], { cwd: path, stderr: "pipe", stdout: "pipe" })
    if (p.exitCode)
        throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
}

async function publish(path: string, request: PublishRequest) {
    return await executeOperationCommand({
        command: "publish",
        request,
        noWait: false,
        graphOptions: () => ({ authorIdentities: { primary: "publish@example.invalid", secondary: [] }, remotePatterns: [] }),
    }, path) as PublishResult
}

async function history(path: string) {
    let result = await executeOperationCommand({ command: "history", noWait: false }, path)
    return result as Extract<typeof result, { command: "history" }>
}
