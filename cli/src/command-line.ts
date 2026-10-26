import { connectRepository, GitError, readRegisteredWorktrees } from "@laneway/git"
import { readSettings, SettingsError } from "@laneway/settings"
import { ConflictRequestSchema, type ErrorEvent, ExitCode, HistoricalEditRequestSchema, LocalRequestSchema, RecoveryRequestSchema, WorktreeRequestSchema } from "@laneway/shared"
import type { BranchGraphReadOptions } from "@laneway/shared"
import { resolve } from "node:path"
import { ZodError } from "zod"
import { commonOptions, flag, operands, option, parseArguments, UsageError } from "./command-arguments"
import { monitorCancellation } from "./command-cancellation"
import { commandHelp } from "./command-help"
import { resultExitCode, writeCommandResult } from "./command-output"
import { compositionRequest, conflictRequest, currentBranch, historicalApplyRequest, historicalEditRequest, publishRequest, worktreeRequest } from "./command-requests"
import { executeOperationCommand, OperationCancelledError, type OperationCommand, OperationRuntimeError } from "./operations/operation-runtime"

let wrappers: Record<string, string[]> = { commit: ["commit"], stage: ["add"], unstage: ["restore", "--staged"], branch: ["branch"], stash: ["stash"] }
let compositionOptions = {
    preview: "boolean",
    yes: "boolean",
    "allow-conflicts": "boolean",
    "no-descendants": "boolean",
    from: "string",
    to: "string",
    "source-branch": "string",
    "target-branch": "string",
    view: "string",
    file: "multiple",
    message: "multiple",
    "message-file": "string",
    remote: "string",
} as const
let worktreeOptions: Record<string, Record<string, "string" | "boolean">> = {
    create: { commit: "string", move: "boolean", local: "string" },
    switch: { path: "string", move: "boolean", local: "string" },
    rename: {},
    repair: {},
    remove: { discard: "boolean" },
    unlock: {},
    list: {},
}
let conflictOptions: Record<string, Record<string, "string" | "boolean" | "multiple">> = {
    list: {},
    inspect: { file: "multiple" },
    choose: { side: "string", hunk: "string" },
    "use-file": {},
    edit: { "content-file": "string" },
    tool: {},
    accept: {},
    cancel: {},
    "keep-stashed": {},
    "resume-working": { path: "string" },
    restore: { path: "string", adopt: "string" },
    discard: {},
    "publish-check": {},
    rewrite: { onto: "string", path: "string" },
}
let editOptions: Record<string, Record<string, "string" | "boolean" | "multiple">> = {
    enter: { path: "string" },
    apply: { path: "string", file: "multiple", view: "string", preview: "boolean", yes: "boolean", "allow-conflicts": "boolean", remote: "string" },
    return: { path: "string", drop: "boolean", bring: "boolean" },
    restart: { path: "string" },
    status: {},
}

