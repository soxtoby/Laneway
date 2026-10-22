import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { GitError } from "./git-error"
import type { GitInstallation } from "./index"

let credentialPattern = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi
let sensitiveQueryPattern = /([?&](?:access_token|auth|key|password|signature|token)=)[^&#\s]*/gi
let sensitiveHeaderPattern = /^(authorization|proxy-authorization):.*$/gim

export interface GitRunOptions {
    env?: Record<string, string>
    readOnly?: boolean
    onOutput?: (chunk: Buffer) => void
    installation: GitInstallation
    args: string[]
    cwd?: string
    input?: string | Uint8Array
    secrets?: string[]
    onProgress?: (message: string) => void
}

export interface GitRunResult {
    exitCode: number
    stderr: Buffer
    stdout: Buffer
}

export function commandFailure(result: GitRunResult, fallback: string, secrets: string[] = []) {
    let diagnostics = redactGitText(result.stderr.toString(), secrets)
    let authentication = /authentication failed|could not read username|permission denied \(publickey\)|host key verification failed|terminal prompts disabled/i
        .test(
            diagnostics,
        )
    return new GitError(
        authentication ? "git.authentication-required" : "git.command-failed",
        diagnostics || fallback,
        { gitExitCode: result.exitCode },
    )
}

export async function runGitProcess(options: GitRunOptions) {
    return startGitProcess(options).result
}

export function startGitProcess(options: GitRunOptions) {
    let cancelled = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let child: ChildProcessWithoutNullStreams
    // Without long-path support, Git on Windows silently skips files beyond 260 characters and fails
    // to delete them, which dependency trees inside worktrees reach routinely.
    let configuration = [
        ...(process.platform == "win32" ? ["-c", "core.longpaths=true"] : []),
        ...(options.readOnly ? ["-c", "diff.autoRefreshIndex=false"] : []),
    ]
    try {
        child = spawn(options.installation.path, [...configuration, ...options.args], {
            cwd: options.cwd,
            detached: process.platform != "win32",
            env: {
                ...process.env,
                ...options.env,
                GIT_TERMINAL_PROMPT: "0",
                ...(options.readOnly ? { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_LITERAL_PATHSPECS: "1" } : {}),
            },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        })
    } catch {
        throw new GitError("git.unavailable", `Laneway could not start Git at ${options.installation.path}.`, { path: options.installation.path })
    }

    let stdout: Buffer[] = []
    let stderr: Buffer[] = []
    let progressBuffer = ""
    child.stdout.on("data", (chunk: Buffer) => options.onOutput ? options.onOutput(chunk) : stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(Buffer.from(chunk))
        progressBuffer += chunk.toString()
        let segments = progressBuffer.split(/[\r\n]+/)
        progressBuffer = segments.pop() ?? ""
        for (let segment of segments) {
            let message = redactGitText(segment, options.secrets)
            if (message)
                options.onProgress?.(message)
        }
    })

    if (options.input == undefined)
        child.stdin.end()
    else
        child.stdin.end(options.input)

    let result = new Promise<GitRunResult>((resolveResult, rejectResult) => {
        child.once("error", () => rejectResult(new GitError("git.unavailable", `Laneway could not start Git at ${options.installation.path}.`)))
        child.once("close", code => {
            if (forceTimer)
                clearTimeout(forceTimer)
            let finalProgress = redactGitText(progressBuffer, options.secrets)
            if (finalProgress)
                options.onProgress?.(finalProgress)
            resolveResult({ exitCode: code ?? 1, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) })
        })
    })

    return {
        result,
        wasCancelled: () => cancelled,
        cancel() {
            if (cancelled || child.exitCode != null)
                return

            cancelled = true
            void terminateProcessTree(child.pid!, false)
            forceTimer = setTimeout(() => void terminateProcessTree(child.pid!, true), 1500)
        },
    }
}

/**
 * Whether a command only reads repository state ("read"), writes nothing a read could observe differently, such as
 * content-addressed objects ("none"), or may change refs, configuration, the index, worktrees, or registrations
 * ("change"). Anything unrecognised counts as a change. A run with its own environment is never a read, since the
 * environment may redirect it, but one that writes objects at most, or works a temporary index without touching
 * files, still changes nothing.
 */
export function commandEffect(args: string[], env?: Record<string, string>): "read" | "none" | "change" {
    let i = 0
    while (args[i]?.startsWith("-"))
        i += args[i] == "-c" || args[i] == "-C" ? 2 : 1
    let command = args[i]
    let rest = args.slice(i + 1)
    let effect = commandEffectWithoutEnvironment(command, rest)
    if (!env)
        return effect
    if (effect != "change")
        return "none"
    if (env.GIT_INDEX_FILE && ["read-tree", "add", "update-index"].includes(command!) && !rest.includes("-u"))
        return "none"
    return "change"
}

function commandEffectWithoutEnvironment(command: string | undefined, rest: string[]): "read" | "none" | "change" {
    switch (command) {
        case "cat-file":
        case "check-attr":
        case "check-ignore":
        case "diff":
        case "diff-files":
        case "diff-index":
        case "diff-tree":
        case "for-each-ref":
        case "log":
        case "ls-files":
        case "ls-tree":
        case "merge-base":
        case "merge-tree":
        case "name-rev":
        case "rev-list":
        case "rev-parse":
        case "show":
        case "show-ref":
        case "status":
        case "var":
        case "write-tree":
            return "read"
        case "config":
            return rest.some(arg => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(arg)) ? "read" : "change"
        case "worktree":
            return rest[0] == "list" ? "read" : "change"
        case "stash":
            return rest[0] == "list" || rest[0] == "show" ? "read" : rest[0] == "create" ? "none" : "change"
        case "branch":
            return rest.includes("--list") || rest.includes("--show-current") ? "read" : "change"
        case "symbolic-ref":
            return rest.filter(arg => !arg.startsWith("-")).length < 2 && !rest.includes("-d") && !rest.includes("--delete") ? "read" : "change"
        case "commit-tree":
        case "hash-object":
        case "index-pack":
        case "mktree":
        case "pack-objects":
        case "stripspace":
            return "none"
        default:
            return "change"
    }
}

export function redactGitText(text: string, secrets: string[] = []) {
    let redacted = text
        .replace(credentialPattern, "$1")
        .replace(sensitiveQueryPattern, "$1[redacted]")
        .replace(sensitiveHeaderPattern, "$1: [redacted]")

    for (let secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length))
        redacted = redacted.replaceAll(secret, "[redacted]")

    return redacted.trim()
}

async function terminateProcessTree(pid: number, force: boolean) {
    if (process.platform == "win32") {
        let args = ["/pid", String(pid), "/t"]
        if (force)
            args.push("/f")
        let killer = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true })
        await new Promise<void>(resolveCompletion => killer.once("close", () => resolveCompletion()))
    } else {
        try {
            process.kill(-pid, force ? "SIGKILL" : "SIGTERM")
        } catch {
            // The process may have exited between the completion check and signal.
        }
    }
}
