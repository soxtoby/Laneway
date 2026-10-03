import { connectRepository, GitError, type RepositoryGit } from "@laneway/git"
import { pathExists, previewWorktree, worktreeBasename } from "@laneway/git"
import { type OperationAvailability, type OperationAvailabilityReason, type OperationHistoryEntry, type OperationHistoryResult, type OperationSummary, OperationSummarySchema, type OperationTransitionResult, type RecoveredExecution, type RecoveryResult, type TestMutationResult } from "@laneway/shared"
import type { WorktreeRequest, WorktreeResult } from "@laneway/shared"
import type { LocalRequest, LocalResult } from "@laneway/shared"
import type { ConflictRequest, ConflictResult } from "@laneway/shared"
import type { BranchGraphReadOptions, PullRequest, PullResult } from "@laneway/shared"
import { link, lstat, mkdir, open, readdir, readFile, readlink, rename, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { conflictMutation, conflictPaths, executeConflict, suspendWorkingConflicts } from "./conflict-operations"
import { isFileExtraction } from "./file-extraction"
import { LocalPreconditionError, mutateLocal, prepareLocal } from "./local-mutations"
import { executePull, preparePull, type PullPreparation, type PullProgressReporter } from "./pull-latest"
import { migrateRecoveryRefs, releaseRecoveryObjects, retainRecoveryObjects } from "./recovery-objects"
import { mutateWorktree } from "./worktree-mutations"
import { captureWorktreeState, relocateRemovedState, restoreWorktreeState, stateIdentity, type WorktreeState, worktreeStateMatches, worktreeStateObjects, WorktreeStateSchema } from "./worktree-state"

const fixtureRef = "refs/laneway/test/fixture"
const journalFileName = "journal.jsonl"
const historyFileName = "history.jsonl"

const RefChangeSchema = z.object({
    ref: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
})

const WorktreeFingerprintSchema = z.object({
    index: z.string(),
    worktree: z.string(),
})

const WorktreeChangeSchema = z.object({
    path: z.string(),
    before: WorktreeFingerprintSchema,
    after: WorktreeFingerprintSchema,
})

const StoredOperationContentSchema = OperationSummarySchema.extend({
    gitCommonDirectory: z.string(),
    expectedGitLockfiles: z.array(z.string()),
    refChanges: z.array(RefChangeSchema),
    worktreeChanges: z.array(WorktreeChangeSchema),
    lifecycle: z.object({ before: WorktreeStateSchema, after: WorktreeStateSchema.optional() }).optional(),
})
const StoredOperationSchema = StoredOperationContentSchema.extend({
    integrity: z.string().regex(/^[0-9a-f]{64}$/),
})

const OperationEventSchema = z.object({
    schemaVersion: z.literal(1),
    type: z.literal("operation"),
    executionId: z.string(),
    operation: StoredOperationSchema,
})

const TransitionEventSchema = z.object({
    schemaVersion: z.literal(1),
    type: z.literal("transition"),
    executionId: z.string(),
    action: z.enum(["undo", "redo"]),
    operationId: z.string(),
    timestamp: z.string(),
    operation: StoredOperationSchema.optional(),
})

const HistoryEventSchema = z.discriminatedUnion("type", [OperationEventSchema, TransitionEventSchema])
const JournalPhaseSchema = z.enum([
    "intent",
    "recovery-retained",
    "preconditions-verified",
    "worktrees-committed",
    "refs-committed",
    "history-committed",
    "finalized",
    "cancelled",
    "aborted",
])
const JournalEventSchema = z.object({
    schemaVersion: z.literal(1),
    executionId: z.string(),
    operationId: z.string(),
    action: z.enum(["apply", "undo", "redo"]),
    phase: JournalPhaseSchema,
    timestamp: z.string(),
    operation: StoredOperationSchema.optional(),
    abandonedOperationIds: z.array(z.string()).optional(),
})

type RefChange = z.infer<typeof RefChangeSchema>
type WorktreeFingerprint = z.infer<typeof WorktreeFingerprintSchema>
type StoredOperation = z.infer<typeof StoredOperationSchema>
type HistoryEvent = z.infer<typeof HistoryEventSchema>
export type JournalPhase = z.infer<typeof JournalPhaseSchema>
type JournalEvent = z.infer<typeof JournalEventSchema>

interface JournalExecution {
    intent: JournalEvent & { operation: StoredOperation }
    phases: Set<JournalPhase>
}

interface HistoryProjection {
    operations: StoredOperation[]
    position: number
}

export type OperationCommand =
    | { command: "conflict"; request: ConflictRequest; noWait: boolean; crashAfter?: JournalPhase }
    | {
        command: "pull"
        request: PullRequest
        noWait: boolean
        crashAfter?: JournalPhase
        graphOptions: (repositoryId: string) => BranchGraphReadOptions
        progress?: PullProgressReporter
    }
    | {
        command: "local" | "local-preview" | "local-transfer"
        request: LocalRequest
        token?: string
        noWait: boolean
        crashAfter?: JournalPhase
        branchPrefix?: string
    }
    | { command: "worktree"; request: WorktreeRequest; token?: string; noWait: boolean; crashAfter?: JournalPhase; branchPrefix?: string }
    | { command: "test-mutation"; value: string; noWait: boolean; crashAfter?: JournalPhase; holdAfterIntentMs?: number }
    | { command: "undo"; noWait: boolean; crashAfter?: JournalPhase; worktreeBasename?: string }
    | { command: "redo"; noWait: boolean; crashAfter?: JournalPhase }
    | { command: "history"; noWait: boolean }
    | { command: "recover"; noWait: boolean }

export type OperationCommandResult =
    | TestMutationResult
    | OperationTransitionResult
    | OperationHistoryResult
    | RecoveryResult
    | WorktreeResult
    | LocalResult
    | ConflictResult
    | PullResult

export interface CancellationSignal {
    isCancelled(): boolean
    wait(delayMs: number): Promise<boolean>
}

export class OperationCancelledError extends Error {}

export class OperationRuntimeError extends Error {
    constructor(
        readonly code:
            | "operation.history-corrupt"
            | "operation.internal"
            | "operation.journal-corrupt"
            | "operation.locked"
            | "operation.precondition-failed"
            | "operation.recovery-blocked",
        message: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message)
    }
}

