import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { titleBarOverlay, windowBackground } from "../src/main/window-colors"

test("React renderer styles and menus work under production CSP in the built app, in both appearances", async () => {
    let directory = await mkdtemp(join(tmpdir(), "laneway-react-renderer-"))
    let root = resolve(import.meta.dir, "../..")
    try {
        await mkdir(join(directory, "repository"))
        git("init", "-q", "-b", "main")
        git("config", "user.name", "Desktop Test")
        git("config", "user.email", "test@example.invalid")
        git("config", "commit.gpgsign", "false")
        // Long names and lines, which must ellipsize or scroll within the column rather than widen it.
        let long = "with a description long enough to run well past the edge of a column at its default width"
        let deep = join(directory, "repository", "zz", "folders", "nested", "deeply", "enough", "to", "fill", "the", "row")
        await mkdir(deep, { recursive: true })
        await writeFile(join(deep, "named-file.txt"), "first\n")
        await writeFile(join(directory, "repository", "file.txt"), "first\n")
        git("add", ".")
        git("commit", "-q", "-m", `Add the file, ${long}`)
        await writeFile(join(directory, "repository", "file.txt"), "stashed\n")
        git("stash", "push", "-q", "-m", `Stash the file, ${long}`)
        // Enough lines that its diff runs past the bottom of the column.
        await writeFile(join(directory, "repository", "file.txt"), Array.from({ length: 60 }, (_, line) => `changed ${line} ${long} ${long}\n`).join(""))
        await writeFile(join(deep, "named-file.txt"), "changed\n")
        await writeFile(join(directory, "settings.json"), JSON.stringify({ version: 1, appearance: "light" }))
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
                join(import.meta.dir, "fixtures/react-renderer-electron.cjs"),
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

        expect(JSON.parse(result)).toEqual({
            light: {
                body: windowBackground("light"),
                header: titleBarOverlay("light").color,
                panel: "#1b2230",
                accent: "#e0930e",
            },
            dark: {
                body: windowBackground("dark"),
                header: titleBarOverlay("dark").color,
                panel: "#0f141c",
                accent: "#f5a733",
            },
            geometry: { header: 48, fileRow: 28, commitRow: 32, collapsedRepositoryRow: 36, repositoryRow: 40 },
            fits: { column: true, fileName: true, panelRowsSteady: true, inlineDiff: true },
            diffScrollbar: { takesRoom: true, onColumnEdge: true },
            contextMenu: { items: ["File history", "Discard changes", "Copy full path", "Copy relative path", "Copy file name"], atPointer: true },
            disabledCommit: { disabled: true, grey: true },
            settingsDialog: { tall: true, centred: true },
            diffColumn: { joined: true, headersAligned: true, focused: true, width: 620, split: true },
            styleElements: 0,
            problems: [],
        })
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
}, 90_000)
