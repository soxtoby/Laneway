import { defaultWorkspacePath } from "@laneway/settings"
import { app, BrowserWindow, ipcMain, Menu } from "electron"
import { resolve } from "node:path"
import { CommitDrafts } from "./commit-drafts"
import { inspectEngine, resolveEnginePath } from "./engine"
import { registerInspectionHandlers } from "./ipc/inspection-ipc"
import { registerMarkdownHandlers } from "./ipc/markdown-ipc"
import { registerOperationHandlers } from "./ipc/operation-ipc"
import { registerRepositoryHandlers } from "./ipc/repository-ipc"
import { OpenRepositories } from "./repositories"
import { createWindow, resource } from "./window"
import { WorkspaceManager } from "./workspace-manager"

let workspacePath = resolve(app.getAppPath(), "..")

let enginePath = resolveEnginePath({
    override: process.env.LANEWAY_ENGINE_PATH,
    isPackaged: app.isPackaged,
    applicationPath: process.execPath,
    workspacePath,
})

let repositories = new OpenRepositories(process.env.LANEWAY_SETTINGS_PATH)

repositories.changed = repositoryId => {
    for (let window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed())
            window.webContents.send("repository:changed", { repositoryId })
    }
}

let workspace = new WorkspaceManager(repositories, process.env.LANEWAY_WORKSPACE_PATH ?? defaultWorkspacePath())

let commitDrafts = new CommitDrafts(resolve(app.getPath("userData"), "commit-drafts.json"))

let engineStatus:
    | { state: "ready"; path: string; name: "lane"; version: string }
    | { state: "error"; path: string; error: string }

// Overlay scrollbars leave rows flush with the column edge; disabling their fade keeps the thumbs easy to grab.
app.commandLine.appendSwitch("enable-features", "OverlayScrollbar:mode/overlay")

app.commandLine.appendSwitch("disable-features", "ScrollbarAnimations")

let singleInstance = app.requestSingleInstanceLock()

if (!singleInstance)
    app.quit()

void app.whenReady().then(async () => {
    await inspectEngineAtStartup()
    await workspace.load()
    registerHandlers()
    Menu.setApplicationMenu(null)
    app.dock?.setIcon(resource("icon.png"))
    createWindow(await repositories.appearance())
})

app.on("second-instance", () => {
    let window = BrowserWindow.getAllWindows()[0]
    if (window?.isMinimized())
        window.restore()
    window?.focus()
})

let workspaceFlushed = false

app.on("before-quit", event => {
    if (workspaceFlushed)
        return
    event.preventDefault()
    void workspace.flush().finally(() => {
        workspaceFlushed = true
        app.quit()
    })
})

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length == 0)
        void repositories.appearance().then(createWindow)
})

app.on("window-all-closed", () => {
    if (process.platform != "darwin")
        app.quit()
})

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

function registerHandlers() {
    registerOperationHandlers(repositories, enginePath, commitDrafts)
    registerInspectionHandlers(repositories, enginePath)
    registerMarkdownHandlers()
    ipcMain.handle("app:state", async () => ({
        workspace: await workspace.refreshAvailability(),
        settings: await repositories.gitSettings(),
        appearance: await repositories.appearance(),
        fileListView: await repositories.fileListView(),
        showCommitAges: await repositories.showCommitAges(),
        graphWidth: await repositories.graphWidth(),
        engine: engineStatus,
    }))

    registerRepositoryHandlers(repositories, workspace)
}