export async function executeOperationCommand(
    command: OperationCommand,
    cwd: string,
    cancellation: CancellationSignal = neverCancelled,
    gitPath?: string,
): Promise<OperationCommandResult> {
    const repository = await connectRepository(cwd, gitPath)
    const store = new OperationStore(repository.descriptor.commonDirectory)

    // Fetching is network-bound and mutates only remote-tracking refs, so it runs before the mutation lock.
    let prepared: PullPreparation | undefined
    if (command.command == "pull") {
        const progress = command.progress ?? (() => {})
        prepared = await preparePull(repository, command.request, command.graphOptions(repository.descriptor.id), () => cancellation.isCancelled(), progress)
        if (prepared.kind == "no-remotes")
            return { type: "result", command: "pull", status: "no-remotes", message: "Add a remote to pull.", fetches: [], stacks: [] }
        if (prepared.kind == "cancelled") {
            return {
                type: "result",
                command: "pull",
                status: "cancelled",
                message: "Pull cancelled before any local changes.",
                fetches: prepared.fetches,
                stacks: [],
            }
        }
        if (!prepared.stacks.length && !prepared.blocked.length) {
            const failed = prepared.fetches.filter(fetch => fetch.status == "failed")
            return {
                type: "result",
                command: "pull",
                status: "fetched",
                message: failed.length
                    ? `Fetching ${failed.map(fetch => fetch.remote).join(", ")} failed; no open stacks to update.`
                    : "Fetched; no open stacks to update.",
                fetches: prepared.fetches,
                stacks: [],
            }
        }
    }

    return store.withLock(command.noWait, cancellation, async () => {
        const runtime = new OperationRuntime(repository, store, cancellation)
        const recovery = await runtime.recover()
        if (command.command == "recover")
            return recovery

        switch (command.command) {
            case "pull":
                return runtime.pull(prepared as Extract<PullPreparation, { kind: "prepared" }>, command.progress ?? (() => {}), command.crashAfter)
            case "conflict":
                return runtime.conflict(command.request, command.crashAfter)
            case "local-preview":
                return {
                    type: "result",
                    command: "local-preview",
                    status: "preview",
                    preview: (await prepareLocal(repository, command.request, command.branchPrefix ?? "worktree/")).preview,
                }
            case "local":
                return runtime.applyLocal(command.request, command.token, command.crashAfter, command.branchPrefix ?? "worktree/")
            case "local-transfer":
                return runtime.transfer(command.request, command.crashAfter, command.branchPrefix ?? "worktree/")
            case "worktree":
                return runtime.applyWorktree(command.request, command.token, command.crashAfter, command.branchPrefix)
            case "test-mutation":
                return runtime.applyTestMutation(command.value, command.crashAfter, command.holdAfterIntentMs)
            case "undo":
                return runtime.undo(command.crashAfter, command.worktreeBasename)
            case "redo":
                return runtime.redo(command.crashAfter)
            case "history":
                return runtime.history()
        }
    })
}

class OperationRuntime {
    constructor(
        private readonly repository: RepositoryGit,
        private readonly store: OperationStore,
        private readonly cancellation: CancellationSignal,
    ) {}

    async conflict(request: ConflictRequest, crashAfter?: JournalPhase): Promise<ConflictResult> {
        const changes = new Map<string, string | null>()
        if (!conflictMutation(request))
            return executeConflict(this.repository, request, changes, () => this.cancellation.isCancelled())
        let result: ConflictResult | undefined
        await this.applySnapshot(
            await conflictPaths(this.repository),
            `conflict.${request.action}`,
            request.action == "rewrite" ? "Rewrite stack" : request.action == "accept" ? "Accept conflict resolution" : request.action.replaceAll("-", " "),
            async () => {
                result = await executeConflict(this.repository, request, changes, () => this.cancellation.isCancelled())
                return changes
            },
            crashAfter,
        )
        return result!
    }

    async pull(prepared: Extract<PullPreparation, { kind: "prepared" }>, progress: PullProgressReporter, crashAfter?: JournalPhase): Promise<PullResult> {
        const changes = new Map<string, string | null>()
        let stacks: PullResult["stacks"] = []
        const operation = await this.applySnapshot(await conflictPaths(this.repository), "pull.latest", "Pull latest", async () => {
            stacks = await executePull(this.repository, prepared, changes, () => this.cancellation.isCancelled(), progress)
            return changes
        }, crashAfter)
        const projection = await this.store.readHistory()
        const recorded = projection.operations[projection.position - 1]?.id == operation.id
        const cancelled = stacks.some(stack => stack.status == "cancelled")
        const counts = new Map<string, number>()
        for (const stack of stacks)
            counts.set(stack.status, (counts.get(stack.status) ?? 0) + 1)
        const labels: Record<string, string> = {
            updated: "updated",
            current: "already current",
            "needs-resolution": "need resolution",
            skipped: "skipped",
            failed: "failed",
            cancelled: "not started",
        }
        const summary = [...counts].map(([status, count]) => `${count} ${labels[status]}`).join(", ")
        return {
            type: "result",
            command: "pull",
            status: cancelled ? "cancelled" : "updated",
            message: cancelled ? `Pull cancelled: ${summary}. Completed updates were kept.` : `Pull complete: ${summary}.`,
            fetches: prepared.fetches,
            stacks,
            ...(recorded ? { operation: summarize(operation as StoredOperation) } : {}),
        }
    }

    async applyLocal(request: LocalRequest, token?: string, crashAfter?: JournalPhase, prefix = "worktree/"): Promise<LocalResult> {
        const { preview, before } = await prepareLocal(this.repository, request, prefix, token)
        if (!token || token != preview.token)
            throw new OperationRuntimeError("operation.precondition-failed", "Repository content changed. Refresh and review the operation again.")
        return this.applyPreparedLocal(request, { preview, before }, crashAfter)
    }

    async transfer(request: LocalRequest, crashAfter?: JournalPhase, prefix = "worktree/"): Promise<LocalResult> {
        if (request.action != "compose")
            throw new OperationRuntimeError("operation.precondition-failed", "Choose a change transfer.")
        const prepared = await prepareLocal(this.repository, request, prefix)
        if (isFileExtraction(prepared.preview))
            return this.applyPreparedLocal(request, prepared, crashAfter)
        return { type: "result", command: "local-preview", status: "preview", preview: prepared.preview }
    }

