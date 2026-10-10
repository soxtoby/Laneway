import { connectRepository, GitError, type RepositoryGit } from "@laneway/git"
import { pathExists, previewWorktree, worktreeBasename } from "@laneway/git"
import { normalize, readRegisteredWorktrees } from "@laneway/git"
import { type OperationAvailability, type OperationAvailabilityReason, type OperationHistoryEntry, type OperationHistoryResult, type OperationSummary, type OperationTransitionResult, type RecoveredExecution, type RecoveryResult, type TestMutationResult } from "@laneway/shared"
import type { WorktreeRequest, WorktreeResult } from "@laneway/shared"
import type { LocalRequest, LocalResult } from "@laneway/shared"
import type { ConflictRequest, ConflictResult } from "@laneway/shared"
import type { BranchGraphReadOptions, PullRequest, PullResult } from "@laneway/shared"
import type { RecoveryRequest, RecoveryStatusResult, WorktreeRecovery } from "@laneway/shared"
import type { GitResult } from "@laneway/shared"
import { lstat, readdir, readFile, readlink, rename, rm } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { isFileExtraction } from "../composition/file-extraction"
import { conflictMutation, conflictPaths, executeConflict, suspendWorkingConflicts } from "../conflicts/conflict-operations"
import { LocalPreconditionError, mutateLocal, prepareLocal } from "../local-mutations"
import { runNativeGit } from "../native-git"
import { executePull, preparePull, type PullPreparation, type PullProgressReporter } from "../pull-latest"
import { recoveryBackupPath } from "../worktrees/worktree-directory"
import { mutateWorktree } from "../worktrees/worktree-mutations"
import { relocateRemovedState, restoreWorktreeState, worktreeStateMatches, worktreeStateObjects } from "../worktrees/worktree-state"
import { captureGitCheckpoint, checkpointIdentity, checkpointMatches, type GitCheckpoint, restoreGitCheckpoint, retainCheckpoint } from "./git-checkpoint"
import { type CancellationSignal, OperationCancelledError, OperationRuntimeError } from "./operation-contracts"
import { type JournalExecution, type JournalPhase, type RefChange, sealOperation, type StoredOperation, type WorktreeFingerprint } from "./operation-record"
import { OperationStore } from "./operation-store"
import { migrateRecoveryRefs, releaseRecoveryObjects, retainRecoveryObjects } from "./recovery-objects"

export { type CancellationSignal, OperationCancelledError, OperationRuntimeError } from "./operation-contracts"
export type { JournalPhase } from "./operation-record"

let fixtureRef = "refs/laneway/test/fixture"

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

class OperationRuntime {
    constructor(
        private readonly repository: RepositoryGit,
        private readonly store: OperationStore,
        private readonly cancellation: CancellationSignal,
    ) {}

    async git(args: string[], cwd: string, json: boolean): Promise<GitResult> {
        let worktrees = (await readRegisteredWorktrees(this.repository)).filter(w => !w.missing)
        for (let worktree of worktrees) {
            for (let marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
                if (await pathExists(join(worktree.gitDirectory, marker))) {
                    throw new OperationRuntimeError(
                        "operation.precondition-failed",
                        "Finish the existing Git operation before using Laneway undoable commands.",
                    )
                }
            }
        }
        let result: GitResult | undefined
        let before = await captureGitCheckpoint(this.repository, worktrees.map(w => w.path), undefined, worktrees, undefined, true, true)
        await this.applyCheckpoint(
            worktrees.map(w => w.path),
            `git.${args[0]}`,
            `git ${args[0]}`,
            async () => {
                result = await runNativeGit(this.repository, args, cwd, json)
                return new Set()
            },
            undefined,
            before,
        )
        return result!
    }

    async conflict(request: ConflictRequest, crashAfter?: JournalPhase): Promise<ConflictResult> {
        let changes = new Map<string, string | null>()
        if (!conflictMutation(request))
            return executeConflict(this.repository, request, changes, () => this.cancellation.isCancelled())

        let result: ConflictResult | undefined
        await this.applyCheckpoint(
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
        let changes = new Map<string, string | null>()
        let stacks: PullResult["stacks"] = []

        let operation = await this.applyCheckpoint(await conflictPaths(this.repository), "pull.latest", "Pull latest", async () => {
            stacks = await executePull(this.repository, prepared, changes, () => this.cancellation.isCancelled(), progress)
            return changes
        }, crashAfter)

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
            ...(recorded ? { operation: summarize(operation as StoredOperation) } : {}),
        }
    }

