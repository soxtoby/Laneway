import type { EntryResult, WorkbenchSession } from "@git-workbench/shared"
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inspectEngine, resolveEnginePath } from "./engine"
import { EntryQueue } from "./entry-queue"
import { entryError, RepositorySession } from "./repositories"

const workspacePath = resolve(app.getAppPath(), "..")
const enginePath = resolveEnginePath({
    override: process.env.WORKBENCH_ENGINE_PATH,
    isPackaged: app.isPackaged,
    applicationPath: process.execPath,
    workspacePath,
})
const repositories = new RepositorySession(process.env.WORKBENCH_SETTINGS_PATH)

const cancelledEntry = () =>
    ({
        ok: false,
        error: { code: "git.cancelled", message: "Repository entry cancelled." },
    }) satisfies EntryResult
const entryQueue = new EntryQueue<EntryResult>(cancelledEntry)
let engineStatus:
    | { state: "ready"; path: string; name: "workbench-engine"; version: string }
    | { state: "error"; path: string; error: string }

async function inspectEngineAtStartup() {
    try {
        engineStatus = { state: "ready", ...await inspectEngine(enginePath) }
    } catch (error) {
        engineStatus = {
            state: "error",
            path: enginePath,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

async function performEntry(action: () => Promise<WorkbenchSession>): Promise<EntryResult> {
    return entryQueue.enqueue(async () => {
        try {
            return { ok: true, session: await action() }
        } catch (error) {
            return { ok: false, error: entryError(error) }
        }
    })
}

function registerHandlers() {
    ipcMain.handle("app:state", async () => ({
        session: repositories.snapshot(),
        settings: await repositories.gitSettings(),
        engine: engineStatus,
        defaultCloneParent: app.getPath("documents"),
    }))

    ipcMain.handle("entry:open", async event => {
        const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
            title: "Open repository root",
            buttonLabel: "Open repository",
            properties: ["openDirectory", "dontAddToRecent"],
        })
        if (selection.canceled || !selection.filePaths[0])
            return { ok: false, error: { code: "git.cancelled", message: "Open cancelled." } } satisfies EntryResult
        return performEntry(() => repositories.open(selection.filePaths[0]))
    })

    ipcMain.handle("entry:choose-directory", async (event, request: { defaultPath?: unknown }) => {
        const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
            title: "Choose directory",
            defaultPath: typeof request?.defaultPath == "string" ? request.defaultPath : undefined,
            buttonLabel: "Choose directory",
            properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
        })
        return selection.canceled ? undefined : selection.filePaths[0]
    })

    ipcMain.handle("entry:suggest-clone", (_event, request: { source?: unknown; parent?: unknown }) => {
        if (typeof request?.source != "string" || typeof request?.parent != "string")
            return ""
        return repositories.suggestedCloneDestination(request.source, request.parent)
    })

    ipcMain.handle("entry:initialize", (_event, request: { path?: unknown; initialBranch?: unknown }) => {
        if (typeof request?.path != "string" || request.path.trim() == "")
            return { ok: false, error: { code: "git.command-failed", message: "Choose a directory to initialise." } } satisfies EntryResult
        if (request.initialBranch != undefined && typeof request.initialBranch != "string")
            return { ok: false, error: { code: "git.command-failed", message: "The initial branch must be text." } } satisfies EntryResult
        const initialBranch = typeof request.initialBranch == "string" && request.initialBranch.trim() ? request.initialBranch.trim() : undefined
        return performEntry(() => repositories.initialize(request.path as string, initialBranch))
    })

    ipcMain.handle("entry:clone", async (event, request: { source?: unknown; destination?: unknown }) => {
        if (typeof request?.source != "string" || request.source.trim() == "")
            return { ok: false, error: { code: "git.command-failed", message: "Enter a repository source to clone." } } satisfies EntryResult
        if (typeof request.destination != "string" || request.destination.trim() == "")
            return { ok: false, error: { code: "git.command-failed", message: "Choose a clone destination." } } satisfies EntryResult
        const source = request.source
        const destination = request.destination
        return entryQueue.enqueue(async setCancel => {
            try {
                const sender = event.sender
                const clone = await repositories.startClone({
                    source,
                    destination,
                    onProgress: message => {
                        if (!sender.isDestroyed())
                            sender.send("entry:progress", { message })
                    },
                })
                setCancel(clone.cancel)
                return { ok: true, session: await clone.result } satisfies EntryResult
            } catch (error) {
                return { ok: false, error: entryError(error) } satisfies EntryResult
            }
        })
    })

    ipcMain.handle("entry:cancel", () => entryQueue.cancel())

    ipcMain.handle("session:select", (_event, request: { id?: unknown }) => {
        if (typeof request?.id == "string")
            repositories.selectRepository(request.id)
        return repositories.snapshot()
    })

    ipcMain.handle("settings:choose-git", async event => {
        const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
            title: "Choose Git executable",
            buttonLabel: "Use this Git",
            properties: ["openFile", "dontAddToRecent"],
            filters: process.platform == "win32" ? [{ name: "Git executable", extensions: ["exe"] }] : undefined,
        })
        if (selection.canceled || !selection.filePaths[0])
            return repositories.gitSettings()
        try {
            return await repositories.setGitOverride(selection.filePaths[0])
        } catch (error) {
            return { path: "", error: entryError(error) }
        }
    })
    ipcMain.handle("settings:use-path", async () => {
        try {
            return await repositories.setGitOverride()
        } catch (error) {
            return { path: "", error: entryError(error) }
        }
    })
    ipcMain.handle("settings:reset", () => repositories.resetSettings())
    ipcMain.handle("settings:open-file", async () => {
        const state = await repositories.gitSettings()
        return shell.openPath(state.path)
    })
}

function createWindow() {
    const window = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 820,
        minHeight: 620,
        backgroundColor: "#0e110f",
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
    registerHandlers()
    createWindow()
})

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length == 0)
        createWindow()
})

app.on("window-all-closed", () => {
    if (process.platform != "darwin")
        app.quit()
})
