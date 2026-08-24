import { type OperationAvailability, type OperationAvailabilityReason, type OperationHistoryEntry, type OperationHistoryResult, type OperationSummary, OperationSummarySchema, type OperationTransitionResult, type RecoveredExecution, type RecoveryResult, type TestMutationResult } from "@git-workbench/shared"
import { link, lstat, mkdir, open, readdir, readFile, readlink, rename, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"

const fixtureRef = "refs/workbench/test/fixture"
const journalFileName = "journal.jsonl"
const historyFileName = "history.jsonl"

interface GitResult {
    exitCode: number
    stderr: string
    stdout: string
}

interface Repository {
    commonDirectory: string
    worktree: string
}

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
})

const HistoryEventSchema = z.discriminatedUnion("type", [OperationEventSchema, TransitionEventSchema])
const JournalPhaseSchema = z.enum([
    "intent",
    "recovery-retained",
    "preconditions-verified",
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
    | { command: "test-mutation"; value: string; noWait: boolean; crashAfter?: JournalPhase; holdAfterIntentMs?: number }
    | { command: "undo"; noWait: boolean; crashAfter?: JournalPhase }
    | { command: "redo"; noWait: boolean; crashAfter?: JournalPhase }
    | { command: "history"; noWait: boolean }
    | { command: "recover"; noWait: boolean }

export type OperationCommandResult = TestMutationResult | OperationTransitionResult | OperationHistoryResult | RecoveryResult

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
): Promise<OperationCommandResult> {
    const repository = await discoverRepository(cwd)
    const store = new OperationStore(repository.commonDirectory)

    return store.withLock(command.noWait, cancellation, async () => {
        const runtime = new OperationRuntime(repository, store, cancellation)
        const recovery = await runtime.recover()
        if (command.command == "recover")
            return recovery

        switch (command.command) {
            case "test-mutation":
                return runtime.applyTestMutation(command.value, command.crashAfter, command.holdAfterIntentMs)
            case "undo":
                return runtime.undo(command.crashAfter)
            case "redo":
                return runtime.redo(command.crashAfter)
            case "history":
                return runtime.history()
        }
    })
}

class OperationRuntime {
    constructor(
        private readonly repository: Repository,
        private readonly store: OperationStore,
        private readonly cancellation: CancellationSignal,
    ) {}

    async applyTestMutation(value: string, crashAfter?: JournalPhase, holdAfterIntentMs?: number): Promise<TestMutationResult> {
        const projection = await this.store.readHistory()
        const before = await readRef(this.repository.worktree, fixtureRef)
        const expectedGitLockfiles = await findGitLockfiles(this.repository.commonDirectory)
        if (expectedGitLockfiles.length > 0)
            throw gitLockfileError(expectedGitLockfiles)
        const after = await writeBlob(this.repository.worktree, value)
        const worktree = await fingerprintWorktree(this.repository.worktree)
        const operation = sealOperation({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            kind: "test.ref-update",
            summary: `Set the test fixture to ${value}`,
            affectedRefs: [fixtureRef],
            affectedWorktrees: [this.repository.worktree],
            gitCommonDirectory: this.repository.commonDirectory,
            expectedGitLockfiles,
            refChanges: [{ ref: fixtureRef, before, after }],
            worktreeChanges: [{ path: this.repository.worktree, before: worktree, after: worktree }],
        })
        const abandoned = projection.operations.slice(projection.position)

        await this.applyOperation(operation, "apply", abandoned, crashAfter, holdAfterIntentMs)

        return { type: "result", command: "test-mutation", operation: summarize(operation) }
    }

    async undo(crashAfter?: JournalPhase): Promise<OperationTransitionResult> {
        const projection = await this.store.readHistory()
        if (projection.position == 0)
            return { type: "result", command: "undo", status: "unavailable", reason: "empty" }

        const operation = projection.operations[projection.position - 1]
        if (!operation)
            throw new OperationRuntimeError("operation.history-corrupt", "Operation History has an invalid undo position.")

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
            await validatePreconditions(this.repository.worktree, operation, action)
            return { available: true, operationId: operation.id }
        } catch (error) {
            if (error instanceof OperationRuntimeError && error.code == "operation.precondition-failed")
                return { available: false, operationId: operation.id, reason: availabilityReason(error.details?.reason) }
            throw error
        }
    }

    async recover(): Promise<RecoveryResult> {
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
        await retainOperation(this.repository.worktree, operation)
        await this.store.appendJournalPhase(executionId, operation.id, action, "recovery-retained")
        crashIfRequested("recovery-retained", crashAfter)
        await this.cancelIfRequested(executionId, operation, action)

        try {
            await validatePreconditions(this.repository.worktree, operation, action)
        } catch (error) {
            await this.abortBeforeCommit(executionId, operation, action)
            throw error
        }
        await this.store.appendJournalPhase(executionId, operation.id, action, "preconditions-verified")
        crashIfRequested("preconditions-verified", crashAfter)
        await this.cancelIfRequested(executionId, operation, action)

        try {
            await applyRefChanges(this.repository.worktree, transitionChanges(operation, action))
        } catch (error) {
            await this.abortBeforeCommit(executionId, operation, action)
            throw error
        }
        await validateOperationState(operation, action, "target")
        await this.store.appendJournalPhase(executionId, operation.id, action, "refs-committed")
        crashIfRequested("refs-committed", crashAfter)

        await this.commitHistory(executionId, operation, action)
        await this.store.appendJournalPhase(executionId, operation.id, action, "history-committed")
        crashIfRequested("history-committed", crashAfter)

        for (const abandonedOperation of abandoned)
            await releaseOperation(this.repository.worktree, abandonedOperation.id)

        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        crashIfRequested("finalized", crashAfter)
    }

    private async cancelIfRequested(executionId: string, operation: StoredOperation, action: "apply" | "undo" | "redo", waitMs = 0) {
        const cancelled = waitMs > 0 ? await this.cancellation.wait(waitMs) : this.cancellation.isCancelled()
        if (!cancelled)
            return

        await this.store.appendJournalPhase(executionId, operation.id, action, "cancelled")
        if (action == "apply")
            await releaseOperation(this.repository.worktree, operation.id)
        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
        throw new OperationCancelledError("Cancellation acknowledged at a verified journal boundary.")
    }

    private async abortBeforeCommit(executionId: string, operation: StoredOperation, action: "apply" | "undo" | "redo") {
        await this.store.appendJournalPhase(executionId, operation.id, action, "aborted")
        if (action == "apply")
            await releaseOperation(this.repository.worktree, operation.id)
        await this.store.appendJournalPhase(executionId, operation.id, action, "finalized")
    }

    private async resumeExecution(execution: JournalExecution) {
        const { action, executionId, operation, operationId } = execution.intent
        if (execution.phases.has("cancelled") || execution.phases.has("aborted")) {
            if (action == "apply")
                await releaseOperation(this.repository.worktree, operation.id)
            await this.store.appendJournalPhase(executionId, operationId, action, "finalized")
            return false
        }

        const historyCommitted = await this.store.hasHistoryEvent(executionId)
        const refsCommitted = execution.phases.has("refs-committed") || historyCommitted
        const targetMatches = await operationStateMatches(operation, action, "target")

        await retainOperation(this.repository.worktree, operation)
        if (!execution.phases.has("recovery-retained"))
            await this.store.appendJournalPhase(executionId, operationId, action, "recovery-retained")

        if (refsCommitted) {
            if (!targetMatches)
                throw recoveryBlocked(operation, action, "The recorded target state no longer matches the repository.")
        } else if (!targetMatches) {
            try {
                await validatePreconditions(this.repository.worktree, operation, action)
            } catch (error) {
                if (error instanceof OperationRuntimeError && error.code == "operation.precondition-failed")
                    throw recoveryBlocked(operation, action, error.message, error.details)
                throw error
            }
            if (!execution.phases.has("preconditions-verified"))
                await this.store.appendJournalPhase(executionId, operationId, action, "preconditions-verified")
            await applyRefChanges(this.repository.worktree, transitionChanges(operation, action))
        }

        if (!execution.phases.has("refs-committed"))
            await this.store.appendJournalPhase(executionId, operationId, action, "refs-committed")
        if (!historyCommitted)
            await this.commitHistory(executionId, operation, action)
        if (!execution.phases.has("history-committed"))
            await this.store.appendJournalPhase(executionId, operationId, action, "history-committed")

        for (const abandonedOperationId of execution.intent.abandonedOperationIds ?? [])
            await releaseOperation(this.repository.worktree, abandonedOperationId)
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
        })
    }
}

