import { isLikelyCloneSource, isText, normalize, previewWorktree, readRegisteredWorktrees } from "@laneway/git"
import { defaultWorkspacePath } from "@laneway/settings"
import { ChangesRequestSchema, type ChangesResult, FileDiffRequestSchema, type FileDiffResult } from "@laneway/shared"
import type { AuthorIdentitySettings, BranchGraphResult, BranchHistoryRequest, BranchHistoryResult, EntryDefaults, EntryResult, RepositoryGraphSettings, Workspace } from "@laneway/shared"
import { type WorktreeActionResult, type WorktreePreviewResult, WorktreeRequestSchema } from "@laneway/shared"
import { CommitDraftSchema, type LocalActionResult, LocalRequestSchema } from "@laneway/shared"
import { type ConflictActionResult, ConflictRequestSchema } from "@laneway/shared"
import { type PullActionResult, type PullProgress, PullRequestSchema } from "@laneway/shared"
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron"
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import windowsIcon from "../../resources/icon.ico?asset"
import icon from "../../resources/icon.png?asset"
import { CommitDrafts } from "./commit-drafts"
import { inspectEngine, resolveEnginePath, runEngineCommand } from "./engine"
import { EntryQueue } from "./entry-queue"
import { entryError, OpenRepositories } from "./repositories"
import { WorkspaceManager } from "./workspace-manager"

const workspacePath = resolve(app.getAppPath(), "..")
const enginePath = resolveEnginePath({
    override: process.env.LANEWAY_ENGINE_PATH,
    isPackaged: app.isPackaged,
    applicationPath: process.execPath,
    workspacePath,
})
const repositories = new OpenRepositories(process.env.LANEWAY_SETTINGS_PATH)
repositories.changed = repositoryId => {
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed())
            window.webContents.send("repository:changed", { repositoryId })
    }
}
const workspace = new WorkspaceManager(repositories, process.env.LANEWAY_WORKSPACE_PATH ?? defaultWorkspacePath())
const commitDrafts = new CommitDrafts(resolve(app.getPath("userData"), "commit-drafts.json"))
const draftWorktrees = new Map<string, string>()
const conflictInspections = new Map<string, ConflictActionResult>()
// One Pull latest per repository; the engine's cooperative cancel line stops at the next safe boundary.
const activePulls = new Map<string, { cancel(): void }>()

const cancelledEntry = () =>
    ({
        ok: false,
        error: { code: "git.cancelled", message: "Repository entry cancelled." },
    }) satisfies EntryResult
