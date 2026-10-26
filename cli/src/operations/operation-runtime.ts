import { connectRepository, GitError, type RepositoryGit } from "@laneway/git"
import { pathExists, previewWorktree, readHistoricalEdits, readHistoricalEditSessions, worktreeBasename } from "@laneway/git"
import { normalize, readRegisteredWorktrees } from "@laneway/git"
import { type OperationAvailability, type OperationAvailabilityReason, type OperationHistoryEntry, type OperationHistoryResult, type OperationSummary, type OperationTransitionResult, type RecoveredExecution, type RecoveryResult, type TestMutationResult } from "@laneway/shared"
import { trackingBranchName, type WorktreeRequest, type WorktreeResult } from "@laneway/shared"
import type { LocalRequest, LocalResult } from "@laneway/shared"
import type { ConflictRequest, ConflictResult } from "@laneway/shared"
import type { BranchGraphReadOptions, PublishRequest, PublishResult, PullRequest, PullResult } from "@laneway/shared"
import type { RecoveryRequest, RecoveryStatusResult, WorktreeRecovery } from "@laneway/shared"
import type { HistoricalEditRequest, HistoricalEditResult } from "@laneway/shared"
import type { GitResult } from "@laneway/shared"
import { lstat, readdir, readFile, readlink, rename, rm } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { isFileExtraction } from "../composition/file-extraction"
import { conflictMutation, conflictPaths, executeConflict, suspendWorkingConflicts } from "../conflicts/conflict-operations"
import { mutateHistoricalEdit, prepareHistoricalEdit } from "../historical-edit/historical-edit"
import { LocalPreconditionError, mutateLocal, prepareLocal } from "../local-mutations"
import { executePublish, type PublishProgressReporter } from "../publish"
import { executePull, preparePull, type PullPreparation, type PullProgressReporter } from "../pull-latest"
import { recoveryBackupPath } from "../worktrees/worktree-directory"
import { mutateWorktree } from "../worktrees/worktree-mutations"
import { captureRegistration, recreateRegistration, registrationObjects } from "../worktrees/worktree-registration"
import { restoreWorktreeState, worktreeStateMatches, worktreeStateObjects } from "../worktrees/worktree-state"
import { applyChanges, changeObjects, expectedRefs, invertChanges, refMoved, relocateChanges } from "./apply-changes"
import { ChangeRecorder } from "./change-recorder"
import { captureGitCheckpoint, checkpointIdentity, checkpointMatches, restoreGitCheckpoint, retainCheckpoint } from "./git-checkpoint"
import { executeNativeGit, replayNativeUndo, validateNativeUndo } from "./native-undo"
import { type CancellationSignal, OperationCancelledError, OperationRuntimeError } from "./operation-contracts"
import { type Change, type JournalExecution, type JournalPhase, type RefChange, type Registration, sealOperation, type Snapshot, type StoredOperation, type WorktreeFingerprint } from "./operation-record"
import { OperationStore } from "./operation-store"
import { migrateRecoveryRefs, releaseRecoveryObjects, retainRecoveryObjects } from "./recovery-objects"
import { captureSnapshot, diffSnapshots, fixtureRef, readRecordedRefs } from "./repository-snapshot"

export { type CancellationSignal, OperationCancelledError, OperationRuntimeError } from "./operation-contracts"
export { crashPhases, type JournalPhase } from "./operation-record"

type Action = "apply" | "undo" | "redo"

export type OperationCommand =
    | { command: "git"; args: string[]; cwd: string; json: boolean; noWait: boolean }
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
        command: "publish"
        request: PublishRequest
        noWait: boolean
        graphOptions: (repositoryId: string) => BranchGraphReadOptions
        progress?: PublishProgressReporter
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
    | { command: "edit"; request: HistoricalEditRequest; noWait: boolean; crashAfter?: JournalPhase }
    | { command: "test-mutation"; value: string; noWait: boolean; crashAfter?: JournalPhase; holdAfterIntentMs?: number }
    | { command: "undo"; noWait: boolean; crashAfter?: JournalPhase; worktreeBasename?: string }
    | { command: "redo"; noWait: boolean; crashAfter?: JournalPhase }
    | { command: "history"; noWait: boolean }
    | { command: "recovery-status"; noWait: boolean }
    | { command: "recover"; noWait: boolean; request?: RecoveryRequest; crashAfter?: JournalPhase }

export type OperationCommandResult =
    | GitResult
    | TestMutationResult
    | OperationTransitionResult
    | OperationHistoryResult
    | RecoveryResult
    | RecoveryStatusResult
    | WorktreeResult
    | LocalResult
    | ConflictResult
    | PullResult
    | PublishResult
    | HistoricalEditResult

interface RecordOptions {
    crashAfter?: JournalPhase
    /** An unrecorded mutation is still journaled, so an interruption reverses it, but never enters Operation History. */
    recorded?: boolean
    removing?: Registration
    holdAfterIntentMs?: number
}

class OperationRuntime {
    constructor(
        private readonly repository: RepositoryGit,
        private readonly store: OperationStore,
        private readonly cancellation: CancellationSignal,
    ) {}

    async conflict(request: ConflictRequest, crashAfter?: JournalPhase): Promise<ConflictResult> {
        if (!conflictMutation(request))
            return executeConflict(this.repository, request, new ChangeRecorder(this.repository), () => this.cancellation.isCancelled())

        let result: ConflictResult | undefined
        await this.record(
            await conflictPaths(this.repository),
            `conflict.${request.action}`,
            request.action == "rewrite" ? "Rewrite stack" : request.action == "accept" ? "Accept conflict resolution" : request.action.replaceAll("-", " "),
            async recorder => {
                result = await executeConflict(this.repository, request, recorder, () => this.cancellation.isCancelled())
            },
            { crashAfter },
        )

        return result!
    }

