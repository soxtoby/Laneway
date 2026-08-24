import { app, BrowserWindow, ipcMain } from "electron"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inspectEngine, resolveEnginePath, runEngineCommand } from "./engine"

type ActiveRun = ReturnType<typeof runEngineCommand>

const workspacePath = resolve(app.getAppPath(), "..")
const enginePath = resolveEnginePath({
    override: process.env.WORKBENCH_ENGINE_PATH,
    isPackaged: app.isPackaged,
    applicationPath: process.execPath,
    workspacePath,
})

let activeRun: ActiveRun | undefined
let engineStatus:
    | {
        state: "ready"
        path: string
        name: "workbench-engine"
        version: string
        repositoryPath: string
    }
    | {
        state: "error"
        path: string
        error: string
        repositoryPath: string
    }

async function inspectEngineAtStartup() {
    try {
        engineStatus = {
            state: "ready",
            ...await inspectEngine(enginePath),
            repositoryPath: process.cwd(),
        }
    } catch (error) {
        engineStatus = {
            state: "error",
            path: enginePath,
            error: error instanceof Error ? error.message : String(error),
            repositoryPath: process.cwd(),
        }
    }
}

function registerEngineHandlers() {
    ipcMain.handle("engine:status", () => engineStatus)

    ipcMain.handle(
        "engine:echo",
        async (event, request: { message?: unknown; repositoryPath?: unknown }) => {
            if (engineStatus.state !== "ready")
                throw new Error(engineStatus.error)
            if (activeRun)
                throw new Error("A Workbench Engine command is already running.")
            if (typeof request.repositoryPath !== "string" || request.repositoryPath.trim() === "")
                throw new Error("A target repository path is required.")
            if (typeof request.message !== "string")
                throw new Error("The echo message must be text.")

            const sender = event.sender
            activeRun = runEngineCommand({
                enginePath: engineStatus.path,
                cwd: resolve(request.repositoryPath),
                args: ["echo", request.message, "--delay-ms", "350"],
                onMessage: (message) => {
                    if (!sender.isDestroyed())
                        sender.send("engine:message", message)
                },
            })

            try {
                return await activeRun.result
            } finally {
                activeRun = undefined
            }
        },
    )

    ipcMain.handle("engine:cancel", () => {
        if (!activeRun)
            return false

        activeRun.cancel()
        return true
    })
}

function createWindow() {
    const window = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 820,
        minHeight: 620,
        backgroundColor: "#171713",
        show: true,
        title: "Git Workbench",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
            sandbox: true,
        },
    })

    if (process.env.ELECTRON_RENDERER_URL)
        void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else
        void window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)))
}

void app.whenReady().then(async () => {
    await inspectEngineAtStartup()
    registerEngineHandlers()
    createWindow()
})

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0)
        createWindow()
})

app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit()
})
