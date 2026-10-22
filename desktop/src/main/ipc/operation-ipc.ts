import { isText, normalize, previewWorktree, readRegisteredWorktrees } from "@laneway/git"
import { CommitDraftSchema, type ConflictActionResult, ConflictRequestSchema, DiscardRequestSchema, type DiscardResult, type DiscardUndoResult, type HistoricalEditActionResult, HistoricalEditRequestSchema, type LocalActionResult, LocalRequestSchema, type PublishActionResult, type PublishProgress, type PublishRequest, PublishRequestSchema, type PullActionResult, type PullProgress, PullRequestSchema, type RecoveryActionResult, RecoveryRequestSchema, type WorktreeActionResult, type WorktreePreviewResult, WorktreeRequestSchema } from "@laneway/shared"
import { ipcMain, type WebContents } from "electron"
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommitDrafts } from "../commit-drafts"
import { WorkingDiscards } from "../discard"
import { type EngineCommandResult, runEngineCommand } from "../engine"
import { runPublish } from "../publish"
import type { OpenRepositories } from "../repositories"

export function registerOperationHandlers(repositories: OpenRepositories, enginePath: string, commitDrafts: CommitDrafts) {
    let draftWorktrees = new Map<string, string>()
    let conflictInspections = new Map<string, ConflictActionResult>()
    // One Pull latest per repository; cancellation stops at the next safe boundary.
    let activePulls = new Map<string, { cancel(): void }>()
    // One Publish per repository; reading plans goes on alongside.
    let activePublishes = new Set<string>()
    let discards = new WorkingDiscards(repositoryId => repositories.worktreeRepository(repositoryId))
    registerConflictHandlers()
    registerPullHandlers()
    registerPublishHandlers()
    registerLocalHandlers()
    registerDiscardHandlers()
    registerWorktreeHandlers()
    registerHistoricalEditHandlers()

    // Discards bypass the engine: they are renames plus one Git call, and stay outside the Operation History.
    function registerDiscardHandlers() {
        ipcMain.handle("discard:apply", async (_event, repositoryId: unknown, value: unknown): Promise<DiscardResult> => {
            try {
                if (typeof repositoryId != "string")
                    throw new Error("Choose a repository.")
                return await discards.apply(repositoryId, DiscardRequestSchema.parse(value))
            } catch (error) {
                return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
            }
        })

        ipcMain.handle("discard:undo", async (_event, repositoryId: unknown, id: unknown): Promise<DiscardUndoResult> => {
            if (typeof repositoryId != "string" || typeof id != "string")
                return { ok: false, error: { message: "Choose a discard to undo." } }
            return discards.undo(repositoryId, id)
        })

        ipcMain.handle("discard:settle", async (_event, repositoryId: unknown, id: unknown) => {
            if (typeof repositoryId == "string" && typeof id == "string")
                await discards.settle(repositoryId, id)
        })
    }

    function registerConflictHandlers() {
        ipcMain.handle("conflict:content", async (_event, repositoryId: unknown, object: unknown): Promise<string | null> => {
            if (typeof repositoryId != "string" || typeof object != "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object))
                throw new Error("Choose a valid conflict file object.")

            let repository = repositories.worktreeRepository(repositoryId)
            let bytes = await repository.command(repository.descriptor.mainWorktree, ["cat-file", "blob", object])
            return bytes.length <= 2_000_000 && isText(bytes) ? bytes.toString() : null
        })

        ipcMain.handle("conflict:operation", async (_event, repositoryId: unknown, value: unknown): Promise<ConflictActionResult> => {
            let requestDirectory: string | undefined
            try {
                if (typeof repositoryId != "string")
                    throw new Error("Choose a repository.")

                let request = ConflictRequestSchema.parse(value)
                let repository = repositories.worktreeRepository(repositoryId)
                let inspectionVersion = async () =>
                    (await repository.command(repository.descriptor.mainWorktree, [
                        "for-each-ref",
                        "--format=%(refname) %(objectname)",
                        "refs/laneway/conflicts/current",
                        ...(request.action == "inspect" ? [`refs/laneway/conflict-candidates/${request.subject}/`] : []),
                    ])).toString()
                let version = request.action == "inspect" ? await inspectionVersion() : undefined
                let cacheKey = JSON.stringify([repository.descriptor.commonDirectory, request, version])

                let cached = version != undefined ? conflictInspections.get(cacheKey) : undefined
                if (cached)
                    return cached
                else {
                    let requestArgs = ["--request", JSON.stringify(request)]
                    if (request.action == "edit") {
                        requestDirectory = await mkdtemp(join(tmpdir(), "laneway-conflict-request-"))
                        let requestPath = join(requestDirectory, "request.json")
                        await writeFile(requestPath, JSON.stringify(request))
                        requestArgs = ["--request-file", requestPath]
                    }

                    let output = await runEngineCommand({
                        enginePath,
                        cwd: repository.descriptor.mainWorktree,
                        args: ["conflict", ...requestArgs, "--git-path", repository.descriptor.git.path],
                    }).result
                    let result = output.messages.find(message => message.type == "result" && message.command == "conflict")
                    if (output.exitCode || !result || result.type != "result" || result.command != "conflict")
                        throw new Error(output.messages.find(message => message.type == "error")?.message ?? output.diagnostics ?? "Conflict operation failed.")

                    let response: ConflictActionResult = { ok: true, result }
                    if (version != undefined && version == await inspectionVersion()) {
                        conflictInspections.set(cacheKey, response)
                        if (conflictInspections.size > 16)
                            conflictInspections.delete(conflictInspections.keys().next().value!)
                    }

                    return response
                }
            } catch (error) {
                return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
            } finally {
                if (requestDirectory) {
                    await rm(join(requestDirectory, "request.json"), { force: true })
                    await rmdir(requestDirectory)
                }
            }
        })
    }

    function registerPullHandlers() {
        ipcMain.handle("pull:latest", async (event, repositoryId: unknown, value: unknown): Promise<PullActionResult> => {
            try {
                if (typeof repositoryId != "string")
                    throw new Error("Choose a repository.")
                if (activePulls.has(repositoryId))
                    throw new Error("Pull latest is already running for this repository.")

                let request = PullRequestSchema.parse(value)
                let repository = repositories.worktreeRepository(repositoryId)
                let sender = event.sender
                let engine = runEngineCommand({
                    enginePath,
                    cwd: repository.descriptor.mainWorktree,
                    args: ["pull", "--request", JSON.stringify(request), "--git-path", repository.descriptor.git.path],
                    onMessage: message => {
                        if (message.type == "progress" && !sender.isDestroyed()) {
                            let progress: PullProgress = { repositoryId, message: message.message, completed: message.completed, total: message.total }
                            sender.send("pull:progress", progress)
                        }
                    },
                })
                activePulls.set(repositoryId, engine)

                try {
                    return pullResponse(await engine.result)
                } finally {
                    activePulls.delete(repositoryId)
                }
            } catch (error) {
                return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
            }
        })

        ipcMain.handle("pull:cancel", (_event, repositoryId: unknown) => {
            let active = typeof repositoryId == "string" ? activePulls.get(repositoryId) : undefined
            active?.cancel()
            return Boolean(active)
        })
    }

    function pullResponse(output: EngineCommandResult): PullActionResult {
        let result = output.messages.find(message => message.type == "result" && message.command == "pull")
        let cancelled = output.messages.find(message => message.type == "cancelled")

        if (result?.type == "result" && result.command == "pull")
            return { ok: true, result }
        else if (cancelled) {
            return {
                ok: true,
                result: { type: "result", command: "pull", status: "cancelled", message: cancelled.message, fetches: [], stacks: [] },
            }
        } else {
            throw new Error(output.messages.find(message => message.type == "error")?.message ?? output.diagnostics ?? "Pull latest failed.")
        }
    }

    // Publish stays outside Operation History and takes the mutation lock only briefly, to retain its receipt's
    // commits, so it never blocks local operations for long.
    function registerPublishHandlers() {
        ipcMain.handle("publish:run", async (event, repositoryId: unknown, value: unknown): Promise<PublishActionResult> => {
            try {
                if (typeof repositoryId != "string")
                    throw new Error("Choose a repository.")
                let request = PublishRequestSchema.parse(value)
                if (request.action == "plan")
                    return await publish(event.sender, repositoryId, request)
                if (activePublishes.has(repositoryId))
                    throw new Error("A publish is already running for this repository.")

                activePublishes.add(repositoryId)
                try {
                    return await publish(event.sender, repositoryId, request)
                } finally {
                    activePublishes.delete(repositoryId)
                }
            } catch (error) {
                return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
            }
        })
    }

    function publish(sender: WebContents, repositoryId: string, request: PublishRequest) {
        return runPublish(enginePath, repositories.worktreeRepository(repositoryId).descriptor, request, progress => {
            if (!sender.isDestroyed())
                sender.send("publish:progress", { repositoryId, ...progress } satisfies PublishProgress)
        })
    }

    function registerLocalHandlers() {
        ipcMain.handle("local:operation", async (_event, repositoryId: unknown, value: unknown, token: unknown): Promise<LocalActionResult> => {
            let requestDirectory: string | undefined
            try {
                if (typeof repositoryId != "string" || (token !== undefined && typeof token != "string"))
                    throw new Error("Choose a repository operation.")

                let request = LocalRequestSchema.parse(value)
                let repository = repositories.worktreeRepository(repositoryId)
                let requestArgs = ["--request", JSON.stringify(request)]
                if (request.action == "compose" || request.action == "reword") {
                    requestDirectory = await mkdtemp(join(tmpdir(), "laneway-composition-request-"))
                    let requestPath = join(requestDirectory, "request.json")
                    await writeFile(requestPath, JSON.stringify(request))
                    requestArgs = ["--request-file", requestPath]
                }

                let output = await runEngineCommand({
                    enginePath,
                    cwd: repository.descriptor.mainWorktree,
                    args: [
                        token ? "local" : request.action == "compose" || request.action == "reword" ? "local-transfer" : "local-preview",
                        ...requestArgs,
                        ...(token ? ["--expected", token] : []),
                        "--git-path",
                        repository.descriptor.git.path,
                    ],
                }).result
                let result = output.messages.find(message => message.type == "result" && (message.command == "local" || message.command == "local-preview"))
                let failure = output.messages.find(message => message.type == "error")
                if (failure)
                    return { ok: false, error: { code: failure.code, message: failure.message } }
                else if (!result || !("status" in result) || !(result.command == "local" || result.command == "local-preview"))
                    throw new Error(output.messages.find(message => message.type == "error")?.message ?? output.diagnostics ?? "Local operation failed.")
                else
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

            let repository = repositories.worktreeRepository(repositoryId)
            let key = JSON.stringify([repositoryId, normalize(path)])
            if (value === undefined || !draftWorktrees.has(key)) {
                let worktree = (await readRegisteredWorktrees(repository)).find(item => normalize(item.path) == normalize(path))
                if (!worktree)
                    throw new Error("The worktree is no longer registered.")
                draftWorktrees.set(key, worktree.id)
            }

            if (value === undefined)
                return commitDrafts.read(repositoryId, draftWorktrees.get(key)!)
            else
                await commitDrafts.write(repositoryId, draftWorktrees.get(key)!, CommitDraftSchema.parse(value))
        })
    }

    // Apply is an ordinary compose request through local:operation; this carries entering, returning, and restarting.
    function registerHistoricalEditHandlers() {
        ipcMain.handle("edit:operation", async (_event, repositoryId: unknown, value: unknown): Promise<HistoricalEditActionResult> => {
            try {
                if (typeof repositoryId != "string")
                    throw new Error("Choose a repository.")

                let request = HistoricalEditRequestSchema.parse(value)
                let repository = repositories.worktreeRepository(repositoryId)
                let output = await runEngineCommand({
                    enginePath,
                    cwd: repository.descriptor.mainWorktree,
                    args: ["edit", "--request", JSON.stringify(request), "--git-path", repository.descriptor.git.path],
                }).result
                let result = output.messages.find(message => message.type == "result" && message.command == "edit")
                if (output.exitCode || !result || result.type != "result" || result.command != "edit")
                    throw new Error(output.messages.find(message => message.type == "error")?.message ?? (output.diagnostics || "Historical Edit failed."))

                return { ok: true, result }
            } catch (error) {
                return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
            }
        })
    }

    function registerWorktreeHandlers() {
        ipcMain.handle("worktree:recover", async (_event, repositoryId: unknown, value: unknown): Promise<RecoveryActionResult> => {
            try {
                if (typeof repositoryId != "string")
                    throw new Error("Choose a repository.")

                let request = RecoveryRequestSchema.parse(value)
                let repository = repositories.worktreeRepository(repositoryId)
                let output = await runEngineCommand({
                    enginePath,
                    cwd: repository.descriptor.mainWorktree,
                    args: ["recover", "--request", JSON.stringify(request), "--git-path", repository.descriptor.git.path],
                }).result
                let result = output.messages.find(message => message.type == "result" && message.command == "recover")
                if (output.exitCode || !result || result.command != "recover")
                    throw new Error(output.messages.find(message => message.type == "error")?.message ?? "Worktree recovery failed.")

                return { ok: true, backupPath: result.backupPath }
            } catch (error) {
                return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
            }
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

                let request = WorktreeRequestSchema.parse(value)
                let repository = repositories.worktreeRepository(repositoryId)
                let result = await runEngineCommand({
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

                let repository = repositories.worktreeRepository(repositoryId)
                let result = await runEngineCommand({
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
    }
}
