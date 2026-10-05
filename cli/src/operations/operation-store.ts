import { link, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises"
import { resolve } from "node:path"
import type { z } from "zod"
import { type CancellationSignal, OperationCancelledError, OperationRuntimeError } from "./operation-contracts"
import { type HistoryEvent, HistoryEventSchema, type HistoryProjection, type JournalEvent, JournalEventSchema, type JournalExecution, type JournalPhase, type StoredOperation, validateOperationIntegrity } from "./operation-record"

let journalFileName = "journal.jsonl"

let historyFileName = "history.jsonl"

export class OperationStore {
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
        let token = crypto.randomUUID()
        let candidatePath = `${this.lockPath}.candidate-${token}`
        let candidate = await open(candidatePath, "wx")
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
        let events = await this.readHistoryEvents()
        let projection: HistoryProjection = { operations: [], position: 0 }
        let executionIds = new Set<string>()
        let operationIds = new Set<string>()

        for (let event of events) {
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

            let expected = event.action == "undo"
                ? projection.operations[projection.position - 1]
                : projection.operations[projection.position]
            if (expected?.id != event.operationId)
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
        let content = await readFile(this.journalPath).catch(error => {
            if (isNotFound(error))
                return Buffer.alloc(0)
            throw error
        })
        let checkpointPath = resolve(this.directory, "journal-checkpoint.json")
        let checkpoint = await readJournalCheckpoint(checkpointPath, content)
        let events: JournalEvent[]
        try {
            events = content.subarray(checkpoint?.length ?? 0).toString().split("\n").filter(Boolean).map(line => JournalEventSchema.parse(JSON.parse(line)))
        } catch {
            throw new OperationRuntimeError("operation.journal-corrupt", "recovery journal is corrupt.")
        }
        let executions = new Map<string, JournalExecution>()
        let finalized = new Set(checkpoint?.executions ?? [])

        for (let event of events) {
            if (event.schemaVersion != 1 || !event.executionId || !event.operationId || !event.action || !event.phase)
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

            let execution = executions.get(event.executionId)
            if (!execution)
                throw new OperationRuntimeError("operation.journal-corrupt", "A recovery phase has no matching intent.")
            if (event.operationId != execution.intent.operationId || event.action != execution.intent.action)
                throw new OperationRuntimeError("operation.journal-corrupt", "A recovery phase does not match its intent.")
            if (execution.phases.has("finalized") || execution.phases.has(event.phase))
                throw new OperationRuntimeError("operation.journal-corrupt", "The recovery journal contains an invalid repeated phase.")
            execution.phases.add(event.phase)
            if (event.phase == "worktrees-committed" && event.operation) {
                validateOperationIntegrity(event.operation, "operation.journal-corrupt")
                execution.intent.operation = event.operation
            }
        }

        let pending = [...executions.values()].filter(execution => !execution.phases.has("finalized"))
        if (!pending.length && content.length && content.at(-1) == 10 && content.length != checkpoint?.length) {
            // A disposable verification checkpoint, never a replacement for the journal. Hash every
            // historical byte on each read; any edit forces full validation. Pending work is never cached.
            let data = JSON.stringify({ version: 1, length: content.length, hash: journalDigest(content), executions: [...finalized, ...executions.keys()] })
            let temporary = `${checkpointPath}.${crypto.randomUUID()}.tmp`
            let file = await open(temporary, "wx")
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

async function readJournalCheckpoint(path: string, content: Buffer): Promise<{ length: number; executions: string[] } | undefined> {
    try {
        let envelope = JSON.parse(await readFile(path, "utf8"))
        if (typeof envelope.data != "string" || journalDigest(envelope.data) != envelope.hash)
            return

        let value = JSON.parse(envelope.data)
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

function journalDigest(content: string | Buffer) {
    return new Bun.CryptoHasher("sha256").update(content).digest("hex")
}

async function appendJsonLine(path: string, value: unknown) {
    let handle = await open(path, "a")
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
        let lock = JSON.parse(await readFile(path, "utf8")) as { token?: string }
        if (lock.token == token)
            await unlink(path)
    } catch (error) {
        if (!isNotFound(error))
            throw error
    }
}

async function reclaimStaleLock(path: string) {
    try {
        let lock = JSON.parse(await readFile(path, "utf8")) as { pid?: number }
        if (lock.pid && isProcessAlive(lock.pid))
            return false

        let stalePath = `${path}.stale-${crypto.randomUUID()}`
        await rename(path, stalePath)
        await unlink(stalePath)
        return true
    } catch (error) {
        if (isNotFound(error))
            return true
        let stalePath = `${path}.stale-${crypto.randomUUID()}`
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
    for (let entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith("mutation.lock.candidate-"))
            continue

        let path = resolve(directory, entry.name)
        try {
            let lock = JSON.parse(await readFile(path, "utf8")) as { pid?: number }
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
