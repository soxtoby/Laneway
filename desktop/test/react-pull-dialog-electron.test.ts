import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("Pull latest outcomes use the dialog width and keep long stacks readable in small windows under production CSP", async () => {
    let directory = await mkdtemp(join(tmpdir(), "laneway-pull-dialog-"))
    try {
        let build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/react-pull-dialog.tsx")], outdir: directory, target: "browser" })
        expect(build.success, build.logs.join("\n")).toBe(true)
        let styles = (await readdir(directory)).filter(name => name.endsWith(".css")).map(name => `<link rel="stylesheet" href="./${name}" />`).join("")
        let html = (await readFile(join(import.meta.dir, "../src/renderer/index.html"), "utf8"))
            .replace('<script type="module" src="./react/main.tsx"></script>', `${styles}<script type="module" src="./react-pull-dialog.js"></script>`)
        await writeFile(join(directory, "index.html"), html)

        let env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        let errors = ""
        let code = await new Promise<number | null>((done, reject) => {
            let child = spawn(electron as unknown as string, [join(import.meta.dir, "fixtures/pull-dialog-electron.cjs"), directory], {
                env,
                windowsHide: true,
                stdio: ["ignore", "ignore", "pipe"],
                timeout: 30_000,
            })
            child.stderr.on("data", chunk => errors += chunk)
            child.on("error", reject)
            child.on("close", done)
        })
        let result = await readFile(join(directory, "result.json"), "utf8").catch(() => errors)

        expect(code, result).toBe(0)
        expect(JSON.parse(result), errors).toEqual({
            desktop: { fullWidth: true, headerSeparated: true, fits: true, closeVisible: true },
            small: { fullWidth: true, headerSeparated: true, fits: true, closeVisible: true },
            problems: [],
        })
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid fixture path")
        await rm(directory, { recursive: true, force: true })
    }
}, 45_000)
