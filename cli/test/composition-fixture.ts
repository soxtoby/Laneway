import type { CompositionRequest, ConflictRequest, ConflictResult, LocalRequest, LocalResult } from "@laneway/shared"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { executeOperationCommand } from "../src/operations/operation-runtime"

export function createCompositionFixtures() {
    let temporary: string[] = []

    return { fixture, cleanup }

    async function fixture(format = "sha1") {
        let path = await mkdtemp(join(tmpdir(), "laneway-compose-test-"))
        temporary.push(path)
        git(path, "init", "-q", "-b", "main", `--object-format=${format}`)
        git(path, "config", "user.name", "Test")
        git(path, "config", "user.email", "test@example.invalid")
        git(path, "config", "commit.gpgsign", "false")
        await writeFile(join(path, "a.txt"), "one\ntwo\nthree\n")
        git(path, "add", ".")
        git(path, "commit", "-qm", "base")
        let base = git(path, "rev-parse", "HEAD")
        git(path, "remote", "add", "origin", "https://example.invalid/repo.git")
        git(path, "update-ref", "refs/remotes/origin/main", base)
        git(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        git(path, "checkout", "-qb", "feature")
        return { path, base }
    }

    async function cleanup() {
        for (let path of temporary.splice(0)) {
            if (!resolve(path).startsWith(resolve(tmpdir()) + sep))
                throw new Error("Invalid fixture path")
            await rm(path, { recursive: true, force: true })
        }
    }
}

export function git(cwd: string, ...args: string[]) {
    let r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (r.exitCode)
        throw new Error(r.stderr.toString())
    return r.stdout.toString().trim()
}

export async function perform(path: string, request: LocalRequest) {
    let p = await preview(path, request)
    let r = await executeOperationCommand({ command: "local", request, token: p.token, noWait: false }, path) as LocalResult
    if (r.status == "failed")
        throw new Error(r.message)
    return r
}

export async function preview(path: string, request: LocalRequest) {
    return (await executeOperationCommand({ command: "local-preview", request, noWait: false }, path) as LocalResult).preview!
}

export function request(r: Pick<CompositionRequest, "source" | "target"> & Partial<CompositionRequest>): CompositionRequest {
    return ({
        action: "compose",
        mode: "move",
        view: "combined",
        message: "Composed",
        descendants: true,
        allowConflicts: false,
        ...r,
    })
}

export async function conflict(path: string, request: ConflictRequest) {
    return await executeOperationCommand({ command: "conflict", request, noWait: false }, path) as ConflictResult
}
