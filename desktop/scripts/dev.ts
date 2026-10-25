// Runs the desktop app for development. Bun's development server serves the renderer, replacing modules as they change;
// the main process and preload script rebuild, and Electron restarts, when their sources do. Quitting the app ends it.
// `--inspect` opens Electron's remote debugging port 9222, and other arguments go to Electron, such as its own
// `--user-data-dir` to run beside another instance. `--renderer-only` serves the renderer alone and prints its URL, for
// tools that start Electron themselves.
import type { Subprocess } from "bun"
import electron from "electron"
import { mkdirSync, watch } from "node:fs"
import { relative, resolve } from "node:path"
import { buildMain, buildPreload, desktop, reported } from "./bundles"

let root = resolve(desktop, "..")
let ownFlags = ["--inspect", "--renderer-only"]
let flags = process.argv.slice(2).filter(arg => ownFlags.includes(arg))
let electronArgs = process.argv.slice(2).filter(arg => !ownFlags.includes(arg) && arg != "--")
let app: Subprocess | undefined
let restarting = false

// The development server watches the files under its working directory, and gives React Fast Refresh to components
// when `react-refresh` resolves from there, so it serves from the repository root, which holds the shared packages.
process.chdir(root)
let url = await serveRenderer()

if (flags.includes("--renderer-only"))
    console.log(url)
else {
    if (!await buildProcesses())
        process.exit(1)
    launch()
    watchProcesses()
    process.on("SIGINT", () => {
        app?.kill()
        process.exit(0)
    })
}

/**
 * Serves a development copy of the page. Hot updates arrive as `blob:` scripts, and the server adds one inline script,
 * which the page's CSP would block; the copy allows exactly those, and the built page keeps the CSP it ships with.
 */
async function serveRenderer() {
    // The hash of the inline script Bun's development server adds; if Bun changes it, only a CSP report follows.
    let beacon = "'sha256-ES8VF47udzjVFFPh4RhgcgjUrADRd1Ef0GD9UagS2mY='"
    let directory = resolve(root, "node_modules/.cache/laneway-dev")
    let html = await Bun.file(resolve(desktop, "src/renderer/index.html")).text()
    let entry = relative(directory, resolve(desktop, "src/renderer/react/main.tsx")).replaceAll("\\", "/")
    let page = html.replace("script-src 'self'", `script-src 'self' blob: ${beacon}`).replace(`src="./react/main.tsx"`, `src="${entry}"`)
    if (!page.includes(beacon) || !page.includes(entry))
        throw new Error("The renderer page no longer has the CSP or entry script the development copy changes.")
    mkdirSync(directory, { recursive: true })
    let copy = resolve(directory, "index.html")
    await Bun.write(copy, page)
    let { default: index } = await import(copy)
    let server = Bun.serve({ port: 0, routes: { "/*": index }, development: { hmr: true, console: true } })
    return server.url.href
}

async function buildProcesses() {
    let [main, preload] = await Promise.all([buildMain(), buildPreload()])
    return [reported("main", main), reported("preload", preload)].every(Boolean)
}

function launch() {
    let env: Record<string, string | undefined> = { ...process.env, ELECTRON_RENDERER_URL: url }
    // A shell that runs Electron as Node would start no window.
    delete env.ELECTRON_RUN_AS_NODE
    let inspect = flags.includes("--inspect") ? ["--remote-debugging-port=9222"] : []
    let started = Bun.spawn([electron as unknown as string, desktop, ...inspect, ...electronArgs], { env, stdio: ["inherit", "inherit", "inherit"] })
    app = started
    void started.exited.then(code => {
        if (started == app && !restarting)
            process.exit(code)
    })
}

// The main process bundles Laneway's own packages, so a change to any of them restarts it.
function watchProcesses() {
    let sources = ["desktop/src/main", "desktop/src/preload", "shared/src", "settings/src", "git/src"]
    let pending: ReturnType<typeof setTimeout> | undefined
    let rebuilding = Promise.resolve()
    for (let source of sources) {
        watch(resolve(root, source), { recursive: true }, () => {
            clearTimeout(pending)
            pending = setTimeout(() => rebuilding = rebuilding.then(restart), 100)
        })
    }
}

async function restart() {
    if (!await buildProcesses())
        return
    restarting = true
    app?.kill()
    await app?.exited
    restarting = false
    console.log("Restarted Electron with the rebuilt main process.")
    launch()
}
