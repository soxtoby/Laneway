import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createRepository, parseNdjson, runEngineAt, runGitAt } from "./engine-fixture"

describe("Laneway Engine executable", () => {
    test("recover finalizes a mutation that crashed after its ref transaction", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        try {
            let crashed = await runEngineAt(
                repository,
                ["test-mutation", "--value", "survived", "--crash-after", "refs-committed", "--json"],
                testEnvironment,
            )

            expect(crashed.exitCode).toBe(86)
            expect(runGitAt(repository, "show", "refs/laneway/test/fixture").stdout.toString()).toBe("survived")

            let recovery = await runEngineAt(repository, ["recover", "--json"], testEnvironment)

            expect(recovery.exitCode).toBe(0)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({
                type: "result",
                command: "recover",
                status: "recovered",
                recovered: [{ action: "apply", operation: { summary: "Set the test fixture to survived" } }],
            })

            expect((await runEngineAt(repository, ["undo", "--json"], testEnvironment)).exitCode).toBe(0)
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/laneway/test/fixture").exitCode).toBe(1)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("recover finalizes an undo that crashed after its ref transaction", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        try {
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "undo-me", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            let crashed = await runEngineAt(
                repository,
                ["undo", "--crash-after", "refs-committed", "--json"],
                testEnvironment,
            )

            expect(crashed.exitCode).toBe(86)
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/laneway/test/fixture").exitCode).toBe(1)

            let recovery = await runEngineAt(repository, ["recover", "--json"], testEnvironment)

            expect(recovery.exitCode).toBe(0)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({
                status: "recovered",
                recovered: [{ action: "undo", operation: { summary: "Set the test fixture to undo-me" } }],
            })

            expect((await runEngineAt(repository, ["redo", "--json"], testEnvironment)).exitCode).toBe(0)
            expect(runGitAt(repository, "show", "refs/laneway/test/fixture").stdout.toString()).toBe("undo-me")
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("every journal boundary recovers apply, undo, and redo idempotently", async () => {
        let phases = ["intent", "recovery-retained", "preconditions-verified", "refs-committed", "history-committed", "finalized"]
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        for (let phase of phases) {
            let repository = await createRepository()
            try {
                expect(
                    (await runEngineAt(
                        repository,
                        ["test-mutation", "--value", phase, "--crash-after", phase, "--json"],
                        testEnvironment,
                    )).exitCode,
                ).toBe(86)
                expect((await runEngineAt(repository, ["recover", "--json"])).exitCode).toBe(0)
                expect(runGitAt(repository, "show", "refs/laneway/test/fixture").stdout.toString()).toBe(phase)

                expect(
                    (await runEngineAt(
                        repository,
                        ["undo", "--crash-after", phase, "--json"],
                        testEnvironment,
                    )).exitCode,
                ).toBe(86)
                expect((await runEngineAt(repository, ["recover", "--json"])).exitCode).toBe(0)
                expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/laneway/test/fixture").exitCode).toBe(1)

                expect(
                    (await runEngineAt(
                        repository,
                        ["redo", "--crash-after", phase, "--json"],
                        testEnvironment,
                    )).exitCode,
                ).toBe(86)
                expect((await runEngineAt(repository, ["recover", "--json"])).exitCode).toBe(0)
                expect(runGitAt(repository, "show", "refs/laneway/test/fixture").stdout.toString()).toBe(phase)
            } finally {
                await rm(repository, { recursive: true, force: true })
            }
        }
    }, 60_000)

    test("corrupt recovery journal cannot change an ordinary branch", async () => {
        let repository = await createRepository()
        let head = runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()

        try {
            let lanewayDirectory = resolve(repository, ".git", "laneway")
            await mkdir(lanewayDirectory, { recursive: true })
            await writeFile(resolve(lanewayDirectory, "journal.jsonl"), "{not-json\n")

            let recovery = await runEngineAt(repository, ["recover", "--json"])

            expect(recovery.exitCode).toBe(1)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({ type: "error", code: "operation.journal-corrupt" })
            expect(runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()).toBe(head)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("recovery refuses to resume when crash preconditions no longer match", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        try {
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "blocked-recovery", "--crash-after", "intent", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(86)

            await writeFile(resolve(repository, "README.md"), "changed after crash\n")

            let recovery = await runEngineAt(repository, ["recover", "--json"])

            expect(recovery.exitCode).toBe(1)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({
                type: "error",
                code: "operation.recovery-blocked",
                details: { reason: "worktree-changed" },
            })
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/laneway/test/fixture").exitCode).toBe(1)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })
})
