import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { createRepository, parseNdjson, runEngineAt, runGitAt } from "./engine-fixture"

describe("Laneway Engine executable", () => {
    test("a Laneway Operation can be undone and redone by later Engine processes", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        try {
            let mutation = await runEngineAt(
                repository,
                ["test-mutation", "--value", "first", "--json"],
                testEnvironment,
            )

            expect(mutation.exitCode).toBe(0)
            expect(runGitAt(repository, "show", "refs/laneway/test/fixture").stdout.toString()).toBe("first")

            let undo = await runEngineAt(repository, ["undo", "--json"], testEnvironment)

            expect(undo.exitCode).toBe(0)
            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({
                type: "result",
                command: "undo",
                status: "performed",
            })
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/laneway/test/fixture").exitCode).toBe(1)

            let redo = await runEngineAt(repository, ["redo", "--json"], testEnvironment)

            expect(redo.exitCode).toBe(0)
            expect(parseNdjson(redo.stdout).at(-1)).toMatchObject({
                type: "result",
                command: "redo",
                status: "performed",
            })
            expect(runGitAt(repository, "show", "refs/laneway/test/fixture").stdout.toString()).toBe("first")

            let history = await runEngineAt(repository, ["history", "--json"], testEnvironment)

            expect(history.exitCode).toBe(0)
            expect(parseNdjson(history.stdout).at(-1)).toMatchObject({
                type: "result",
                command: "history",
                position: 1,
                total: 1,
                entries: [{
                    kind: "test.ref-update",
                    summary: "Set the test fixture to first",
                    state: "applied",
                    affectedRefs: ["refs/laneway/test/fixture"],
                    affectedWorktrees: [repository],
                    isNextUndo: true,
                    isNextRedo: false,
                }],
            })
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("a Laneway Operation supports SHA-256 and an ephemeral Git path", async () => {
        let repository = await createRepository("sha256")
        let gitPath = Bun.which("git")

        expect(gitPath).toBeTruthy()

        try {
            let mutation = await runEngineAt(
                repository,
                ["test-mutation", "--value", "sha256", "--git-path", gitPath!, "--json"],
                { LANEWAY_ENABLE_TEST_COMMANDS: "1" },
            )

            expect(mutation.exitCode).toBe(0)
            expect(runGitAt(repository, "rev-parse", "refs/laneway/test/fixture").stdout.toString().trim()).toHaveLength(64)
            expect((await runEngineAt(repository, ["undo", "--git-path", gitPath!, "--json"])).exitCode).toBe(0)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("an external worktree change creates an undo boundary without changing refs", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        try {
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "first", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            let fixtureOid = runGitAt(repository, "rev-parse", "refs/laneway/test/fixture").stdout.toString().trim()

            await writeFile(resolve(repository, "README.md"), "changed outside Laneway\n")
            let undo = await runEngineAt(repository, ["undo", "--json"], testEnvironment)

            expect(undo.exitCode).toBe(1)
            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({
                type: "error",
                code: "operation.precondition-failed",
                details: { reason: "worktree-changed" },
            })
            expect(runGitAt(repository, "rev-parse", "refs/laneway/test/fixture").stdout.toString().trim()).toBe(fixtureOid)

            let history = await runEngineAt(repository, ["history", "--json"], testEnvironment)

            expect(parseNdjson(history.stdout).at(-1)).toMatchObject({
                undo: { available: false, reason: "worktree-changed" },
            })
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("corrupt Operation History fails safely with a stable error", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }
        let head = runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()

        try {
            let lanewayDirectory = resolve(repository, ".git", "laneway")
            await mkdir(lanewayDirectory, { recursive: true })
            await writeFile(
                resolve(lanewayDirectory, "history.jsonl"),
                `${JSON.stringify({ schemaVersion: 1, type: "operation", executionId: "missing-operation" })}\n`,
            )

            let history = await runEngineAt(repository, ["history", "--json"], testEnvironment)

            expect(history.exitCode).toBe(1)
            expect(parseNdjson(history.stdout).at(-1)).toMatchObject({ type: "error", code: "operation.history-corrupt" })
            expect(runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()).toBe(head)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("valid JSON corruption cannot redirect undo onto an ordinary branch", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }
        let head = runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()

        try {
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "integrity", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            let historyPath = resolve(repository, ".git", "laneway", "history.jsonl")
            let event = JSON.parse(await Bun.file(historyPath).text()) as {
                operation: {
                    affectedRefs: string[]
                    affectedWorktrees: string[]
                    refChanges: Array<{ ref: string; before: string | null; after: string | null }>
                    worktreeChanges: unknown[]
                }
            }
            event.operation.affectedRefs = ["refs/heads/master"]
            event.operation.affectedWorktrees = []
            event.operation.refChanges = [{ ref: "refs/heads/master", before: null, after: head }]
            event.operation.worktreeChanges = []
            await writeFile(historyPath, `${JSON.stringify(event)}\n`)

            let undo = await runEngineAt(repository, ["undo", "--json"])

            expect(undo.exitCode).toBe(1)
            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({ type: "error", code: "operation.history-corrupt" })
            expect(runGitAt(repository, "rev-parse", "refs/heads/master").stdout.toString().trim()).toBe(head)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("empty history is unavailable without being an error and unsafe overrides are rejected", async () => {
        let repository = await createRepository()

        try {
            for (let command of ["undo", "redo"] as const) {
                let result = await runEngineAt(repository, [command, "--json"])

                expect(result.exitCode).toBe(0)
                expect(parseNdjson(result.stdout).at(-1)).toEqual({
                    type: "result",
                    command,
                    status: "unavailable",
                    reason: "empty",
                })
            }

            expect((await runEngineAt(repository, ["undo", "--force", "--json"])).exitCode).toBe(2)
            expect((await runEngineAt(repository, ["history", "--limit", "20", "--json"])).exitCode).toBe(2)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("history centres ten entries and a new operation abandons the redo path", async () => {
        let repository = await createRepository()
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }
        let operationIds: string[] = []

        try {
            for (let index = 1; index <= 12; index += 1) {
                let mutation = await runEngineAt(
                    repository,
                    ["test-mutation", "--value", `value-${index}`, "--json"],
                    testEnvironment,
                )
                let message = parseNdjson(mutation.stdout).at(-1) as { operation: { id: string } }
                operationIds.push(message.operation.id)
            }
            for (let index = 0; index < 4; index += 1)
                expect((await runEngineAt(repository, ["undo", "--json"])).exitCode).toBe(0)

            let history = parseNdjson((await runEngineAt(repository, ["history", "--json"])).stdout).at(-1) as {
                position: number
                total: number
                entries: Array<{ id: string; state: string; isNextUndo: boolean; isNextRedo: boolean }>
            }

            expect(history.position).toBe(8)
            expect(history.total).toBe(12)
            expect(history.entries).toHaveLength(10)
            expect(history.entries.map(entry => entry.id)).toEqual(operationIds.slice(2).reverse())
            expect(history.entries.find(entry => entry.isNextUndo)?.id).toBe(operationIds[7])
            expect(history.entries.find(entry => entry.isNextRedo)?.id).toBe(operationIds[8])

            let replacement = await runEngineAt(
                repository,
                ["test-mutation", "--value", "replacement", "--json"],
                testEnvironment,
            )

            expect(replacement.exitCode).toBe(0)

            let branched = parseNdjson((await runEngineAt(repository, ["history", "--json"])).stdout).at(-1) as {
                position: number
                total: number
                redo: { available: boolean; reason: string }
            }

            expect(branched).toMatchObject({ position: 9, total: 9, redo: { available: false, reason: "empty" } })

            for (let operationId of operationIds.slice(8)) {
                let refs = runGitAt(repository, "for-each-ref", "--format=%(refname)", `refs/laneway/recovery/${operationId}/`)

                expect(refs.stdout.toString()).toBe("")
            }
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    }, 90_000)

    test("ignored files stay outside recovery while index and ref changes create boundaries", async () => {
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        let ignoredRepository = await createRepository()
        try {
            await writeFile(resolve(ignoredRepository, ".gitignore"), "ignored.log\n")

            expect(runGitAt(ignoredRepository, "add", ".gitignore").exitCode).toBe(0)
            expect(runGitAt(ignoredRepository, "commit", "--quiet", "-m", "Ignore test log").exitCode).toBe(0)
            expect(
                (await runEngineAt(
                    ignoredRepository,
                    ["test-mutation", "--value", "ignored", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            await writeFile(resolve(ignoredRepository, "ignored.log"), "not recoverable\n")

            expect((await runEngineAt(ignoredRepository, ["undo", "--json"])).exitCode).toBe(0)
        } finally {
            await rm(ignoredRepository, { recursive: true, force: true })
        }

        let indexRepository = await createRepository()
        try {
            expect(
                (await runEngineAt(
                    indexRepository,
                    ["test-mutation", "--value", "index", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            await writeFile(resolve(indexRepository, "README.md"), "staged outside Laneway\n")

            expect(runGitAt(indexRepository, "add", "README.md").exitCode).toBe(0)

            let undo = await runEngineAt(indexRepository, ["undo", "--json"])

            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({
                code: "operation.precondition-failed",
                details: { reason: "index-changed" },
            })
        } finally {
            await rm(indexRepository, { recursive: true, force: true })
        }

        let refRepository = await createRepository()
        try {
            expect(
                (await runEngineAt(
                    refRepository,
                    ["test-mutation", "--value", "ref", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)
            expect(runGitAt(refRepository, "update-ref", "refs/laneway/test/fixture", "HEAD").exitCode).toBe(0)

            let externalOid = runGitAt(refRepository, "rev-parse", "refs/laneway/test/fixture").stdout.toString().trim()
            let undo = await runEngineAt(refRepository, ["undo", "--json"])

            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({
                code: "operation.precondition-failed",
                details: { reason: "ref-changed" },
            })
            expect(runGitAt(refRepository, "rev-parse", "refs/laneway/test/fixture").stdout.toString().trim()).toBe(externalOid)
        } finally {
            await rm(refRepository, { recursive: true, force: true })
        }
    })

    test("linked worktrees share repository-wide Operation History", async () => {
        let repository = await createRepository()
        let linkedContainer = await mkdtemp(resolve(tmpdir(), "laneway-linked-"))
        let linkedWorktree = resolve(linkedContainer, "worktree")
        let testEnvironment = { LANEWAY_ENABLE_TEST_COMMANDS: "1" }

        try {
            expect(runGitAt(repository, "worktree", "add", "--quiet", "-b", "linked-test", linkedWorktree).exitCode).toBe(0)
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "shared", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            let linkedHistory = parseNdjson((await runEngineAt(linkedWorktree, ["history", "--json"])).stdout).at(-1)

            expect(linkedHistory).toMatchObject({ position: 1, total: 1 })
            expect((await runEngineAt(linkedWorktree, ["undo", "--json"])).exitCode).toBe(0)
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/laneway/test/fixture").exitCode).toBe(1)
        } finally {
            runGitAt(repository, "worktree", "remove", "--force", linkedWorktree)
            await rm(linkedContainer, { recursive: true, force: true })
            await rm(repository, { recursive: true, force: true })
        }
    })
})
