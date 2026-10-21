import { connectRepository, readConflictState } from "@laneway/git"
import type { ConflictRequest, ConflictResult, PullResult } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

test("fetches, fast-forwards the Base, restacks open stacks, preserves Working Changes, and undoes as one operation", async () => {
    let { other, local } = await fixture()
    // Upstream main advances; a colleague also adds a commit to branch one.
    git(other, "switch", "-q", "main")
    let newMain = await commit(other, "base.txt", "base updated\n", "upstream main")
    git(other, "push", "-q", "origin", "main")
    git(other, "switch", "-qc", "one", "origin/one")
    await commit(other, "shared.txt", "from colleague\n", "colleague on one")
    git(other, "push", "-q", "origin", "one")
    // Local one gains an unpublished commit; two is checked out with dirty Working Changes.
    git(local, "switch", "-q", "one")
    await commit(local, "mine.txt", "mine\n", "mine on one")
    git(local, "switch", "-q", "two")
    await writeFile(join(local, "two.txt"), "two edited\n")
    let before = { main: git(local, "rev-parse", "main"), one: git(local, "rev-parse", "one"), two: git(local, "rev-parse", "two") }
    let messages: string[] = []
    let result = await pull(local, ["refs/heads/two"], message => messages.push(message))

    expect(result.status).toBe("updated")
    expect(result.fetches).toEqual([{ remote: "origin", status: "fetched" }])
    expect(result.stacks).toHaveLength(1)
    expect(result.stacks[0]).toMatchObject({ branches: ["main", "one", "two"], status: "updated", base: { before: before.main, after: newMain } })
    expect(messages.some(message => message.startsWith("Fetching origin"))).toBe(true)
    expect(messages.some(message => message.startsWith("Updating two"))).toBe(true)
    expect(result.operation?.summary).toBe("Pull latest")
    expect(git(local, "rev-parse", "main")).toBe(newMain)
    // one: incoming colleague commit first, then the local-only commit, on the updated Base.
    expect(git(local, "log", "--format=%s", "main..one").split("\n")).toEqual(["mine on one", "colleague on one", "one"])
    expect(git(local, "log", "--format=%s", "one..two").split("\n")).toEqual(["two"])
    expect(git(local, "merge-base", "--is-ancestor", "main", "one")).toBe("")
    expect(git(local, "symbolic-ref", "--short", "HEAD")).toBe("two")
    expect(await readFile(join(local, "two.txt"), "utf8")).toBe("two edited\n")
    expect(await readFile(join(local, "base.txt"), "utf8")).toBe("base updated\n")
    expect(await readFile(join(local, "shared.txt"), "utf8")).toBe("from colleague\n")
    expect((await conflict(local, { action: "list" })).conflicts).toHaveLength(0)
    expect((await history(local)).undo.available).toBe(true)

    await transition(local, "undo")

    expect(git(local, "rev-parse", "main")).toBe(before.main)
    expect(git(local, "rev-parse", "one")).toBe(before.one)
    expect(git(local, "rev-parse", "two")).toBe(before.two)
    expect(await readFile(join(local, "two.txt"), "utf8")).toBe("two edited\n")
    // Fetch results remain available after undo.
    expect(git(local, "rev-parse", "origin/main")).toBe(newMain)

    await transition(local, "redo")

    expect(git(local, "rev-parse", "main")).toBe(newMain)
    // Already current: no new Undo entry.

    let total = (await history(local)).total
    let again = await pull(local, ["refs/heads/two"])

    expect(again.stacks[0]).toMatchObject({ status: "current" })
    expect(again.operation).toBeUndefined()
    expect((await history(local)).total).toBe(total)
}, 120_000)

test("fast-forwards a stack consisting only of the primary branch", async () => {
    let { other, local } = await fixture()
    git(other, "switch", "-q", "main")
    let newMain = await commit(other, "base.txt", "base updated\n", "upstream main")
    git(other, "push", "-q", "origin", "main")
    let before = git(local, "rev-parse", "main")
    let result = await pull(local, ["refs/heads/main"])

    expect(result.stacks).toHaveLength(1)
    expect(result.stacks[0]).toMatchObject({ branches: ["main"], status: "updated", base: { before, after: newMain } })
    expect(git(local, "rev-parse", "main")).toBe(newMain)

    let again = await pull(local, ["refs/heads/main"])

    expect(again.stacks[0]).toMatchObject({ branches: ["main"], status: "current" })
}, 120_000)

