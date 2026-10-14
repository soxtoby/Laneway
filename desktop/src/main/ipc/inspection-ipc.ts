import type { BranchGraphResult, BranchHistoryRequest, BranchHistoryResult, RepositoryGraphSettings } from "@laneway/shared"
import { ChangesRequestSchema, type ChangesResult, FileDiffRequestSchema, type FileDiffResult, FileHistoryRequestSchema, type FileHistoryResult, FileImageRequestSchema, type FileImageResult } from "@laneway/shared"
import { ipcMain } from "electron"
import { runEngineCommand } from "../engine"
import type { OpenRepositories } from "../repositories"
import { entryError } from "../repositories"

export function registerInspectionHandlers(repositories: OpenRepositories, enginePath: string) {
    registerChangesHandlers()
    registerGraphHandlers()

    function registerChangesHandlers() {
        ipcMain.handle("history:read", async (_event, repositoryId: unknown, requestId: unknown, value: unknown): Promise<FileHistoryResult> => {
            let request = FileHistoryRequestSchema.safeParse(value)
            if (typeof repositoryId != "string" || typeof requestId != "string" || !request.success)
                return { ok: false, error: { code: "git.command-failed", message: "Invalid file history request." } }

            try {
                return { ok: true, page: await repositories.readFileHistory(repositoryId, requestId, request.data) }
            } catch (error) {
                return { ok: false, error: entryError(error) }
            }
        })

        ipcMain.handle("changes:read", async (_event, repositoryId: unknown, requestId: unknown, value: unknown): Promise<ChangesResult> => {
            let request = ChangesRequestSchema.safeParse(value)
            if (typeof repositoryId != "string" || typeof requestId != "string" || !request.success)
                return { ok: false, error: { code: "git.command-failed", message: "Invalid changes request." } }

            try {
                return { ok: true, inventory: await repositories.readChanges(repositoryId, requestId, request.data) }
            } catch (error) {
                return { ok: false, error: entryError(error) }
            }
        })

        ipcMain.handle("changes:diff", async (_event, repositoryId: unknown, requestId: unknown, value: unknown): Promise<FileDiffResult> => {
            let request = FileDiffRequestSchema.safeParse(value)
            if (typeof repositoryId != "string" || typeof requestId != "string" || !request.success)
                return { ok: false, error: { code: "git.command-failed", message: "Invalid diff request." } }

            try {
                return { ok: true, page: await repositories.readFileDiff(repositoryId, requestId, request.data) }
            } catch (error) {
                return { ok: false, error: entryError(error) }
            }
        })

        ipcMain.handle("changes:image", async (_event, repositoryId: unknown, requestId: unknown, value: unknown): Promise<FileImageResult> => {
            let request = FileImageRequestSchema.safeParse(value)
            if (typeof repositoryId != "string" || typeof requestId != "string" || !request.success)
                return { ok: false, error: { code: "git.command-failed", message: "Invalid image request." } }

            try {
                return { ok: true, page: await repositories.readFileImage(repositoryId, requestId, request.data) }
            } catch (error) {
                return { ok: false, error: entryError(error) }
            }
        })

        ipcMain.handle(
            "changes:cancel",
            (_event, repositoryId: unknown, requestId: unknown) =>
                typeof repositoryId == "string" && typeof requestId == "string" && repositories.cancelInspection(repositoryId, requestId),
        )
    }

    function registerGraphHandlers() {
        ipcMain.handle(
            "graph:read",
            async (_event, request: { repositoryId?: unknown; refreshRemote?: unknown; allBranches?: unknown }): Promise<BranchGraphResult> => {
                if (typeof request?.repositoryId != "string")
                    return { ok: false, error: { code: "git.command-failed", message: "Choose a repository." } }

                try {
                    let read = await repositories.startBranchGraph(request.repositoryId, request.refreshRemote === true, request.allBranches === true)
                    let repository = repositories.worktreeRepository(request.repositoryId)
                    let [graph, output] = await Promise.all([
                        read.result,
                        runEngineCommand({
                            enginePath,
                            cwd: repository.descriptor.mainWorktree,
                            args: ["recovery-status", "--git-path", repository.descriptor.git.path],
                        }).result,
                    ])
                    let recovery = output.messages.find(message => message.type == "result" && message.command == "recovery-status")
                    if (output.exitCode || !recovery || recovery.command != "recovery-status")
                        throw new Error(output.messages.find(message => message.type == "error")?.message ?? "Could not read worktree recovery.")

                    return { ok: true, graph, worktreeRecoveries: recovery.worktrees }
                } catch (error) {
                    return { ok: false, error: entryError(error) }
                }
            },
        )

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
}

function isGraphSettings(value: unknown): value is RepositoryGraphSettings {
    if (!value || typeof value != "object")
        return false

    let settings = value as Partial<RepositoryGraphSettings>
    return (settings.selectedRemote == undefined || typeof settings.selectedRemote == "string")
        && Array.isArray(settings.remotePatterns) && settings.remotePatterns.every(pattern => typeof pattern == "string")
}

function isBranchHistoryRequest(value: unknown): value is BranchHistoryRequest {
    if (!value || typeof value != "object")
        return false

    let request = value as Partial<BranchHistoryRequest>
    return typeof request.branchRef == "string" && typeof request.tip == "string"
        && Array.isArray(request.baseTips) && request.baseTips.every(tip => typeof tip == "string")
        && (request.remoteTips == undefined || Array.isArray(request.remoteTips) && request.remoteTips.every(tip => typeof tip == "string"))
        && (request.requestId == undefined || typeof request.requestId == "string")
        && (request.offset == undefined || Number.isSafeInteger(request.offset))
        && (request.limit == undefined || Number.isSafeInteger(request.limit))
}
