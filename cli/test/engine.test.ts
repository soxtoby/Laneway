import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const enginePath = resolve(import.meta.dir, "../bin/workbench-engine.exe")

async function runEngineAt(cwd: string, ...args: string[]) {
    const process = Bun.spawn([enginePath, ...args], {
        cwd,
        stderr: "pipe",
        stdout: "pipe",
    })

    const [exitCode, stderr, stdout] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
        new Response(process.stdout).text(),
    ])

    return { exitCode, stderr, stdout }
}

async function runEngine(...args: string[]) {
    return runEngineAt(resolve(import.meta.dir, "../.."), ...args)
}

function parseNdjson(output: string): unknown[] {
    return output.trimEnd().split("\n").map((line) => JSON.parse(line))
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
        expect(parseNdjson(result.stdout)).toEqual([
            {
                type: "progress",
                command: "echo",
                completed: 0,
                total: 2,
                message: "Preparing echo",
            },
            {
                type: "progress",
                command: "echo",
                completed: 1,
                total: 2,
                message: "Echoing message",
            },
            { type: "result", command: "echo", message: "Hello, Workbench" },
        ])
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

        const [exitCode, stderr, stdout] = await Promise.all([
            process.exited,
            new Response(process.stderr).text(),
            new Response(process.stdout).text(),
        ])
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
        expect(result.stderr).toBe("Unknown command \"frobnicate\".\n")
        expect(parseNdjson(result.stdout)).toEqual([
            {
                type: "error",
                code: "usage.unknown-command",
                message: "Unknown command \"frobnicate\".",
                details: { command: "frobnicate" },
            },
        ])
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
            "Invalid value \"tomorrow\" for --delay-ms. Expected a non-negative integer.\n",
        )
        expect(parseNdjson(result.stdout)).toEqual([
            {
                type: "error",
                code: "usage.invalid-argument",
                message: "Invalid value \"tomorrow\" for --delay-ms. Expected a non-negative integer.",
                details: { argument: "--delay-ms", value: "tomorrow" },
            },
        ])
    })

    test("git-smoke reports system Git and the repository from cwd", async () => {
        const repository = await mkdtemp(resolve(tmpdir(), "workbench-git-smoke-"))

        try {
            const init = Bun.spawnSync(["git", "init", "--quiet", repository])
            expect(init.exitCode).toBe(0)

            const result = await runEngineAt(repository, "git-smoke", "--json")
            const messages = parseNdjson(result.stdout) as Array<Record<string, unknown>>

            expect(result.exitCode).toBe(0)
            expect(result.stderr).toBe("")
            expect(messages).toHaveLength(1)
            expect(messages[0]?.type).toBe("result")
            expect(messages[0]?.command).toBe("git-smoke")
            expect(messages[0]?.gitVersion).toMatch(/^git version \d+\.\d+\.\d+/)
            expect(messages[0]?.repositoryRoot).toBe(repository)
        } finally {
            await rm(repository, { recursive: true, force: true })
        }
    })

    test("git-smoke rejects unsupported arguments", async () => {
        const result = await runEngine("git-smoke", "--write", "--json")

        expect(result.exitCode).toBe(2)
        expect(parseNdjson(result.stdout)).toEqual([
            {
                type: "error",
                code: "usage.invalid-argument",
                message: "Unknown option \"--write\" for git-smoke.",
                details: { argument: "--write" },
            },
        ])
    })
})
