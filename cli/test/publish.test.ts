import { type ConflictResult, ExitCode, type LocalResult, type PublishRequest, type PublishResult, type PullResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import type { CancellationSignal } from "../src/operations/operation-contracts"
import { executeOperationCommand } from "../src/operations/operation-runtime"
import { runEngineAt } from "./engine-fixture"

let fixtures: string[] = []
let servers: Bun.Server<undefined>[] = []
afterEach(async () => {
    for (let server of servers.splice(0))
        await server.stop(true)
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
        git(local, "config", "push.followTags", "true")
        git(local, "tag", "-a", "-m", "release", "release", "one")

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
        expect(git(origin, "tag")).toBe("")
        expect(git(local, "rev-parse", "three@{upstream}")).toBe(git(local, "rev-parse", "three"))
        expect(git(local, "config", "branch.three.merge")).toBe("refs/heads/three")
        expect((await publish(local, { action: "plan", branch: "refs/heads/three" })).status).toBe("nothing")
    },
    120_000,
)

test("the Primary Branch, which has no Base, publishes alone, leaving the stacks built on it", async () => {
    let { origin, local } = await fixture()
    let before = tip(origin, "one")
    await commit(local, "base.txt", "local base\n", "unpublished base")
    git(local, "switch", "-q", "one")
    await commit(local, "one.txt", "one advanced\n", "one advanced")
    git(local, "switch", "-q", "main")

    let planned = await publish(local, { action: "plan", branch: "refs/heads/main" })
    let result = await publish(local, { action: "publish", branch: "refs/heads/main", token: planned.plan!.token })

    expect(planned.message).toBe("Publish main to origin.")
    expect(planned.plan?.stack).toEqual(["main"])
    expect(result.status).toBe("published")
    expect(tip(origin, "main")).toBe(git(local, "rev-parse", "main"))
    expect(tip(origin, "one")).toBe(before)
}, 120_000)

test("a branch sharing the Primary Branch's tip is not the Primary Branch, so it doesn't publish alone", async () => {
    let { local } = await fixture()
    await commit(local, "base.txt", "local base\n", "unpublished base")
    git(local, "branch", "backup")

    let result = await publish(local, { action: "plan", branch: "refs/heads/backup" })

    expect(result.status).toBe("blocked")
}, 120_000)

test("planning several branches plans each as planning it alone would, and gives the reason a branch can't be planned", async () => {
    let { local } = await fixture()
    await advance(local, "one", "two")
    let alone = {
        one: await publish(local, { action: "plan", branch: "refs/heads/one" }),
        two: await publish(local, { action: "plan", branch: "refs/heads/two" }),
    }

    let result = await publish(local, { action: "plans", branches: ["refs/heads/two", "refs/heads/one", "refs/heads/gone"] })

    expect(result.status).toBe("planned")
    expect(result.plans).toEqual([{ branch: "refs/heads/two", message: alone.two.message, plan: alone.two.plan }, {
        branch: "refs/heads/one",
        message: alone.one.message,
        plan: alone.one.plan,
    }, { branch: "refs/heads/gone", message: "gone is not a local branch." }])
}, 120_000)

test("a local operation stays undoable after Publish replaces an upstream, and undo keeps the replacement", async () => {
    let { origin, other, local } = await fixture()
    git(other, "push", "-q", "origin", "main:refs/heads/feature")
    git(local, "fetch", "-q", "origin")
    git(local, "switch", "-qc", "solo", "--track", "origin/feature")
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
        // As if the push of two reached the remote but the crash lost its outcome and Git's tracking update:
        // pushing to the path rather than the remote leaves origin/two behind. Resume verifies it rather than pushing again.

        await rm(join(origin, "hooks", "pre-receive"))
        git(local, "push", "-q", "--force", origin, `${git(local, "rev-parse", "two")}:refs/heads/two`)
        let resumed = await publish(local, { action: "resume", receipt: result.receipt!.id })

        expect(resumed.status).toBe("published")
        expect(tip(origin, "three")).toBe(git(local, "rev-parse", "three"))
        expect(git(local, "rev-parse", "origin/two")).toBe(git(local, "rev-parse", "two"))
    },
    120_000,
)

test("Resume publishes nothing more once a branch it already published has moved on the remote", async () => {
    let { origin, other, local } = await fixture()
    git(origin, "config", "receive.advertiseAtomic", "false")
    await refuseOnRemote(origin, "two")
    let before = tip(origin, "two")
    await advance(local, "one", "two")
    let result = await publish(local, { action: "publish", branch: "refs/heads/two" })
    expect(result.receipt?.updates.map(update => update.status)).toEqual(["published", "failed"])
    git(other, "fetch", "-q", "origin")
    git(other, "switch", "-qc", "one", "origin/one")
    await commit(other, "colleague.txt", "colleague\n", "colleague on one")
    git(other, "push", "-q", "origin", "one")
    await rm(join(origin, "hooks", "pre-receive"))

    let resumed = await publish(local, { action: "resume", receipt: result.receipt!.id })

    expect(resumed.status).toBe("stale")
    expect(tip(origin, "two")).toBe(before)
}, 120_000)

test("Resume pushes nothing to any remote when the remote holding the receipt's published updates cannot be read", async () => {
    let { origin, local } = await fixture()
    let fork = join(origin, "..", "fork.git")
    git(local, "clone", "-q", "--bare", origin, fork)
    git(local, "remote", "add", "fork", fork)
    git(local, "fetch", "-q", "fork")
    git(local, "branch", "-q", "--set-upstream-to=fork/two", "two")
    await refuseOnRemote(fork, "two")
    await advance(local, "one", "two")
    let result = await publish(local, { action: "publish", branch: "refs/heads/two" })
    expect(result.receipt?.updates.map(update => [update.remote, update.status])).toEqual([["origin", "published"], ["fork", "failed"]])
    let before = tip(fork, "two")
    await rm(join(fork, "hooks", "pre-receive"))
    git(local, "config", "remote.origin.pushurl", join(origin, "..", "missing.git"))

    let resumed = await publish(local, { action: "resume", receipt: result.receipt!.id })

    expect(resumed.receipt?.updates.map(update => update.status)).toEqual(["published", "failed"])
    expect(resumed.receipt?.updates[1]?.message).toContain("missing.git")
    expect(tip(fork, "two")).toBe(before)
}, 120_000)

test("a publish cancelled before pushing publishes nothing, and restoration finds an update that reached the remote unrecorded", async () => {
    let { origin, local } = await fixture()
    let before = tip(origin, "one")
    await advance(local, "one", "two")

    let result = await publish(local, { action: "publish", branch: "refs/heads/two" }, { isCancelled: () => true, wait: async () => true })

    expect(result.receipt?.updates.map(update => update.status)).toEqual(["pending", "pending"])
    expect(tip(origin, "one")).toBe(before)

    // As if a push of one reached the remote and a crash lost its outcome.
    git(local, "push", "-q", origin, "one:refs/heads/one")
    let restored = await publish(local, { action: "restore", receipt: result.receipt!.id })

    expect(restored.status).toBe("published")
    expect(restored.receipt?.updates.map(update => update.branch)).toEqual(["one"])
    expect(tip(origin, "one")).toBe(before)
}, 120_000)

test("restoration of an interrupted publish fails with Git's diagnostics when the remote cannot be read", async () => {
    let { origin, local } = await fixture()
    await advance(local, "one", "two")
    let interrupted = await publish(local, { action: "publish", branch: "refs/heads/two" }, { isCancelled: () => true, wait: async () => true })
    // As if a push of one reached the remote and a crash lost its outcome.
    git(local, "push", "-q", origin, "one:refs/heads/one")
    git(local, "config", "remote.origin.pushurl", join(origin, "..", "missing.git"))

    let result = await publish(local, { action: "restore", receipt: interrupted.receipt!.id })

    expect(result.status).toBe("failed")
    expect(result.receipt?.updates[0]?.message).toContain("missing.git")
}, 120_000)

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

test("a branch whose upstream Laneway fetched without pulling can't publish over the fetched commits until it pulls", async () => {
    let { origin, other, local } = await fixture()
    await advance(local, "one")
    git(other, "switch", "-qc", "one", "origin/one")
    await commit(other, "colleague.txt", "colleague\n", "colleague on one")
    git(other, "push", "-q", "origin", "one")
    let colleague = tip(origin, "one")
    // With no open stacks, a pull only fetches.
    await pull(local, [])

    let blocked = await publish(local, { action: "publish", branch: "refs/heads/one" })

    expect(blocked.status).toBe("blocked")
    expect(blocked.message).toBe("origin/one changed since the last pull. Pull latest, then publish again.")
    expect(tip(origin, "one")).toBe(colleague)

    await pull(local, ["refs/heads/one"])
    let published = await publish(local, { action: "publish", branch: "refs/heads/one" })

    expect(published.status).toBe("published")
    expect(git(local, "merge-base", "--is-ancestor", colleague!, "one")).toBe("")
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

test("a push URL refusing credentials publishes nothing and keeps Git's diagnostics, and Resume publishes once access returns", async () => {
    let { origin, local } = await fixture()
    let server = Bun.serve({ port: 0, fetch: () => new Response("", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="publish"' } }) })
    servers.push(server)
    // Fetching still reads the bare repository; only the push URL needs credentials, and nothing can supply them.
    let rewrite = `url.http://127.0.0.1:${server.port}/origin.git.pushInsteadOf`
    git(local, "config", rewrite, git(local, "config", "remote.origin.url"))
    git(local, "config", "credential.helper", "")
    git(local, "config", "--add", "credential.helper", "!f() { echo quit=true; }; f")
    let before = tip(origin, "one")
    await advance(local, "one")

    let result = await publish(local, { action: "publish", branch: "refs/heads/one" })

    expect(result.status).toBe("failed")
    expect(tip(origin, "one")).toBe(before)
    let persisted = (await publish(local, { action: "plan", branch: "refs/heads/one" })).plan?.receipt
    expect(persisted?.updates[0]?.message).toContain("credential")

    git(local, "config", "--unset", rewrite)
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

test("an Unresolved Stack can neither publish nor resume an earlier receipt", async () => {
    let { origin, local } = await fixture()
    let before = tip(origin, "one")
    await writeHook(join(local, ".git", "hooks", "pre-push"), "exit 1")
    await advance(local, "one", "two")
    let interrupted = await publish(local, { action: "publish", branch: "refs/heads/two" })
    await rm(join(local, ".git", "hooks", "pre-push"))
    let base = await commit(local, "one.txt", "conflicting\n", "conflicting base")
    let rewrite = await executeOperationCommand(
        { command: "conflict", request: { action: "rewrite", branches: ["one", "two"], base }, noWait: false },
        local,
    ) as ConflictResult
    expect(rewrite.conflicts.length).toBe(1)

    let planned = await publish(local, { action: "plan", branch: "refs/heads/two" })
    let resumed = await publish(local, { action: "resume", receipt: interrupted.receipt!.id })

    expect([planned.status, resumed.status]).toEqual(["blocked", "blocked"])
    expect(planned.message).toBe("Resolve this stack's conflicts before publishing.")
    expect(tip(origin, "one")).toBe(before)
}, 120_000)

test("restoration still has the earlier commits after reflogs expire and Git prunes", async () => {
    let { origin, local } = await fixture()
    let before = tip(origin, "two")
    git(local, "switch", "-q", "two")
    git(local, "commit", "-q", "--amend", "-m", "two rewritten")
    git(local, "switch", "-q", "main")
    let published = await publish(local, { action: "publish", branch: "refs/heads/two" })
    git(local, "reflog", "expire", "--expire=now", "--all")
    git(local, "gc", "-q", "--prune=now")

    let result = await publish(local, { action: "restore", receipt: published.receipt!.id })

    expect(result.status).toBe("published")
    expect(tip(origin, "two")).toBe(before)
}, 120_000)

test("an upstream that cannot be recorded is reported alongside the publish that reached the remote", async () => {
    let { origin, local } = await fixture()
    git(local, "switch", "-qc", "three", "two")
    await commit(local, "three.txt", "three\n", "three")
    git(local, "switch", "-q", "main")
    let lock = join(local, ".git", "config.lock")
    await writeFile(lock, "")

    let result = await publish(local, { action: "publish", branch: "refs/heads/three" })
    await rm(lock)

    expect(result.status).toBe("published")
    expect(result.message).toStartWith("Published three. Git could not record the upstreams of three:")
    expect(tip(origin, "three")).toBe(git(local, "rev-parse", "three"))
}, 120_000)

test("a receipt whose recorded identifier is not its file name is never resumed", async () => {
    let { local } = await fixture()
    await writeHook(join(local, ".git", "hooks", "pre-push"), "exit 1")
    await advance(local, "one")
    let failed = await publish(local, { action: "publish", branch: "refs/heads/one" })
    let directory = join(local, ".git", "laneway", "publish")
    let receipt = JSON.parse(await readFile(join(directory, `${failed.receipt!.id}.json`), "utf8"))
    await writeFile(join(directory, "forged.json"), JSON.stringify({ ...receipt, id: "../../forged" }))

    await expect(publish(local, { action: "resume", receipt: "forged" })).rejects.toThrow("There is no Publish Receipt forged.")
    expect(await Bun.file(join(local, ".git", "forged.json")).exists()).toBe(false)
}, 120_000)

test("Resume keeps the receipt it resumes on disk while pushing when it is the oldest of more than 100 finished receipts", async () => {
    let { local } = await fixture()
    let hook = join(local, ".git", "hooks", "pre-push")
    await writeHook(hook, "exit 1")
    await advance(local, "one")
    let failed = (await publish(local, { action: "publish", branch: "refs/heads/one" })).receipt!
    let updates = failed.updates.map(update => ({ ...update, branch: "elsewhere", ref: "refs/heads/elsewhere", status: "published" }))
    let newer = Array.from({ length: 100 }, (_, index) => `${failed.id}-${String(index).padStart(3, "0")}`)
    await Promise.all(newer.map(id => writeFile(join(local, ".git", "laneway", "publish", `${id}.json`), JSON.stringify({ ...failed, id, updates }))))
    // A crash during the push would leave the remote changed with whatever receipt is on disk now.
    await writeHook(hook, `test -f .git/laneway/publish/${failed.id}.json`)

    let resumed = await publish(local, { action: "resume", receipt: failed.id })

    expect(resumed.status).toBe("published")
}, 120_000)

test("the command line and the request transport both exit with failure when a stale lease publishes nothing", async () => {
    let { other, local } = await fixture()
    await advance(local, "one", "two")
    git(other, "switch", "-qc", "one", "origin/one")
    await commit(other, "colleague.txt", "colleague\n", "colleague on one")
    git(other, "push", "-q", "origin", "one")

    let command = await runEngineAt(local, ["publish", "two"])
    let request = await runEngineAt(local, ["publish", "--request", JSON.stringify({ action: "publish", branch: "refs/heads/two" }), "--json"])

    expect([command.exitCode, request.exitCode]).toEqual([ExitCode.failure, ExitCode.failure])
    expect(JSON.parse(request.stdout.trim().split("\n").at(-1)!).status).toBe("stale")
}, 120_000)

test("the command line refuses --preview with --resume or --restore before publishing anything", async () => {
    let { origin, local } = await fixture()
    await advance(local, "one")
    let published = await publish(local, { action: "publish", branch: "refs/heads/one" })

    let restore = await runEngineAt(local, ["publish", "--restore", published.receipt!.id, "--preview"])
    let resume = await runEngineAt(local, ["publish", "--resume", published.receipt!.id, "--preview"])

    expect([restore.exitCode, resume.exitCode]).toEqual([ExitCode.usage, ExitCode.usage])
    expect(tip(origin, "one")).toBe(git(local, "rev-parse", "one"))
}, 120_000)

test("native undo of a branch rename still works after Publish replaces the renamed branch's upstream", async () => {
    let { local } = await fixture()
    let two = git(local, "rev-parse", "two")
    expect((await runEngineAt(local, ["branch", "-m", "two", "renamed"])).exitCode).toBe(0)
    expect((await publish(local, { action: "publish", branch: "refs/heads/renamed" })).status).toBe("published")

    let result = await runEngineAt(local, ["undo"])

    expect(result.exitCode).toBe(0)
    expect(git(local, "rev-parse", "two")).toBe(two)
    expect(git(local, "config", "branch.two.merge")).toBe("refs/heads/two")
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

async function publish(path: string, request: PublishRequest, cancellation?: CancellationSignal) {
    return await executeOperationCommand(
        {
            command: "publish",
            request,
            noWait: false,
            graphOptions: () => ({ authorIdentities: { primary: "publish@example.invalid", secondary: [] }, remotePatterns: [] }),
        },
        path,
        cancellation,
    ) as PublishResult
}

async function pull(path: string, branches: string[]) {
    return await executeOperationCommand({
        command: "pull",
        request: { branches },
        noWait: false,
        graphOptions: () => ({ authorIdentities: { primary: "publish@example.invalid", secondary: [] }, remotePatterns: [] }),
    }, path) as PullResult
}

async function history(path: string) {
    let result = await executeOperationCommand({ command: "history", noWait: false }, path)
    return result as Extract<typeof result, { command: "history" }>
}