class OperationStore {
    private readonly directory: string
    private readonly journalPath: string
    private readonly historyPath: string
    private readonly lockPath: string

    constructor(commonDirectory: string) {
        this.directory = resolve(commonDirectory, "workbench")
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
                        throw new OperationRuntimeError("operation.locked", "Another Workbench mutation holds the repository lock.")
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
                    throw new OperationRuntimeError("operation.history-corrupt", "Operation History contains a duplicate Workbench Operation.")
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
            projection.position += event.action == "undo" ? -1 : 1
        }

        return projection
    }

    appendHistory(event: HistoryEvent) {
        return appendJsonLine(this.historyPath, event)
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
        const events = await readJsonLines(this.journalPath, "recovery journal", "operation.journal-corrupt", JournalEventSchema)
        const executions = new Map<string, JournalExecution>()

        for (const event of events) {
            if (event.schemaVersion !== 1 || !event.executionId || !event.operationId || !event.action || !event.phase)
                throw new OperationRuntimeError("operation.journal-corrupt", "The recovery journal contains an invalid record.")
            if (event.phase == "intent") {
                if (!event.operation)
                    throw new OperationRuntimeError("operation.journal-corrupt", "A recovery intent does not contain its Workbench Operation.")
                validateOperationIntegrity(event.operation, "operation.journal-corrupt")
                if (executions.has(event.executionId))
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
        }

        return [...executions.values()].filter(execution => !execution.phases.has("finalized"))
    }

    private readHistoryEvents() {
        return readJsonLines(this.historyPath, "Operation History", "operation.history-corrupt", HistoryEventSchema)
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
        throw new OperationRuntimeError(code, "A stored Workbench Operation failed its integrity check.")
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

async function operationStateMatches(operation: StoredOperation, action: "apply" | "undo" | "redo", side: "source" | "target") {
    try {
        await validateOperationState(operation, action, side)
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

async function discoverRepository(cwd: string): Promise<Repository> {
    const [commonDirectory, worktree] = await Promise.all([
        requireGit(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
        requireGit(cwd, "rev-parse", "--path-format=absolute", "--show-toplevel"),
    ])
    return { commonDirectory: resolve(commonDirectory), worktree: resolve(worktree) }
}

async function writeBlob(cwd: string, value: string) {
    return requireGit(cwd, ["hash-object", "-w", "--stdin"], value)
}

async function readRef(cwd: string, ref: string) {
    const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", ref])
    if (result.exitCode == 1)
        return null
    if (result.exitCode != 0)
        throw gitFailure(result, `Could not read ${ref}.`)
    return result.stdout.trim()
}

async function retainOperation(cwd: string, operation: StoredOperation) {
    for (const [index, change] of operation.refChanges.entries()) {
        if (change.before)
            await updatePrivateRef(cwd, `refs/workbench/recovery/${operation.id}/before/${index}`, change.before)
        if (change.after)
            await updatePrivateRef(cwd, `refs/workbench/recovery/${operation.id}/after/${index}`, change.after)
    }
}

async function releaseOperation(cwd: string, operationId: string) {
    const prefix = `refs/workbench/recovery/${operationId}/`
    const result = await runGit(cwd, ["for-each-ref", "--format=%(refname)", prefix])
    if (result.exitCode != 0)
        throw gitFailure(result, `Could not inspect recovery refs for ${operationId}.`)

    const refs = result.stdout.split("\n").filter(Boolean)
    for (const ref of refs) {
        const deletion = await runGit(cwd, ["update-ref", "-d", ref])
        if (deletion.exitCode != 0)
            throw gitFailure(deletion, `Could not release recovery ref ${ref}.`)
    }
}

async function updatePrivateRef(cwd: string, ref: string, oid: string) {
    const result = await runGit(cwd, ["update-ref", ref, oid])
    if (result.exitCode != 0)
        throw gitFailure(result, `Could not retain recovery ref ${ref}.`)
}

async function applyRefChanges(cwd: string, changes: RefChange[]) {
    const oidLength = changes.flatMap(change => [change.before, change.after]).find(Boolean)?.length ?? 40
    const zeroOid = "0".repeat(oidLength)
    const commands = ["start"]
    for (const change of changes) {
        if (change.after)
            commands.push(`update ${change.ref} ${change.after} ${change.before ?? zeroOid}`)
        else if (change.before)
            commands.push(`delete ${change.ref} ${change.before}`)
    }
    commands.push("prepare", "commit", "")

    const result = await runGit(cwd, ["update-ref", "--stdin"], commands.join("\n"))
    if (result.exitCode != 0) {
        throw new OperationRuntimeError(
            "operation.precondition-failed",
            "Repository state changed before the Workbench Operation could be applied.",
            { git: result.stderr },
        )
    }
}

async function validatePreconditions(cwd: string, operation: StoredOperation, action: "apply" | "undo" | "redo") {
    const gitLockfiles = await findGitLockfiles(operation.gitCommonDirectory)
    if (!sameStrings(gitLockfiles, operation.expectedGitLockfiles))
        throw gitLockfileError(gitLockfiles)

    const expectsAfter = action == "undo"
    for (const change of operation.refChanges) {
        const expected = expectsAfter ? change.after : change.before
        const actual = await readRef(cwd, change.ref)
        if (actual !== expected) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `Repository ref ${change.ref} changed outside Workbench.`,
                { reason: "ref-changed", ref: change.ref, expected, actual },
            )
        }
    }

    for (const change of operation.worktreeChanges) {
        const expected = expectsAfter ? change.after : change.before
        const actual = await fingerprintWorktree(change.path)
        if (actual.index !== expected.index) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `The index at ${change.path} changed outside Workbench.`,
                { reason: "index-changed", worktree: change.path },
            )
        }
        if (actual.worktree !== expected.worktree) {
            throw new OperationRuntimeError(
                "operation.precondition-failed",
                `The worktree at ${change.path} changed outside Workbench.`,
                { reason: "worktree-changed", worktree: change.path },
            )
        }
    }
}

function validateOperationState(operation: StoredOperation, action: "apply" | "undo" | "redo", side: "source" | "target") {
    const stateAction = side == "source" ? action : action == "undo" ? "redo" : "undo"
    return validatePreconditions(operation.affectedWorktrees[0] ?? process.cwd(), operation, stateAction)
}

async function findGitLockfiles(commonDirectory: string) {
    const lockfiles: string[] = []

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
            else if (entry.isFile() && entry.name.endsWith(".lock"))
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
        `Git lockfiles prevent the Workbench Operation: ${lockfiles.join(", ")}.`,
        { reason: "git-lockfile-present", lockfiles },
    )
}

