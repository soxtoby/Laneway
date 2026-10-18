import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("React composition drags, approves conflicts, and transfers by keyboard under the production CSP", async () => {
    let directory = await mkdtemp(join(tmpdir(), "laneway-react-composition-"))
    try {
        let build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/react-composition.tsx")], outdir: directory, target: "browser" })
        expect(build.success, build.logs.join("\n")).toBe(true)

        // The React page with its CSP, loading the fixture and the stylesheet its imports bundle into.
        let styles = (await readdir(directory)).filter(name => name.endsWith(".css")).map(name => `<link rel="stylesheet" href="./${name}" />`).join("")
        let html = (await readFile(join(import.meta.dir, "../src/renderer/react.html"), "utf8"))
            .replace('<script type="module" src="./react/main.tsx"></script>', `${styles}<script type="module" src="./react-composition.js"></script>`)
        await writeFile(join(directory, "index.html"), html)

        let env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        let errors = ""
        let code = await new Promise<number | null>((done, reject) => {
            let child = spawn(electron as unknown as string, [join(import.meta.dir, "fixtures/composition-electron.cjs"), directory], {
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
            cancellation: true,
            dragBindingsRefresh: true,
            branchRejectsFiles: true,
            inlineMessage: true,
            positionalDrop: true,
            wholeCommitSeam: true,
            publishedWarning: true,
            conflictPrompt: true,
            keyboardCopy: true,
            immediateTransfer: true,
        })
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid test path")
        await rm(directory, { recursive: true, force: true })
    }
}, 45_000)
