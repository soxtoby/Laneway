import { expect, test } from "bun:test"
import electron from "electron"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

test("image diffs decode and compare pictures under the production CSP", async () => {
    let directory = await mkdtemp(join(tmpdir(), "laneway-image-diff-electron-"))
    try {
        let build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/image-diff.tsx")], outdir: directory, target: "browser" })
        expect(build.success, build.logs.join("\n")).toBe(true)

        let html = (await readFile(join(import.meta.dir, "../src/renderer/index.html"), "utf8"))
            .replace("./src/styles.css", "./styles.css").replace("./src/main.tsx", "./image-diff.js")
        await writeFile(join(directory, "index.html"), html)
        await writeFile(join(directory, "styles.css"), await readFile(join(import.meta.dir, "../src/renderer/src/styles.css")))

        let env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        let errors = ""
        let code = await new Promise<number | null>((done, reject) => {
            let child = spawn(electron as unknown as string, [join(import.meta.dir, "fixtures/image-diff-electron.cjs"), directory], {
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
        expect(result.messages.filter((message: string) => /content security policy|refused/i.test(message))).toEqual([])
        expect(result).toMatchObject({
            decoded: true,
            swipe: { oldWidth: 120, newWidth: 160, divider: true },
            difference: "difference",
            onion: "0.5",
        })
        expect(result.captions).toContain("Old · 120 × 80")
        expect(result.captions).toContain("New · 160 × 100")
        expect(result.swipe.clip).toContain("inset(0px 0px 0px 50%)")

        // The enlarged picture fits the viewer, which leaves 24px around it and 16px inside, then shows every pixel at 1:1.
        let viewer = result.viewer
        expect(viewer.error, viewer.text).toBeUndefined()
        expect(viewer).toMatchObject({ closed: true, fit: { open: true }, stacked: { open: true, layers: 2 } })
        let available = viewer.window.width - 48 - 2 - 32
        expect(viewer.window.width).toBeLessThan(1200)
        expect(viewer.fit.width).toBeWithin(available - 2, available + 1)
        expect(viewer.fit.height).toBeWithin(available / 4 - 2, available / 4 + 3)
        expect(viewer.actual.width).toBeWithin(1600, 1603)
        expect(viewer.actual.height).toBeWithin(400, 403)
        expect(viewer.old.width).toBeWithin(1200, 1203)
        expect(viewer.old.caption).toContain("Old · 1200 × 300")
        // The zoom chosen for one viewer carries over to the next.
        expect(viewer.stacked.kept).toBeWithin(1600, 1603)
        expect(viewer.stacked.width).toBeWithin(available - 2, available + 1)
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
            throw new Error("Invalid test path")
        await rm(directory, { recursive: true, force: true })
    }
}, 45_000)
