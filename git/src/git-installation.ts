import { constants } from "node:fs"
import { access, realpath } from "node:fs/promises"
import { basename, delimiter, dirname, resolve } from "node:path"
import { GitError } from "./git-error"
import { type GitRunResult, redactGitText, runGitProcess } from "./git-process"
import type { GitInstallation } from "./index"

let minimumGitVersion = [2, 41, 0] as const

export async function selectGit(override?: string): Promise<GitInstallation> {
    let path = override ? resolve(override) : await findGitOnPath()
    if (override) {
        try {
            await access(path, constants.X_OK)
        } catch {
            throw new GitError("git.unavailable", `The selected Git executable does not exist or cannot run: ${path}.`, { path })
        }
    }

    let result: GitRunResult
    try {
        result = await runGitProcess({ installation: { path, version: "" }, args: ["--version"] })
    } catch (error) {
        if (error instanceof GitError)
            throw error
        throw new GitError("git.unavailable", `Laneway could not start Git at ${path}.`, { path })
    }
    if (result.exitCode != 0)
        throw new GitError("git.unavailable", redactGitText(result.stderr.toString()) || `Git at ${path} could not run.`, { path })

    let version = parseGitVersion(result.stdout.toString())

    // Git for Windows supports direct invocation of its native executable. Avoid the extra
    // launcher process for automatic discovery; explicit executable overrides stay exact.
    if (!override && process.platform == "win32" && basename(dirname(path)).toLowerCase() == "cmd" && /\.windows\./.test(result.stdout.toString())) {
        for (let runtime of ["ucrt64", "mingw64", "mingw32", "clangarm64"]) {
            let native = resolve(dirname(path), "..", runtime, "bin", "git.exe")
            try {
                await access(native, constants.X_OK)
                let check = await runGitProcess({ installation: { path: native, version }, args: ["--version"] })
                if (!check.exitCode && check.stdout.equals(result.stdout))
                    return { path: await realpath(native), version }
            } catch {
                // Nonstandard installations keep using their discovered launcher.
            }
        }
    }

    return { path, version }
}

export function parseGitVersion(output: string) {
    let match = /^git version (\d+)\.(\d+)\.(\d+)(?:[^\d].*)?\s*$/.exec(output)
    if (!match)
        throw new GitError("git.unavailable", "The selected executable did not return a valid Git version.")

    let numbers = match.slice(1, 4).map(Number) as [number, number, number]
    let difference = numbers.findIndex((number, index) => number != minimumGitVersion[index])
    if (difference >= 0 && numbers[difference] < minimumGitVersion[difference]) {
        throw new GitError(
            "git.too-old",
            `Git ${numbers.join(".")} is too old. Git ${minimumGitVersion.join(".")} or newer is required.`,
            { version: numbers.join("."), minimumVersion: minimumGitVersion.join(".") },
        )
    }

    return numbers.join(".")
}

async function findGitOnPath() {
    let pathValue = process.env.PATH
    if (!pathValue)
        throw new GitError("git.unavailable", "Git was not found because PATH is empty. Install Git 2.41 or newer, or choose it in Settings.")

    let candidates = process.platform == "win32" ? ["git.exe"] : ["git"]
    for (let directory of pathValue.split(delimiter).map(value => value.replace(/^"|"$/g, "")).filter(Boolean)) {
        for (let candidate of candidates) {
            let path = resolve(directory, candidate)
            try {
                await access(path, constants.X_OK)
                return await realpath(path)
            } catch {
                // Try the next PATH entry.
            }
        }
    }
    throw new GitError("git.unavailable", "Git was not found on PATH. Install Git 2.41 or newer, or choose it in Settings.")
}