    async applyLocal(request: LocalRequest, token?: string, crashAfter?: JournalPhase, prefix = "worktree/"): Promise<LocalResult> {
        let { preview, before } = await prepareLocal(this.repository, request, prefix, token)
        if (!token || token != preview.token)
            throw new OperationRuntimeError("operation.precondition-failed", "Repository content changed. Refresh and review the operation again.")
        return this.applyPreparedLocal(request, { preview, before }, crashAfter)
    }

    async transfer(request: LocalRequest, crashAfter?: JournalPhase, prefix = "worktree/"): Promise<LocalResult> {
        if (request.action != "compose" && request.action != "reword")
            throw new OperationRuntimeError("operation.precondition-failed", "Choose a change transfer.")
        // A reword applies in the same invocation unless its preview reports a decision for the user; a separate
        // apply would launch the engine and capture the repository again for nothing. Mutation re-verifies the
        // checkpoint before changing refs, so the reword's preparation defers its own verification.
        let prepared = await prepareLocal(this.repository, request, prefix, undefined, request.action != "reword")
        let composition = prepared.preview.composition
        let immediate = request.action == "reword"
            ? !composition?.published.length && !composition?.removed.length && !composition?.conflicts.length
            : isFileExtraction(prepared.preview)
        if (immediate)
            return this.applyPreparedLocal(request, prepared, crashAfter)
        if (request.action == "reword" && !await checkpointMatches(this.repository, prepared.before))
            throw new OperationRuntimeError("operation.precondition-failed", "Repository content changed while preparing the reword. Review it again.")

        return { type: "result", command: "local-preview", status: "preview", preview: prepared.preview }
    }

    private async applyPreparedLocal(
        request: LocalRequest,
        { preview, before }: Awaited<ReturnType<typeof prepareLocal>>,
        crashAfter?: JournalPhase,
    ): Promise<LocalResult> {
        let result: LocalResult = { type: "result", command: "local", status: "performed" }
        let expectedRefs = new Map<string, string | null>()

        // Preparation happened under this mutation lock, so its snapshot becomes the journal's
        // "before" state. The mutation still validates it immediately before changing Git state.
        await this.applyCheckpoint(
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
        let preview = await previewWorktree(this.repository, request)
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
        if (request.action == "remove" && preview.ignoredCount && !request.allowIgnoredLoss)
            throw new OperationRuntimeError("operation.precondition-failed", "Review ignored-file loss before removal.")

        let operation = await this.applyCheckpoint(
            preview.affected,
            `worktree.${request.action}`,
            `${request.action[0]!.toUpperCase()}${request.action.slice(1)} worktree ${preview.destination ?? ("path" in request ? request.path : "")}`,
            async (_before, operationId) => {
                let changed = await mutateWorktree(this.repository, preview, operationId, branchPrefix)
                let conflictChanges = new Map<string, string | null>()
                await suspendWorkingConflicts(this.repository, conflictChanges)
                for (let ref of conflictChanges.keys())
                    changed.add(ref)
                return changed
            },
            crashAfter,
        )

        return { type: "result", command: "worktree", operation }
    }

    private async applyCheckpoint(
        affected: string[],
        kind: string,
        summary: string,
        mutate: (before: GitCheckpoint, operationId: string) => Promise<Set<string> | Map<string, string | null>>,
        crashAfter?: JournalPhase,
        prepared?: GitCheckpoint,
    ): Promise<OperationSummary> {
        let locks = await findGitLockfiles(this.repository.descriptor.commonDirectory)
        if (locks.length)
            throw gitLockfileError(locks)

        let before = prepared ?? await captureGitCheckpoint(this.repository, affected)

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
            checkpoint: { restore: before, expected: before },
        })

        let executionId = crypto.randomUUID()
        await retainCheckpoint(this.repository, operation.id, before)
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
        crashIfRequested("recovery-retained", crashAfter)
        await this.cancelIfRequested(executionId, operation, "apply")
        crashIfRequested("preconditions-verified", crashAfter)

        try {
            await mutate(before, operation.id)
        } catch (error) {
            // A failure is unwound here rather than left as a pending execution, which would block every
            // later operation in the repository until recovery. Only a failed restoration stays pending.
            let outcome = await this.rollBackFailedMutation(before, operation)
            if (outcome != "pending")
                await this.abortBeforeCommit(executionId, operation, "apply")
            if (outcome == "restored")
                throw new Error(`${error instanceof Error ? error.message : String(error)} Laneway restored the Git state from before the operation.`)
            throw error
        }
        let expected = await captureGitCheckpoint(this.repository, affected, before, undefined, undefined, false)
        if ((kind.startsWith("local.") || kind.startsWith("pull.") || kind.startsWith("git.")) && checkpointIdentity(before) == checkpointIdentity(expected)) {
            await this.abortBeforeCommit(executionId, operation, "apply")
            return operation
        }