const entryQueue = new EntryQueue<EntryResult>(cancelledEntry)
let engineStatus:
    | { state: "ready"; path: string; name: "lane"; version: string }
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
    ipcMain.handle("conflict:content", async (_event, repositoryId: unknown, object: unknown): Promise<string | null> => {
        if (typeof repositoryId != "string" || typeof object != "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object))
            throw new Error("Choose a valid conflict file object.")
        const repository = repositories.worktreeRepository(repositoryId)
        const bytes = await repository.command(repository.descriptor.mainWorktree, ["cat-file", "blob", object])
        return bytes.length <= 2_000_000 && isText(bytes) ? bytes.toString() : null
    })
    ipcMain.handle("conflict:operation", async (_event, repositoryId: unknown, value: unknown): Promise<ConflictActionResult> => {
        let requestDirectory: string | undefined
        try {
            if (typeof repositoryId != "string")
                throw new Error("Choose a repository.")
            const request = ConflictRequestSchema.parse(value)
            const repository = repositories.worktreeRepository(repositoryId)
            const inspectionVersion = async () =>
                (await repository.command(repository.descriptor.mainWorktree, [
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/laneway/conflicts/current",
                    ...(request.action == "inspect" ? [`refs/laneway/conflict-candidates/${request.subject}/`] : []),
                ])).toString()
            const version = request.action == "inspect" ? await inspectionVersion() : undefined
            const cacheKey = JSON.stringify([repository.descriptor.commonDirectory, request, version])
            if (version != undefined) {
                const cached = conflictInspections.get(cacheKey)
                if (cached)
                    return cached
            }
            let requestArgs = ["--request", JSON.stringify(request)]
            if (request.action == "edit") {
                requestDirectory = await mkdtemp(join(tmpdir(), "laneway-conflict-request-"))
                const requestPath = join(requestDirectory, "request.json")
                await writeFile(requestPath, JSON.stringify(request))
                requestArgs = ["--request-file", requestPath]
            }
            const output = await runEngineCommand({
                enginePath,
                cwd: repository.descriptor.mainWorktree,
                args: ["conflict", ...requestArgs, "--git-path", repository.descriptor.git.path],
            }).result
            const result = output.messages.find(message => message.type == "result" && message.command == "conflict")
            if (output.exitCode || !result || result.type != "result" || result.command != "conflict")
                throw new Error(output.messages.find(message => message.type == "error")?.message ?? output.diagnostics ?? "Conflict operation failed.")
            const response: ConflictActionResult = { ok: true, result }
            if (version != undefined && version == await inspectionVersion()) {
                conflictInspections.set(cacheKey, response)
                if (conflictInspections.size > 16)
                    conflictInspections.delete(conflictInspections.keys().next().value!)
            }
            return response
        } catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        } finally {
            if (requestDirectory) {
                await rm(join(requestDirectory, "request.json"), { force: true })
                await rmdir(requestDirectory)
            }
        }
    })
    ipcMain.handle("pull:latest", async (event, repositoryId: unknown, value: unknown): Promise<PullActionResult> => {
        try {
            if (typeof repositoryId != "string")
                throw new Error("Choose a repository.")
            if (activePulls.has(repositoryId))
                throw new Error("Pull latest is already running for this repository.")
            const request = PullRequestSchema.parse(value)
            const repository = repositories.worktreeRepository(repositoryId)
            const sender = event.sender
            const engine = runEngineCommand({
                enginePath,
                cwd: repository.descriptor.mainWorktree,
                args: ["pull", "--request", JSON.stringify(request), "--git-path", repository.descriptor.git.path],
                onMessage: message => {
                    if (message.type == "progress" && !sender.isDestroyed()) {
                        const progress: PullProgress = { repositoryId, message: message.message, completed: message.completed, total: message.total }
                        sender.send("pull:progress", progress)
                    }
                },
            })
            activePulls.set(repositoryId, engine)
            try {
                const output = await engine.result
                const result = output.messages.find(message => message.type == "result" && message.command == "pull")
                if (!result || result.type != "result" || result.command != "pull") {
                    const cancelled = output.messages.find(message => message.type == "cancelled")
                    if (cancelled) {
                        return {
                            ok: true,
                            result: { type: "result", command: "pull", status: "cancelled", message: cancelled.message, fetches: [], stacks: [] },
                        }
                    }
                    throw new Error(output.messages.find(message => message.type == "error")?.message ?? output.diagnostics ?? "Pull latest failed.")
                }
                return { ok: true, result }
            } finally {
                activePulls.delete(repositoryId)
            }
        } catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        }
    })
    ipcMain.handle("pull:cancel", (_event, repositoryId: unknown) => {
        const active = typeof repositoryId == "string" ? activePulls.get(repositoryId) : undefined
        active?.cancel()
        return Boolean(active)
    })
    ipcMain.handle("local:operation", async (_event, repositoryId: unknown, value: unknown, token: unknown): Promise<LocalActionResult> => {
        let requestDirectory: string | undefined
        try {
            if (typeof repositoryId != "string" || (token !== undefined && typeof token != "string"))
                throw new Error("Choose a repository operation.")
            const request = LocalRequestSchema.parse(value)
            const repository = repositories.worktreeRepository(repositoryId)
            let requestArgs = ["--request", JSON.stringify(request)]
            if (request.action == "compose") {
                requestDirectory = await mkdtemp(join(tmpdir(), "laneway-composition-request-"))
                const requestPath = join(requestDirectory, "request.json")
                await writeFile(requestPath, JSON.stringify(request))
                requestArgs = ["--request-file", requestPath]
            }
            const output = await runEngineCommand({
                enginePath,
                cwd: repository.descriptor.mainWorktree,
                args: [
                    token ? "local" : request.action == "compose" ? "local-transfer" : "local-preview",
                    ...requestArgs,
                    ...(token ? ["--expected", token] : []),
                    "--git-path",
                    repository.descriptor.git.path,
                ],
            }).result
            const result = output.messages.find(message => message.type == "result" && (message.command == "local" || message.command == "local-preview"))
            if (!result || !("status" in result) || !(result.command == "local" || result.command == "local-preview"))
                throw new Error(output.messages.find(message => message.type == "error")?.message ?? output.diagnostics ?? "Local operation failed.")
            return { ok: true, result }
        } catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        } finally {
            if (requestDirectory) {
                await rm(join(requestDirectory, "request.json"), { force: true })
                await rmdir(requestDirectory)
            }
        }
    })
    ipcMain.handle("commit:draft", async (_event, repositoryId: unknown, path: unknown, value: unknown) => {
        if (typeof repositoryId != "string" || typeof path != "string")
            throw new Error("Choose a worktree.")
        const repository = repositories.worktreeRepository(repositoryId)
        const key = JSON.stringify([repositoryId, normalize(path)])
        if (value === undefined || !draftWorktrees.has(key)) {
            const worktree = (await readRegisteredWorktrees(repository)).find(item => normalize(item.path) == normalize(path))
            if (!worktree)
                throw new Error("The worktree is no longer registered.")
            draftWorktrees.set(key, worktree.id)
        }
        if (value === undefined)
            return commitDrafts.read(repositoryId, draftWorktrees.get(key)!)
        await commitDrafts.write(repositoryId, draftWorktrees.get(key)!, CommitDraftSchema.parse(value))
    })
    ipcMain.handle("worktree:preview", async (_event, repositoryId: unknown, value: unknown): Promise<WorktreePreviewResult> => {
        try {
            if (typeof repositoryId != "string")
                throw new Error("Choose a repository.")
            return { ok: true, preview: await previewWorktree(repositories.worktreeRepository(repositoryId), WorktreeRequestSchema.parse(value)) }
        } catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        }
    })
    ipcMain.handle("worktree:execute", async (_event, repositoryId: unknown, value: unknown, token: unknown): Promise<WorktreeActionResult> => {
        try {
            if (typeof repositoryId != "string" || typeof token != "string")
                throw new Error("Review this worktree operation first.")
            const request = WorktreeRequestSchema.parse(value)
            const repository = repositories.worktreeRepository(repositoryId)
            const result = await runEngineCommand({
                enginePath,
                cwd: repository.descriptor.mainWorktree,
                args: ["worktree", "--request", JSON.stringify(request), "--expected", token, "--git-path", repository.descriptor.git.path],
            }).result
            if (result.exitCode)
                throw new Error(result.messages.find(message => message.type == "error")?.message ?? result.diagnostics)
            return { ok: true }
        } catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        }
    })
    ipcMain.handle("worktree:history", async (_event, repositoryId: unknown, action: unknown, basename: unknown): Promise<WorktreeActionResult> => {
        try {
            if (typeof repositoryId != "string" || typeof action != "string" || (action != "undo" && action != "redo"))
                throw new Error("Choose undo or redo.")
            const repository = repositories.worktreeRepository(repositoryId)
            const result = await runEngineCommand({
                enginePath,
                cwd: repository.descriptor.mainWorktree,
                args: [
                    action,
                    "--git-path",
                    repository.descriptor.git.path,
                    ...(action == "undo" && typeof basename == "string" ? ["--worktree-basename", basename] : []),
                ],
            }).result
            if (result.exitCode)
                throw new Error(result.messages.find(message => message.type == "error")?.message ?? result.diagnostics)
            return { ok: true }
        } catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        }
    })
    ipcMain.handle("history:read", async (_event, repositoryId: unknown, requestId: unknown, value: unknown): Promise<FileHistoryResult> => {
        const request = FileHistoryRequestSchema.safeParse(value)
        if (typeof repositoryId != "string" || typeof requestId != "string" || !request.success)
            return { ok: false, error: { code: "git.command-failed", message: "Invalid file history request." } }
        try {
            return { ok: true, page: await repositories.readFileHistory(repositoryId, requestId, request.data) }
        } catch (error) {
            return { ok: false, error: entryError(error) }
        }
    })
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
        workspace: await workspace.refreshAvailability(),
        settings: await repositories.gitSettings(),
        appearance: await repositories.appearance(),
        engine: engineStatus,
    }))

    ipcMain.handle("entry:defaults", (_event, request: { form?: unknown }) => {
        const parent = workspace.repositoryOpenDefaultPath() ?? app.getPath("documents")
        if (request?.form != "clone")
            return { parent } satisfies EntryDefaults
        const text = clipboard.readText().trim()
        return { parent, ...(isLikelyCloneSource(text) ? { source: text } : {}) } satisfies EntryDefaults
    })

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

    ipcMain.handle("entry:suggest-clone", (_event, request: { source?: unknown }) => {
        if (typeof request?.source != "string")
            return ""
        return repositories.suggestedCloneDirectoryName(request.source)
    })

    ipcMain.handle("entry:initialize", (_event, request: { parent?: unknown; name?: unknown; initialBranch?: unknown }) => {
        if (typeof request?.parent != "string" || request.parent.trim() == "")
            return { ok: false, error: { code: "git.command-failed", message: "Choose a parent directory for the repository." } } satisfies EntryResult
        if (typeof request.name != "string" || request.name.trim() == "")
            return { ok: false, error: { code: "git.command-failed", message: "Enter a directory name for the repository." } } satisfies EntryResult
        if (request.initialBranch != undefined && typeof request.initialBranch != "string")
            return { ok: false, error: { code: "git.command-failed", message: "The initial branch must be text." } } satisfies EntryResult
        const parent = request.parent.trim()
        const name = request.name.trim()
        const initialBranch = typeof request.initialBranch == "string" && request.initialBranch.trim() ? request.initialBranch.trim() : undefined
        return performEntry(async () => workspace.add(await repositories.initialize(parent, name, initialBranch)))
    })

    ipcMain.handle("entry:clone", async (event, request: { source?: unknown; parent?: unknown; name?: unknown }) => {
        if (typeof request?.source != "string" || request.source.trim() == "")
            return { ok: false, error: { code: "git.command-failed", message: "Enter a repository source to clone." } } satisfies EntryResult
        if (typeof request.parent != "string" || request.parent.trim() == "")
            return { ok: false, error: { code: "git.command-failed", message: "Choose a parent directory for the clone." } } satisfies EntryResult
        if (typeof request.name != "string" || request.name.trim() == "")
            return { ok: false, error: { code: "git.command-failed", message: "Enter a directory name for the clone." } } satisfies EntryResult
        const source = request.source
        const parent = request.parent.trim()
        const name = request.name.trim()
        return entryQueue.enqueue(async setCancel => {
            try {
                const sender = event.sender
                const clone = await repositories.startClone({
                    source,
                    parent,
                    name,
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
        return workspace.update(request?.workspace)
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
        async (_event, request: { appearance?: unknown }) => {
            const appearance = await repositories.setAppearance(request?.appearance == "dark" ? "dark" : "light")
            for (const window of BrowserWindow.getAllWindows())
                window.setTitleBarOverlay?.(titleBarOverlay(appearance))
            return appearance
        },
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
    return typeof request.branchRef == "string" && typeof request.tip == "string"
        && Array.isArray(request.baseTips) && request.baseTips.every(tip => typeof tip == "string")
        && (request.remoteTips == undefined || Array.isArray(request.remoteTips) && request.remoteTips.every(tip => typeof tip == "string"))
        && (request.requestId == undefined || typeof request.requestId == "string")
        && (request.offset == undefined || Number.isSafeInteger(request.offset))
        && (request.limit == undefined || Number.isSafeInteger(request.limit))
}

// Window controls are drawn over the renderer's header, so they share its colours; they stop 1px short to leave its bottom border visible.
function titleBarOverlay(appearance: string) {
    return appearance == "dark"
        ? { color: "#1c222d", symbolColor: "#e9edf3", height: 47 }
        : { color: "#ffffff", symbolColor: "#141a24", height: 47 }
}

function createWindow(appearance: string) {
    const window = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 820,
        minHeight: 620,
        backgroundColor: appearance == "dark" ? "#1a1e1b" : "#f4f5f4",
        show: true,
        title: "Laneway",
        icon: process.platform == "win32" ? windowsIcon : icon,
        titleBarStyle: "hidden",
        titleBarOverlay: process.platform == "darwin" ? undefined : titleBarOverlay(appearance),
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

// Overlay scrollbars leave rows flush with the column edge; disabling their fade keeps the thumbs easy to grab.
app.commandLine.appendSwitch("enable-features", "OverlayScrollbar:mode/overlay")
app.commandLine.appendSwitch("disable-features", "ScrollbarAnimations")

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance)
    app.quit()

void app.whenReady().then(async () => {
    await inspectEngineAtStartup()
    await workspace.load()
    registerHandlers()
    Menu.setApplicationMenu(null)
    app.dock?.setIcon(icon)
    createWindow(await repositories.appearance())
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
        void repositories.appearance().then(createWindow)
})

app.on("window-all-closed", () => {
    if (process.platform != "darwin")
        app.quit()
})
import { FileHistoryRequestSchema, type FileHistoryResult } from "@laneway/shared"