async function fingerprintWorktree(worktree: string): Promise<WorktreeFingerprint> {
    const [index, status, diff, untracked] = await Promise.all([
        requireGitRaw(worktree, "ls-files", "--stage", "-v", "-z"),
        requireGitRaw(worktree, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"),
        requireGitRaw(worktree, "diff", "--binary", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"),
        requireGitRaw(worktree, "ls-files", "--others", "--exclude-standard", "-z"),
    ])
    const worktreeHasher = new Bun.CryptoHasher("sha256")
    hashPart(worktreeHasher, "status", status)
    hashPart(worktreeHasher, "diff", diff)

    for (const path of untracked.split("\0").filter(Boolean)) {
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

async function requireGit(cwd: string, ...args: string[]): Promise<string>
async function requireGit(cwd: string, args: string[], input: string): Promise<string>
async function requireGit(cwd: string, first: string | string[], ...rest: string[]): Promise<string> {
    const args = Array.isArray(first) ? first : [first, ...rest]
    const input = Array.isArray(first) ? rest[0] : undefined
    const result = await runGit(cwd, args, input)
    if (result.exitCode != 0)
        throw gitFailure(result, result.stderr || "Git command failed.")
    return result.stdout.trim()
}

async function requireGitRaw(cwd: string, ...args: string[]) {
    const result = await runGit(cwd, args)
    if (result.exitCode != 0)
        throw gitFailure(result, result.stderr || "Git command failed.")
    return result.stdout
}

async function runGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
    const child = Bun.spawn(["git", ...args], {
        cwd,
        stdin: input == undefined ? "ignore" : "pipe",
        stderr: "pipe",
        stdout: "pipe",
    })
    if (input != undefined) {
        const stdin = child.stdin
        if (!stdin)
            throw new OperationRuntimeError("operation.internal", "Git stdin was unavailable.")
        stdin.write(input)
        await stdin.end()
    }
    const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
    ])
    return { exitCode, stderr, stdout }
}

function gitFailure(result: GitResult, fallback: string) {
    return new OperationRuntimeError("operation.internal", result.stderr.trim() || fallback, { gitExitCode: result.exitCode })
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
            if (lock.pid && isProcessAlive(lock.pid))
                continue
        } catch {
            // An unpublished corrupt candidate cannot own the repository lock.
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
