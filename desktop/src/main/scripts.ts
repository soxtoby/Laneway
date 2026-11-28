import type { RepositoryScript, ScriptFile, ScriptRunResult } from "@laneway/shared"
import { spawn, type SpawnOptions } from "node:child_process"
import { stat } from "node:fs/promises"
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path"

/** How much of a failed script's output its notice shows, from the end. */
let outputLimit = 1200

let escapeSequences = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")

/** The environment variable a File Script's command reads its file's path from. */
let fileVariable = "LANEWAY_FILE"

/** The variables `cmd` answers for whatever the environment holds. */
let shellVariables = [
    "CD",
    "DATE",
    "TIME",
    "RANDOM",
    "ERRORLEVEL",
    "CMDEXTVERSION",
    "CMDCMDLINE",
    "HIGHESTNUMANODENUMBER",
    "__CD__",
    "__APPDIR__",
    "PROMPT",
    "COMSPEC",
    "PATHEXT",
]

/**
 * Runs a Repository Script in a worktree's directory, a File Script on a file there. Without a terminal it runs
 * through the system shell with no window and settles once it exits, reporting a failure with the end of its output.
 * In a terminal it settles once the window opens, which shows the rest.
 */
export async function runScript(script: RepositoryScript, directory: string, file?: ScriptFile): Promise<ScriptRunResult> {
    if (!await isDirectory(directory))
        return { ok: false, message: `${directory} is no longer a directory.` }
    let command = script.command
    let environment: Record<string, string> | undefined
    if (script.target == "file") {
        if (!file || (file.line != undefined && !(Number.isSafeInteger(file.line) && file.line > 0)))
            return { ok: false, message: "It runs on a file, and none was chosen." }
        // The path comes from a repository, so it reaches the command only as a file found inside the worktree.
        let path = resolvePath(directory, file.path)
        let found = isWithin(directory, path) ? await stat(path).catch(() => undefined) : undefined
        if (!found)
            return { ok: false, message: `${file.path} is not in ${directory}.` }
        // A submodule's folder shows among a worktree's files, and a script meant for one file would take all of it.
        if (!found.isFile())
            return { ok: false, message: `${file.path} is not a file.` }
        let expanded = fileCommand(script.command, { path, line: file.line })
        let variable = process.platform == "win32" ? variableIn(path, { ...process.env, ...expanded.environment }) : undefined
        if (variable != undefined)
            return { ok: false, message: `${file.path} has %${variable}% in its name, which the shell could read as that variable.` }
        command = expanded.command
        environment = expanded.environment
    }
    return script.terminal ? openTerminal(terminalLaunch(command, script.name, directory, environment)) : runHidden(command, directory, environment)
}

export async function isDirectory(path: string) {
    return stat(path).then(entry => entry.isDirectory(), () => false)
}

