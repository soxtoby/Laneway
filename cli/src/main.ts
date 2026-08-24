import { type CancelledEvent, type EchoResult, ENGINE_VERSION, type ErrorEvent, ExitCode, type GitSmokeResult, type ProgressEvent } from "@git-workbench/shared"
import { resolve } from "node:path"

const args = process.argv.slice(2)

function write(
    message: string | ProgressEvent | EchoResult | GitSmokeResult | CancelledEvent,
    json: boolean,
) {
    if (json)
        console.log(JSON.stringify(message))
    else if (typeof message === "string")
        console.log(message)
    else if ("message" in message)
        console.log(message.message)
    else {
        console.log(`System Git: ${message.gitVersion}`)
        console.log(`Repository: ${message.repositoryRoot}`)
    }
}

function writeError(error: ErrorEvent, json: boolean) {
    console.error(error.message)
    if (json)
        console.log(JSON.stringify(error))
}

type ParsedEchoArguments =
    | { ok: true; json: boolean; delayMs: number; message: string }
    | { ok: false; json: boolean; error: ErrorEvent }

function parseEchoArguments(commandArguments: string[]): ParsedEchoArguments {
    const json = commandArguments.includes("--json")
    let delayMs = 50
    let message: string | undefined

    for (let index = 0; index < commandArguments.length; index += 1) {
        const argument = commandArguments[index]
        if (argument == "--json")
            continue

        if (argument == "--delay-ms") {
            const value = commandArguments[index + 1]
            const parsedValue = Number(value)
            if (value == undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(parsedValue)) {
                const displayedValue = value ?? ""
                return {
                    ok: false,
                    json,
                    error: {
                        type: "error",
                        code: "usage.invalid-argument",
                        message: `Invalid value "${displayedValue}" for --delay-ms. Expected a non-negative integer.`,
                        details: { argument: "--delay-ms", value: displayedValue },
                    } satisfies ErrorEvent,
                }
            }

            delayMs = parsedValue
            index += 1
            continue
        }

        if (argument.startsWith("--")) {
            return {
                ok: false,
                json,
                error: {
                    type: "error",
                    code: "usage.invalid-argument",
                    message: `Unknown option "${argument}" for echo.`,
                    details: { argument },
                } satisfies ErrorEvent,
            }
        }

        if (message != undefined) {
            return {
                ok: false,
                json,
                error: {
                    type: "error",
                    code: "usage.invalid-argument",
                    message: `Unexpected argument "${argument}" for echo.`,
                    details: { argument },
                } satisfies ErrorEvent,
            }
        }

        message = argument
    }

    return {
        ok: true,
        json,
        delayMs,
        message: message ?? "Workbench Engine is running.",
    }
}

function monitorCancellation() {
    let buffer = ""
    let cancelled = false
    let notifyWaiter: (() => void) | undefined
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()

    const readControls = async () => {
        while (true) {
            const { done, value } = await reader.read()
            if (done)
                return

            buffer += decoder.decode(value, { stream: true })

            while (buffer.includes("\n")) {
                const newline = buffer.indexOf("\n")
                const line = buffer.slice(0, newline).trim()
                buffer = buffer.slice(newline + 1)

                if (line == "cancel" && !cancelled) {
                    cancelled = true
                    notifyWaiter?.()
                    return
                }
            }
        }
    }

    void readControls()

    return {
        async wait(delayMs: number) {
            if (cancelled)
                return true

            return new Promise<boolean>((resolveWait) => {
                const timer = setTimeout(() => {
                    notifyWaiter = undefined
                    resolveWait(false)
                }, delayMs)
                notifyWaiter = () => {
                    clearTimeout(timer)
                    notifyWaiter = undefined
                    resolveWait(true)
                }
            })
        },
        dispose() {
            void reader.cancel()
        },
    }
}

async function echo(message: string, delayMs: number, json: boolean) {
    const cancellation = monitorCancellation()

    try {
        write({
            type: "progress",
            command: "echo",
            completed: 0,
            total: 2,
            message: "Preparing echo",
        }, json)

        if (await cancellation.wait(delayMs)) {
            write({
                type: "cancelled",
                command: "echo",
                message: "Cancellation acknowledged.",
            }, json)
            return ExitCode.cancelled
        }

        write({
            type: "progress",
            command: "echo",
            completed: 1,
            total: 2,
            message: "Echoing message",
        }, json)

        if (await cancellation.wait(delayMs)) {
            write({
                type: "cancelled",
                command: "echo",
                message: "Cancellation acknowledged.",
            }, json)
            return ExitCode.cancelled
        }

        write({ type: "result", command: "echo", message }, json)
        return ExitCode.ok
    } finally {
        cancellation.dispose()
    }
}

async function runGit(...gitArgs: string[]) {
    const child = Bun.spawn(["git", ...gitArgs], {
        cwd: process.cwd(),
        stderr: "pipe",
        stdout: "pipe",
    })
    const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
    ])

    return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() }
}

async function gitSmoke(json: boolean) {
    try {
        const version = await runGit("--version")
        if (version.exitCode != 0)
            throw new Error(version.stderr || "Git did not report its version.")

        const root = await runGit("rev-parse", "--show-toplevel")
        if (root.exitCode !== 0) {
            const message = root.stderr || "The current directory is not a Git repository."
            writeError({
                type: "error",
                code: "git.smoke-failed",
                message,
            }, json)
            return ExitCode.failure
        }

        write({
            type: "result",
            command: "git-smoke",
            gitVersion: version.stdout,
            repositoryRoot: resolve(root.stdout),
        }, json)
        return ExitCode.ok
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeError({ type: "error", code: "git.unavailable", message }, json)
        return ExitCode.failure
    }
}

if (args.length == 1 && args[0] == "--version")
    console.log(`workbench-engine ${ENGINE_VERSION}`)
else if (args[0] == "git-smoke") {
    const commandArguments = args.slice(1)
    const invalidArgument = commandArguments.find((argument) => argument !== "--json")
    const json = commandArguments.includes("--json")

    if (invalidArgument) {
        writeError({
            type: "error",
            code: "usage.invalid-argument",
            message: `Unknown option "${invalidArgument}" for git-smoke.`,
            details: { argument: invalidArgument },
        }, json)
        process.exitCode = ExitCode.usage
    } else {
        process.exitCode = await gitSmoke(json)
    }
} else if (args[0] == "echo") {
    const parsed = parseEchoArguments(args.slice(1))
    if (!parsed.ok) {
        writeError(parsed.error, parsed.json)
        process.exitCode = ExitCode.usage
    } else {
        process.exitCode = await echo(parsed.message, parsed.delayMs, parsed.json)
    }
} else {
    const command = args[0] ?? ""
    writeError({
        type: "error",
        code: command ? "usage.unknown-command" : "usage.invalid-argument",
        message: command ? `Unknown command "${command}".` : "A command is required.",
        details: command ? { command } : undefined,
    }, args.includes("--json"))
    process.exitCode = ExitCode.usage
}
