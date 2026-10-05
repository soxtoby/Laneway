import { describe, expect, test } from "bun:test"
import { mkdir, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { createRepository, enginePath, parseNdjson, runEngineAt, runGitAt, waitForFile } from "./engine-fixture"

describe("Laneway Engine executable", () => {
    test("lock cleanup preserves candidates still being written", async () => {
        let repository = await createRepository()
        let directory = resolve(repository, ".git", "laneway")
        await mkdir(directory)
        let path = resolve(directory, "mutation.lock.candidate-writing")
        let candidate = await open(path, "wx")
        try {
            expect((await runEngineAt(repository, ["recover", "--json"])).exitCode).toBe(0)
            expect(await Bun.file(path).exists()).toBe(true)

            await candidate.writeFile(JSON.stringify({ pid: process.pid, token: "writing" }))
            let stale = resolve(directory, "mutation.lock.candidate-dead")
            await writeFile(stale, JSON.stringify({ pid: 2147483647, token: "dead" }))

            expect((await runEngineAt(repository, ["recover", "--json"])).exitCode).toBe(0)
            expect(await Bun.file(path).exists()).toBe(true)
            expect(await Bun.file(stale).exists()).toBe(false)
        } finally {
            await candidate.close()
            if (!repository.startsWith(resolve(tmpdir(), "laneway-mutation-")))
                throw new Error("Invalid fixture path")
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("a held repository lock can fail immediately and its operation can cancel safely", async () => {
        let repository = await createRepository()
        let testEnvironment = { ...process.env, LANEWAY_ENABLE_TEST_COMMANDS: "1" }
        let lockPath = resolve(repository, ".git", "laneway", "mutation.lock")

        try {
            let held = Bun.spawn(
                [enginePath, "test-mutation", "--value", "cancelled", "--hold-after-intent-ms", "5000", "--json"],
                { cwd: repository, env: testEnvironment, stdin: "pipe", stderr: "pipe", stdout: "pipe" },
            )
            await waitForFile(lockPath)

            let blocked = await runEngineAt(
                repository,
                ["test-mutation", "--value", "blocked", "--no-wait", "--json"],
                testEnvironment,
            )

            expect(blocked.exitCode).toBe(1)
            expect(parseNdjson(blocked.stdout).at(-1)).toMatchObject({ type: "error", code: "operation.locked" })

            held.stdin.write("cancel\n")
            await held.stdin.end()
            let [exitCode, stdout] = await Promise.all([held.exited, new Response(held.stdout).text()])

            expect(exitCode).toBe(3)
            expect(parseNdjson(stdout).at(-1)).toMatchObject({ type: "cancelled", command: "test-mutation" })
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/laneway/test/fixture").exitCode).toBe(1)

            let recovery = await runEngineAt(repository, ["recover", "--json"], testEnvironment)

            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({ status: "clean", recovered: [] })
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("a Git lockfile blocks a Laneway mutation before refs change", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        try {
            await writeFile(resolve(repository, ".git", "index.lock"), "external Git owns this lock")
            let mutation = await runEngineAt(
                repository,
                ["test-mutation", "--value", "blocked", "--json"],
                testEnvironment,
            )

            expect(mutation.exitCode).toBe(1)
            expect(parseNdjson(mutation.stdout).at(-1)).toMatchObject({
                type: "error",
                code: "operation.precondition-failed",
                details: { reason: "git-lockfile-present" },
            })
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/laneway/test/fixture").exitCode).toBe(1)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("an unrelated .lock file in the Git directory does not block a Laneway mutation", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        try {
            await writeFile(resolve(repository, ".git", "project.lock"), "")
            let mutation = await runEngineAt(
                repository,
                ["test-mutation", "--value", "allowed", "--json"],
                testEnvironment,
            )

            expect(mutation.exitCode).toBe(0)
            expect(parseNdjson(mutation.stdout).at(-1)).toMatchObject({ type: "result", command: "test-mutation" })
            expect(runGitAt(repository, "show", "refs/laneway/test/fixture").stdout.toString()).toBe("allowed")
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })
})
