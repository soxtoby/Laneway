import { expect } from "bun:test"
import { access, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

export let enginePath = resolve(import.meta.dir, "../bin/lane.exe")

let testSettingsPath = resolve(tmpdir(), `lane-tests-${process.pid}.json`)

export async function runEngine(...args: string[]) {
    return runEngineAt(resolve(import.meta.dir, "../.."), args)
}

export async function runEngineAt(
    cwd: string,
    args: string[],
    environment: Record<string, string> = {},
) {
    let child = Bun.spawn([enginePath, ...args], {
        cwd,
        env: { ...process.env, LANEWAY_SETTINGS_PATH: testSettingsPath, ...environment },
        stderr: "pipe",
        stdout: "pipe",
    })

    let [exitCode, stderr, stdout] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])

    return { exitCode, stderr, stdout }
}

export async function createRepository(objectFormat: "sha1" | "sha256" = "sha1") {
    let repository = await mkdtemp(resolve(tmpdir(), "laneway-mutation-"))

    expect(runGitAt(repository, "init", "--quiet", `--object-format=${objectFormat}`).exitCode).toBe(0)
    expect(runGitAt(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
    expect(runGitAt(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)

    await writeFile(resolve(repository, "README.md"), "initial\n")

    expect(runGitAt(repository, "add", "README.md").exitCode).toBe(0)
    expect(runGitAt(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)

    return repository
}

export function runGitAt(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
}

export async function waitForFile(path: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await access(path)
            return
        } catch {
            await Bun.sleep(20)
        }
    }
    throw new Error(`Timed out waiting for ${path}`)
}

export function parseNdjson(output: string): unknown[] {
    return output.trimEnd().split("\n").map(line => JSON.parse(line))
}
