import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ObjectId, openRepository } from "../src/index"

let directories: string[] = []
afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test("memoized reads repeat their first result until a command through the instance changes the repository or forgetReads is called", async () => {
    let { path, first } = await fixture()
    let repository = await openRepository(path)
    repository.memoizeReads()

    expect(await repository.resolveRef("HEAD")).toBe(first)

    let second = commit(path, "second")

    expect(await repository.resolveRef("HEAD")).toBe(first)

    await repository.command(path, ["commit-tree", `${second}^{tree}`, "-p", second], "pure object write\n")

    expect(await repository.resolveRef("HEAD")).toBe(first)

    await repository.command(path, ["update-ref", "refs/heads/other", second])

    expect(await repository.resolveRef("HEAD")).toBe(second)

    let third = commit(path, "third")
    repository.forgetReads()

    expect(await repository.resolveRef("HEAD")).toBe(third)
})

test("failures, runs with an environment, and other instances are never served from the memo", async () => {
    let { path, first } = await fixture()
    let repository = await openRepository(path)
    let other = await openRepository(path)
    repository.memoizeReads()

    expect(await repository.resolveRef("refs/heads/missing")).toBeNull()
    expect(await repository.resolveRef("HEAD")).toBe(first)

    let second = commit(path, "second")
    git(path, "update-ref", "refs/heads/missing", second)
    let environment = { GIT_DIR: join(path, ".git") }

    expect(await repository.resolveRef("refs/heads/missing")).toBe(second)
    expect((await repository.run(path, ["rev-parse", "HEAD"], undefined, environment)).stdout.toString().trim()).toBe(second)
    expect(await repository.resolveRef("HEAD")).toBe(first)

    await repository.command(path, ["update-ref", "refs/heads/other", second], undefined, environment)

    expect(await repository.resolveRef("HEAD")).toBe(second)

    let third = commit(path, "third")

    expect(await repository.resolveRef("HEAD")).toBe(second)
    expect(await other.resolveRef("HEAD")).toBe(third)
})

async function fixture() {
    let path = await mkdtemp(join(tmpdir(), "laneway-read-memo-"))
    directories.push(path)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Test")
    git(path, "config", "user.email", "test@example.invalid")
    git(path, "config", "commit.gpgsign", "false")
    return { path, first: commit(path, "first") }
}

function commit(path: string, message: string) {
    git(path, "commit", "-q", "--allow-empty", "-m", message)
    return git(path, "rev-parse", "HEAD") as ObjectId
}

function git(cwd: string, ...args: string[]) {
    let result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
}
