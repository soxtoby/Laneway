import { defaultWorkspacePath } from "@git-workbench/settings"
import { ChangesRequestSchema, type ChangesResult, FileDiffRequestSchema, type FileDiffResult } from "@git-workbench/shared"
import type { AuthorIdentitySettings, BranchGraphResult, BranchHistoryRequest, BranchHistoryResult, EntryResult, RepositoryGraphSettings, Workspace } from "@git-workbench/shared"
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inspectEngine, resolveEnginePath } from "./engine"
import { EntryQueue } from "./entry-queue"
import { entryError, OpenRepositories } from "./repositories"
import { WorkspaceManager } from "./workspace-manager"

const workspacePath = resolve(app.getAppPath(), "..")
const enginePath = resolveEnginePath({
    override: process.env.WORKBENCH_ENGINE_PATH,
    isPackaged: app.isPackaged,
    applicationPath: process.execPath,
    workspacePath,
})
const repositories = new OpenRepositories(process.env.WORKBENCH_SETTINGS_PATH)
const workspace = new WorkspaceManager(repositories, process.env.WORKBENCH_WORKSPACE_PATH ?? defaultWorkspacePath())

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

async function performEntry(action: () => Promise<Workspace>): Promise<EntryResult> {
    return entryQueue.enqueue(async () => {
        try {
            return { ok: true, workspace: await action() }
        } catch (error) {
            return { ok: false, error: entryError(error) }
        }
    })
}

function registerHandlers() {
    ipcMain.handle("changes:read", async (_event, repositoryId: unknown, requestId: unknown, value: unknown): Promise<ChangesResult> => {
        const request = ChangesRequestSchema.safeParse(value)
        if (typeof repositoryId != "string" || typeof requestId != "string" || !request.success)
            return { ok: false, error: { code: "git.command-failed", message: "Invalid changes request." } }
        try {
            return { ok: true, inventory: await repositories.readChanges(repositoryId, requestId, request.data) }
        } catch (error) {
            return { ok: false, error: entryError(error) }
        }
    })
    ipcMain.handle("changes:diff", async (_event, repositoryId: unknown, requestId: unknown, value: unknown): Promise<FileDiffResult> => {
        const request = FileDiffRequestSchema.safeParse(value)
        if (typeof repositoryId != "string" || typeof requestId != "string" || !request.success)
            return { ok: false, error: { code: "git.command-failed", message: "Invalid diff request." } }
        try {
            return { ok: true, page: await repositories.readFileDiff(repositoryId, requestId, request.data) }
        } catch (error) {
            return { ok: false, error: entryError(error) }
        }
    })
    ipcMain.handle(
        "changes:cancel",
        (_event, repositoryId: unknown, requestId: unknown) =>
            typeof repositoryId == "string" && typeof requestId == "string" && repositories.cancelInspection(repositoryId, requestId),
    )
    ipcMain.handle("app:state", async () => ({
        workspace: workspace.snapshot(),
        settings: await repositories.gitSettings(),
        appearance: await repositories.appearance(),
        engine: engineStatus,
        defaultCloneParent: app.getPath("documents"),
    }))

    ipcMain.handle("entry:open", async event => {
        const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
            title: "Open repository root",
            defaultPath: workspace.repositoryOpenDefaultPath(),
            buttonLabel: "Open repository",
            properties: ["openDirectory", "dontAddToRecent"],
        })
        if (selection.canceled || !selection.filePaths[0])
            return { ok: false, error: { code: "git.cancelled", message: "Open cancelled." } } satisfies EntryResult
        return performEntry(() => workspace.open(selection.filePaths[0]))
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
            return { ok: false, error: { code: "git.command-failed", message: "Choose a directory to initialize." } } satisfies EntryResult
        if (request.initialBranch != undefined && typeof request.initialBranch != "string")
            return { ok: false, error: { code: "git.command-failed", message: "The initial branch must be text." } } satisfies EntryResult
        const initialBranch = typeof request.initialBranch == "string" && request.initialBranch.trim() ? request.initialBranch.trim() : undefined
        return performEntry(async () => workspace.add(await repositories.initialize(request.path as string, initialBranch)))
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
                return { ok: true, workspace: await workspace.add(await clone.result) } satisfies EntryResult
            } catch (error) {
                return { ok: false, error: entryError(error) } satisfies EntryResult
            }
        })
    })

    ipcMain.handle("entry:cancel", () => entryQueue.cancel())

    ipcMain.handle(
        "workspace:select",
        (_event, request: { id?: unknown }) => typeof request?.id == "string" ? workspace.select(request.id) : workspace.snapshot(),
    )
    ipcMain.handle(
        "workspace:close",
        (_event, request: { id?: unknown }) => typeof request?.id == "string" ? workspace.close(request.id) : workspace.snapshot(),
    )
    ipcMain.handle("workspace:update", (_event, request: { workspace?: unknown }) => {
        if (!isWorkspace(request.workspace))
            throw new Error("Workspace State is invalid.")
        return workspace.update(request.workspace)
    })
    ipcMain.handle("workspace:reset", () => workspace.reset())
    ipcMain.handle("workspace:locate", async (event, request: { id?: unknown; useAnyway?: unknown }) => {
        if (typeof request?.id != "string")
            return workspace.snapshot()
        const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
            title: "Locate repository root",
            buttonLabel: "Use repository",
            properties: ["openDirectory", "dontAddToRecent"],
        })
        if (selection.canceled || !selection.filePaths[0])
            return workspace.snapshot()
        try {
            return await workspace.locate(request.id, selection.filePaths[0], request.useAnyway === true)
        } catch (error) {
            if (request.useAnyway === true)
                throw error
            const confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, {
                type: "warning",
                title: "Repository identity differs",
                message: "The selected repository does not match the saved Workspace State.",
                detail: "Its object format or saved object anchors differ. Use it anyway only if this is the relocated repository.",
                buttons: ["Cancel", "Use anyway"],
                defaultId: 0,
                cancelId: 0,
            })
            return confirmation.response == 1 ? workspace.locate(request.id, selection.filePaths[0], true) : workspace.snapshot()
        }
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
    ipcMain.handle("settings:author-identities", (_event, request: AuthorIdentitySettings) => {
        const primary = typeof request?.primary == "string" && request.primary.trim() ? request.primary.trim() : undefined
        const secondary = Array.isArray(request?.secondary)
            ? [...new Set(request.secondary.filter(email => typeof email == "string").map(email => email.trim()).filter(Boolean))]
            : []
        return repositories.setAuthorIdentities({ primary, secondary })
    })
    ipcMain.handle(
        "settings:appearance",
        (_event, request: { appearance?: unknown }) => repositories.setAppearance(request?.appearance == "dark" ? "dark" : "light"),
    )
    ipcMain.handle("settings:open-file", async () => {
        const state = await repositories.gitSettings()
        return shell.openPath(state.path)
    })

    ipcMain.handle("graph:read", async (_event, request: { repositoryId?: unknown; refreshRemote?: unknown }): Promise<BranchGraphResult> => {
        if (typeof request?.repositoryId != "string")
            return { ok: false, error: { code: "git.command-failed", message: "Choose a repository." } }
        try {
            const read = await repositories.startBranchGraph(request.repositoryId, request.refreshRemote === true)
            return { ok: true, graph: await read.result }
        } catch (error) {
            return { ok: false, error: entryError(error) }
        }
    })
    ipcMain.handle(
        "graph:cancel",
        (_event, request: { repositoryId?: unknown }) => typeof request?.repositoryId == "string" && repositories.cancelBranchGraph(request.repositoryId),
    )
    ipcMain.handle("graph:history", async (_event, request: { repositoryId?: unknown; history?: unknown }): Promise<BranchHistoryResult> => {
        if (typeof request?.repositoryId != "string" || !isBranchHistoryRequest(request.history))
            return { ok: false, error: { code: "git.command-failed", message: "The branch history request is invalid." } }
        try {
            return { ok: true, page: await repositories.startBranchHistory(request.repositoryId, request.history).result }
        } catch (error) {
            return { ok: false, error: entryError(error) }
        }
    })
    ipcMain.handle(
        "graph:history-cancel",
        (_event, request: { repositoryId?: unknown }) => typeof request?.repositoryId == "string" && repositories.cancelBranchHistory(request.repositoryId),
    )
    ipcMain.handle("graph:settings", (_event, request: { repositoryId?: unknown; settings?: unknown }) => {
        if (typeof request?.repositoryId != "string" || !isGraphSettings(request.settings))
            throw new Error("The Branch Graph settings are invalid.")
        return repositories.setRepositoryGraphSettings(request.repositoryId, request.settings)
    })
}

