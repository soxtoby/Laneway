import { describe, expect, test } from "bun:test"
import { enginePath, parseNdjson, runEngine } from "./engine-fixture"

describe("Laneway Engine executable", () => {
    test("reports its version", async () => {
        let result = await runEngine("--version")

        expect(result).toEqual({
            exitCode: 0,
            stderr: "",
            stdout: "lane 0.1.0\n",
        })
    })

    test("echo writes human-readable progress and its result", async () => {
        let result = await runEngine("echo", "Hello, Laneway", "--delay-ms", "0")

        expect(result).toEqual({
            exitCode: 0,
            stderr: "",
            stdout: "Preparing echo\nEchoing message\nHello, Laneway\n",
        })
    })

    test("echo streams machine-readable progress and its result", async () => {
        let result = await runEngine(
            "echo",
            "Hello, Laneway",
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
        }, { type: "result", command: "echo", message: "Hello, Laneway" }])
    })

    test("echo uses its default payload when only options are passed", async () => {
        let result = await runEngine("echo", "--delay-ms", "0", "--json")

        expect(result.exitCode).toBe(0)
        expect(parseNdjson(result.stdout).at(-1)).toEqual({
            type: "result",
            command: "echo",
            message: "Laneway Engine is running.",
        })
    })

    test("echo acknowledges cancellation from stdin", async () => {
        let process = Bun.spawn(
            [enginePath, "echo", "Too late", "--delay-ms", "1000", "--json"],
            { stdin: "pipe", stderr: "pipe", stdout: "pipe" },
        )

        process.stdin.write("cancel\n")
        await process.stdin.end()

        let [exitCode, stderr, stdout] = await Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).text()])
        let messages = parseNdjson(stdout)

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
        let result = await runEngine("frobnicate", "--json")

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
        let result = await runEngine(
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
})
