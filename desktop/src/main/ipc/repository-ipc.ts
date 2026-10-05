import { isLikelyCloneSource } from "@laneway/git"
import type { AuthorIdentitySettings, EntryDefaults, EntryResult, Workspace } from "@laneway/shared"
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron"
import { EntryQueue } from "../entry-queue"
import type { OpenRepositories } from "../repositories"
import { entryError } from "../repositories"
import { titleBarOverlay } from "../window"
import type { WorkspaceManager } from "../workspace-manager"

export function registerRepositoryHandlers(repositories: OpenRepositories, workspace: WorkspaceManager) {
    let entryQueue = new EntryQueue<EntryResult>(cancelledEntry)
    registerEntryHandlers()
    registerWorkspaceHandlers()
    registerSettingsHandlers()

    function registerEntryHandlers() {
        ipcMain.handle("entry:defaults", (_event, request: { form?: unknown }) => {
            let parent = workspace.repositoryOpenDefaultPath() ?? app.getPath("documents")
            if (request?.form != "clone")
                return { parent } satisfies EntryDefaults
            let text = clipboard.readText().trim()
            return { parent, ...(isLikelyCloneSource(text) ? { source: text } : {}) } satisfies EntryDefaults
        })

        ipcMain.handle("entry:open", async event => {
            let selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
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
            let selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
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

            let parent = request.parent.trim()
            let name = request.name.trim()
            let initialBranch = typeof request.initialBranch == "string" && request.initialBranch.trim() ? request.initialBranch.trim() : undefined
            return performEntry(async () => workspace.add(await repositories.initialize(parent, name, initialBranch)))
        })

        ipcMain.handle("entry:clone", async (event, request: { source?: unknown; parent?: unknown; name?: unknown }) => {
            if (typeof request?.source != "string" || request.source.trim() == "")
                return { ok: false, error: { code: "git.command-failed", message: "Enter a repository source to clone." } } satisfies EntryResult
            if (typeof request.parent != "string" || request.parent.trim() == "")
                return { ok: false, error: { code: "git.command-failed", message: "Choose a parent directory for the clone." } } satisfies EntryResult
            if (typeof request.name != "string" || request.name.trim() == "")
                return { ok: false, error: { code: "git.command-failed", message: "Enter a directory name for the clone." } } satisfies EntryResult

            let source = request.source
            let parent = request.parent.trim()
            let name = request.name.trim()
            return entryQueue.enqueue(async setCancel => {
                try {
                    let sender = event.sender
                    let clone = await repositories.startClone({
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
    }

    function registerWorkspaceHandlers() {
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

            let selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
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

                let confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, {
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
    }

    function registerSettingsHandlers() {
        ipcMain.handle("settings:choose-git", async event => {
            let selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {
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
            let primary = typeof request?.primary == "string" && request.primary.trim() ? request.primary.trim() : undefined
            let secondary = Array.isArray(request?.secondary)
                ? [...new Set(request.secondary.filter(email => typeof email == "string").map(email => email.trim()).filter(Boolean))]
                : []
            return repositories.setAuthorIdentities({ primary, secondary })
        })

        ipcMain.handle(
            "settings:appearance",
            async (_event, request: { appearance?: unknown }) => {
                let appearance = await repositories.setAppearance(request?.appearance == "dark" ? "dark" : "light")
                for (let window of BrowserWindow.getAllWindows())
                    window.setTitleBarOverlay?.(titleBarOverlay(appearance))
                return appearance
            },
        )
        ipcMain.handle("settings:open-file", async () => {
            let state = await repositories.gitSettings()
            return shell.openPath(state.path)
        })
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
}
function cancelledEntry(): EntryResult {
    return { ok: false, error: { code: "git.cancelled", message: "Repository entry cancelled." } }
}
