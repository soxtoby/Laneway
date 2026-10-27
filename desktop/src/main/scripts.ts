import type { RepositoryScript, ScriptRunResult } from "@laneway/shared"
import { spawn, type SpawnOptions } from "node:child_process"
import { stat } from "node:fs/promises"

/** How much of a failed script's output its notice shows, from the end. */
let outputLimit = 1200

let escapeSequences = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")

/**
 * Runs a Repository Script in a worktree's directory. Without a terminal it runs through the system shell with no
 * window and settles once it exits, reporting a failure with the end of its output. In a terminal it settles once
 * the window opens, which shows the rest.
 */
export async function runScript(script: RepositoryScript, directory: string): Promise<ScriptRunResult> {
    if (!await isDirectory(directory))
        return { ok: false, message: `${directory} is no longer a directory.` }
    return script.terminal ? openTerminal(terminalLaunch(script.command, script.name, directory)) : runHidden(script.command, directory)
}

export async function isDirectory(path: string) {
    return stat(path).then(entry => entry.isDirectory(), () => false)
}

function runHidden(command: string, directory: string): Promise<ScriptRunResult> {
    return new Promise(resolve => {
        let output = ""
        let child = spawn(command, { cwd: directory, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        let collect = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-4 * outputLimit)
        }
        child.stdout.on("data", collect)
        child.stderr.on("data", collect)
        child.on("error", error => resolve({ ok: false, message: error.message }))
        child.on("close", (code, signal) => {
            let lines = output.replace(escapeSequences, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "")
            let tail = lines.trimEnd().slice(-outputLimit).trim()
            resolve(
                code == 0 ? { ok: true } : {
                    ok: false,
                    message: signal ? `It was stopped by ${signal}.` : `It exited with code ${code}.`,
                    ...(tail ? { output: tail } : {}),
                },
            )
        })
    })
}

interface TerminalLaunch {
    file: string
    args: string[]
    options: SpawnOptions
    /** The launcher exits once the window opens, so its exit code says whether it did. */
    waits: boolean
}

/**
 * How to open a terminal window running `command` in `directory` as if it were typed there, which stays open once
 * the command ends. Windows opens the default terminal with `start`; macOS uses Terminal and Linux the Debian
 * alternatives' terminal, best-effort.
 */
export function terminalLaunch(command: string, title: string, directory: string, platform = process.platform): TerminalLaunch {
    if (platform == "win32") {
        // Carets keep the outer shell from reading the command, quotes included, so `start` passes it on as typed.
        let escape = (text: string) => text.replace(/[()%!^"<>&|]/g, "^$&")
        return {
            file: process.env.ComSpec ?? "cmd.exe",
            args: [`/d /s /c "start ^"${escape(title)}^" cmd.exe /d /s /k ^"${escape(command)}^""`],
            options: { cwd: directory, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "ignore", "pipe"] },
            waits: true,
        }
    } else if (platform == "darwin") {
        let script = [
            "on run argv",
            `tell application "Terminal"`,
            `do script "cd " & quoted form of item 1 of argv & " && " & item 2 of argv`,
            "activate",
            "end tell",
            "end run",
        ]
        return {
            file: "osascript",
            args: [...script.flatMap(line => ["-e", line]), directory, command],
            options: { stdio: ["ignore", "ignore", "pipe"] },
            waits: true,
        }
    } else {
        return {
            file: "x-terminal-emulator",
            args: ["-e", "sh", "-c", `eval "$LANEWAY_SCRIPT"; exec "\${SHELL:-sh}"`],
            options: { cwd: directory, env: { ...process.env, LANEWAY_SCRIPT: command }, detached: true, stdio: "ignore" },
            waits: false,
        }
    }
}

function openTerminal({ file, args, options, waits }: TerminalLaunch): Promise<ScriptRunResult> {
    return new Promise(resolve => {
        let failed = (message: string) => resolve({ ok: false, message: `Laneway couldn't open a terminal: ${message}` })
        let errors = ""
        let child = spawn(file, args, options)
        child.stderr?.on("data", (chunk: Buffer) => errors += chunk.toString())
        child.on("error", error => failed(error.message))
        if (waits)
            child.on("close", code => code == 0 ? resolve({ ok: true }) : failed(errors.trim() || `exited with code ${code}.`))
        else {
            child.on("spawn", () => resolve({ ok: true }))
            child.unref()
        }
    })
}
