import type { BranchGraph, BranchGraphReadOptions } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { type BranchGraphReadCache, startBranchGraphRead } from "../src/branch-graph"
import { connectRepository } from "../src/index"

const directories: string[] = []
afterEach(async () => {
    for (const path of directories.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(path, { recursive: true, force: true })
    }
})

async function fixture(format = "sha1") {
    const path = await mkdtemp(join(tmpdir(), "laneway-graph-cache-"))
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
    git("commit", "--allow-empty", "-qm", "Base")
    git("remote", "add", "origin", ".")
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"))
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    git("checkout", "-qb", "feature")
    for (let i = 0; i < 6; i++)
        git("commit", "--allow-empty", "-qm", `Feature ${i}`)
    const repo = await connectRepository(path)
    let cache: BranchGraphReadCache | undefined
    const calls: Array<{ args: string[]; input?: string; output: string }> = []
    const hooks: { afterCommand?: (args: string[]) => void | Promise<void>; published: number } = { published: 0 }
    const options: BranchGraphReadOptions = { authorIdentities: { secondary: [] }, remotePatterns: [] }
    const task = (cold = false) =>
        startBranchGraphRead(
            repo.descriptor,
            (args, input) => ({
                result: repo.run(path, args, input).then(async result => {
                    calls.push({ args, input, output: result.stdout.toString() })
                    await hooks.afterCommand?.(args)
                    return result
                }),
                cancel() {},
                wasCancelled: () => false,
            }),
            options,
            cold ? undefined : cache,
            value => {
                if (!cold) {
                    cache = value
                    hooks.published++
                }
            },
        )
    const read = (cold = false) => task(cold).result
    return { path, git, repo, calls, options, read, task, hooks }
}

function comparable(graph: BranchGraph) {
    const positions = new Map(graph.history.map((point, index) => [point.objectId, index]))
    for (const [index, point] of graph.history.entries())
        expect(point.parentIds.every(parent => !positions.has(parent) || positions.get(parent)! > index)).toBe(true)
    return { ...graph, history: graph.history.toSorted((a, b) => a.objectId.localeCompare(b.objectId)) }
}

for (const format of ["sha1", "sha256"]) {
    test(`incremental graph reads only new commits and reuses history for ref-only edits (${format})`, async () => {
        const { git, calls, read } = await fixture(format)
        await read()
        git("commit", "--allow-empty", "-qm", "New commit")
        calls.length = 0
        const updated = await read()
        const walks = calls.filter(call => call.args[0] == "rev-list")
        expect(walks).toHaveLength(1)
        expect(walks[0].output.trim().split("\n")).toHaveLength(1)
        const authors = calls.filter(call => call.args[0] == "log" && call.args.includes("--no-walk"))
        expect(authors).toHaveLength(1)
        expect(authors[0].input?.trim().split("\n")).toHaveLength(1)
        expect(comparable(updated)).toEqual(comparable(await read(true)))
        git("branch", "-m", "renamed")
        git("tag", "waypoint", "HEAD~2")
        calls.length = 0
        const renamed = await read()
        expect(calls.some(call => call.args[0] == "rev-list" || call.args[0] == "log" && call.args.includes("--no-walk"))).toBe(false)
        expect(comparable(renamed)).toEqual(comparable(await read(true)))
    }, 30_000)
}

test("cached graph notices identity and mailmap changes without rereading topology", async () => {
    const { path, git, calls, read } = await fixture()
    expect((await read()).branches.find(branch => branch.name == "feature")?.involvement).toBe("involved")
    git("config", "user.email", "canonical@example.invalid")
    calls.length = 0
    expect((await read()).branches.find(branch => branch.name == "feature")?.involvement).toBe("uninvolved")
    expect(calls.some(call => call.args[0] == "rev-list")).toBe(false)
    await writeFile(join(path, ".mailmap"), "<canonical@example.invalid> <test@example.invalid>\n")
    const mapped = await read()
    expect(mapped.branches.find(branch => branch.name == "feature")?.involvement).toBe("involved")
    expect(comparable(mapped)).toEqual(comparable(await read(true)))
}, 30_000)

test("incremental graphs match cold reads through rewrites, shared bases, merges, and ref deletion", async () => {
    const { git, read } = await fixture()
    const check = async () => expect(comparable(await read())).toEqual(comparable(await read(true)))
    await check()
    const original = git("rev-parse", "HEAD")
    git("reset", "--soft", "HEAD~3")
    for (let i = 0; i < 3; i++)
        git("commit", "--allow-empty", "-qm", `Replacement ${i}`)
    await check()
    const rewritten = git("rev-parse", "HEAD")
    git("reset", "--soft", original)
    await check()
    git("reset", "--soft", rewritten)
    git("branch", "shared", "HEAD~2")
    git("checkout", "-qb", "stacked")
    git("commit", "--allow-empty", "-qm", "Stacked work")
    await check()
    git("update-ref", "refs/heads/feature", git("rev-parse", "HEAD~4"))
    await check()
    git("checkout", "-q", "feature")
    git("commit", "--allow-empty", "-qm", "Diverging work")
    git("merge", "--no-ff", "-qm", "Merge sibling", "stacked")
    await check()
    git("branch", "-D", "stacked", "shared")
    await check()
}, 30_000)

