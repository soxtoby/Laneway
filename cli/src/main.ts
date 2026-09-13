import { GitError } from "@git-workbench/git"
import { readSettings, SettingsError } from "@git-workbench/settings"
import { ENGINE_VERSION, type EngineMessage, type ErrorEvent, ExitCode } from "@git-workbench/shared"
import { type WorktreeRequest, WorktreeRequestSchema } from "@git-workbench/shared"
import { type LocalRequest, LocalRequestSchema } from "@git-workbench/shared"
import { executeOperationCommand, type JournalPhase, OperationCancelledError, type OperationCommand, OperationRuntimeError } from "./operation-runtime.ts"

const args = process.argv.slice(2)

function write(message: string | EngineMessage, json: boolean) {
    if (json)
        console.log(JSON.stringify(message))
    else if (typeof message === "string")
        console.log(message)
    else if ("message" in message)
        console.log(message.message)
    else if (message.command == "history") {
        if (message.entries.length == 0)
            console.log("No Workbench Operations.")
        else {
            for (const entry of message.entries)
                console.log(`${entry.isNextUndo ? "undo" : entry.isNextRedo ? "redo" : entry.state} ${entry.id} ${entry.summary}`)
        }
    } else if (message.command == "undo" || message.command == "redo")
        console.log(message.status == "performed" ? message.operation?.summary : `Nothing to ${message.command}.`)
    else if (message.command == "test-mutation" || message.command == "worktree")
        console.log(message.operation.summary)
    else if (message.command == "local" || message.command == "local-preview") {
        console.log(
            message.preview
                ? JSON.stringify(message.preview)
                : message.status == "hook-review"
                ? `Hook changed files: ${message.changedFiles?.join(", ")}`
                : message.status,
        )
    } else if (message.command == "recover") {
        console.log(message.status == "clean" ? "No recovery is required." : `Recovered ${message.recovered.length} operation(s).`)
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
        isCancelled() {
            return cancelled
        },
        async wait(delayMs: number) {
            if (cancelled)
                return true

            return new Promise<boolean>(resolveWait => {
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

type ParsedOperationArguments =
    | { ok: true; json: boolean; gitPath?: string; command: OperationCommand }
    | { ok: false; json: boolean; error: ErrorEvent }

function parseOperationArguments(command: OperationCommand["command"], commandArguments: string[]): ParsedOperationArguments {
    const json = commandArguments.includes("--json")
    const noWait = commandArguments.includes("--no-wait")
    let value: string | undefined
    let gitPath: string | undefined
    let crashAfter: JournalPhase | undefined
    let holdAfterIntentMs: number | undefined
    let request: WorktreeRequest | undefined
    let localRequest: LocalRequest | undefined
    let token: string | undefined
    let worktreeBasename: string | undefined

    for (let index = 0; index < commandArguments.length; index += 1) {
        const argument = commandArguments[index]
        if (argument == "--json" || argument == "--no-wait")
            continue
        if (command == "undo" && argument == "--worktree-basename") {
            worktreeBasename = commandArguments[++index]
            if (!worktreeBasename)
                return invalidOperationArgument(command, json, "Provide a new basename for the restored worktree.", "--worktree-basename")
            continue
        }
        if ((command == "local" || command == "local-preview") && argument == "--request") {
            try {
                localRequest = LocalRequestSchema.parse(JSON.parse(commandArguments[++index]!))
            } catch {
                return invalidOperationArgument(command, json, "Provide a valid local operation request.", "--request")
            }
            continue
        }
        if (command == "worktree" && argument == "--request") {
            try {
                request = WorktreeRequestSchema.parse(JSON.parse(commandArguments[++index]!))
            } catch {
                return invalidOperationArgument(command, json, "Provide a valid worktree request JSON object.", "--request")
            }
            continue
        }
        if ((command == "worktree" || command == "local") && argument == "--expected") {
            token = commandArguments[++index]
            if (!token)
                return invalidOperationArgument(command, json, "Provide a preview token.", "--expected")
            continue
        }
        if (argument == "--git-path") {
            gitPath = commandArguments[index + 1]
            if (!gitPath)
                return invalidOperationArgument(command, json, "A path is required for --git-path.", "--git-path")
            index += 1
            continue
        }
        if (command == "test-mutation" && argument == "--value") {
            value = commandArguments[index + 1]
            if (value == undefined)
                break
            index += 1
            continue
        }
        if (command == "test-mutation" && argument == "--hold-after-intent-ms" && process.env.WORKBENCH_ENABLE_TEST_COMMANDS == "1") {
            const value = commandArguments[index + 1]
            const parsedValue = Number(value)
            if (value == undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(parsedValue))
                return invalidOperationArgument(command, json, `Invalid hold duration "${value ?? ""}".`, "--hold-after-intent-ms")
            holdAfterIntentMs = parsedValue
            index += 1
            continue
        }
        if (
            (command == "test-mutation" || command == "worktree" || command == "local" || command == "undo" || command == "redo") && argument == "--crash-after"
            && process.env.WORKBENCH_ENABLE_TEST_COMMANDS == "1"
        ) {
            const phase = commandArguments[index + 1]
            const phases: JournalPhase[] = [
                "intent",
                "recovery-retained",
                "preconditions-verified",
                "worktrees-committed",
                "refs-committed",
                "history-committed",
                "finalized",
            ]
            if (!phase || !phases.includes(phase as JournalPhase))
                return invalidOperationArgument(command, json, `Invalid journal phase "${phase ?? ""}".`, "--crash-after")
            crashAfter = phase as JournalPhase
            index += 1
            continue
        }

        return invalidOperationArgument(command, json, `Unknown option "${argument}" for ${command}.`, argument)
    }

    if (command == "test-mutation" && value == undefined)
        return invalidOperationArgument(command, json, "A value is required for --value.", "--value")
    if (command == "worktree" && !request)
        return invalidOperationArgument(command, json, "A worktree request is required.", "--request")
    if ((command == "local" || command == "local-preview") && !localRequest)
        return invalidOperationArgument(command, json, "A local operation request is required.", "--request")

    return {
        ok: true,
        json,
        gitPath,
        command: command == "local" || command == "local-preview"
            ? { command, request: localRequest!, token, noWait, crashAfter }
            : command == "worktree"
            ? { command, request: request!, token, noWait, crashAfter }
            : command == "test-mutation"
            ? { command, value: value!, noWait, crashAfter, holdAfterIntentMs }
            : command == "undo" || command == "redo"
            ? { command, noWait, crashAfter, ...(command == "undo" ? { worktreeBasename } : {}) }
            : { command, noWait },
    }
}

function invalidOperationArgument(command: string, json: boolean, message: string, argument: string): ParsedOperationArguments {
    return {
        ok: false,
        json,
        error: {
            type: "error",
            code: "usage.invalid-argument",
            message,
            details: { command, argument },
        },
    }
}

async function runOperationCommand(command: OperationCommand["command"], commandArguments: string[]) {
    const parsed = parseOperationArguments(command, commandArguments)
    if (!parsed.ok) {
        writeError(parsed.error, parsed.json)
        return ExitCode.usage
    }

    const cancellation = monitorCancellation()
    try {
        const settings = await readSettings(process.env.WORKBENCH_SETTINGS_PATH)
        const command = "request" in parsed.command ? { ...parsed.command, branchPrefix: settings.virtualBranchPrefix } : parsed.command
        const result = await executeOperationCommand(command, process.cwd(), cancellation, parsed.gitPath ?? settings.gitPath)
        write(result, parsed.json)
        return "status" in result && result.status == "failed" ? ExitCode.failure : ExitCode.ok
    } catch (error) {
        if (error instanceof OperationCancelledError) {
            write({ type: "cancelled", command, message: error.message }, parsed.json)
            return ExitCode.cancelled
        }
        if (error instanceof GitError || error instanceof SettingsError) {
            writeError({
                type: "error",
                code: error.code,
                message: error.message,
                details: error instanceof GitError ? error.details : { path: error.path },
            }, parsed.json)
            return ExitCode.failure
        }
        const runtimeError = error instanceof OperationRuntimeError
            ? error
            : new OperationRuntimeError("operation.internal", error instanceof Error ? error.message : String(error))
        writeError({ type: "error", code: runtimeError.code, message: runtimeError.message, details: runtimeError.details }, parsed.json)
        return ExitCode.failure
    } finally {
        cancellation.dispose()
    }
}

if (args.length == 1 && args[0] == "--version")
    console.log(`workbench-engine ${ENGINE_VERSION}`)
else if (args[0] == "echo") {
    const parsed = parseEchoArguments(args.slice(1))
    if (!parsed.ok) {
        writeError(parsed.error, parsed.json)
        process.exitCode = ExitCode.usage
    } else {
        process.exitCode = await echo(parsed.message, parsed.delayMs, parsed.json)
    }
} else if (
    args[0] == "local" || args[0] == "local-preview" || args[0] == "worktree" || args[0] == "undo" || args[0] == "redo" || args[0] == "history"
    || args[0] == "recover"
) {
    process.exitCode = await runOperationCommand(args[0], args.slice(1))
} else if (args[0] == "test-mutation" && process.env.WORKBENCH_ENABLE_TEST_COMMANDS == "1")
    process.exitCode = await runOperationCommand("test-mutation", args.slice(1))
else {
    const command = args[0] ?? ""
    writeError({
        type: "error",
        code: command ? "usage.unknown-command" : "usage.invalid-argument",
        message: command ? `Unknown command "${command}".` : "A command is required.",
        details: command ? { command } : undefined,
    }, args.includes("--json"))
    process.exitCode = ExitCode.usage
}