    private async applyPreparedLocal(
        request: LocalRequest,
        { preview, before }: Awaited<ReturnType<typeof prepareLocal>>,
        crashAfter?: JournalPhase,
    ): Promise<LocalResult> {
        let result: LocalResult = { type: "result", command: "local", status: "performed" }
        const expectedRefs = new Map<string, string | null>()
        // Preparation happened under this mutation lock, so its snapshot becomes the journal's
        // "before" state. The mutation still validates it immediately before changing Git state.
        await this.applySnapshot(
            preview.affected,
            `local.${request.action}`,
            request.action.replaceAll("-", " "),
            async () => {
                try {
                    result = await mutateLocal(this.repository, request, before, preview, expectedRefs, () => this.cancellation.isCancelled())
                } catch (error) {
                    if (error instanceof LocalPreconditionError)
                        throw error
                    // Hook/filter failures may leave intentional edits. Retain the resulting state as an
                    // undoable operation instead of overwriting edits or leaving an unexplained journal.
                    result = { type: "result", command: "local", status: "failed", message: error instanceof Error ? error.message : String(error) }
                }
                return expectedRefs
            },
            crashAfter,
            before,
        )
        return result
    }

    async applyWorktree(request: WorktreeRequest, token?: string, crashAfter?: JournalPhase, branchPrefix = "worktree/"): Promise<WorktreeResult> {
        await this.repository.command(this.repository.descriptor.mainWorktree, ["check-ref-format", "--branch", `${branchPrefix}worktree`])
        const preview = await previewWorktree(this.repository, request)
        request = preview.request
        if (token && token != preview.token)
            throw new OperationRuntimeError("operation.precondition-failed", "Worktree state changed after preview. Review it again.")
        if (
            (request.action == "create" || request.action == "switch") && !request.move
            && preview.worktrees.some(item =>
                item.branchRef == `refs/heads/${request.branch?.replace(/^refs\/heads\//, "")}` && !("path" in request && item.path == request.path)
            )
        ) {
            throw new OperationRuntimeError("operation.precondition-failed", "Confirm moving the branch from its current worktree first.")
        }
        if (request.action == "remove" && preview.ignored.length && !request.allowIgnoredLoss)
            throw new OperationRuntimeError("operation.precondition-failed", "Review ignored-file loss before removal.")
        const operation = await this.applySnapshot(
            preview.affected,
            `worktree.${request.action}`,
            `${request.action[0]!.toUpperCase()}${request.action.slice(1)} worktree ${preview.destination ?? ("path" in request ? request.path : "")}`,
            async () => {
                const changed = await mutateWorktree(this.repository, preview, branchPrefix)
                const conflictChanges = new Map<string, string | null>()
                await suspendWorkingConflicts(this.repository, conflictChanges)
                for (const ref of conflictChanges.keys())
                    changed.add(ref)
                return changed
            },
            crashAfter,
        )
        return { type: "result", command: "worktree", operation }
    }