test("defers commit conflicts as an Unresolved Stack, skips a diverged Base, and updates the Unresolved Stack on a later pull", async () => {
    let { other, local } = await fixture()
    git(other, "switch", "-q", "main")
    await commit(other, "one.txt", "upstream wins\n", "conflicting main")
    git(other, "push", "-q", "origin", "main")
    let first = await pull(local, ["refs/heads/two", "refs/heads/one"])

    expect(first.stacks.map(stack => stack.status)).toEqual(["needs-resolution", "needs-resolution"])
    expect(first.stacks.map(stack => stack.branches)).toEqual([["main", "one", "two"], ["main", "one"]])
    expect(first.stacks[0].conflicts).toBe(1)

    let listed = await conflict(local, { action: "list" })

    expect(listed.conflicts).toHaveLength(1)
    expect(listed.conflicts[0].branch).toBe("two")

    let state = await readConflictState(await connectRepository(local))

    expect(state.stacks).toHaveLength(1)
    expect(state.stacks[0].branches.map(branch => branch.ref)).toEqual(["refs/heads/one", "refs/heads/two"])
    // A second upstream main commit updates the Unresolved Stack onto newer history while retaining the conflict.

    let mainAgain = await commit(other, "extra.txt", "extra\n", "more main")
    git(other, "push", "-q", "origin", "main")
    let second = await pull(local, ["refs/heads/two"])

    expect(second.stacks[0]).toMatchObject({ status: "needs-resolution", conflicts: 1 })

    let updated = await readConflictState(await connectRepository(local))

    expect(updated.stacks[0].base).toBe(mainAgain)
    expect(updated.stacks[0].steps.filter(step => step.conflict)).toHaveLength(1)
    // A locally diverged Base blocks synchronization without touching the stack.

    await commit(local, "local-main.txt", "local\n", "local main")
    await commit(other, "other-main.txt", "other\n", "remote main")
    git(other, "push", "-q", "origin", "main")
    let third = await pull(local, ["refs/heads/two"])

    expect(third.stacks[0].status).toBe("skipped")
    expect(third.stacks[0].message).toContain("Base has diverged")
    expect(third.operation).toBeUndefined()
}, 120_000)

test("adopts a rewritten upstream only without local work, and reports disappeared upstreams and failed fetches", async () => {
    let { other, local, root } = await fixture()
    // Rewrite origin/one; local one has no unpublished commits, so it adopts the rewrite.
    git(other, "switch", "-qc", "one", "origin/one")
    git(other, "commit", "-q", "--amend", "-m", "one rewritten")
    let rewritten = git(other, "rev-parse", "HEAD")
    git(other, "push", "-q", "--force", "origin", "one")
    let adopt = await pull(local, ["refs/heads/one"])

    expect(adopt.stacks[0].status).toBe("updated")
    expect(git(local, "rev-parse", "one")).toBe(rewritten)
    // Rewrite it again while local one has an unpublished commit: leave the stack unchanged and explain.

    git(local, "switch", "-q", "one")
    let localOnly = await commit(local, "mine.txt", "mine\n", "mine")
    git(other, "commit", "-q", "--amend", "-m", "one rewritten twice")
    git(other, "push", "-q", "--force", "origin", "one")
    let blocked = await pull(local, ["refs/heads/one"])

    expect(blocked.stacks[0].status).toBe("skipped")
    expect(blocked.stacks[0].message).toContain("cannot identify which local commits to retain")
    expect(git(local, "rev-parse", "one")).toBe(localOnly)
    // Upstream deleted: nothing to incorporate, so the branch synchronizes onto its Base without complaint.

    git(other, "push", "-q", "origin", "--delete", "two")
    let gone = await pull(local, ["refs/heads/two"])

    expect(["updated", "current"]).toContain(gone.stacks[0].status)
    expect(gone.stacks[0].message ?? "").not.toContain("no longer exists")
    // A failing fetch skips dependent stacks with an actionable error.

    git(local, "remote", "set-url", "origin", join(root, "missing.git"))
    let failed = await pull(local, ["refs/heads/one"])

    expect(failed.fetches[0].status).toBe("failed")
    expect(failed.stacks[0].status).toBe("skipped")
    expect(failed.stacks[0].message).toContain("Fetching origin failed")
    expect(failed.operation).toBeUndefined()
}, 120_000)

