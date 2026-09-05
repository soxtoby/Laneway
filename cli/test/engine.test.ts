import { describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const enginePath = resolve(import.meta.dir, "../bin/workbench-engine.exe")
const testSettingsPath = resolve(tmpdir(), `workbench-engine-tests-${process.pid}.json`)

async function runEngineAt(
    cwd: string,
    args: string[],
    environment: Record<string, string> = {},
) {
    const child = Bun.spawn([enginePath, ...args], {
        cwd,
        env: { ...process.env, WORKBENCH_SETTINGS_PATH: testSettingsPath, ...environment },
        stderr: "pipe",
        stdout: "pipe",
    })

    const [exitCode, stderr, stdout] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])

    return { exitCode, stderr, stdout }
}

async function runEngine(...args: string[]) {
    return runEngineAt(resolve(import.meta.dir, "../.."), args)
}

function runGitAt(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
}

async function createRepository(objectFormat: "sha1" | "sha256" = "sha1") {
    const repository = await mkdtemp(resolve(tmpdir(), "workbench-mutation-"))
    expect(runGitAt(repository, "init", "--quiet", `--object-format=${objectFormat}`).exitCode).toBe(0)
    expect(runGitAt(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
    expect(runGitAt(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
    await writeFile(resolve(repository, "README.md"), "initial\n")
    expect(runGitAt(repository, "add", "README.md").exitCode).toBe(0)
    expect(runGitAt(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
    return repository
}

async function waitForFile(path: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await access(path)
            return
        } catch {
            await Bun.sleep(20)
        }
    }
    throw new Error(`Timed out waiting for ${path}`)
}

function parseNdjson(output: string): unknown[] {
    return output.trimEnd().split("\n").map(line => JSON.parse(line))
}

describe("Workbench Engine executable", () => {
    test("reports its version", async () => {
        const result = await runEngine("--version")

        expect(result).toEqual({
            exitCode: 0,
            stderr: "",
            stdout: "workbench-engine 0.1.0\n",
        })
    })

    test("echo writes human-readable progress and its result", async () => {
        const result = await runEngine("echo", "Hello, Workbench", "--delay-ms", "0")

        expect(result).toEqual({
            exitCode: 0,
            stderr: "",
            stdout: "Preparing echo\nEchoing message\nHello, Workbench\n",
        })
    })

    test("echo streams machine-readable progress and its result", async () => {
        const result = await runEngine(
            "echo",
            "Hello, Workbench",
            "--delay-ms",
            "0",
            "--json",
        )

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe("")
        expect(parseNdjson(result.stdout)).toEqual([{
            type: "progress",
            command: "echo",
            completed: 0,
            total: 2,
            message: "Preparing echo",
        }, {
            type: "progress",
            command: "echo",
            completed: 1,
            total: 2,
            message: "Echoing message",
        }, { type: "result", command: "echo", message: "Hello, Workbench" }])
    })

    test("echo uses its default payload when only options are passed", async () => {
        const result = await runEngine("echo", "--delay-ms", "0", "--json")

        expect(result.exitCode).toBe(0)
        expect(parseNdjson(result.stdout).at(-1)).toEqual({
            type: "result",
            command: "echo",
            message: "Workbench Engine is running.",
        })
    })

    test("echo acknowledges cancellation from stdin", async () => {
        const process = Bun.spawn(
            [enginePath, "echo", "Too late", "--delay-ms", "1000", "--json"],
            { stdin: "pipe", stderr: "pipe", stdout: "pipe" },
        )

        process.stdin.write("cancel\n")
        await process.stdin.end()

        const [exitCode, stderr, stdout] = await Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).text()])
        const messages = parseNdjson(stdout)

        expect(exitCode).toBe(3)
        expect(stderr).toBe("")
        expect(messages.at(-1)).toEqual({
            type: "cancelled",
            command: "echo",
            message: "Cancellation acknowledged.",
        })
        expect(messages).not.toContainEqual({
            type: "result",
            command: "echo",
            message: "Too late",
        })
    })

    test("unknown commands return a structured usage error", async () => {
        const result = await runEngine("frobnicate", "--json")

        expect(result.exitCode).toBe(2)
        expect(result.stderr).toBe('Unknown command "frobnicate".\n')
        expect(parseNdjson(result.stdout)).toEqual([{
            type: "error",
            code: "usage.unknown-command",
            message: 'Unknown command "frobnicate".',
            details: { command: "frobnicate" },
        }])
    })

    test("malformed options return a structured usage error", async () => {
        const result = await runEngine(
            "echo",
            "Hello",
            "--delay-ms",
            "tomorrow",
            "--json",
        )

        expect(result.exitCode).toBe(2)
        expect(result.stderr).toBe(
            'Invalid value "tomorrow" for --delay-ms. Expected a non-negative integer.\n',
        )
        expect(parseNdjson(result.stdout)).toEqual([{
            type: "error",
            code: "usage.invalid-argument",
            message: 'Invalid value "tomorrow" for --delay-ms. Expected a non-negative integer.',
            details: { argument: "--delay-ms", value: "tomorrow" },
        }])
    })

    test("a Workbench Operation can be undone and redone by later Engine processes", async () => {
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        try {
            const mutation = await runEngineAt(
                repository,
                ["test-mutation", "--value", "first", "--json"],
                testEnvironment,
            )
            expect(mutation.exitCode).toBe(0)
            expect(runGitAt(repository, "show", "refs/workbench/test/fixture").stdout.toString()).toBe("first")

            const undo = await runEngineAt(repository, ["undo", "--json"], testEnvironment)
            expect(undo.exitCode).toBe(0)
            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({
                type: "result",
                command: "undo",
                status: "performed",
            })
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/workbench/test/fixture").exitCode).toBe(1)

            const redo = await runEngineAt(repository, ["redo", "--json"], testEnvironment)
            expect(redo.exitCode).toBe(0)
            expect(parseNdjson(redo.stdout).at(-1)).toMatchObject({
                type: "result",
                command: "redo",
                status: "performed",
            })
            expect(runGitAt(repository, "show", "refs/workbench/test/fixture").stdout.toString()).toBe("first")

            const history = await runEngineAt(repository, ["history", "--json"], testEnvironment)
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
                    affectedRefs: ["refs/workbench/test/fixture"],
                    affectedWorktrees: [repository],
                    isNextUndo: true,
                    isNextRedo: false,
                }],
            })
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("a Workbench Operation supports SHA-256 and an ephemeral Git path", async () => {
        const repository = await createRepository("sha256")
        const gitPath = Bun.which("git")
        expect(gitPath).toBeTruthy()

        try {
            const mutation = await runEngineAt(
                repository,
                ["test-mutation", "--value", "sha256", "--git-path", gitPath!, "--json"],
                { WORKBENCH_ENABLE_TEST_COMMANDS: "1" },
            )
            expect(mutation.exitCode).toBe(0)
            expect(runGitAt(repository, "rev-parse", "refs/workbench/test/fixture").stdout.toString().trim()).toHaveLength(64)
            expect((await runEngineAt(repository, ["undo", "--git-path", gitPath!, "--json"])).exitCode).toBe(0)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("an external worktree change creates an undo boundary without changing refs", async () => {
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        try {
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "first", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)
            const fixtureOid = runGitAt(repository, "rev-parse", "refs/workbench/test/fixture").stdout.toString().trim()

            await writeFile(resolve(repository, "README.md"), "changed outside Workbench\n")
            const undo = await runEngineAt(repository, ["undo", "--json"], testEnvironment)

            expect(undo.exitCode).toBe(1)
            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({
                type: "error",
                code: "operation.precondition-failed",
                details: { reason: "worktree-changed" },
            })
            expect(runGitAt(repository, "rev-parse", "refs/workbench/test/fixture").stdout.toString().trim()).toBe(fixtureOid)

            const history = await runEngineAt(repository, ["history", "--json"], testEnvironment)
            expect(parseNdjson(history.stdout).at(-1)).toMatchObject({
                undo: { available: false, reason: "worktree-changed" },
            })
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("recover finalizes a mutation that crashed after its ref transaction", async () => {
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        try {
            const crashed = await runEngineAt(
                repository,
                ["test-mutation", "--value", "survived", "--crash-after", "refs-committed", "--json"],
                testEnvironment,
            )
            expect(crashed.exitCode).toBe(86)
            expect(runGitAt(repository, "show", "refs/workbench/test/fixture").stdout.toString()).toBe("survived")

            const recovery = await runEngineAt(repository, ["recover", "--json"], testEnvironment)
            expect(recovery.exitCode).toBe(0)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({
                type: "result",
                command: "recover",
                status: "recovered",
                recovered: [{ action: "apply", operation: { summary: "Set the test fixture to survived" } }],
            })

            expect((await runEngineAt(repository, ["undo", "--json"], testEnvironment)).exitCode).toBe(0)
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/workbench/test/fixture").exitCode).toBe(1)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("recover finalizes an undo that crashed after its ref transaction", async () => {
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        try {
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "undo-me", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            const crashed = await runEngineAt(
                repository,
                ["undo", "--crash-after", "refs-committed", "--json"],
                testEnvironment,
            )
            expect(crashed.exitCode).toBe(86)
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/workbench/test/fixture").exitCode).toBe(1)

            const recovery = await runEngineAt(repository, ["recover", "--json"], testEnvironment)
            expect(recovery.exitCode).toBe(0)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({
                status: "recovered",
                recovered: [{ action: "undo", operation: { summary: "Set the test fixture to undo-me" } }],
            })

            expect((await runEngineAt(repository, ["redo", "--json"], testEnvironment)).exitCode).toBe(0)
            expect(runGitAt(repository, "show", "refs/workbench/test/fixture").stdout.toString()).toBe("undo-me")
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("a held repository lock can fail immediately and its operation can cancel safely", async () => {
        const repository = await createRepository()
        const testEnvironment = { ...process.env, WORKBENCH_ENABLE_TEST_COMMANDS: "1" }
        const lockPath = resolve(repository, ".git", "workbench", "mutation.lock")

        try {
            const held = Bun.spawn(
                [enginePath, "test-mutation", "--value", "cancelled", "--hold-after-intent-ms", "5000", "--json"],
                { cwd: repository, env: testEnvironment, stdin: "pipe", stderr: "pipe", stdout: "pipe" },
            )
            await waitForFile(lockPath)

            const blocked = await runEngineAt(
                repository,
                ["test-mutation", "--value", "blocked", "--no-wait", "--json"],
                testEnvironment,
            )
            expect(blocked.exitCode).toBe(1)
            expect(parseNdjson(blocked.stdout).at(-1)).toMatchObject({ type: "error", code: "operation.locked" })

            held.stdin.write("cancel\n")
            await held.stdin.end()
            const [exitCode, stdout] = await Promise.all([held.exited, new Response(held.stdout).text()])
            expect(exitCode).toBe(3)
            expect(parseNdjson(stdout).at(-1)).toMatchObject({ type: "cancelled", command: "test-mutation" })
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/workbench/test/fixture").exitCode).toBe(1)

            const recovery = await runEngineAt(repository, ["recover", "--json"], testEnvironment)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({ status: "clean", recovered: [] })
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("a Git lockfile blocks a Workbench mutation before refs change", async () => {
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        try {
            await writeFile(resolve(repository, ".git", "index.lock"), "external Git owns this lock")
            const mutation = await runEngineAt(
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
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/workbench/test/fixture").exitCode).toBe(1)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("corrupt Operation History fails safely with a stable error", async () => {
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }
        const head = runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()

        try {
            const workbenchDirectory = resolve(repository, ".git", "workbench")
            await mkdir(workbenchDirectory, { recursive: true })
            await writeFile(
                resolve(workbenchDirectory, "history.jsonl"),
                `${JSON.stringify({ schemaVersion: 1, type: "operation", executionId: "missing-operation" })}\n`,
            )

            const history = await runEngineAt(repository, ["history", "--json"], testEnvironment)
            expect(history.exitCode).toBe(1)
            expect(parseNdjson(history.stdout).at(-1)).toMatchObject({ type: "error", code: "operation.history-corrupt" })
            expect(runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()).toBe(head)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("valid JSON corruption cannot redirect undo onto an ordinary branch", async () => {
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }
        const head = runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()

        try {
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "integrity", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            const historyPath = resolve(repository, ".git", "workbench", "history.jsonl")
            const event = JSON.parse(await Bun.file(historyPath).text()) as {
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

            const undo = await runEngineAt(repository, ["undo", "--json"])
            expect(undo.exitCode).toBe(1)
            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({ type: "error", code: "operation.history-corrupt" })
            expect(runGitAt(repository, "rev-parse", "refs/heads/master").stdout.toString().trim()).toBe(head)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("empty history is unavailable without being an error and unsafe overrides are rejected", async () => {
        const repository = await createRepository()

        try {
            for (const command of ["undo", "redo"] as const) {
                const result = await runEngineAt(repository, [command, "--json"])
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
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }
        const operationIds: string[] = []

        try {
            for (let index = 1; index <= 12; index += 1) {
                const mutation = await runEngineAt(
                    repository,
                    ["test-mutation", "--value", `value-${index}`, "--json"],
                    testEnvironment,
                )
                const message = parseNdjson(mutation.stdout).at(-1) as { operation: { id: string } }
                operationIds.push(message.operation.id)
            }
            for (let index = 0; index < 4; index += 1)
                expect((await runEngineAt(repository, ["undo", "--json"])).exitCode).toBe(0)

            const history = parseNdjson((await runEngineAt(repository, ["history", "--json"])).stdout).at(-1) as {
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

            const replacement = await runEngineAt(
                repository,
                ["test-mutation", "--value", "replacement", "--json"],
                testEnvironment,
            )
            expect(replacement.exitCode).toBe(0)
            const branched = parseNdjson((await runEngineAt(repository, ["history", "--json"])).stdout).at(-1) as {
                position: number
                total: number
                redo: { available: boolean; reason: string }
            }
            expect(branched).toMatchObject({ position: 9, total: 9, redo: { available: false, reason: "empty" } })

            for (const operationId of operationIds.slice(8)) {
                const refs = runGitAt(repository, "for-each-ref", "--format=%(refname)", `refs/workbench/recovery/${operationId}/`)
                expect(refs.stdout.toString()).toBe("")
            }
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    }, 30_000)

    test("ignored files stay outside recovery while index and ref changes create boundaries", async () => {
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        const ignoredRepository = await createRepository()
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

        const indexRepository = await createRepository()
        try {
            expect(
                (await runEngineAt(
                    indexRepository,
                    ["test-mutation", "--value", "index", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)
            await writeFile(resolve(indexRepository, "README.md"), "staged outside Workbench\n")
            expect(runGitAt(indexRepository, "add", "README.md").exitCode).toBe(0)
            const undo = await runEngineAt(indexRepository, ["undo", "--json"])
            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({
                code: "operation.precondition-failed",
                details: { reason: "index-changed" },
            })
        } finally {
            await rm(indexRepository, { recursive: true, force: true })
        }

        const refRepository = await createRepository()
        try {
            expect(
                (await runEngineAt(
                    refRepository,
                    ["test-mutation", "--value", "ref", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)
            expect(runGitAt(refRepository, "update-ref", "refs/workbench/test/fixture", "HEAD").exitCode).toBe(0)
            const externalOid = runGitAt(refRepository, "rev-parse", "refs/workbench/test/fixture").stdout.toString().trim()
            const undo = await runEngineAt(refRepository, ["undo", "--json"])
            expect(parseNdjson(undo.stdout).at(-1)).toMatchObject({
                code: "operation.precondition-failed",
                details: { reason: "ref-changed" },
            })
            expect(runGitAt(refRepository, "rev-parse", "refs/workbench/test/fixture").stdout.toString().trim()).toBe(externalOid)
        } finally {
            await rm(refRepository, { recursive: true, force: true })
        }
    })

    test("linked worktrees share repository-wide Operation History", async () => {
        const repository = await createRepository()
        const linkedContainer = await mkdtemp(resolve(tmpdir(), "workbench-linked-"))
        const linkedWorktree = resolve(linkedContainer, "worktree")
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        try {
            expect(runGitAt(repository, "worktree", "add", "--quiet", "-b", "linked-test", linkedWorktree).exitCode).toBe(0)
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "shared", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(0)

            const linkedHistory = parseNdjson((await runEngineAt(linkedWorktree, ["history", "--json"])).stdout).at(-1)
            expect(linkedHistory).toMatchObject({ position: 1, total: 1 })
            expect((await runEngineAt(linkedWorktree, ["undo", "--json"])).exitCode).toBe(0)
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/workbench/test/fixture").exitCode).toBe(1)
        } finally {
            runGitAt(repository, "worktree", "remove", "--force", linkedWorktree)
            await rm(linkedContainer, { recursive: true, force: true })
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("every journal boundary recovers apply, undo, and redo idempotently", async () => {
        const phases = ["intent", "recovery-retained", "preconditions-verified", "refs-committed", "history-committed", "finalized"]
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        for (const phase of phases) {
            const repository = await createRepository()
            try {
                expect(
                    (await runEngineAt(
                        repository,
                        ["test-mutation", "--value", phase, "--crash-after", phase, "--json"],
                        testEnvironment,
                    )).exitCode,
                ).toBe(86)
                expect((await runEngineAt(repository, ["recover", "--json"])).exitCode).toBe(0)
                expect(runGitAt(repository, "show", "refs/workbench/test/fixture").stdout.toString()).toBe(phase)

                expect(
                    (await runEngineAt(
                        repository,
                        ["undo", "--crash-after", phase, "--json"],
                        testEnvironment,
                    )).exitCode,
                ).toBe(86)
                expect((await runEngineAt(repository, ["recover", "--json"])).exitCode).toBe(0)
                expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/workbench/test/fixture").exitCode).toBe(1)

                expect(
                    (await runEngineAt(
                        repository,
                        ["redo", "--crash-after", phase, "--json"],
                        testEnvironment,
                    )).exitCode,
                ).toBe(86)
                expect((await runEngineAt(repository, ["recover", "--json"])).exitCode).toBe(0)
                expect(runGitAt(repository, "show", "refs/workbench/test/fixture").stdout.toString()).toBe(phase)
            } finally {
                await rm(repository, { recursive: true, force: true })
            }
        }
    }, 60_000)

    test("corrupt recovery journal cannot change an ordinary branch", async () => {
        const repository = await createRepository()
        const head = runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()

        try {
            const workbenchDirectory = resolve(repository, ".git", "workbench")
            await mkdir(workbenchDirectory, { recursive: true })
            await writeFile(resolve(workbenchDirectory, "journal.jsonl"), "{not-json\n")

            const recovery = await runEngineAt(repository, ["recover", "--json"])
            expect(recovery.exitCode).toBe(1)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({ type: "error", code: "operation.journal-corrupt" })
            expect(runGitAt(repository, "rev-parse", "HEAD").stdout.toString().trim()).toBe(head)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("recovery refuses to resume when crash preconditions no longer match", async () => {
        const repository = await createRepository()
        const testEnvironment = { WORKBENCH_ENABLE_TEST_COMMANDS: "1" }

        try {
            expect(
                (await runEngineAt(
                    repository,
                    ["test-mutation", "--value", "blocked-recovery", "--crash-after", "intent", "--json"],
                    testEnvironment,
                )).exitCode,
            ).toBe(86)
            await writeFile(resolve(repository, "README.md"), "changed after crash\n")

            const recovery = await runEngineAt(repository, ["recover", "--json"])
            expect(recovery.exitCode).toBe(1)
            expect(parseNdjson(recovery.stdout).at(-1)).toMatchObject({
                type: "error",
                code: "operation.recovery-blocked",
                details: { reason: "worktree-changed" },
            })
            expect(runGitAt(repository, "rev-parse", "--verify", "--quiet", "refs/workbench/test/fixture").exitCode).toBe(1)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })
})