    private async applySnapshot(
        affected: string[],
        kind: string,
        summary: string,
        mutate: (before: WorktreeState) => Promise<Set<string> | Map<string, string | null>>,
        crashAfter?: JournalPhase,
        prepared?: WorktreeState,
    ): Promise<OperationSummary> {
        const locks = await findGitLockfiles(this.repository.descriptor.commonDirectory)
        if (locks.length)
            throw gitLockfileError(locks)
        const before = prepared ?? await captureWorktreeState(this.repository, affected)
        const projection = await this.store.readHistory()
        const abandoned = projection.operations.slice(projection.position)
        let operation = sealOperation({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            kind,
            summary,
            affectedRefs: [],
            affectedWorktrees: affected,
            gitCommonDirectory: this.repository.descriptor.commonDirectory,
            expectedGitLockfiles: [],
            refChanges: [],
            worktreeChanges: [],
            lifecycle: { before },
        })
        const executionId = crypto.randomUUID()
        const retainedHeads = new Map<string, string>()
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action: "apply",
            phase: "intent",
            timestamp: new Date().toISOString(),
            operation,
            abandonedOperationIds: abandoned.map(item => item.id),
        })
        crashIfRequested("intent", crashAfter)
        await retainOperation(this.repository, operation, retainedHeads)
        await this.store.appendJournalPhase(executionId, operation.id, "apply", "recovery-retained")
        crashIfRequested("recovery-retained", crashAfter)
        await this.cancelIfRequested(executionId, operation, "apply")
        try {
            // This process captured "before" moments ago and has only written journal and recovery
            // storage since, so the snapshot is not re-captured for comparison here or after mutation.
            await validatePreconditions(this.repository, operation, "apply", false)
        } catch (error) {
            await this.abortBeforeCommit(executionId, operation, "apply")
            throw error
        }
        await this.store.appendJournalPhase(executionId, operation.id, "apply", "preconditions-verified")
        crashIfRequested("preconditions-verified", crashAfter)
        await this.cancelIfRequested(executionId, operation, "apply")
        let changedRefs: Set<string> | Map<string, string | null>
        try {
            changedRefs = await mutate(before)
        } catch (error) {
            if (await worktreeStateMatches(this.repository, before))
                await this.abortBeforeCommit(executionId, operation, "apply")
            else {
                throw recoveryBlocked(
                    operation,
                    "apply",
                    `The worktree operation stopped: ${
                        error instanceof Error ? error.message : String(error)
                    }. Its original state remains retained for recovery.`,
                )
            }
            throw error
        }
        const after = await captureWorktreeState(this.repository, affected, before)
        if ((kind.startsWith("local.") || kind.startsWith("pull.")) && stateIdentity(before) == stateIdentity(after)) {
            await this.abortBeforeCommit(executionId, operation, "apply")
            return operation
        }
        const refChanges = [...new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])].filter(ref => before.refs[ref] != after.refs[ref]).map(
            ref => ({ ref, before: before.refs[ref] ?? null, after: after.refs[ref] ?? null }),
        )
        if (refChanges.some(change => !changedRefs.has(change.ref) || changedRefs instanceof Map && changedRefs.get(change.ref) != change.after)) {
            throw recoveryBlocked(
                operation,
                "apply",
                "An unrelated ref changed during the worktree mutation. Its state was left intact; inspect recovery before continuing.",
            )
        }
        operation = sealOperation({ ...operation, affectedRefs: refChanges.map(change => change.ref), refChanges, lifecycle: { before, after } })
        await retainOperation(this.repository, operation, retainedHeads)
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action: "apply",
            phase: "worktrees-committed",
            timestamp: new Date().toISOString(),
            operation,
        })
        await validateOperationState(this.repository, operation, "apply", "target", false)
        crashIfRequested("worktrees-committed", crashAfter)
        await this.store.appendJournalPhase(executionId, operation.id, "apply", "refs-committed")
        crashIfRequested("refs-committed", crashAfter)
        await this.commitHistory(executionId, operation, "apply")
        await this.store.appendJournalPhase(executionId, operation.id, "apply", "history-committed")
        crashIfRequested("history-committed", crashAfter)
        for (const old of abandoned)
            await releaseOperation(this.repository, old.id)
        await this.store.appendJournalPhase(executionId, operation.id, "apply", "finalized")
        return summarize(operation)
    }

    async applyTestMutation(value: string, crashAfter?: JournalPhase, holdAfterIntentMs?: number): Promise<TestMutationResult> {
        const projection = await this.store.readHistory()
        const before = await this.repository.resolveRef(fixtureRef)
        const expectedGitLockfiles = await findGitLockfiles(this.repository.descriptor.commonDirectory)
        if (expectedGitLockfiles.length > 0)
            throw gitLockfileError(expectedGitLockfiles)
        const after = await this.repository.hashObject(value)
        const worktree = await fingerprintWorktree(this.repository, this.repository.descriptor.selectedWorktree)
        const operation = sealOperation({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            kind: "test.ref-update",
            summary: `Set the test fixture to ${value}`,
            affectedRefs: [fixtureRef],
            affectedWorktrees: [this.repository.descriptor.selectedWorktree],
            gitCommonDirectory: this.repository.descriptor.commonDirectory,
            expectedGitLockfiles,
            refChanges: [{ ref: fixtureRef, before, after }],
            worktreeChanges: [{ path: this.repository.descriptor.selectedWorktree, before: worktree, after: worktree }],
        })
        const abandoned = projection.operations.slice(projection.position)

        await this.applyOperation(operation, "apply", abandoned, crashAfter, holdAfterIntentMs)

        return { type: "result", command: "test-mutation", operation: summarize(operation) }
    }

    async undo(crashAfter?: JournalPhase, basename?: string): Promise<OperationTransitionResult> {
        const projection = await this.store.readHistory()
        if (projection.position == 0)
            return { type: "result", command: "undo", status: "unavailable", reason: "empty" }

        let operation = projection.operations[projection.position - 1]
        if (!operation)
            throw new OperationRuntimeError("operation.history-corrupt", "Operation History has an invalid undo position.")

        if (basename) {
            if (operation.kind != "worktree.remove" || !operation.lifecycle?.after)
                throw new OperationRuntimeError("operation.precondition-failed", "An alternate basename is only available when undoing worktree removal.")
            const root = operation.lifecycle.before.roots.find(root => root.kind == "working" && root.present)
            if (!root)
                throw new OperationRuntimeError("operation.precondition-failed", "There is no removed directory to recreate.")
            const destination = join(dirname(root.path), worktreeBasename(basename))
            if (await pathExists(destination))
                throw new OperationRuntimeError("operation.precondition-failed", "The alternate worktree path is occupied.")
            operation = sealOperation({
                ...operation,
                affectedWorktrees: [...new Set([...operation.affectedWorktrees, destination])],
                lifecycle: {
                    before: await relocateRemovedState(this.repository, operation.lifecycle.before, root.path, destination),
                    after: await relocateRemovedState(this.repository, operation.lifecycle.after, root.path, destination),
                },
            })
        }

        await this.applyOperation(operation, "undo", [], crashAfter)
        return { type: "result", command: "undo", status: "performed", operation: summarize(operation) }
    }

    async redo(crashAfter?: JournalPhase): Promise<OperationTransitionResult> {
        const projection = await this.store.readHistory()
        if (projection.position == projection.operations.length)
            return { type: "result", command: "redo", status: "unavailable", reason: "empty" }

        const operation = projection.operations[projection.position]
        if (!operation)
            throw new OperationRuntimeError("operation.history-corrupt", "Operation History has an invalid redo position.")

        await this.applyOperation(operation, "redo", [], crashAfter)
        return { type: "result", command: "redo", status: "performed", operation: summarize(operation) }
    }

    async history(): Promise<OperationHistoryResult> {
        const projection = await this.store.readHistory()
        const start = historyWindowStart(projection.position, projection.operations.length)
        const entries = projection.operations.slice(start, start + 10).map((operation, offset) => {
            const index = start + offset
            return {
                ...summarize(operation),
                state: index < projection.position ? "applied" : "undone",
                isNextUndo: index == projection.position - 1,
                isNextRedo: index == projection.position,
            } satisfies OperationHistoryEntry
        }).reverse()

        return {
            type: "result",
            command: "history",
            position: projection.position,
            total: projection.operations.length,
            entries,
            undo: await this.availability(projection.operations[projection.position - 1], "undo"),
            redo: await this.availability(projection.operations[projection.position], "redo"),
        }
    }

    private async availability(operation: StoredOperation | undefined, action: "undo" | "redo"): Promise<OperationAvailability> {
        if (!operation)
            return { available: false, reason: "empty" }

        try {
            await validatePreconditions(this.repository, operation, action)
            return { available: true, operationId: operation.id }
        } catch (error) {
            if (error instanceof OperationRuntimeError && error.code == "operation.precondition-failed")
                return { available: false, operationId: operation.id, reason: availabilityReason(error.details?.reason) }
            throw error
        }
    }

    async recover(): Promise<RecoveryResult> {
        await migrateRecoveryRefs(this.repository)
        const pending = await this.store.readPendingExecutions()
        const recovered: RecoveredExecution[] = []

        for (const execution of pending) {
            if (await this.resumeExecution(execution))
                recovered.push({ action: execution.intent.action, operation: summarize(execution.intent.operation) })
        }

        return {
            type: "result",
            command: "recover",
            status: recovered.length == 0 ? "clean" : "recovered",
            recovered,
        }
    }

    private async applyOperation(
        operation: StoredOperation,
        action: "apply" | "undo" | "redo",
        abandoned: StoredOperation[],
        crashAfter?: JournalPhase,
        holdAfterIntentMs?: number,
    ) {
        const executionId = crypto.randomUUID()
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action,
            phase: "intent",
            timestamp: new Date().toISOString(),
            operation,
            abandonedOperationIds: abandoned.map(item => item.id),
        })
        crashIfRequested("intent", crashAfter)
        await this.cancelIfRequested(executionId, operation, action, holdAfterIntentMs)
        await retainOperation(this.repository, operation)
        await this.store.appendJournalPhase(executionId, operation.id, action, "recovery-retained")
        crashIfRequested("recovery-retained", crashAfter)
        await this.cancelIfRequested(executionId, operation, action)

        try {
            await validatePreconditions(this.repository, operation, action)
        } catch (error) {
            await this.abortBeforeCommit(executionId, operation, action)
            throw error
        }
        await this.store.appendJournalPhase(executionId, operation.id, action, "preconditions-verified")
        crashIfRequested("preconditions-verified", crashAfter)
        await this.cancelIfRequested(executionId, operation, action)

        try {
            if (operation.lifecycle) {
                const { before, after } = operation.lifecycle
                if (!after)
                    throw recoveryBlocked(operation, action, "The worktree operation has no completed target snapshot.")
                await restoreWorktreeState(this.repository, action == "undo" ? after : before, action == "undo" ? before : after)
            } else {
                await applyRefChanges(this.repository, transitionChanges(operation, action))
            }
        } catch (error) {
            if (!operation.lifecycle)
                await this.abortBeforeCommit(executionId, operation, action)
            throw error
        }
        await validateOperationState(this.repository, operation, action, "target")
        await this.store.appendJournalPhase(executionId, operation.id, action, "refs-committed")
        crashIfRequested("refs-committed", crashAfter)

        await this.commitHistory(executionId, operation, action)
        await this.store.appendJournalPhase(executionId, operation.id, action, "history-committed")
        crashIfRequested("history-committed", crashAfter)

        for (const abandonedOperation of abandoned)
            await releaseOperation(this.repository, abandonedOperation.id)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        crashIfRequested("finalized", crashAfter)
    }

    private async cancelIfRequested(executionId: string, operation: StoredOperation, action: "apply" | "undo" | "redo", waitMs = 0) {
        const cancelled = waitMs > 0 ? await this.cancellation.wait(waitMs) : this.cancellation.isCancelled()
        if (!cancelled)
            return

        await this.store.appendJournalPhase(executionId, operation.id, action, "cancelled")
        if (action == "apply")
            await releaseOperation(this.repository, operation.id)
        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        throw new OperationCancelledError("Cancellation acknowledged at a verified journal boundary.")
    }

    private async abortBeforeCommit(executionId: string, operation: StoredOperation, action: "apply" | "undo" | "redo") {
        await this.store.appendJournalPhase(executionId, operation.id, action, "aborted")
        if (action == "apply")
            await releaseOperation(this.repository, operation.id)
        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
    }

    private async resumeExecution(execution: JournalExecution) {
        const { action, executionId, operation, operationId } = execution.intent
        if (operation.lifecycle && !operation.lifecycle.after && !execution.phases.has("cancelled")) {
            if (await worktreeStateMatches(this.repository, operation.lifecycle.before)) {
                await this.abortBeforeCommit(executionId, operation, action)
                return false
            }
            throw recoveryBlocked(
                operation,
                action,
                "A worktree mutation stopped before its target was recorded. Retained Git and file state is available under this operation's recovery refs; inspect the affected paths before continuing.",
            )
        }
        if (execution.phases.has("cancelled") || execution.phases.has("aborted")) {
            if (action == "apply")
                await releaseOperation(this.repository, operation.id)
            await this.store.appendJournalPhase(executionId, operationId, action, "finalized")
            return false
        }

        const historyCommitted = await this.store.hasHistoryEvent(executionId)
        const refsCommitted = execution.phases.has("refs-committed") || historyCommitted
        const targetMatches = await operationStateMatches(this.repository, operation, action, "target")

        await retainOperation(this.repository, operation)
        if (!execution.phases.has("recovery-retained"))
            await this.store.appendJournalPhase(executionId, operationId, action, "recovery-retained")

        if (refsCommitted) {
            if (!targetMatches)
                throw recoveryBlocked(operation, action, "The recorded target state no longer matches the repository.")
        } else if (!targetMatches) {
            try {
                await validatePreconditions(this.repository, operation, action)
            } catch (error) {
                if (error instanceof OperationRuntimeError && error.code == "operation.precondition-failed")
                    throw recoveryBlocked(operation, action, error.message, error.details)
                throw error
            }
            if (!execution.phases.has("preconditions-verified"))
                await this.store.appendJournalPhase(executionId, operationId, action, "preconditions-verified")
            if (operation.lifecycle?.after) {
                await restoreWorktreeState(
                    this.repository,
                    action == "undo" ? operation.lifecycle.after : operation.lifecycle.before,
                    action == "undo" ? operation.lifecycle.before : operation.lifecycle.after,
                )
            } else {
                await applyRefChanges(this.repository, transitionChanges(operation, action))
            }
        }

        await validateOperationState(this.repository, operation, action, "target")
        if (!execution.phases.has("refs-committed"))
            await this.store.appendJournalPhase(executionId, operationId, action, "refs-committed")
        if (!historyCommitted)
            await this.commitHistory(executionId, operation, action)
        if (!execution.phases.has("history-committed"))
            await this.store.appendJournalPhase(executionId, operationId, action, "history-committed")

        for (const abandonedOperationId of execution.intent.abandonedOperationIds ?? [])
            await releaseOperation(this.repository, abandonedOperationId)
        await this.store.appendJournalPhase(executionId, operationId, action, "finalized")
        return true
    }

    private async commitHistory(executionId: string, operation: StoredOperation, action: "apply" | "undo" | "redo") {
        if (action == "apply") {
            await this.store.appendHistory({ schemaVersion: 1, type: "operation", executionId, operation })
            return
        }

        await this.store.appendHistory({
            schemaVersion: 1,
            type: "transition",
            executionId,
            action,
            operationId: operation.id,
            timestamp: new Date().toISOString(),
            ...(operation.lifecycle ? { operation } : {}),
        })
    }
}

