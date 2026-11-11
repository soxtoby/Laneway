import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test(
    "a diff in a maximized diff column shows its scrollbar when the column is restored, without a ResizeObserver loop",
    async () => {
        let directory = await mkdtemp(join(tmpdir(), "laneway-react-maximized-diff-"))
        let root = resolve(import.meta.dir, "../..")
        try {
            await mkdir(join(directory, "repository"))
            git("init", "-q", "-b", "main")
            git("config", "user.name", "Desktop Test")
            git("config", "user.email", "test@example.invalid")
            git("config", "commit.gpgsign", "false")
            // Its lines fit a maximized diff column, and run past a diff column at its own width.
            await writeFile(join(directory, "repository", "long.ts"), lines("before"))
            git("add", ".")
            git("commit", "-q", "-m", "Add the file")
            await writeFile(join(directory, "repository", "long.ts"), lines("after"))
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
                    join(import.meta.dir, "fixtures/react-maximized-diff-electron.cjs"),
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

            // Restoring the column narrows the diff past its lines, so its pinned scrollbar shows; showing it inside the
            // diff's own resize callback would resize the column within the browser's ResizeObserver loop.
            expect(JSON.parse(result)).toEqual({ maximized: { scrollbar: false }, restored: { scrollbar: true }, errors: [] })
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

function lines(version: string) {
    return Array.from({ length: 30 }, (_, line) => `export const value_${line} = "${version} ${"x".repeat(70)}"\n`).join("")
}
