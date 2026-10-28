import { type EngineMessage, EngineMessageSchema, engineVersion } from "@laneway/shared"
import { execFile, spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

let execFileAsync = promisify(execFile)

export interface EnginePathOptions {
    override?: string
    isPackaged: boolean
    applicationPath: string
    workspacePath: string
}

export interface EngineCommandOptions {
    enginePath: string
    cwd: string
    args: string[]
    /** Added to the environment the engine, and the Git it runs, inherit. */
    env?: Record<string, string>
    onMessage?: (message: EngineMessage) => void
}

export interface EngineCommandResult {
    exitCode: number
    diagnostics: string
    messages: EngineMessage[]
}

export function resolveEnginePath(options: EnginePathOptions) {
    if (options.override)
        return resolve(options.override)

    if (options.isPackaged)
        return join(dirname(options.applicationPath), "lane.exe")

    return join(options.workspacePath, "cli", "bin", "lane.exe")
}

export async function inspectEngine(enginePath: string) {
    let { stdout } = await execFileAsync(enginePath, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
    })

    return { path: enginePath, ...parseEngineIdentity(stdout) }
}

export function parseEngineIdentity(output: string) {
    let match = /^lane (\d+\.\d+\.\d+)\r?\n?$/.exec(output)

    if (!match)
        throw new Error("The selected Laneway Engine returned an invalid --version response.")

    let version = match[1]
    if (version != engineVersion)
        throw new Error(`Incompatible Laneway Engine version ${version}; expected ${engineVersion}.`)

    return { name: "lane" as const, version }
}

export function runEngineCommand(options: EngineCommandOptions) {
    let args = options.args.includes("--json")
        ? options.args
        : [...options.args, "--json"]

    let child = spawn(options.enginePath, args, {
        cwd: options.cwd,
        env: options.env && { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    })
    let messages: EngineMessage[] = []
    let diagnostics = ""

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
        diagnostics += chunk
    })

    let completion = new Promise<number>((resolveCompletion, rejectCompletion) => {
        child.once("error", rejectCompletion)
        child.once("close", code => resolveCompletion(code ?? 1))
    })

    let result = (async (): Promise<EngineCommandResult> => {
        let lines = createInterface({ input: child.stdout })
        let protocolError: Error | undefined

        for await (let line of lines) {
            if (!protocolError && line.length > 0) {
                try {
                    let message = parseEngineMessage(line)
                    messages.push(message)
                    options.onMessage?.(message)
                } catch {
                    protocolError = new Error(`Laneway Engine returned malformed NDJSON: ${line}`)
                }
            }
        }

        let exitCode = await completion
        if (protocolError)
            throw protocolError

        return { exitCode, diagnostics, messages }
    })()

    return {
        result,
        cancel() {
            child.stdin.end("cancel\n")
        },
    }
}

export function parseEngineMessage(line: string) {
    try {
        return EngineMessageSchema.parse(JSON.parse(line))
    } catch {
        throw new Error(`Laneway Engine returned malformed NDJSON: ${line}`)
    }
}