class OperationStore {
    private readonly directory: string
    private readonly journalPath: string
    private readonly historyPath: string
    private readonly lockPath: string
    private historyEvents?: Promise<HistoryEvent[]>

    constructor(commonDirectory: string) {
        this.directory = resolve(commonDirectory, "laneway")
        this.journalPath = resolve(this.directory, journalFileName)
        this.historyPath = resolve(this.directory, historyFileName)
        this.lockPath = resolve(this.directory, "mutation.lock")
    }

    async withLock<T>(noWait: boolean, cancellation: CancellationSignal, work: () => Promise<T>): Promise<T> {
        await mkdir(this.directory, { recursive: true })
        await cleanupStaleLockCandidates(this.directory)
        const token = crypto.randomUUID()
        const candidatePath = `${this.lockPath}.candidate-${token}`
        const candidate = await open(candidatePath, "wx")
        await candidate.writeFile(JSON.stringify({ token, pid: process.pid, timestamp: new Date().toISOString() }))
        await candidate.sync()
        await candidate.close()

        try {
            while (true) {
                try {
                    await link(candidatePath, this.lockPath)
                } catch (error) {
                    if (!isAlreadyExists(error))
                        throw error
                    if (await reclaimStaleLock(this.lockPath))
                        continue
                    if (noWait)
                        throw new OperationRuntimeError("operation.locked", "Another Laneway mutation holds the repository lock.")
                    if (await cancellation.wait(50))
                        throw new OperationCancelledError("Cancellation acknowledged while waiting for the repository lock.")
                    continue
                }

                try {
                    return await work()
                } finally {
                    await releaseLock(this.lockPath, token)
                }
            }
        } finally {
            await unlinkIfPresent(candidatePath)
        }
    }