        let refChanges = [...new Set([...Object.keys(before.refs), ...Object.keys(expected.refs)])]
            .filter(ref => before.refs[ref] != expected.refs[ref])
            .map(ref => ({ ref, before: before.refs[ref] ?? null, after: expected.refs[ref] ?? null }))
        operation = sealOperation({ ...operation, affectedRefs: refChanges.map(change => change.ref), refChanges, checkpoint: { restore: before, expected } })

        crashIfRequested("worktrees-committed", crashAfter)
        crashIfRequested("refs-committed", crashAfter)

        await this.commitHistory(executionId, operation, "apply")
        crashIfRequested("history-committed", crashAfter)

        for (let old of abandoned)
            await releaseOperation(this.repository, old.id)

        await this.store.appendJournalPhase(executionId, operation.id, "apply", "finalized")
        return summarize(operation)
    }

    private async rollBackFailedMutation(before: GitCheckpoint, operation: StoredOperation): Promise<"unchanged" | "restored" | "pending"> {
        try {
            let current = await captureGitCheckpoint(this.repository, operation.affectedWorktrees, before, undefined, undefined, false)
            if (checkpointIdentity(current) == checkpointIdentity(before))
                return "unchanged"
            await restoreGitCheckpoint(this.repository, current, before)
            return "restored"
        } catch {
            return "pending"
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
        crashIfRequested("recovery-retained", crashAfter)
        await this.cancelIfRequested(executionId, pending, action)
        crashIfRequested("preconditions-verified", crashAfter)
        await restoreGitCheckpoint(this.repository, departing, target)
        let expected = await captureGitCheckpoint(this.repository, target.worktrees.map(w => w.path), target, undefined, undefined, false)
        let updated = sealOperation({ ...operation, checkpoint: { restore: departing, expected } })
        crashIfRequested("refs-committed", crashAfter)

        await this.commitHistory(executionId, updated, action)
        crashIfRequested("history-committed", crashAfter)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
    }

    async applyTestMutation(value: string, crashAfter?: JournalPhase, holdAfterIntentMs?: number): Promise<TestMutationResult> {
        let projection = await this.store.readHistory()
        let before = await this.repository.resolveRef(fixtureRef)
        let expectedGitLockfiles = await findGitLockfiles(this.repository.descriptor.commonDirectory)
        if (expectedGitLockfiles.length > 0)
            throw gitLockfileError(expectedGitLockfiles)
        let after = await this.repository.hashObject(value)
        let worktree = await fingerprintWorktree(this.repository, this.repository.descriptor.selectedWorktree)
        let operation = sealOperation({
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
        let abandoned = projection.operations.slice(projection.position)

        await this.applyOperation(operation, "apply", abandoned, crashAfter, holdAfterIntentMs)

        return { type: "result", command: "test-mutation", operation: summarize(operation) }
    }

    async undo(crashAfter?: JournalPhase, basename?: string): Promise<OperationTransitionResult> {
        let projection = await this.store.readHistory()
        if (projection.position == 0)
            return { type: "result", command: "undo", status: "unavailable", reason: "empty" }

        let operation = projection.operations[projection.position - 1]
        if (!operation)
            throw new OperationRuntimeError("operation.history-corrupt", "Operation History has an invalid undo position.")

        if (basename && operation.checkpoint) {
            if (operation.kind != "worktree.remove")
                throw new OperationRuntimeError("operation.precondition-failed", "An alternate basename is only available when undoing worktree removal.")
            let removed = operation.checkpoint.restore.worktrees.find(w => w.registered && !w.main)
            if (!removed)
                throw new OperationRuntimeError("operation.precondition-failed", "There is no removed worktree to recreate.")
            let destination = join(dirname(removed.path), worktreeBasename(basename))
            if (await pathExists(destination))
                throw new OperationRuntimeError("operation.precondition-failed", "The alternate worktree path is occupied.")
            let relocated = structuredClone(operation.checkpoint.restore)
            relocated.worktrees.find(w => w.id == removed.id)!.path = destination
            operation = sealOperation({
                ...operation,
                affectedWorktrees: operation.affectedWorktrees.map(path => path == removed.path ? destination : path),
                checkpoint: { ...operation.checkpoint, restore: relocated },
            })
        } else if (basename) {
            if (operation.kind != "worktree.remove" || !operation.lifecycle?.after)
                throw new OperationRuntimeError("operation.precondition-failed", "An alternate basename is only available when undoing worktree removal.")
            let root = operation.lifecycle.before.roots.find(root => root.kind == "working" && root.present)
            if (!root)
                throw new OperationRuntimeError("operation.precondition-failed", "There is no removed directory to recreate.")
            let destination = join(dirname(root.path), worktreeBasename(basename))
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

        if (operation.checkpoint)
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

        if (operation.checkpoint)
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
            await validatePreconditions(this.repository, operation, action)
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
            if (
                execution.intent.action == "apply" && operation.kind == "worktree.remove" && operation.checkpoint
                && !execution.phases.has("aborted") && !execution.phases.has("cancelled") && !await this.store.hasHistoryEvent(execution.intent.executionId)
            ) {
                for (let worktree of operation.checkpoint.restore.worktrees.filter(w => w.registered && !w.main)) {
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
            }
        }

        return { type: "result", command: "recovery-status", worktrees }
    }

    async resolveWorktreeRecovery(request: RecoveryRequest, crashAfter?: JournalPhase): Promise<RecoveryResult> {
        let pending = await this.store.readPendingExecutions()
        let execution = pending.find(item => item.intent.operationId == request.operationId)
        if (!execution)
            return { type: "result", command: "recover", status: "clean", recovered: [] }
        let { operation, executionId, action } = execution.intent
        if (action != "apply" || operation.kind != "worktree.remove" || !operation.checkpoint)
            throw new OperationRuntimeError("operation.precondition-failed", "Choose an interrupted worktree removal.")
        if (execution.phases.has("aborted") || execution.phases.has("cancelled")) {
            await this.resumeExecution(execution)
            return { type: "result", command: "recover", status: "clean", recovered: [] }
        }
        if (await this.store.hasHistoryEvent(executionId)) {
            for (let id of execution.intent.abandonedOperationIds ?? [])
                await releaseOperation(this.repository, id)
            await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
            return { type: "result", command: "recover", status: "recovered", recovered: [{ action, operation: summarize(operation) }] }
        }

        let worktree = operation.checkpoint.restore.worktrees.find(w => w.registered && !w.main)
        if (!worktree || normalize(worktree.path) == normalize(this.repository.descriptor.mainWorktree))
            throw new OperationRuntimeError("operation.precondition-failed", "The Main Worktree cannot be removed or replaced.")
        let locks = await findGitLockfiles(this.repository.descriptor.commonDirectory)
        if (locks.length)
            throw gitLockfileError(locks)

        let current = await captureGitCheckpoint(this.repository, operation.affectedWorktrees, operation.checkpoint.restore)
        await retainCheckpoint(this.repository, operation.id, operation.checkpoint.restore, current)
        let registrations = await readRegisteredWorktrees(this.repository)
        let registered = registrations.find(w => normalize(w.path) == normalize(worktree.path))
        if (registered && registered.id != worktree.id)
            throw new OperationRuntimeError("operation.precondition-failed", "Another worktree now occupies this path. Its files were left intact.")
        if (registered?.locked)
            throw new OperationRuntimeError("operation.precondition-failed", "Unlock the worktree before resolving its removal.")

        let restore = {
            ...operation.checkpoint.restore,
            refs: { ...current.refs },
            metadata: current.metadata,
            branchConfig: current.branchConfig,
            stashes: current.stashes,
        }

        let changedBranch = worktree.branchRef && current.refs[worktree.branchRef] && current.refs[worktree.branchRef] != worktree.head
        let otherHolder = worktree.branchRef
            && (await readRegisteredWorktrees(this.repository)).some(w => w.branchRef == worktree.branchRef && normalize(w.path) != normalize(worktree.path))
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
        if (changedBranch || otherHolder)
            restore.worktrees = restore.worktrees.map(w => ({ ...w, branchRef: undefined }))
        else if (worktree.branchRef)
            restore.refs[worktree.branchRef] = worktree.head

        let backupPath = recoveryBackupPath(worktree.path, operation.id)
        if (request.action == "remove") {
            if (registrations.some(w => normalize(w.path) == normalize(backupPath) || normalize(w.path).startsWith(`${normalize(backupPath)}${sep}`)))
                throw new OperationRuntimeError("operation.precondition-failed", "Another worktree occupies the recovery backup. Its files were left intact.")
            // An earlier interrupted recovery may have left its backup where removal moves the directory.
            await rm(resolve(backupPath), { recursive: true, force: true })
            if (registered) {
                let preview = await previewWorktree(this.repository, { action: "remove", path: worktree.path, preserve: true, allowIgnoredLoss: true })
                await mutateWorktree(this.repository, preview, operation.id)
            }
            await rm(resolve(worktree.path), { recursive: true, force: true })
            await rm(resolve(backupPath), { recursive: true, force: true })
        } else if (registered && !registered.missing) {
            let saved = current.worktrees.find(w => w.id == worktree.id)
            if (
                saved?.head != worktree.head || saved.fingerprint != worktree.fingerprint
                || JSON.stringify(saved.submodules) != JSON.stringify(worktree.submodules)
            ) {
                throw new OperationRuntimeError(
                    "operation.precondition-failed",
                    "The worktree has newer changes. Preserve them before restoring its saved state.",
                )
            }
        } else {
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
        }

        if (request.action == "restore") {
            let source = await captureGitCheckpoint(this.repository, operation.affectedWorktrees, restore, undefined, undefined, false)
            if (checkpointIdentity(source) != checkpointIdentity(restore))
                await restoreGitCheckpoint(this.repository, source, restore)
            crashIfRequested("worktrees-committed", crashAfter)
        } else {
            let expected = await captureGitCheckpoint(this.repository, operation.affectedWorktrees, restore, undefined, undefined, false)
            let completed = sealOperation({ ...operation, checkpoint: { restore, expected } })
            crashIfRequested("worktrees-committed", crashAfter)
            await this.commitHistory(executionId, completed, action)
            crashIfRequested("history-committed", crashAfter)
            for (let id of execution.intent.abandonedOperationIds ?? [])
                await releaseOperation(this.repository, id)
        }

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        if (request.action == "restore")
            await releaseOperation(this.repository, operation.id)

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
        action: "apply" | "undo" | "redo",
        abandoned: StoredOperation[],
        crashAfter?: JournalPhase,
        holdAfterIntentMs?: number,
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
        crashIfRequested("refs-committed", crashAfter)

        await this.commitHistory(executionId, operation, action)
        await this.store.appendJournalPhase(executionId, operation.id, action, "history-committed")
        crashIfRequested("history-committed", crashAfter)

        for (let abandonedOperation of abandoned)
            await releaseOperation(this.repository, abandonedOperation.id)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        crashIfRequested("finalized", crashAfter)
    }

    private async cancelIfRequested(executionId: string, operation: StoredOperation, action: "apply" | "undo" | "redo", waitMs = 0) {
        let cancelled = waitMs > 0 ? await this.cancellation.wait(waitMs) : this.cancellation.isCancelled()
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
        let { action, executionId, operation, operationId } = execution.intent
        if (operation.checkpoint) {
            let committed = await this.store.hasHistoryEvent(executionId)
            if (!committed && !execution.phases.has("aborted") && !execution.phases.has("cancelled")) {
                let target = operation.checkpoint.restore
                try {
                    let current = await captureGitCheckpoint(this.repository, operation.affectedWorktrees, target)
                    await retainCheckpoint(this.repository, operation.id, target, current)
                    if (checkpointIdentity(current) != checkpointIdentity(target))
                        await restoreGitCheckpoint(this.repository, current, target)
                } catch (error) {
                    throw recoveryBlocked(operation, action, "Git could not restore the starting checkpoint. It remains retained for manual recovery.", {
                        reason: error instanceof Error ? error.message : String(error),
                    })
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
            ...(operation.lifecycle || operation.checkpoint ? { operation } : {}),
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
        let runtime = new OperationRuntime(repository, store, cancellation)
        if (command.command == "recovery-status")
            return runtime.recoveryStatus()
        if (command.command == "recover" && command.request)
            return runtime.resolveWorktreeRecovery(command.request, command.crashAfter)
        let recovery = await runtime.recover(command.command != "recover")
        if (command.command == "recover")
            return recovery

        switch (command.command) {
            case "git":
                return runtime.git(command.args, command.cwd, command.json)
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
    action: "apply" | "undo" | "redo",
    side: "source" | "target",
    recaptureWorktrees = true,
) {
    let stateAction = side == "source" ? action : action == "undo" ? "redo" : "undo"
    return validatePreconditions(repository, operation, stateAction, recaptureWorktrees)
}

async function validatePreconditions(repository: RepositoryGit, operation: StoredOperation, action: "apply" | "undo" | "redo", recaptureWorktrees = true) {
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
