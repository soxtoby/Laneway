import type { RepositoryGit } from "@laneway/git"
import type { GitResult } from "@laneway/shared"

export async function runNativeGit(repository: RepositoryGit, args: string[], cwd: string, json: boolean): Promise<GitResult> {
    let child = Bun.spawn([repository.descriptor.git.path, ...args], {
        cwd,
        stdin: "inherit",
        stdout: json ? "pipe" : "inherit",
        stderr: json ? "pipe" : "inherit",
    })
    let [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        child.stdout ? new Response(child.stdout).text() : "",
        child.stderr ? new Response(child.stderr).text() : "",
    ])
    return { type: "result", command: "git", gitCommand: args[0]!, exitCode, stdout, stderr }
}