    async readHistory(): Promise<HistoryProjection> {
        const events = await this.readHistoryEvents()
        const projection: HistoryProjection = { operations: [], position: 0 }
        const executionIds = new Set<string>()
        const operationIds = new Set<string>()

        for (const event of events) {
            if (executionIds.has(event.executionId))
                throw new OperationRuntimeError("operation.history-corrupt", "Operation History contains a duplicate execution.")
            executionIds.add(event.executionId)

            if (event.type == "operation") {
                validateOperationIntegrity(event.operation, "operation.history-corrupt")
                if (operationIds.has(event.operation.id))
                    throw new OperationRuntimeError("operation.history-corrupt", "Operation History contains a duplicate Laneway Operation.")
                operationIds.add(event.operation.id)
                projection.operations.splice(projection.position)
                projection.operations.push(event.operation)
                projection.position += 1
                continue
            }

            const expected = event.action == "undo"
                ? projection.operations[projection.position - 1]
                : projection.operations[projection.position]
            if (expected?.id !== event.operationId)
                throw new OperationRuntimeError("operation.history-corrupt", `Operation History contains an invalid ${event.action} transition.`)
            if (event.operation) {
                validateOperationIntegrity(event.operation, "operation.history-corrupt")
                if (event.operation.id != expected.id)
                    throw new OperationRuntimeError("operation.history-corrupt", "A transition snapshot belongs to another operation.")
                projection.operations[event.action == "undo" ? projection.position - 1 : projection.position] = event.operation
            }
            projection.position += event.action == "undo" ? -1 : 1
        }

        return projection
    }

    async appendHistory(event: HistoryEvent) {
        await appendJsonLine(this.historyPath, event)
        this.historyEvents = undefined
    }

    appendJournal(event: JournalEvent) {
        return appendJsonLine(this.journalPath, event)
    }

    appendJournalPhase(executionId: string, operationId: string, action: JournalEvent["action"], phase: JournalPhase) {
        return this.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId,
            action,
            phase,
            timestamp: new Date().toISOString(),
        })
    }

    async hasHistoryEvent(executionId: string) {
        return (await this.readHistoryEvents()).some(event => event.executionId == executionId)
    }

    async readPendingExecutions(): Promise<JournalExecution[]> {
        const content = await readFile(this.journalPath).catch(error => {
            if (isNotFound(error))
                return Buffer.alloc(0)
            throw error
        })
        const checkpointPath = resolve(this.directory, "journal-checkpoint.json")
        const checkpoint = await readJournalCheckpoint(checkpointPath, content)
        let events: JournalEvent[]
        try {
            events = content.subarray(checkpoint?.length ?? 0).toString().split("\n").filter(Boolean).map(line => JournalEventSchema.parse(JSON.parse(line)))
        } catch {
            throw new OperationRuntimeError("operation.journal-corrupt", "recovery journal is corrupt.")
        }
        const executions = new Map<string, JournalExecution>()
        const finalized = new Set(checkpoint?.executions ?? [])

        for (const event of events) {
            if (event.schemaVersion !== 1 || !event.executionId || !event.operationId || !event.action || !event.phase)
                throw new OperationRuntimeError("operation.journal-corrupt", "The recovery journal contains an invalid record.")
            if (event.phase == "intent") {
                if (!event.operation)
                    throw new OperationRuntimeError("operation.journal-corrupt", "A recovery intent does not contain its Laneway Operation.")
                validateOperationIntegrity(event.operation, "operation.journal-corrupt")
                if (executions.has(event.executionId) || finalized.has(event.executionId))
                    throw new OperationRuntimeError("operation.journal-corrupt", "The recovery journal contains a duplicate intent.")
                executions.set(event.executionId, {
                    intent: event as JournalEvent & { operation: StoredOperation },
                    phases: new Set(["intent"]),
                })
                continue
            }

            const execution = executions.get(event.executionId)
            if (!execution)
                throw new OperationRuntimeError("operation.journal-corrupt", "A recovery phase has no matching intent.")
            if (event.operationId !== execution.intent.operationId || event.action !== execution.intent.action)
                throw new OperationRuntimeError("operation.journal-corrupt", "A recovery phase does not match its intent.")
            if (execution.phases.has("finalized") || execution.phases.has(event.phase))
                throw new OperationRuntimeError("operation.journal-corrupt", "The recovery journal contains an invalid repeated phase.")
            execution.phases.add(event.phase)
            if (event.phase == "worktrees-committed" && event.operation) {
                validateOperationIntegrity(event.operation, "operation.journal-corrupt")
                execution.intent.operation = event.operation
            }
        }

        const pending = [...executions.values()].filter(execution => !execution.phases.has("finalized"))
        if (!pending.length && content.length && content.at(-1) == 10 && content.length != checkpoint?.length) {
            // A disposable verification checkpoint, never a replacement for the journal. Hash every
            // historical byte on each read; any edit forces full validation. Pending work is never cached.
            const data = JSON.stringify({ version: 1, length: content.length, hash: journalDigest(content), executions: [...finalized, ...executions.keys()] })
            const temporary = `${checkpointPath}.${crypto.randomUUID()}.tmp`
            const file = await open(temporary, "wx")
            try {
                await file.writeFile(JSON.stringify({ data, hash: journalDigest(data) }))
            } finally {
                await file.close()
            }
            try {
                await rename(temporary, checkpointPath)
            } finally {
                await unlinkIfPresent(temporary)
            }
        }
        return pending
    }

    private readHistoryEvents() {
        return this.historyEvents ??= readJsonLines(this.historyPath, "Operation History", "operation.history-corrupt", HistoryEventSchema)
    }
}

