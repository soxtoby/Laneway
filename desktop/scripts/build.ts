// Builds the desktop app into `out/`: the main process, its preload script, and the renderer page.
import { rmSync } from "node:fs"
import { buildMain, buildPreload, buildRenderer, out, reported } from "./bundles"

let started = performance.now()
rmSync(out, { recursive: true, force: true })
let [main, preload, renderer] = await Promise.all([buildMain(), buildPreload(), buildRenderer()])
let built = [reported("main", main), reported("preload", preload), reported("renderer", renderer)].every(Boolean)
if (!built)
    process.exit(1)
console.log(`Built the desktop app in ${Math.round(performance.now() - started)} ms`)
