import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("rebuilt desktop commits through production IPC and restores drafts across process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbench-local-electron-"))
    const root = resolve(import.meta.dir, "../..")
    function git(...args: string[]) {
        const result = Bun.spawnSync(["git", ...args], { cwd: join(directory, "repository"), stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
    }
    try {
        await mkdir(join(directory, "repository"))
        git("init", "-q", "-b", "main")
        git("config", "user.name", "Desktop Test")
        git("config", "user.email", "test@example.invalid")
        git("config", "commit.gpgsign", "false")
        await writeFile(join(directory, "repository", "file.txt"), "desktop commit\n")
        await writeFile(
            join(directory, "workspace.json"),
            JSON.stringify({
                version: 1,
                activeRepositoryId: "fixture",
                repositories: [{
                    id: "fixture",
                    path: join(directory, "repository"),
                    name: "repository",
                    anchors: [],
                    open: true,
                    columns: [],
                    layoutInitialized: false,
                }],
            }),
        )
        const build = Bun.spawn([process.execPath, "run", "--cwd", "desktop", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" })
        const diagnostics = await new Response(build.stderr).text()
        expect(await build.exited, diagnostics).toBe(0)
        for (const phase of ["draft", "commit", "compose"]) {
            if (phase == "compose")
                await writeFile(join(directory, "repository", "file.txt"), "composed desktop change\n")
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                WORKBENCH_ENGINE_PATH: join(root, "cli/bin/workbench-engine.exe"),
                WORKBENCH_SETTINGS_PATH: join(directory, "settings.json"),
                WORKBENCH_WORKSPACE_PATH: join(directory, "workspace.json"),
            }
            delete env.ELECTRON_RUN_AS_NODE
            let errors = ""
            const exitCode = await new Promise<number | null>((done, reject) => {
                const child = spawn(electron as unknown as string, [
                    join(import.meta.dir, "fixtures/local-electron.cjs"),
                    directory,
                    join(root, "desktop/out/main/index.js"),
                    phase,
                ], {
                    env,
                    windowsHide: true,
                    stdio: ["ignore", "ignore", "pipe"],
                    timeout: 75_000,
                })
                child.stderr.on("data", chunk => errors += String(chunk))
                child.on("error", reject)
                child.on("close", done)
            })
            const result = await readFile(join(directory, `${phase}.json`), "utf8").catch(() => errors)
            expect(exitCode, result).toBe(0)
            expect(JSON.parse(result)).toEqual(phase == "draft" ? { draft: true } : phase == "compose" ? { composed: true } : { committed: true })
        }
        expect(git("log", "-1", "--format=%s")).toBe("Composed in desktop")
        expect(git("show", "HEAD:file.txt")).toBe("composed desktop change")
        expect(git("status", "--porcelain")).toBe("")
        expect(git("branch", "--show-current")).toBe("main")
        expect(git("branch", "--list", "alias", "renamed")).toBe("")
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
}, 180_000)