function journalDigest(content: string | Buffer) {
    return new Bun.CryptoHasher("sha256").update(content).digest("hex")
}

async function readJournalCheckpoint(path: string, content: Buffer): Promise<{ length: number; executions: string[] } | undefined> {
    try {
        const envelope = JSON.parse(await readFile(path, "utf8"))
        if (typeof envelope.data != "string" || journalDigest(envelope.data) != envelope.hash)
            return
        const value = JSON.parse(envelope.data)
        if (
            value.version != 1 || !Number.isSafeInteger(value.length) || value.length <= 0 || value.length > content.length
            || content[value.length - 1] != 10 || !Array.isArray(value.executions) || value.executions.some((id: unknown) => typeof id != "string")
            || journalDigest(content.subarray(0, value.length)) != value.hash
        ) {
            return
        }
        return value
    } catch {
        // Missing, obsolete, truncated or damaged checkpoints are rebuilt from the durable journal.
        return undefined
    }
}

function summarize(operation: StoredOperation): OperationSummary {
    return {
        id: operation.id,
        timestamp: operation.timestamp,
        kind: operation.kind,
        summary: operation.summary,
        affectedRefs: operation.affectedRefs,
        affectedWorktrees: operation.affectedWorktrees,
    }
}

function sealOperation(content: z.input<typeof StoredOperationContentSchema>): StoredOperation {
    const parsed = StoredOperationContentSchema.parse(content)
    return { ...parsed, integrity: operationIntegrity(parsed) }
}

function validateOperationIntegrity(
    operation: StoredOperation,
    code: "operation.history-corrupt" | "operation.journal-corrupt",
) {
    const { integrity, ...content } = operation
    if (integrity !== operationIntegrity(content))
        throw new OperationRuntimeError(code, "A stored Laneway Operation failed its integrity check.")
}

function operationIntegrity(content: z.output<typeof StoredOperationContentSchema>) {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(content)).digest("hex")
}

function availabilityReason(reason: unknown): OperationAvailabilityReason {
    switch (reason) {
        case "ref-changed":
        case "index-changed":
        case "worktree-changed":
        case "git-lockfile-present":
            return reason
        default:
            return "precondition-failed"
    }
}

function historyWindowStart(position: number, total: number) {
    if (position < 5)
        return 0
    if (total - position < 5)
        return Math.max(0, total - 10)
    return position - 5
}

function transitionChanges(operation: StoredOperation, action: "apply" | "undo" | "redo") {
    return action == "undo"
        ? operation.refChanges.map(change => ({ ref: change.ref, before: change.after, after: change.before }))
        : operation.refChanges
}

async function operationStateMatches(repository: RepositoryGit, operation: StoredOperation, action: "apply" | "undo" | "redo", side: "source" | "target") {
    try {
        await validateOperationState(repository, operation, action, side)
        return true
    } catch (error) {
        if (error instanceof OperationRuntimeError && error.code == "operation.precondition-failed")
            return false
        throw error
    }
}

function recoveryBlocked(operation: StoredOperation, action: string, message: string, details?: Record<string, unknown>) {
    return new OperationRuntimeError("operation.recovery-blocked", `Cannot recover ${action} for ${operation.id}: ${message}`, {
        operationId: operation.id,
        action,
        ...details,
    })
}

function crashIfRequested(phase: JournalPhase, requested?: JournalPhase) {
    if (phase == requested)
        process.exit(86)
}

const neverCancelled: CancellationSignal = {
    isCancelled: () => false,
    wait: async delayMs => {
        await Bun.sleep(delayMs)
        return false
    },
}

async function retainOperation(repository: RepositoryGit, operation: StoredOperation, heads = new Map<string, string>()) {
    const objects = operation.refChanges.flatMap(change => [change.before, change.after]).filter((object): object is string => object != null)
    if (operation.lifecycle) {
        objects.push(...await worktreeStateObjects(repository, operation.lifecycle.before, heads))
        if (operation.lifecycle.after)
            objects.push(...await worktreeStateObjects(repository, operation.lifecycle.after, heads))
    }
    await retainRecoveryObjects(repository, operation.id, objects)
}

async function releaseOperation(repository: RepositoryGit, operationId: string) {
    await releaseRecoveryObjects(repository, operationId)
}

async function applyRefChanges(repository: RepositoryGit, changes: RefChange[]) {
    try {
        await repository.updateRefs(changes)
    } catch (error) {
        throw new OperationRuntimeError(
            "operation.precondition-failed",
            "Repository state changed before the Laneway Operation could be applied.",
            error instanceof GitError ? error.details : undefined,
        )
    }
}

async function validatePreconditions(repository: RepositoryGit, operation: StoredOperation, action: "apply" | "undo" | "redo", recaptureWorktrees = true) {
    const gitLockfiles = await findGitLockfiles(operation.gitCommonDirectory)
    if (!sameStrings(gitLockfiles, operation.expectedGitLockfiles))
        throw gitLockfileError(gitLockfiles)

    if (operation.lifecycle && recaptureWorktrees) {
        const expected = action == "undo" ? operation.lifecycle.after : operation.lifecycle.before
        let matches = false
        try {
            matches = Boolean(expected && await worktreeStateMatches(repository, expected))
        } catch (error) {
            throw new OperationRuntimeError("operation.precondition-failed", error instanceof Error ? error.message : String(error), {
                reason: "worktree-changed",
            })
        }
        if (!matches) {
            throw new OperationRuntimeError("operation.precondition-failed", "Worktree files, registration, HEAD, index, or refs changed outside Laneway.", {
                reason: "worktree-changed",
            })
        }
    }

    const expectsAfter = action == "undo"
    for (const change of operation.refChanges) {
        const expected = expectsAfter ? change.after : change.before
        const actual = await repository.resolveRef(change.ref)
        if (actual !== expected) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `Repository ref ${change.ref} changed outside Laneway.`,
                { reason: "ref-changed", ref: change.ref, expected, actual },
            )
        }
    }

    for (const change of operation.worktreeChanges) {
        const expected = expectsAfter ? change.after : change.before
        const actual = await fingerprintWorktree(repository, change.path)
        if (actual.index !== expected.index) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `The index at ${change.path} changed outside Laneway.`,
                { reason: "index-changed", worktree: change.path },
            )
        }
        if (actual.worktree !== expected.worktree) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `The worktree at ${change.path} changed outside Laneway.`,
                { reason: "worktree-changed", worktree: change.path },
            )
        }
    }
}