test("undo and redo reuse recent verified graph results without repeating ancestry or author reads", async () => {
    const { git, read, calls } = await fixture()
    const original = git("rev-parse", "HEAD")
    const before = await read()
    git("commit", "--allow-empty", "-qm", "Next")
    const tip = git("rev-parse", "HEAD")
    const after = await read()
    for (const [head, expected] of [[original, before], [tip, after]] as const) {
        git("reset", "--soft", head)
        calls.length = 0
        expect(await read()).toEqual(expected)
        expect(calls.some(call => call.args[0] == "rev-list" || call.args[0] == "log" && call.args.includes("--no-walk"))).toBe(false)
    }
    git("reset", "--soft", original)
    await read()
    git("commit", "--allow-empty", "-qm", "Different work after undo")
    expect(comparable(await read())).toEqual(comparable(await read(true)))
}, 30_000)

test("resetting a branch onto a shared fork recomputes its sibling's base", async () => {
    const { git, read } = await fixture()
    const fork = git("rev-parse", "HEAD~3")
    git("checkout", "-qb", "sibling", fork)
    git("commit", "--allow-empty", "-qm", "Sibling work")
    git("checkout", "-q", "feature")
    await read()
    git("reset", "--soft", fork)
    const updated = await read()
    expect(comparable(updated)).toEqual(comparable(await read(true)))
    expect(updated.branches.find(branch => branch.name == "sibling")?.base).toMatchObject({ status: "known", name: "feature" })
}, 30_000)

test("replacement refs, shallow boundaries, and configured mailmaps invalidate the appropriate cached evidence", async () => {
    const { path, git, read, calls } = await fixture()
    await read()
    const head = git("rev-parse", "HEAD"), base = git("rev-parse", "main")
    git("replace", "--graft", head, base)
    calls.length = 0
    expect(comparable(await read())).toEqual(comparable(await read(true)))
    expect(calls.filter(call => call.args[0] == "rev-list")[0].input).not.toContain("^")
    git("replace", "-d", head)
    await read()
    await writeFile(join(path, ".git", "info", "grafts"), `${head} ${base}\n`)
    expect(comparable(await read())).toEqual(comparable(await read(true)))
    await unlink(join(path, ".git", "info", "grafts"))
    await read()
    await writeFile(join(path, ".git", "shallow"), head + "\n")
    expect((await read()).limited).toContain("shallow")
    expect(comparable(await read())).toEqual(comparable(await read(true)))
    await unlink(join(path, ".git", "shallow"))
    expect((await read()).limited).not.toContain("shallow")
    git("config", "user.email", "canonical@example.invalid")
    git("config", "mailmap.file", "authors.txt")
    await writeFile(join(path, "authors.txt"), "<canonical@example.invalid> <test@example.invalid>\n")
    expect((await read()).branches.find(branch => branch.name == "feature")?.involvement).toBe("involved")
    await writeFile(join(path, "authors.txt"), "")
    expect((await read()).branches.find(branch => branch.name == "feature")?.involvement).toBe("uninvolved")
    git("config", "--unset", "mailmap.file")
    await writeFile(join(path, "authors.txt"), "<canonical@example.invalid> <test@example.invalid>\n")
    const blob = git("hash-object", "-w", "authors.txt")
    git("update-ref", "refs/mailmaps/current", blob)
    git("config", "mailmap.blob", "refs/mailmaps/current")
    expect((await read()).branches.find(branch => branch.name == "feature")?.involvement).toBe("involved")
    await writeFile(join(path, "authors.txt"), "")
    git("update-ref", "refs/mailmaps/current", git("hash-object", "-w", "authors.txt"))
    expect((await read()).branches.find(branch => branch.name == "feature")?.involvement).toBe("uninvolved")
}, 30_000)

test("collected old tips fall back safely without relying on retained unreachable history", async () => {
    const { git, read, calls } = await fixture()
    await read()
    git("reset", "--soft", "main")
    git("commit", "--allow-empty", "-qm", "External replacement")
    git("reflog", "expire", "--expire=now", "--all")
    git("gc", "--prune=now")
    calls.length = 0
    const result = await read()
    expect(calls.filter(call => call.args[0] == "rev-list")).toHaveLength(2)
    expect(comparable(result)).toEqual(comparable(await read(true)))
}, 30_000)

test("races retry and cancelled or failed reads never publish a partial cache", async () => {
    const { git, read, task, hooks } = await fixture()
    const first = await read()
    first.branches.length = 0
    expect((await read()).branches.length).toBeGreaterThan(0)
    git("commit", "--allow-empty", "-qm", "Next")
    hooks.afterCommand = args => {
        if (args[0] == "rev-list") {
            hooks.afterCommand = undefined
            git("branch", "external", "HEAD~2")
        }
    }
    const result = await read()
    expect(hooks.published).toBe(2)
    expect(comparable(result)).toEqual(comparable(await read(true)))
    git("commit", "--allow-empty", "-qm", "Cancelled read")
    const cancelled = task()
    hooks.afterCommand = args => {
        if (args[0] == "rev-list")
            cancelled.cancel()
    }
    await expect(cancelled.result).rejects.toMatchObject({ code: "git.cancelled" })
    expect(hooks.published).toBe(2)
    hooks.afterCommand = args => {
        if (args[0] == "log")
            throw new Error("Simulated author read failure")
    }
    await expect(read()).rejects.toThrow("Simulated author read failure")
    expect(hooks.published).toBe(2)
    hooks.afterCommand = undefined
    expect(comparable(await read())).toEqual(comparable(await read(true)))
}, 30_000)