/** Whether `path` is somewhere inside `directory`: neither the directory itself nor a way out of it. */
function isWithin(directory: string, path: string) {
    let inside = relative(directory, path)
    return inside != "" && inside != ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

/**
 * The environment variable `cmd` would read in place of part of a path, if the path names one between two of its
 * percent signs. `cmd` reads a line a second time past a pipe, in `for /f`, after `call`, and for a batch file, and
 * a path that was text by then has its variables read with the rest; a variable can hold a quote, which a path can't.
 */
export function variableIn(path: string, environment: NodeJS.ProcessEnv) {
    let defined = new Set([...Object.keys(environment), ...shellVariables].map(name => name.toUpperCase()))
    return path.split("%").slice(1, -1).find(between => between.startsWith("=") || defined.has(between.toUpperCase()))
}

/**
 * A File Script's command as the shell takes it, and the environment it needs. `{file}` becomes the file's path,
 * which goes last when the command names none, and `{line}` the line chosen in its diff; a part in [brackets] holding
 * `{line}` goes when no line was chosen, and a `{line}` outside any becomes 1.
 *
 * The path is a file's name out of a repository, so the command never holds it: the path is in the environment, and
 * `{file}` becomes the variable, quoted for where it stands so that it stays one argument. That is inside the
 * command's own quotes on Windows, where a path can hold no quote, and between them in other shells, which start
 * quoting afresh inside each command substitution. A command that starts a shell of its own hands that one the path
 * as text; it can name the variable there instead.
 */
export function fileCommand(command: string, file: { path: string; line?: number }, platform = process.platform) {
    let windows = platform == "win32"
    let template = command.replace(/\[([^[\]]*\{line\}[^[\]]*)\]/g, (_part, optional: string) => file.line == undefined ? "" : optional)
    if (!template.includes("{file}"))
        template = `${template.trimEnd()} {file}`
    let expanded = ""
    // What the shell is reading where a token stands: the command, then each command substitution it is inside, with
    // the quote open there, what closes the substitution, and how many brackets of its own are open.
    let reading = [{ quote: "", closes: "", brackets: 0 }]
    for (let at = 0; at < template.length;) {
        let here = reading.at(-1)!
        let character = template[at]!
        let substitutes = !windows && here.quote != "'"
        if (template.startsWith("{file}", at)) {
            expanded += windows ? (here.quote ? `%${fileVariable}%` : `"%${fileVariable}%"`) : `${here.quote}"$${fileVariable}"${here.quote}`
            at += 6
        } else if (template.startsWith("{line}", at)) {
            expanded += String(file.line ?? 1)
            at += 6
        } else if (character == (windows ? "^" : "\\") && (windows ? !here.quote : here.quote != "'")) {
            // The shell's escape character takes the next character as it is, a quote or a brace included.
            expanded += template.slice(at, at + 2)
            at += 2
        } else if (substitutes && template.startsWith("$(", at)) {
            reading.push({ quote: "", closes: ")", brackets: 0 })
            expanded += "$("
            at += 2
        } else {
            if (character == '"' || (!windows && character == "'"))
                here.quote = here.quote == character ? "" : here.quote || character
            else if (substitutes && character == "`" && here.closes == "`")
                reading.pop()
            else if (substitutes && character == "`")
                reading.push({ quote: "", closes: "`", brackets: 0 })
            else if (here.closes == ")" && !here.quote && character == "(")
                here.brackets++
            else if (here.closes == ")" && !here.quote && character == ")" && here.brackets)
                here.brackets--
            else if (here.closes == ")" && !here.quote && character == ")")
                reading.pop()
            expanded += character
            at++
        }
    }
    return { command: expanded, environment: { [fileVariable]: file.path } }
}

function runHidden(command: string, directory: string, environment?: Record<string, string>): Promise<ScriptRunResult> {
    return new Promise(resolve => {
        let output = ""
        let child = spawn(command, {
            cwd: directory,
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            ...(environment ? { env: { ...process.env, ...environment } } : {}),
        })
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
 * alternatives' terminal, best-effort. The window's shell has `environment` too; macOS's Terminal starts its shell
 * with an environment of its own, so there the command exports it first.
 */
export function terminalLaunch(
    command: string,
    title: string,
    directory: string,
    environment?: Record<string, string>,
    platform = process.platform,
): TerminalLaunch {
    let env = { ...process.env, ...environment }
    if (platform == "win32") {
        // Carets keep the outer shell from reading the command, quotes included, so `start` passes it on as typed.
        let escape = (text: string) => text.replace(/[()%!^"<>&|]/g, "^$&")
        return {
            file: process.env.ComSpec ?? "cmd.exe",
            args: [`/d /s /c "start ^"${escape(title)}^" cmd.exe /d /s /k ^"${escape(command)}^""`],
            options: { cwd: directory, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "ignore", "pipe"] },
            waits: true,
        }
    } else if (platform == "darwin") {
        let exports = Object.entries(environment ?? {}).map(([name, value]) => `export ${name}='${value.replaceAll("'", `'\\''`)}'`)
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
            args: [...script.flatMap(line => ["-e", line]), directory, [...exports, command].join(" && ")],
            options: { stdio: ["ignore", "ignore", "pipe"] },
            waits: true,
        }
    } else {
        return {
            file: "x-terminal-emulator",
            args: ["-e", "sh", "-c", `eval "$LANEWAY_SCRIPT"; exec "\${SHELL:-sh}"`],
            options: { cwd: directory, env: { ...env, LANEWAY_SCRIPT: command }, detached: true, stdio: "ignore" },
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