function validateOperationState(
    repository: RepositoryGit,
    operation: StoredOperation,
    action: "apply" | "undo" | "redo",
    side: "source" | "target",
    recaptureWorktrees = true,
) {
    const stateAction = side == "source" ? action : action == "undo" ? "redo" : "undo"
    return validatePreconditions(repository, operation, stateAction, recaptureWorktrees)
}

async function findGitLockfiles(commonDirectory: string) {
    const lockfiles: string[] = []
    const commonLockfiles = new Set(["config.lock", "gc.log.lock", "HEAD.lock", "index.lock", "packed-refs.lock", "shallow.lock"])

    async function visit(directory: string, relativeDirectory: string, recursive: boolean) {
        let entries
        try {
            entries = await readdir(directory, { withFileTypes: true })
        } catch (error) {
            if (isNotFound(error))
                return
            throw error
        }

        for (const entry of entries) {
            const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
            if (recursive && entry.isDirectory())
                await visit(resolve(directory, entry.name), relativePath, true)
            else if (entry.isFile() && entry.name.endsWith(".lock") && (relativeDirectory || commonLockfiles.has(entry.name)))
                lockfiles.push(relativePath)
        }
    }

    await visit(commonDirectory, "", false)
    for (const subtree of ["refs", "logs", "worktrees"])
        await visit(resolve(commonDirectory, subtree), subtree, true)
    return lockfiles.sort()
}

function sameStrings(left: string[], right: string[]) {
    return left.length == right.length && left.every((value, index) => value == right[index])
}

function gitLockfileError(lockfiles: string[]) {
    return new OperationRuntimeError(
        "operation.precondition-failed",
        `Git lockfiles prevent the Laneway Operation: ${lockfiles.join(", ")}.`,
        { reason: "git-lockfile-present", lockfiles },
    )
}

async function fingerprintWorktree(repository: RepositoryGit, worktree: string): Promise<WorktreeFingerprint> {
    const { diff, index, status, untracked } = await repository.readWorktreeState(worktree)
    const worktreeHasher = new Bun.CryptoHasher("sha256")
    hashPart(worktreeHasher, "status", status)
    hashPart(worktreeHasher, "diff", diff)

    for (const path of untracked) {
        const absolutePath = resolve(worktree, path)
        const metadata = await lstat(absolutePath)
        hashPart(worktreeHasher, "untracked-path", path)
        hashPart(worktreeHasher, "untracked-mode", String(metadata.mode))
        if (metadata.isSymbolicLink())
            hashPart(worktreeHasher, "untracked-link", await readlink(absolutePath))
        else if (metadata.isFile())
            hashPart(worktreeHasher, "untracked-content", await readFile(absolutePath))
        else
            hashPart(worktreeHasher, "untracked-special", metadata.isDirectory() ? "directory" : "special")
    }

    return {
        index: new Bun.CryptoHasher("sha256").update(index).digest("hex"),
        worktree: worktreeHasher.digest("hex"),
    }
}

function hashPart(hasher: Bun.CryptoHasher, label: string, value: string | Uint8Array) {
    const length = typeof value == "string" ? Buffer.byteLength(value) : value.byteLength
    hasher.update(`${label}\0${length}\0`)
    hasher.update(value)
}

async function appendJsonLine(path: string, value: unknown) {
    const handle = await open(path, "a")
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`)
        await handle.sync()
    } finally {
        await handle.close()
    }
}

async function readJsonLines<T>(
    path: string,
    label: string,
    code: "operation.history-corrupt" | "operation.journal-corrupt",
    schema: z.ZodType<T>,
): Promise<T[]> {
    let content: string
    try {
        content = await readFile(path, "utf8")
    } catch (error) {
        if (isNotFound(error))
            return []
        throw error
    }

    try {
        return content.split("\n").filter(Boolean).map(line => schema.parse(JSON.parse(line)))
    } catch {
        throw new OperationRuntimeError(code, `${label} is corrupt.`)
    }
}

async function releaseLock(path: string, token: string) {
    try {
        const lock = JSON.parse(await readFile(path, "utf8")) as { token?: string }
        if (lock.token == token)
            await unlink(path)
    } catch (error) {
        if (!isNotFound(error))
            throw error
    }
}

async function reclaimStaleLock(path: string) {
    try {
        const lock = JSON.parse(await readFile(path, "utf8")) as { pid?: number }
        if (lock.pid && isProcessAlive(lock.pid))
            return false

        const stalePath = `${path}.stale-${crypto.randomUUID()}`
        await rename(path, stalePath)
        await unlink(stalePath)
        return true
    } catch (error) {
        if (isNotFound(error))
            return true
        const stalePath = `${path}.stale-${crypto.randomUUID()}`
        try {
            await rename(path, stalePath)
            await unlink(stalePath)
            return true
        } catch (renameError) {
            return isNotFound(renameError)
        }
    }
}

async function cleanupStaleLockCandidates(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith("mutation.lock.candidate-"))
            continue

        const path = resolve(directory, entry.name)
        try {
            const lock = JSON.parse(await readFile(path, "utf8")) as { pid?: number }
            if (!Number.isInteger(lock.pid) || !lock.pid || lock.pid < 0 || isProcessAlive(lock.pid))
                continue
        } catch {
            // A competing process may have opened this file but not finished
            // writing it. Only reclaim candidates with a known, dead owner.
            continue
        }
        await unlinkIfPresent(path)
    }
}

async function unlinkIfPresent(path: string) {
    try {
        await unlink(path)
    } catch (error) {
        if (!isNotFound(error))
            throw error
    }
}

function isProcessAlive(pid: number) {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code == "EEXIST"
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code == "ENOENT"
}
