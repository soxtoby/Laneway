import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("a file list scrolling with its column keeps the view in place as rows open and their diffs grow", async () => {
    let directory = await mkdtemp(join(tmpdir(), "laneway-react-file-tree-"))
    try {
        // Built as the app is, not for a test, where React Aria's virtualizer would draw every row and skip measuring.
        let build = await Bun.build({
            entrypoints: [join(import.meta.dir, "fixtures/react-file-tree.tsx")],
            outdir: directory,
            target: "browser",
            define: { "process.env.NODE_ENV": JSON.stringify("production") },
        })
        expect(build.success, build.logs.join("\n")).toBe(true)

        // The React page with its CSP, loading the fixture and the stylesheet its imports bundle into.
        let styles = (await readdir(directory)).filter(name => name.endsWith(".css")).map(name => `<link rel="stylesheet" href="./${name}" />`).join("")
        let html = (await readFile(join(import.meta.dir, "../src/renderer/index.html"), "utf8"))
            .replace('<script type="module" src="./react/main.tsx"></script>', `${styles}<script type="module" src="./react-file-tree.js"></script>`)
        await writeFile(join(directory, "index.html"), html)

        let env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        let errors = ""
        let code = await new Promise<number | null>((done, reject) => {
            let child = spawn(electron as unknown as string, [join(import.meta.dir, "fixtures/file-tree-electron.cjs"), directory], {
                env,
                windowsHide: true,
                stdio: ["ignore", "ignore", "pipe"],
                timeout: 30_000,
            })
            child.stderr.on("data", chunk => errors += chunk)
            child.on("error", reject)
            child.on("close", done)
        })
        let result = JSON.parse(await readFile(join(directory, "result.json"), "utf8").catch(() => errors))

        expect(code, errors).toBe(0)
        expect(result.error, result.text).toBeUndefined()
        let { before, opened, grown } = result
        // The last rows start at the top of the view, with the content below the list in view under them.
        expect(before.rowTop).toBeWithin(100, 300)
        expect(before.belowTop).toBeLessThan(600)

        // Opening a row keeps the view where it was: the row stays put, and the content below moves down by its diff.
        expect(opened.scrollTop).toBe(before.scrollTop)
        expect(opened.rowTop).toBe(before.rowTop)
        expect(opened.nextTop).toBeWithin(opened.rowBottom - 1, opened.rowBottom + 1)
        expect(opened.belowTop).toBeWithin(before.belowTop + 39, before.belowTop + 41)
        expect(opened.drawn).toBeGreaterThanOrEqual(before.drawn)

        // So does its diff growing, as a picture's does when it decodes; the row after it is now beyond the view's reach.
        expect(grown.scrollTop).toBe(before.scrollTop)
        expect(grown.rowTop).toBe(before.rowTop)
        expect(grown.rowBottom).toBeWithin(grown.rowTop + 627, grown.rowTop + 629)
        expect(grown.belowTop).toBeWithin(opened.belowTop + 559, opened.belowTop + 561)

        // Narrowing the column measured every row again without the browser reporting a ResizeObserver loop, which React
        // Aria's scroll view would cause by laying the list out inside its own resize callback; patches/ defers it a frame.
        expect(result.errors).toEqual([])
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid test path")
        await rm(directory, { recursive: true, force: true })
    }
}, 45_000)
