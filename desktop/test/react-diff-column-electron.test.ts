import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test(
    "a large diff column draws only the diffs, toolbars, and source rows near its view in the built app, each other diff once it nears, and glides to a chosen file",
    async () => {
        let directory = await mkdtemp(join(tmpdir(), "laneway-react-diff-column-"))
        let root = resolve(import.meta.dir, "../..")
        try {
            await mkdir(join(directory, "repository"))
            git("init", "-q", "-b", "main")
            git("config", "user.name", "Desktop Test")
            git("config", "user.email", "test@example.invalid")
            git("config", "commit.gpgsign", "false")
            // Every file's diff is taller than the window, and the files run well past the bottom of their list.
            let names = Array.from({ length: 72 }, (_, index) => `file-${String(index).padStart(3, "0")}.ts`)
            for (let name of names)
                await writeFile(join(directory, "repository", name), lines(name, "before"))
            git("add", ".")
            git("commit", "-q", "-m", "Add the files")
            for (let name of names)
                await writeFile(join(directory, "repository", name), lines(name, "after"))
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
            let env: NodeJS.ProcessEnv = {
                ...process.env,
                LANEWAY_ENGINE_PATH: join(root, "cli/bin/lane.exe"),
                LANEWAY_SETTINGS_PATH: join(directory, "settings.json"),
                LANEWAY_WORKSPACE_PATH: join(directory, "workspace.json"),
            }
            delete env.ELECTRON_RUN_AS_NODE
            let errors = ""
            let exitCode = await new Promise<number | null>((done, reject) => {
                let child = spawn(electron as unknown as string, [
                    join(import.meta.dir, "fixtures/react-diff-column-electron.cjs"),
                    directory,
                    join(root, "desktop/out/main/index.js"),
                ], {
                    env,
                    windowsHide: true,
                    stdio: ["ignore", "ignore", "pipe"],
                    timeout: 60_000,
                })
                child.stderr.on("data", chunk => errors += String(chunk))
                child.on("error", reject)
                child.on("close", done)
            })
            let result = await readFile(join(directory, "result.json"), "utf8").catch(() => errors || "Electron exited before writing its result.")
            expect(exitCode, result).toBe(0)

            let { opened, ...nearing } = JSON.parse(result)
            expect(opened.drawn.length).toBeLessThanOrEqual(2)
            expect(opened.drawn[0]).toBe("file-000.ts")
            expect(opened.lastHoldsItsPlace).toBe(true)
            expect(opened.lastToolbarWaits).toBe(true)
            expect(opened.sourceRows).toBeLessThan(72)
            expect(nearing).toEqual({ uncovered: true, scrolled: true, glided: { through: true, oneWay: true, landed: true } })
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
    },
    90_000,
)

function lines(name: string, version: string) {
    return Array.from({ length: 30 }, (_, line) => `export let ${name.replace(/\W/g, "_")}_${line} = "${version} ${line}"\n`).join("")
}