test("reports no remotes, fetch-only with no open stacks, and cancellation at a stack boundary", async () => {
    let { local } = await fixture()

    expect((await pull(local, [])).status).toBe("fetched")

    let cancelled = false
    let cancelling = await executeOperationCommand(
        {
            command: "pull",
            request: { branches: ["refs/heads/one", "refs/heads/two"] },
            noWait: false,
            graphOptions: () => ({ authorIdentities: { secondary: [] }, remotePatterns: [] }),
            progress: message => {
                if (message.startsWith("Updating "))
                    cancelled = true
            },
        },
        local,
        {
            // Cancel as soon as the first stack starts updating.
            isCancelled: () => cancelled,
            wait: async () => false,
        },
    ) as PullResult

    expect(cancelling.status).toBe("cancelled")
    expect(cancelling.stacks.some(stack => stack.status == "cancelled")).toBe(true)

    git(local, "remote", "remove", "origin")

    expect((await pull(local, ["refs/heads/one"])).status).toBe("no-remotes")
}, 120_000)
test("stacks overlapping a Historical Edit are skipped and the session continues", async () => {
    let { other, local } = await fixture()
    git(other, "switch", "-qc", "one", "origin/one")
    await commit(other, "shared.txt", "from colleague\n", "colleague on one")
    git(other, "push", "-q", "origin", "one")
    git(local, "switch", "-q", "two")
    let before = { one: git(local, "rev-parse", "one"), two: git(local, "rev-parse", "two") }
    await executeOperationCommand({ command: "edit", request: { action: "enter", path: local, commit: before.one }, noWait: false }, local)

    let result = await pull(local, ["refs/heads/two", "refs/heads/one"])

    expect(result.stacks.map(stack => [stack.branches.at(-1), stack.status])).toEqual([["two", "skipped"], ["one", "skipped"]])
    expect(result.stacks[0]!.message).toContain("two is in a Historical Edit")
    expect(git(local, "rev-parse", "one")).toBe(before.one)
    expect(git(local, "rev-parse", "two")).toBe(before.two)
    expect(git(local, "rev-parse", "HEAD")).toBe(before.one)
}, 120_000)

// A shared bare "origin" with a separate contributor clone that publishes upstream changes,
// and the local clone under test with main and a two-branch stack tracking origin.
async function fixture() {
    let root = await mkdtemp(join(tmpdir(), "laneway-pull-test-"))
    fixtures.push(root)
    let origin = join(root, "origin.git"), other = join(root, "other"), local = join(root, "local")
    git(root, "init", "-q", "--bare", "-b", "main", origin)
    git(root, "init", "-q", "-b", "main", other)
    for (let path of [other]) {
        git(path, "config", "user.name", "Pull Test")
        git(path, "config", "user.email", "pull@example.invalid")
        git(path, "config", "commit.gpgsign", "false")
    }
    await commit(other, "base.txt", "base\n", "base")
    git(other, "remote", "add", "origin", origin)
    git(other, "push", "-q", "-u", "origin", "main")
    git(root, "clone", "-q", origin, local)
    git(local, "config", "user.name", "Pull Test")
    git(local, "config", "user.email", "pull@example.invalid")
    git(local, "config", "commit.gpgsign", "false")
    git(local, "switch", "-qc", "one")
    await commit(local, "one.txt", "one\n", "one")
    git(local, "switch", "-qc", "two")
    await commit(local, "two.txt", "two\n", "two")
    git(local, "push", "-q", "-u", "origin", "one", "two")
    git(local, "switch", "-q", "main")
    git(other, "fetch", "-q", "origin")
    return { root, origin, other, local }
}
async function commit(path: string, file: string, content: string, message: string) {
    await writeFile(join(path, file), content)
    git(path, "add", "--all")
    git(path, "commit", "-qm", message)
    return git(path, "rev-parse", "HEAD")
}
function git(path: string, ...args: string[]) {
    let p = Bun.spawnSync(["git", ...args], { cwd: path, stderr: "pipe", stdout: "pipe" })
    if (p.exitCode)
        throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
}

async function pull(path: string, branches: string[], onProgress?: (message: string) => void) {
    return await executeOperationCommand({
        command: "pull",
        request: { branches },
        noWait: false,
        graphOptions: () => ({ authorIdentities: { primary: "pull@example.invalid", secondary: [] }, remotePatterns: [] }),
        progress: message => onProgress?.(message),
    }, path) as PullResult
}

async function conflict(path: string, request: ConflictRequest) {
    return await executeOperationCommand({ command: "conflict", request, noWait: false }, path) as ConflictResult
}

function transition(path: string, command: "undo" | "redo") {
    return executeOperationCommand({ command, noWait: false }, path)
}

async function history(path: string) {
    let result = await executeOperationCommand({ command: "history", noWait: false }, path)
    return result as Extract<typeof result, { command: "history" }>
}
