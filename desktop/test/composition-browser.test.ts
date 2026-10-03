import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("Pragmatic drag bindings, conflict approval and keyboard transfers under production CSP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "laneway-composition-browser-"))
    try {
        const build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/composition.tsx")], outdir: directory, target: "browser" })
        expect(build.success, build.logs.join("\n")).toBe(true)
        const html = (await readFile(join(import.meta.dir, "../src/renderer/index.html"), "utf8"))
            .replace("./src/styles.css", "./styles.css").replace("./src/main.tsx", "./composition.js")
        await writeFile(join(directory, "index.html"), html)
        await writeFile(join(directory, "styles.css"), await readFile(join(import.meta.dir, "../src/renderer/src/styles.css")))
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        let errors = ""
        const code = await new Promise<number | null>((done, reject) => {
            const child = spawn(electron as unknown as string, [join(import.meta.dir, "fixtures/composition-electron.cjs"), directory], {
                env,
                windowsHide: true,
                stdio: ["ignore", "ignore", "pipe"],
                timeout: 30_000,
            })
            child.stderr.on("data", chunk => errors += chunk)
            child.on("error", reject)
            child.on("close", done)
        })
        const result = await readFile(join(directory, "result.json"), "utf8").catch(() => errors)
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