export async function runCommandLine(argv: string[]): Promise<number | undefined> {
    if (argv[0] == "echo" && argv.length == 2 && (argv[1] == "--help" || argv[1] == "-h")) {
        console.log(commandHelp("echo"))
        return ExitCode.ok
    }
    // Existing desktop requests retain their pinned snapshots and large-selection transport.
    if (
        ["local", "local-preview", "local-transfer", "test-mutation", "echo", "--version"].includes(argv[0] ?? "")
        || (["undo", "redo", "recover"].includes(argv[0] ?? "") && argv.includes("--crash-after"))
        || (["worktree", "pull", "publish", "conflict", "recover", "edit"].includes(argv[0] ?? "")
            && argv.some(arg => arg == "--request" || arg == "--request-file"))
    ) {
        return undefined
    }

    if (
        argv[0] && !argv[0].startsWith("-")
        && ![
            ...Object.keys(wrappers),
            "help",
            "move",
            "copy",
            "rebase",
            "reword",
            "worktree",
            "pull",
            "publish",
            "conflict",
            "edit",
            "undo",
            "redo",
            "history",
            "recover",
            "recovery-status",
        ].includes(argv[0])
    ) {
        return undefined
    }

    let json = argv.includes("--json")
    let cancellation: ReturnType<typeof monitorCancellation> | undefined
    try {
        let { command, rest, globals } = splitCommand(argv)
        if (!command || command == "help" || flag(globals, "help")) {
            if (command == "help" && rest.length > 1)
                throw new UsageError("Use lane help [command].")
            console.log(commandHelp(command == "help" ? rest[0] : undefined))
            return ExitCode.ok
        }
        if (wrappers[command]) {
            json = flag(globals, "json")
            if (rest.length == 1 && (rest[0] == "--help" || rest[0] == "-h")) {
                console.log(commandHelp(command))
                return ExitCode.ok
            }
            let settings = await readSettings(process.env.LANEWAY_SETTINGS_PATH)
            let cwd = resolve(option(globals, "directory") ?? process.cwd())
            let result = await executeOperationCommand(
                { command: "git", args: [...wrappers[command]!, ...rest], cwd, json, noWait: flag(globals, "no-wait") },
                cwd,
                undefined,
                option(globals, "git-path") ?? settings.gitPath,
            )
            writeCommandResult(result, json)
            return result.command == "git" ? result.exitCode : ExitCode.failure
        }

        let { args, action } = workflowArguments(command, rest)
        args.values = { ...globals.values, ...args.values }
        json = flag(args, "json")
        if (flag(args, "help")) {
            console.log(commandHelp(command))
            return ExitCode.ok
        }
        let settings = await readSettings(process.env.LANEWAY_SETTINGS_PATH)
        let cwd = resolve(option(args, "directory") ?? process.cwd())
        let gitPath = option(args, "git-path") ?? settings.gitPath
        cancellation = monitorCancellation(json)
        let repo = await connectRepository(cwd, gitPath)
        let noWait = flag(args, "no-wait")
        let execute = (operation: OperationCommand) => executeOperationCommand(operation, cwd, cancellation, repo.descriptor.git.path)
        let graphOptions = (repositoryId: string): BranchGraphReadOptions => ({
            authorIdentities: settings.authorIdentities ?? { secondary: [] },
            selectedRemote: settings.repositories?.[repositoryId]?.selectedRemote,
            remotePatterns: settings.repositories?.[repositoryId]?.remotePatterns ?? [],
        })
        let progress = (message: string, completed: number, total: number) => writeCommandResult({ type: "progress", command, message, completed, total }, json)
        let operation: OperationCommand

        if (["move", "copy", "rebase", "reword"].includes(command) || command == "edit" && action == "apply") {
            let request = LocalRequestSchema.parse(
                command == "edit" ? await historicalApplyRequest(args, repo, cwd) : await compositionRequest(command, args, repo, cwd),
            )
            let preview = await execute({ command: "local-preview", request, noWait })
            if (preview.command != "local-preview" || !preview.preview)
                throw new Error("The engine did not return a composition preview.")
            let composition = preview.preview.composition
            let needsReview = !flag(args, "yes") && Boolean(composition?.published.length || composition?.removed.length)
            let needsConflictApproval = !flag(args, "allow-conflicts") && Boolean(composition?.conflicts.length)
            if (flag(args, "preview") || needsReview || needsConflictApproval) {
                writeCommandResult(preview, json)
                if (!flag(args, "preview")) {
                    throw new UsageError(
                        needsConflictApproval
                            ? "Review the conflicts, then repeat with --allow-conflicts to proceed."
                            : "Review the plan, then repeat with --yes to proceed.",
                    )
                }
                return ExitCode.ok
            }
            operation = { command: "local", request, token: preview.preview.token, noWait }
        } else if (command == "worktree") {
            if (action == "list") {
                operands(args, 0)
                let worktrees = await readRegisteredWorktrees(repo)
                writeCommandResult({ type: "result", command: "worktree-list", worktrees }, json)
                return ExitCode.ok
            }
            operation = {
                command,
                request: WorktreeRequestSchema.parse(await worktreeRequest(action!, args, repo, cwd)),
                noWait,
                branchPrefix: settings.virtualBranchPrefix,
            }
        } else if (command == "conflict")
            operation = { command, request: ConflictRequestSchema.parse(await conflictRequest(action!, args, repo, cwd, execute)), noWait }
        else if (command == "edit")
            operation = { command, request: HistoricalEditRequestSchema.parse(await historicalEditRequest(action!, args, repo, cwd)), noWait }
        else if (command == "pull") {
            let branches = args.positionals.length ? args.positionals : [await currentBranch(repo)]
            operation = {
                command,
                noWait,
                request: {
                    branches: branches.map(branch => branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`),
                    remote: option(args, "remote"),
                },
                graphOptions,
                progress,
            }
        } else if (command == "publish")
            operation = { command, noWait, request: await publishRequest(args, repo), graphOptions, progress }
        else if (command == "recover") {
            operands(args, args.positionals.length ? 2 : 0)
            let parsed = args.positionals.length
                ? RecoveryRequestSchema.safeParse({ action: args.positionals[0], operationId: args.positionals[1] })
                : undefined
            if (parsed && !parsed.success)
                throw new UsageError("Use recover restore|remove <operation-id>.")
            operation = { command, noWait, request: parsed?.data }
        } else if (command == "undo") {
            operands(args, 0)
            operation = { command, noWait, worktreeBasename: option(args, "worktree-basename") }
        } else if (command == "redo" || command == "history" || command == "recovery-status") {
            operands(args, 0)
            operation = { command, noWait }
        } else {
            throw new UsageError(`Unknown command "${command}".`)
        }

        let result = await execute(operation)
        writeCommandResult(result, json)
        return resultExitCode(result)
    } catch (error) {
        if (error instanceof OperationCancelledError) {
            writeCommandResult({ type: "cancelled", command: argv[0] ?? "", message: error.message }, json)
            return ExitCode.cancelled
        }
        let usage = error instanceof UsageError || error instanceof ZodError || (error instanceof Error && error.message.startsWith("Unknown help topic"))
        let event: ErrorEvent = {
            type: "error",
            code: error instanceof GitError || error instanceof SettingsError || error instanceof OperationRuntimeError
                ? error.code
                : usage
                ? "usage.invalid-argument"
                : "operation.internal",
            message: error instanceof ZodError
                ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n")
                : error instanceof Error
                ? error.message
                : String(error),
            details: error instanceof GitError || error instanceof OperationRuntimeError
                ? error.details
                : error instanceof SettingsError
                ? { path: error.path }
                : undefined,
        }
        console.error(event.message)
        if (json)
            console.log(JSON.stringify(event))
        return usage ? ExitCode.usage : ExitCode.failure
    } finally {
        cancellation?.dispose()
    }
}

function splitCommand(argv: string[]) {
    let index = 0
    while (index < argv.length && argv[index]!.startsWith("-")) {
        let argument = argv[index++]!
        if (["-C", "--directory", "--git-path"].includes(argument))
            index++
    }
    let globals = parseArguments(argv.slice(0, index), commonOptions)
    return { globals, command: argv[index], rest: argv.slice(index + 1) }
}

function workflowArguments(command: string, rest: string[]) {
    let definitions: Record<string, "string" | "boolean" | "multiple">
    let action: string | undefined
    if (command == "worktree" || command == "conflict" || command == "edit") {
        action = rest[0]?.startsWith("-") ? undefined : rest.shift()
        let actions = command == "worktree" ? worktreeOptions : command == "edit" ? editOptions : conflictOptions
        if (action && !actions[action])
            throw new UsageError(`Unknown ${command} action "${action}". Use lane ${command} --help.`)
        definitions = action ? actions[action]! : {}
    } else if (command == "move" || command == "copy")
        definitions = compositionOptions
    else if (command == "reword")
        definitions = { branch: "string", message: "multiple", "message-file": "string", preview: "boolean", yes: "boolean", remote: "string" }
    else if (command == "rebase")
        definitions = { onto: "string", preview: "boolean", yes: "boolean", "allow-conflicts": "boolean", remote: "string" }
    else if (command == "pull")
        definitions = { remote: "string" }
    else if (command == "publish")
        definitions = { remote: "string", preview: "boolean", resume: "string", restore: "string" }
    else if (command == "undo")
        definitions = { "worktree-basename": "string" }
    else if (["redo", "history", "recover", "recovery-status"].includes(command))
        definitions = {}
    else
        throw new UsageError(`Unknown command "${command}".`)

    let args = parseArguments(rest, definitions)
    if ((command == "worktree" || command == "conflict" || command == "edit") && !action && !flag(args, "help"))
        throw new UsageError(`Choose an action. Use lane ${command} --help.`)
    return { args, action }
}
