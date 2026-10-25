import type { BuildOutput } from "bun"
import { resolve } from "node:path"

// The desktop app's three bundles, built by Bun into `out/`: the main process, the preload script, and the renderer page.

export let desktop = resolve(import.meta.dir, "..")
export let out = resolve(desktop, "out")

/** The main process: an ES module bundling Laneway's own packages, with Electron and Node's modules external. */
export function buildMain() {
    return Bun.build({
        entrypoints: [resolve(desktop, "src/main/index.ts")],
        outdir: resolve(out, "main"),
        naming: "index.js",
        target: "node",
        format: "esm",
        external: ["electron"],
    })
}

/** The preload script, as CommonJS: a sandboxed preload can't load ES modules. */
export function buildPreload() {
    return Bun.build({
        entrypoints: [resolve(desktop, "src/preload/index.ts")],
        outdir: resolve(out, "preload"),
        naming: "index.cjs",
        target: "node",
        format: "cjs",
        external: ["electron"],
    })
}

/** The renderer page, compiled by Bun's React Compiler, with its modules split and linked relatively for `file:`. */
export function buildRenderer() {
    return Bun.build({
        entrypoints: [resolve(desktop, "src/renderer/index.html")],
        outdir: resolve(out, "renderer"),
        target: "browser",
        splitting: true,
        minify: true,
        publicPath: "./",
        reactCompiler: true,
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
    })
}

/** Whether a build succeeded, reporting its errors and warnings. */
export function reported(name: string, result: BuildOutput) {
    for (let log of result.logs)
        console.error(`${name}: ${log}`)
    return result.success
}
