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
    try {
        child = spawn(options.installation.path, options.readOnly ? ["-c", "diff.autoRefreshIndex=false", ...options.args] : options.args, {
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