function isGraphSettings(value: unknown): value is RepositoryGraphSettings {
    if (!value || typeof value != "object")
        return false
    const settings = value as Partial<RepositoryGraphSettings>
    return (settings.selectedRemote == undefined || typeof settings.selectedRemote == "string")
        && Array.isArray(settings.remotePatterns) && settings.remotePatterns.every(pattern => typeof pattern == "string")
}

function isBranchHistoryRequest(value: unknown): value is BranchHistoryRequest {
    if (!value || typeof value != "object")
        return false
    const request = value as Partial<BranchHistoryRequest>
    return typeof request.branchRef == "string" && typeof request.tip == "string" && typeof request.baseTip == "string"
        && (request.requestId == undefined || typeof request.requestId == "string")
        && (request.offset == undefined || Number.isSafeInteger(request.offset))
        && (request.limit == undefined || Number.isSafeInteger(request.limit))
}

function isWorkspace(value: unknown): value is Workspace {
    if (!value || typeof value != "object")
        return false
    const candidate = value as Partial<Workspace>
    if (!Array.isArray(candidate.repositories) || (candidate.activeRepositoryId != undefined && typeof candidate.activeRepositoryId != "string"))
        return false
    const repositoryIds = new Set<string>()
    const valid = candidate.repositories.every(repository => {
        if (!repository || typeof repository.id != "string" || repositoryIds.has(repository.id) || !Array.isArray(repository.columns))
            return false
        repositoryIds.add(repository.id)
        const columnIds = new Set<string>()
        return repository.columns.every(column => {
            if (
                !column || typeof column.id != "string" || columnIds.has(column.id) || typeof column.lastSeenObjectId != "string"
                || typeof column.width != "number"
                || !Number.isFinite(column.width) || column.width < 310
                || (column.diffLayout != undefined && column.diffLayout != "unified" && column.diffLayout != "split")
            ) {
                return false
            }
            columnIds.add(column.id)
            return column.kind == "branch" ? typeof column.ref == "string" : column.kind == "virtual" && typeof column.worktreePath == "string"
        })
    })
    return valid && (candidate.activeRepositoryId == undefined || repositoryIds.has(candidate.activeRepositoryId))
}

function createWindow(backgroundColor: string) {
    const window = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 820,
        minHeight: 620,
        backgroundColor,
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

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance)
    app.quit()

void app.whenReady().then(async () => {
    await inspectEngineAtStartup()
    await workspace.load()
    registerHandlers()
    createWindow(await repositories.appearance() == "dark" ? "#1a1e1b" : "#f4f5f4")
})

app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0]
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
        void repositories.appearance().then(appearance => createWindow(appearance == "dark" ? "#1a1e1b" : "#f4f5f4"))
})

app.on("window-all-closed", () => {
    if (process.platform != "darwin")
        app.quit()
})
