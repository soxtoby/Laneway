import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test(
    "switching a diff between unified and side by side keeps the line under its pinned row in place",
    async () => {
        let directory = await mkdtemp(join(tmpdir(), "laneway-react-diff-layout-"))
        let root = resolve(import.meta.dir, "../..")
        try {
            await mkdir(join(directory, "repository"))
            git("init", "-q", "-b", "main")
            git("config", "user.name", "Desktop Test")
            git("config", "user.email", "test@example.invalid")
            git("config", "commit.gpgsign", "false")
            let original = Array.from({ length: 280 }, (_, line) => `export const value_${line} = ${line}\n`)
            await writeFile(join(directory, "repository", "above.ts"), original.join(""))
            await writeFile(join(directory, "repository", "below.ts"), original.join(""))
            git("add", ".")
            git("commit", "-q", "-m", "Add the files")
            // Side by side, the diff of above.ts takes two rows for every three it takes unified, so the row of below.ts
            // moves up as they switch. The changes to below.ts replace three lines with one, so each of its additions
            // shares its side by side row with a deletion.
            await writeFile(join(directory, "repository", "above.ts"), original.map((line, index) => index % 2 ? line : line.replace("=", "= -")).join(""))
            await writeFile(
                join(directory, "repository", "below.ts"),
                original.flatMap((line, index) => index % 6 == 0 ? [line.replace("=", "= -")] : index % 6 < 3 ? [] : [line]).join(""),
            )
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
                    join(import.meta.dir, "fixtures/react-diff-layout-electron.cjs"),
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

            // The line just under the pinned row of below.ts stays there while both diffs redraw, and switching back
            // returns to the line rather than to its side by side row's deletion. With the row partway down the view,
            // the row and its first line stay put, though the file list moves the row up only a frame or more later.
            expect(JSON.parse(result)).toEqual({ pinned: { under: 0, split: 0, unified: 0 }, partway: { split: 0, unified: 0 } })
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