    async pull(prepared: Extract<PullPreparation, { kind: "prepared" }>, progress: PullProgressReporter, crashAfter?: JournalPhase): Promise<PullResult> {
        let stacks: PullResult["stacks"] = []

        let operation = await this.record(await conflictPaths(this.repository), "pull.latest", "Pull latest", async recorder => {
            stacks = await executePull(this.repository, prepared, recorder, () => this.cancellation.isCancelled(), progress)
        }, { crashAfter })

        let projection = await this.store.readHistory()
        let recorded = projection.operations[projection.position - 1]?.id == operation.id
        let cancelled = stacks.some(stack => stack.status == "cancelled")
        let counts = new Map<string, number>()
        for (let stack of stacks)
            counts.set(stack.status, (counts.get(stack.status) ?? 0) + 1)

        let labels: Record<string, string> = {
            updated: "updated",
            current: "already current",
            "needs-resolution": "need resolution",
            skipped: "skipped",
            failed: "failed",
            cancelled: "not started",
        }

        let summary = [...counts].map(([status, count]) => `${count} ${labels[status]}`).join(", ")

        return {
            type: "result",
            command: "pull",
            status: cancelled ? "cancelled" : "updated",
            message: cancelled ? `Pull cancelled: ${summary}. Completed updates were kept.` : `Pull complete: ${summary}.`,
            fetches: prepared.fetches,
            stacks,
            ...(recorded ? { operation: summarize(operation) } : {}),
        }
    }

    async applyLocal(request: LocalRequest, token?: string, crashAfter?: JournalPhase, prefix = "worktree/"): Promise<LocalResult> {
        let { preview } = await prepareLocal(this.repository, request, prefix, token)
        if (!token || token != preview.token)
            throw new OperationRuntimeError("operation.precondition-failed", "Repository content changed. Refresh and review the operation again.")
        return this.applyPreparedLocal(request, preview, crashAfter)
    }

    async transfer(request: LocalRequest, crashAfter?: JournalPhase, prefix = "worktree/"): Promise<LocalResult> {
        if (request.action != "compose" && request.action != "reword")
            throw new OperationRuntimeError("operation.precondition-failed", "Choose a change transfer.")
        // A reword applies in the same invocation unless its preview reports a decision for the user; a separate
        // apply would launch the engine and prepare again for nothing.
        let prepared = await prepareLocal(this.repository, request, prefix)
        let composition = prepared.preview.composition
        let immediate = request.action == "reword"
            ? !composition?.published.length && !composition?.removed.length && !composition?.conflicts.length
            : isFileExtraction(prepared.preview)
        if (immediate)
            return this.applyPreparedLocal(request, prepared.preview, crashAfter)

        return { type: "result", command: "local-preview", status: "preview", preview: prepared.preview }
    }

    private async applyPreparedLocal(
        request: LocalRequest,
        preview: Awaited<ReturnType<typeof prepareLocal>>["preview"],
        crashAfter: JournalPhase | undefined,
    ): Promise<LocalResult> {
        let result: LocalResult = { type: "result", command: "local", status: "performed" }

        await this.record(
            preview.affected,
            `local.${request.action}`,
            request.action.replaceAll("-", " "),
            async recorder => {
                try {
                    result = await mutateLocal(this.repository, request, preview, recorder, () => this.cancellation.isCancelled())
                } catch (error) {
                    if (error instanceof LocalPreconditionError)
                        throw error
                    // Hook/filter failures may leave intentional edits. Retain the resulting state as an
                    // undoable operation instead of overwriting edits or leaving an unexplained journal.
                    result = { type: "result", command: "local", status: "failed", message: error instanceof Error ? error.message : String(error) }
                }
            },
            { crashAfter },
        )

        return result
    }

    async historicalEdit(request: HistoricalEditRequest, crashAfter?: JournalPhase): Promise<HistoricalEditResult> {
        if (request.action == "status")
            return { type: "result", command: "edit", message: "", sessions: await readHistoricalEdits(this.repository) }

        let plan = await prepareHistoricalEdit(this.repository, request)
        let message = ""
        let operation = await this.record(
            [plan.worktree.path],
            `edit.${request.action == "return" ? request.mode : request.action}`,
            plan.summary,
            async recorder => {
                message = await mutateHistoricalEdit(this.repository, plan, recorder)
            },
            { crashAfter, recorded: plan.recorded },
        )

        return {
            type: "result",
            command: "edit",
            message,
            sessions: await readHistoricalEdits(this.repository),
            ...(plan.recorded ? { operation: summarize(operation) } : {}),
        }
    }

