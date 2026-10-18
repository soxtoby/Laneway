import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("the built React renderer commits through production IPC and restores drafts across process restart", async () => {
    let directory = await mkdtemp(join(tmpdir(), "laneway-react-local-electron-"))
    let root = resolve(import.meta.dir, "../..")
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

        // The test script builds desktop/out once; parallel test files must not rebuild it.
        for (let phase of ["draft", "commit"]) {
            let env: NodeJS.ProcessEnv = {
                ...process.env,
                LANEWAY_RENDERER: "react",
                LANEWAY_ENGINE_PATH: join(root, "cli/bin/lane.exe"),
                LANEWAY_SETTINGS_PATH: join(directory, "settings.json"),
                LANEWAY_WORKSPACE_PATH: join(directory, "workspace.json"),
            }
            delete env.ELECTRON_RUN_AS_NODE
            let errors = ""
            let exitCode = await new Promise<number | null>((done, reject) => {
                let child = spawn(electron as unknown as string, [
                    join(import.meta.dir, "fixtures/react-local-electron.cjs"),
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
            let result = await readFile(join(directory, `${phase}.json`), "utf8").catch(() => errors)
            expect(exitCode, result).toBe(0)
            expect(JSON.parse(result)).toEqual(phase == "draft" ? { draft: true } : { committed: true })
        }
        expect(git("log", "-1", "--format=%s")).toBe("Persistent desktop commit")
        expect(git("status", "--porcelain")).toBe("")
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
    function git(...args: string[]) {
        let result = Bun.spawnSync(["git", ...args], { cwd: join(directory, "repository"), stdout: "pipe", stderr: "pipe" })
        if (result.exitCode)
            throw new Error(result.stderr.toString())
        return result.stdout.toString().trim()
    }
}, 180_000)