    async applyWorktree(request: WorktreeRequest, token?: string, crashAfter?: JournalPhase, branchPrefix = "worktree/"): Promise<WorktreeResult> {
        await this.repository.command(this.repository.descriptor.mainWorktree, ["check-ref-format", "--branch", `${branchPrefix}worktree`])
        let preview = await previewWorktree(this.repository, request)
        request = preview.request
        if (request.action == "switch" || request.action == "remove") {
            let path = request.path
            let editing = preview.worktrees.find(w => !w.missing && normalize(w.path) == normalize(path))
            // A missing worktree's session cannot continue, so its removal leaves only an inert session ref behind.
            if (editing && (await readHistoricalEditSessions(this.repository)).some(stored => stored.session.worktreeId == editing.id))
                throw new OperationRuntimeError("operation.precondition-failed", "Return from the Historical Edit in this worktree first.")
        }
        if (token && token != preview.token)
            throw new OperationRuntimeError("operation.precondition-failed", "Worktree state changed after preview. Review it again.")
        let tracking = preview.tracking
        if ((request.action == "create" || request.action == "switch") && tracking?.taken && !request.local) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `A local branch named ${tracking.name} already exists. Choose whether to reset it or create ${tracking.alternative}.`,
            )
        }
        let branch = request.action == "create" || request.action == "switch"
            ? tracking ? trackingBranchName(tracking, request.local) : request.branch?.replace(/^refs\/heads\//, "")
            : undefined
        if (
            (request.action == "create" || request.action == "switch") && !request.move
            && preview.worktrees.some(item => item.branchRef == `refs/heads/${branch}` && !("path" in request && item.path == request.path))
        ) {
            throw new OperationRuntimeError("operation.precondition-failed", "Confirm moving the branch from its current worktree first.")
        }

        // A removal retains the worktree's Working Changes before anything happens, so an interruption at any point
        // leaves them recoverable from its Workspace Column.
        let removing: Registration | undefined
        if (request.action == "remove") {
            let removed = preview.worktrees.find(w => normalize(w.path) == normalize(request.path))
            if (removed?.main)
                throw new OperationRuntimeError("operation.precondition-failed", "The Main Worktree cannot be removed.")
            if (removed)
                removing = await captureRegistration(this.repository, removed, true)
        }

        let operation = await this.record(
            preview.affected,
            `worktree.${request.action}`,
            `${request.action[0]!.toUpperCase()}${request.action.slice(1)} worktree ${preview.destination ?? ("path" in request ? request.path : "")}`,
            async (recorder, operationId) => {
                await mutateWorktree(this.repository, preview, operationId, branchPrefix, recorder)
                await suspendWorkingConflicts(this.repository, recorder)
            },
            { crashAfter, removing },
        )

        return { type: "result", command: "worktree", operation: summarize(operation) }
    }

    async applyTestMutation(value: string, crashAfter?: JournalPhase, holdAfterIntentMs?: number): Promise<TestMutationResult> {
        let after = await this.repository.hashObject(value)
        let operation = await this.record(
            [this.repository.descriptor.selectedWorktree],
            "test.ref-update",
            `Set the test fixture to ${value}`,
            async () => {
                await this.repository.updateRefs([{ ref: fixtureRef, before: await this.repository.resolveRef(fixtureRef), after }])
            },
            { crashAfter, holdAfterIntentMs },
        )

        return { type: "result", command: "test-mutation", operation: summarize(operation) }
    }

    /**
     * Runs a mutation and records what it changed: journals the repository as found, mutates, compares, retains the
     * objects the record names, journals the record, and enters it in Operation History. A mutation that changed
     * nothing leaves no entry; one that fails is reversed from its record at once.
     */
    private async record(
        affected: string[],
        kind: string,
        summary: string,
        mutate: (recorder: ChangeRecorder, operationId: string) => Promise<void>,
        { crashAfter, recorded = true, removing, holdAfterIntentMs }: RecordOptions = {},
    ): Promise<StoredOperation> {
        let locks = await findGitLockfiles(this.repository.descriptor.commonDirectory)
        if (locks.length)
            throw gitLockfileError(locks)

        let before = await captureSnapshot(this.repository)
        let projection = await this.store.readHistory()
        let abandoned = projection.operations.slice(projection.position)
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
            changes: [],
            removing,
            ...(recorded ? {} : { transient: true }),
        })

        let executionId = crypto.randomUUID()
        if (removing)
            await retainRecoveryObjects(this.repository, operation.id, registrationObjects(removing))
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action: "apply",
            phase: "intent",
            timestamp: new Date().toISOString(),
            operation,
            snapshot: before,
            abandonedOperationIds: abandoned.map(item => item.id),
        })
        crashIfRequested("intent", crashAfter)
        await this.cancelIfRequested(executionId, operation, "apply", holdAfterIntentMs)

        let recorder = new ChangeRecorder(this.repository)
        if (removing)
            recorder.removing.set(removing.id, removing)
        try {
            await mutate(recorder, operation.id)
        } catch (error) {
            // A failure is unwound here rather than left as a pending execution, which would block every
            // later operation in the repository until recovery. Only a failed reversal stays pending.
            let outcome = await this.reverse(before, recorder, operation, "apply")
            if (outcome != "pending")
                await this.abortBeforeCommit(executionId, operation, "apply")
            if (outcome == "restored")
                throw new Error(`${error instanceof Error ? error.message : String(error)} Laneway restored the Git state from before the operation.`)
            throw error
        }

        let changes = await this.changesSince(before, recorder)
        if (!changes.length) {
            await this.abortBeforeCommit(executionId, operation, "apply")
            return operation
        }
        operation = sealOperation({ ...operation, affectedRefs: changedRefs(changes), changes })
        await retainRecoveryObjects(this.repository, operation.id, changeObjects(changes))
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action: "apply",
            phase: "recorded",
            timestamp: new Date().toISOString(),
            operation,
        })
        crashIfRequested("recorded", crashAfter)

        if (!recorded) {
            await this.store.appendJournalPhase(executionId, operation.id, "apply", "finalized")
            await releaseOperation(this.repository, operation.id)
            return operation
        }

        await this.commitHistory(executionId, operation, "apply")
        crashIfRequested("history-committed", crashAfter)

        for (let old of abandoned)
            await releaseOperation(this.repository, old.id)

        await this.store.appendJournalPhase(executionId, operation.id, "apply", "finalized")
        crashIfRequested("finalized", crashAfter)
        return operation
    }

    /** Undoes or redoes a recorded operation by applying its changes in the chosen direction, and records what that did. */
    private async transition(operation: StoredOperation, action: "undo" | "redo", crashAfter?: JournalPhase, basename?: string) {
        let locks = await findGitLockfiles(this.repository.descriptor.commonDirectory)
        if (locks.length)
            throw gitLockfileError(locks)

        let changes = operation.changes!
        if (basename) {
            let removal = action == "undo" && operation.kind == "worktree.remove"
                ? changes.find((change): change is Extract<Change, { type: "worktree" }> =>
                    change.type == "worktree" && Boolean(change.before) && !change.after
                )
                : undefined
            if (!removal)
                throw new OperationRuntimeError("operation.precondition-failed", "An alternate basename is only available when undoing worktree removal.")
            let destination = join(dirname(removal.before!.path), worktreeBasename(basename))
            if (await pathExists(destination))
                throw new OperationRuntimeError("operation.precondition-failed", "The alternate worktree path is occupied.")
            changes = relocateChanges(changes, removal.before!.path, destination)
            operation = sealOperation({
                ...operation,
                affectedWorktrees: operation.affectedWorktrees.map(path => normalize(path) == normalize(removal.before!.path) ? destination : path),
                changes,
            })
        }

        let applying = action == "undo" ? invertChanges(changes) : changes
        await this.verifyRefs(applying, action)

        let before = await captureSnapshot(this.repository)
        let executionId = crypto.randomUUID()
        // Both sides stay retained: the one being left becomes unreachable, and the other is what the next reversal restores.
        await retainRecoveryObjects(this.repository, operation.id, changeObjects(changes))
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action,
            phase: "intent",
            timestamp: new Date().toISOString(),
            operation,
            snapshot: before,
        })
        crashIfRequested("intent", crashAfter)
        await this.cancelIfRequested(executionId, operation, action)

        let recorder = new ChangeRecorder(this.repository)
        try {
            await applyChanges(this.repository, applying, recorder, { operationId: operation.id, action })
        } catch (error) {
            let outcome = await this.reverse(before, recorder, operation, action)
            if (outcome != "pending")
                await this.abortBeforeCommit(executionId, operation, action)
            if (outcome == "restored")
                throw new Error(`${error instanceof Error ? error.message : String(error)} Laneway restored the Git state from before the ${action}.`)
            throw error
        }

        let done = await this.changesSince(before, recorder)
        let forward = action == "undo" ? invertChanges(done) : done
        let updated = sealOperation({ ...operation, affectedRefs: changedRefs(forward), changes: forward })
        await retainRecoveryObjects(this.repository, operation.id, changeObjects(forward))
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action,
            phase: "recorded",
            timestamp: new Date().toISOString(),
            operation: updated,
        })
        crashIfRequested("recorded", crashAfter)

        await this.commitHistory(executionId, updated, action)
        crashIfRequested("history-committed", crashAfter)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        crashIfRequested("finalized", crashAfter)
    }

    private async changesSince(before: Snapshot, recorder: ChangeRecorder) {
        let after = await captureSnapshot(this.repository)
        return [...await diffSnapshots(this.repository, before, after, recorder.removing), ...recorder.trees]
    }

    /** Reverses what a mutation or transition did before it failed. */
    private async reverse(before: Snapshot, recorder: ChangeRecorder, operation: StoredOperation, action: Action) {
        try {
            let changes = await this.changesSince(before, recorder)
            if (!changes.length)
                return "unchanged"
            await applyChanges(this.repository, invertChanges(changes), new ChangeRecorder(this.repository), { operationId: operation.id, action })
            return "restored"
        } catch {
            return "pending"
        }
    }

    private async verifyRefs(applying: Change[], action: Action) {
        let expected = expectedRefs(applying)
        if (!expected.length)
            return
        let refs = await readRecordedRefs(this.repository)
        for (let { ref, expected: value } of expected) {
            if ((refs[ref] ?? null) != value)
                throw refMoved(ref, action, value, refs[ref] ?? null)
        }
    }

    private async restoreCheckpoint(operation: StoredOperation, action: "undo" | "redo", crashAfter?: JournalPhase) {
        await validatePreconditions(this.repository, operation, action)
        let target = operation.checkpoint!.restore
        let departing = await captureGitCheckpoint(this.repository, operation.affectedWorktrees, operation.checkpoint!.expected)
        await retainCheckpoint(this.repository, operation.id, target, departing)

        let executionId = crypto.randomUUID()
        let pending = sealOperation({ ...operation, checkpoint: { restore: departing, expected: departing } })
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action,
            phase: "intent",
            timestamp: new Date().toISOString(),
            operation: pending,
        })
        crashIfRequested("intent", crashAfter)
        await this.cancelIfRequested(executionId, pending, action)
        await restoreGitCheckpoint(this.repository, departing, target, operation.checkpoint!.expected)
        let expected = await captureGitCheckpoint(this.repository, target.worktrees.map(w => w.path), target, undefined, undefined, false)
        let updated = sealOperation({ ...operation, checkpoint: { restore: departing, expected } })
        await this.store.appendJournal({
            schemaVersion: 1,
            executionId,
            operationId: operation.id,
            action,
            phase: "worktrees-committed",
            timestamp: new Date().toISOString(),
            operation: sealOperation({ ...pending, checkpoint: { restore: departing, expected } }),
        })
        crashIfRequested("recorded", crashAfter)

        await this.commitHistory(executionId, updated, action)
        crashIfRequested("history-committed", crashAfter)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
    }

    async undo(crashAfter?: JournalPhase, basename?: string): Promise<OperationTransitionResult> {
        let projection = await this.store.readHistory()
        if (projection.position == 0)
            return { type: "result", command: "undo", status: "unavailable", reason: "empty" }

        let operation = projection.operations[projection.position - 1]
        if (!operation)
            throw new OperationRuntimeError("operation.history-corrupt", "Operation History has an invalid undo position.")

        if (operation.nativeUndo)
            await replayNativeUndo(this.repository, this.store, operation, "undo")
        else if (operation.changes)
            await this.transition(operation, "undo", crashAfter, basename)
        else if (basename)
            throw new OperationRuntimeError("operation.precondition-failed", "An alternate basename is only available when undoing worktree removal.")
        else if (operation.checkpoint)
            await this.restoreCheckpoint(operation, "undo", crashAfter)
        else
            await this.applyOperation(operation, "undo", [], crashAfter)

        return { type: "result", command: "undo", status: "performed", operation: summarize(operation) }
    }

    async redo(crashAfter?: JournalPhase): Promise<OperationTransitionResult> {
        let projection = await this.store.readHistory()
        if (projection.position == projection.operations.length)
            return { type: "result", command: "redo", status: "unavailable", reason: "empty" }

        let operation = projection.operations[projection.position]
        if (!operation)
            throw new OperationRuntimeError("operation.history-corrupt", "Operation History has an invalid redo position.")

        if (operation.nativeUndo)
            await replayNativeUndo(this.repository, this.store, operation, "redo")
        else if (operation.changes)
            await this.transition(operation, "redo", crashAfter)
        else if (operation.checkpoint)
            await this.restoreCheckpoint(operation, "redo", crashAfter)
        else
            await this.applyOperation(operation, "redo", [], crashAfter)

        return { type: "result", command: "redo", status: "performed", operation: summarize(operation) }
    }

    async history(): Promise<OperationHistoryResult> {
        let projection = await this.store.readHistory()
        let start = historyWindowStart(projection.position, projection.operations.length)
        let entries = projection.operations.slice(start, start + 10).map((operation, offset) => {
            let index = start + offset
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
            if (operation.changes) {
                let lockfiles = await findGitLockfiles(this.repository.descriptor.commonDirectory)
                if (lockfiles.length)
                    throw gitLockfileError(lockfiles)
                await this.verifyRefs(action == "undo" ? invertChanges(operation.changes) : operation.changes, action)
            } else {
                await validatePreconditions(this.repository, operation, action)
            }
            return { available: true, operationId: operation.id }
        } catch (error) {
            if (error instanceof OperationRuntimeError && error.code == "operation.precondition-failed")
                return { available: false, operationId: operation.id, reason: availabilityReason(error.details?.reason) }
            throw error
        }
    }

    async recoveryStatus(): Promise<RecoveryStatusResult> {
        let pending = await this.store.readPendingExecutions()
        let worktrees: WorktreeRecovery[] = []
        let registered = await readRegisteredWorktrees(this.repository)
        for (let execution of pending) {
            let operation = execution.intent.operation
            if (!await this.isInterruptedRemoval(execution))
                continue
            let worktree = operation.removing!
            let occupied = await pathExists(worktree.path) && !registered.some(w => normalize(w.path) == normalize(worktree.path))
            let backupPath = recoveryBackupPath(worktree.path, operation.id)
            worktrees.push({
                operationId: operation.id,
                worktreeId: worktree.id,
                path: worktree.path,
                head: worktree.head,
                branchRef: worktree.branchRef,
                message: occupied
                    ? "Files remain in the worktree directory after its Git registration was removed."
                    : "Removal stopped before it was recorded.",
                backupPath: await pathExists(backupPath) ? backupPath : undefined,
            })
        }

        return { type: "result", command: "recovery-status", worktrees }
    }

    /** A removal that stopped after retaining its worktree and before recording what it did waits for the user's choice. */
    private async isInterruptedRemoval(execution: JournalExecution) {
        let { action, operation, executionId } = execution.intent
        return action == "apply" && operation.kind == "worktree.remove" && Boolean(operation.removing)
            && !execution.phases.has("aborted") && !execution.phases.has("cancelled") && !execution.phases.has("recorded")
            && !await this.store.hasHistoryEvent(executionId)
    }

    async resolveWorktreeRecovery(request: RecoveryRequest, crashAfter?: JournalPhase): Promise<RecoveryResult> {
        let pending = await this.store.readPendingExecutions()
        let execution = pending.find(item => item.intent.operationId == request.operationId)
        if (!execution)
            return { type: "result", command: "recover", status: "clean", recovered: [] }
        let { operation, executionId, action } = execution.intent
        if (action != "apply" || operation.kind != "worktree.remove" || !operation.removing)
            throw new OperationRuntimeError("operation.precondition-failed", "Choose an interrupted worktree removal.")
        if (!await this.isInterruptedRemoval(execution)) {
            let completed = await this.resumeExecution(execution)
            return {
                type: "result",
                command: "recover",
                status: completed ? "recovered" : "clean",
                recovered: completed ? [{ action, operation: summarize(operation) }] : [],
            }
        }

        let worktree = operation.removing
        if (normalize(worktree.path) == normalize(this.repository.descriptor.mainWorktree))
            throw new OperationRuntimeError("operation.precondition-failed", "The Main Worktree cannot be removed or replaced.")
        let locks = await findGitLockfiles(this.repository.descriptor.commonDirectory)
        if (locks.length)
            throw gitLockfileError(locks)

        let registrations = await readRegisteredWorktrees(this.repository)
        let registered = registrations.find(w => normalize(w.path) == normalize(worktree.path))
        if (registered && registered.id != worktree.id)
            throw new OperationRuntimeError("operation.precondition-failed", "Another worktree now occupies this path. Its files were left intact.")
        if (registered?.locked)
            throw new OperationRuntimeError("operation.precondition-failed", "Unlock the worktree before resolving its removal.")

        let tip = worktree.branchRef ? await this.repository.resolveRef(worktree.branchRef) : null
        let changedBranch = Boolean(tip && tip != worktree.head)
        let otherHolder = Boolean(
            worktree.branchRef && registrations.some(w => w.branchRef == worktree.branchRef && normalize(w.path) != normalize(worktree.path)),
        )
        if (request.action == "restore" && changedBranch) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                "The saved branch has changed. Choose Remove to finish removal, or resolve the branch before recovering.",
            )
        }
        if (request.action == "restore" && otherHolder) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                "The saved branch is checked out in another worktree. Switch that worktree away before recovering.",
            )
        }

        let backupPath = recoveryBackupPath(worktree.path, operation.id)
        if (request.action == "remove") {
            if (registrations.some(w => normalize(w.path) == normalize(backupPath) || normalize(w.path).startsWith(`${normalize(backupPath)}${sep}`)))
                throw new OperationRuntimeError("operation.precondition-failed", "Another worktree occupies the recovery backup. Its files were left intact.")
            let before = await captureSnapshot(this.repository)
            let recorder = new ChangeRecorder(this.repository)
            recorder.removing.set(worktree.id, worktree)
            // A worktree restored by an interrupted Recover was registered again under a new id.
            if (registered)
                recorder.removing.set(registered.id, { ...worktree, id: registered.id })
            // An earlier interrupted recovery may have left its backup where removal moves the directory.
            await rm(resolve(backupPath), { recursive: true, force: true })
            if (registered) {
                let preview = await previewWorktree(this.repository, { action: "remove", path: worktree.path, preserve: true })
                await mutateWorktree(this.repository, preview, operation.id, "worktree/", recorder)
            }
            await rm(resolve(worktree.path), { recursive: true, force: true })
            await rm(resolve(backupPath), { recursive: true, force: true })
            this.repository.forgetReads()

            let changes = await this.changesSince(before, recorder)
            if (!changes.some(change => change.type == "worktree"))
                changes.push({ type: "worktree", id: worktree.id, before: worktree, after: null })
            let completed = sealOperation({ ...operation, affectedRefs: changedRefs(changes), changes })
            await retainRecoveryObjects(this.repository, operation.id, changeObjects(changes))
            await this.store.appendJournal({
                schemaVersion: 1,
                executionId,
                operationId: operation.id,
                action,
                phase: "recorded",
                timestamp: new Date().toISOString(),
                operation: completed,
            })
            crashIfRequested("recorded", crashAfter)
            await this.commitHistory(executionId, completed, action)
            crashIfRequested("history-committed", crashAfter)
            for (let id of execution.intent.abandonedOperationIds ?? [])
                await releaseOperation(this.repository, id)
            await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        } else {
            if (!registered || registered.missing) {
                if (await pathExists(worktree.path)) {
                    if (await pathExists(backupPath)) {
                        throw new OperationRuntimeError(
                            "operation.precondition-failed",
                            `A recovery backup already exists at ${backupPath}. Move the remaining directory aside before retrying.`,
                        )
                    }
                    await rename(worktree.path, backupPath)
                }
                if (registered)
                    await this.repository.command(this.repository.descriptor.mainWorktree, ["worktree", "remove", "--force", "--", worktree.path])
                // The worktree directory was moved aside directly.
                this.repository.forgetReads()
                await recreateRegistration(this.repository, worktree)
            }
            crashIfRequested("recorded", crashAfter)
            await this.store.appendJournalPhase(executionId, operation.id, action, "aborted")
            await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
            await releaseOperation(this.repository, operation.id)
        }

        return {
            type: "result",
            command: "recover",
            status: "recovered",
            recovered: [{ action, operation: summarize(operation) }],
            backupPath: await pathExists(backupPath) ? backupPath : undefined,
        }
    }

    async recover(automatic = false): Promise<RecoveryResult> {
        await migrateRecoveryRefs(this.repository)
        let pending = await this.store.readPendingExecutions()
        let recovered: RecoveredExecution[] = []

        for (let execution of pending) {
            let operation = execution.intent.operation
            if (automatic && await this.isInterruptedRemoval(execution)) {
                // A removal that stopped before touching its registration and directory has nothing to recover.
                let registered = (await readRegisteredWorktrees(this.repository)).find(w => w.id == operation.removing!.id)
                if (!registered || registered.missing)
                    throw recoveryBlocked(operation, "apply", "Worktree removal was interrupted. Recover or remove it from its Workspace Column.")
            }
            if (
                automatic && execution.intent.action == "apply" && operation.kind == "worktree.remove" && operation.checkpoint
                && !execution.phases.has("aborted") && !execution.phases.has("cancelled") && !await this.store.hasHistoryEvent(execution.intent.executionId)
                && !await checkpointMatches(this.repository, operation.checkpoint.restore)
            ) {
                throw recoveryBlocked(operation, "apply", "Worktree removal was interrupted. Recover or remove it from its Workspace Column.")
            }
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
        action: Action,
        abandoned: StoredOperation[],
        crashAfter?: JournalPhase,
    ) {
        let executionId = crypto.randomUUID()
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
        await this.cancelIfRequested(executionId, operation, action)
        await retainOperation(this.repository, operation)
        await this.store.appendJournalPhase(executionId, operation.id, action, "recovery-retained")
        await this.cancelIfRequested(executionId, operation, action)

        try {
            await validatePreconditions(this.repository, operation, action)
        } catch (error) {
            await this.abortBeforeCommit(executionId, operation, action)
            throw error
        }
        await this.store.appendJournalPhase(executionId, operation.id, action, "preconditions-verified")
        await this.cancelIfRequested(executionId, operation, action)

        try {
            if (operation.lifecycle) {
                let { before, after } = operation.lifecycle
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
        crashIfRequested("recorded", crashAfter)

        await this.commitHistory(executionId, operation, action)
        await this.store.appendJournalPhase(executionId, operation.id, action, "history-committed")
        crashIfRequested("history-committed", crashAfter)

        for (let abandonedOperation of abandoned)
            await releaseOperation(this.repository, abandonedOperation.id)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        crashIfRequested("finalized", crashAfter)
    }

    private async cancelIfRequested(executionId: string, operation: StoredOperation, action: Action, waitMs = 0) {
        let cancelled = waitMs > 0 ? await this.cancellation.wait(waitMs) : this.cancellation.isCancelled()
        if (!cancelled)
            return

        await this.store.appendJournalPhase(executionId, operation.id, action, "cancelled")
        if (action == "apply")
            await releaseOperation(this.repository, operation.id)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        throw new OperationCancelledError("Cancellation acknowledged at a verified journal boundary.")
    }

    private async abortBeforeCommit(executionId: string, operation: StoredOperation, action: Action) {
        await this.store.appendJournalPhase(executionId, operation.id, action, "aborted")
        if (action == "apply")
            await releaseOperation(this.repository, operation.id)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
    }

    private async resumeExecution(execution: JournalExecution) {
        let { action, executionId, operation, operationId } = execution.intent
        if (operation.changes)
            return this.resumeRecorded(execution)
        if (operation.checkpoint) {
            let committed = await this.store.hasHistoryEvent(executionId)
            if (!committed && !execution.phases.has("aborted") && !execution.phases.has("cancelled")) {
                let { restore: target, expected } = operation.checkpoint
                // Once the mutation finished, anything beyond the state it recorded is later work, which rolling back would undo.
                // An interruption during the mutation has no such boundary, so it still rolls back whatever it finds.
                let changedSince = false
                try {
                    let current = await captureGitCheckpoint(this.repository, operation.affectedWorktrees, target)
                    await retainCheckpoint(this.repository, operation.id, target, current)
                    let identity = checkpointIdentity(current)
                    changedSince = execution.phases.has("worktrees-committed") && identity != checkpointIdentity(target)
                        && identity != checkpointIdentity(expected)
                    if (!changedSince && identity != checkpointIdentity(target))
                        await restoreGitCheckpoint(this.repository, current, target)
                } catch (error) {
                    throw recoveryBlocked(operation, action, "Git could not restore the starting checkpoint. It remains retained for manual recovery.", {
                        reason: error instanceof Error ? error.message : String(error),
                    })
                }
                if (changedSince) {
                    throw recoveryBlocked(
                        operation,
                        action,
                        "The repository changed after this operation was interrupted, so recovery left it as it is. The starting state remains retained for manual recovery.",
                    )
                }
            }
            if (action == "apply" && !committed)
                await releaseOperation(this.repository, operation.id)
            if (committed) {
                for (let id of execution.intent.abandonedOperationIds ?? [])
                    await releaseOperation(this.repository, id)
            }
            await this.store.appendJournalPhase(executionId, operationId, action, "finalized")
            return true
        }
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

        let historyCommitted = await this.store.hasHistoryEvent(executionId)
        let refsCommitted = execution.phases.has("refs-committed") || historyCommitted
        let targetMatches = await operationStateMatches(this.repository, operation, action, "target")

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

        for (let abandonedOperationId of execution.intent.abandonedOperationIds ?? [])
            await releaseOperation(this.repository, abandonedOperationId)
        await this.store.appendJournalPhase(executionId, operationId, action, "finalized")
        return true
    }

    /**
     * Completes an execution that wrote its record, and reverses one that did not: the refs, HEADs, registrations,
     * configuration and metadata that differ from the journaled starting snapshot move back, while files and stashes
     * stay as the interrupted work left them for the user to look at.
     */
    private async resumeRecorded(execution: JournalExecution) {
        let { action, executionId, operation, operationId } = execution.intent
        if (execution.phases.has("cancelled") || execution.phases.has("aborted")) {
            if (action == "apply")
                await releaseOperation(this.repository, operation.id)
            await this.store.appendJournalPhase(executionId, operationId, action, "finalized")
            return false
        }

        let committed = await this.store.hasHistoryEvent(executionId)
        if (execution.phases.has("recorded") || committed) {
            if (!committed && !operation.transient)
                await this.commitHistory(executionId, operation, action)
            if (operation.transient)
                await releaseOperation(this.repository, operation.id)
            for (let id of execution.intent.abandonedOperationIds ?? [])
                await releaseOperation(this.repository, id)
            await this.store.appendJournalPhase(executionId, operationId, action, "finalized")
            return !operation.transient
        }

        let before = execution.intent.snapshot
        if (!before)
            throw recoveryBlocked(operation, action, "The interrupted execution journaled no starting state to compare against.")
        let recorder = new ChangeRecorder(this.repository)
        if (operation.removing)
            recorder.removing.set(operation.removing.id, operation.removing)
        let changes = (await this.changesSince(before, recorder)).filter(change => change.type != "stashes")
        if (changes.length) {
            try {
                await applyChanges(this.repository, invertChanges(changes), new ChangeRecorder(this.repository), { operationId, action })
            } catch (error) {
                throw recoveryBlocked(
                    operation,
                    action,
                    `Laneway could not reverse the interrupted ${action}: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
        }
        await this.abortBeforeCommit(executionId, operation, action)
        return changes.length > 0
    }

    private async commitHistory(executionId: string, operation: StoredOperation, action: Action) {
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
            ...(operation.changes || operation.lifecycle || operation.checkpoint ? { operation } : {}),
        })
    }
}

let neverCancelled: CancellationSignal = {
    isCancelled: () => false,
    wait: async delayMs => {
        await Bun.sleep(delayMs)
        return false
    },
}

export async function executeOperationCommand(
    command: OperationCommand,
    cwd: string,
    cancellation: CancellationSignal = neverCancelled,
    gitPath?: string,
): Promise<OperationCommandResult> {
    let repository = await connectRepository(cwd, gitPath)
    let store = new OperationStore(repository.descriptor.commonDirectory)

    if (command.command == "git")
        return executeNativeGit(repository, store, command.args, command.cwd, command.json, command.noWait, cancellation)

    // Publish changes no local branch, so it runs outside Operation History and holds the mutation lock only
    // to retain its receipt's commits.
    if (command.command == "publish") {
        let graphOptions = command.graphOptions(repository.descriptor.id)
        return executePublish(repository, command.request, graphOptions, {
            lock: work => store.withLock(command.noWait, cancellation, work),
            cancelled: () => cancellation.isCancelled(),
            progress: command.progress ?? (() => {}),
        })
    }

    // Fetching is network-bound and mutates only remote-tracking refs, so it runs before the mutation lock.
    let prepared: PullPreparation | undefined
    if (command.command == "pull") {
        let progress = command.progress ?? (() => {})
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
            let failed = prepared.fetches.filter(fetch => fetch.status == "failed")
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
        // Only this process changes the repository while it holds the lock, so repeated reads within the operation
        // can share one Git launch.
        repository.memoizeReads()
        let runtime = new OperationRuntime(repository, store, cancellation)
        if (command.command == "recovery-status")
            return runtime.recoveryStatus()
        if (command.command == "recover" && command.request)
            return runtime.resolveWorktreeRecovery(command.request, command.crashAfter)
        if (command.command == "undo" || command.command == "redo") {
            let history = await store.readHistory()
            let next = history.operations[history.position - (command.command == "undo" ? 1 : 0)]
            if (next?.nativeUndo)
                return command.command == "undo" ? runtime.undo(command.crashAfter, command.worktreeBasename) : runtime.redo(command.crashAfter)
        }
        let recovery = await runtime.recover(command.command != "recover")
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
            case "edit":
                return runtime.historicalEdit(command.request, command.crashAfter)
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

function changedRefs(changes: Change[]) {
    return changes.flatMap(change => change.type == "ref" ? [change.ref] : change.type == "stashes" ? ["refs/stash"] : [])
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

function transitionChanges(operation: StoredOperation, action: Action) {
    return action == "undo"
        ? operation.refChanges.map(change => ({ ref: change.ref, before: change.after, after: change.before }))
        : operation.refChanges
}

async function operationStateMatches(repository: RepositoryGit, operation: StoredOperation, action: Action, side: "source" | "target") {
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

async function retainOperation(repository: RepositoryGit, operation: StoredOperation, heads = new Map<string, string>()) {
    let objects = operation.refChanges.flatMap(change => [change.before, change.after]).filter((object): object is string => object != null)
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

function validateOperationState(
    repository: RepositoryGit,
    operation: StoredOperation,
    action: Action,
    side: "source" | "target",
    recaptureWorktrees = true,
) {
    let stateAction = side == "source" ? action : action == "undo" ? "redo" : "undo"
    return validatePreconditions(repository, operation, stateAction, recaptureWorktrees)
}

/** The checks operations recorded before ADR 0023 make: their checkpoints, snapshots and fingerprints must still match. */
async function validatePreconditions(repository: RepositoryGit, operation: StoredOperation, action: Action, recaptureWorktrees = true) {
    if (operation.nativeUndo)
        return validateNativeUndo(repository, operation.nativeUndo, action == "undo" ? "undo" : "redo")

    let gitLockfiles = await findGitLockfiles(operation.gitCommonDirectory)
    if (!sameStrings(gitLockfiles, operation.expectedGitLockfiles))
        throw gitLockfileError(gitLockfiles)

    if (operation.checkpoint) {
        if (!await checkpointMatches(repository, operation.checkpoint.expected)) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                "Repository state changed outside Laneway. The saved checkpoint remains available.",
                { reason: "worktree-changed" },
            )
        }
        return
    }

    if (operation.lifecycle && recaptureWorktrees) {
        let expected = action == "undo" ? operation.lifecycle.after : operation.lifecycle.before
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

    let expectsAfter = action == "undo"
    for (let change of operation.refChanges) {
        let expected = expectsAfter ? change.after : change.before
        let actual = await repository.resolveRef(change.ref)
        if (actual !== expected) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `Repository ref ${change.ref} changed outside Laneway.`,
                { reason: "ref-changed", ref: change.ref, expected, actual },
            )
        }
    }

    for (let change of operation.worktreeChanges) {
        let expected = expectsAfter ? change.after : change.before
        let actual = await fingerprintWorktree(repository, change.path)
        if (actual.index != expected.index) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `The index at ${change.path} changed outside Laneway.`,
                { reason: "index-changed", worktree: change.path },
            )
        }
        if (actual.worktree != expected.worktree) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `The worktree at ${change.path} changed outside Laneway.`,
                { reason: "worktree-changed", worktree: change.path },
            )
        }
    }
}

async function findGitLockfiles(commonDirectory: string) {
    let lockfiles: string[] = []
    let commonLockfiles = new Set(["config.lock", "gc.log.lock", "HEAD.lock", "index.lock", "packed-refs.lock", "shallow.lock"])

    await visit(commonDirectory, "", false)
    for (let subtree of ["refs", "logs", "worktrees"])
        await visit(resolve(commonDirectory, subtree), subtree, true)
    return lockfiles.sort()

    async function visit(directory: string, relativeDirectory: string, recursive: boolean) {
        let entries
        try {
            entries = await readdir(directory, { withFileTypes: true })
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code == "ENOENT")
                return
            throw error
        }

        for (let entry of entries) {
            let relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
            if (recursive && entry.isDirectory())
                await visit(resolve(directory, entry.name), relativePath, true)
            else if (entry.isFile() && entry.name.endsWith(".lock") && (relativeDirectory || commonLockfiles.has(entry.name)))
                lockfiles.push(relativePath)
        }
    }
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
    let { diff, index, status, untracked } = await repository.readWorktreeState(worktree)
    let worktreeHasher = new Bun.CryptoHasher("sha256")
    hashPart(worktreeHasher, "status", status)
    hashPart(worktreeHasher, "diff", diff)

    for (let path of untracked) {
        let absolutePath = resolve(worktree, path)
        let metadata = await lstat(absolutePath)
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
    let length = typeof value == "string" ? Buffer.byteLength(value) : value.byteLength
    hasher.update(`${label}\0${length}\0`)
    hasher.update(value)
}
