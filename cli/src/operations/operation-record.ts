import { OperationSummarySchema } from "@laneway/shared"
import { z } from "zod"
import { WorktreeStateSchema } from "../worktrees/worktree-state"
import { GitCheckpointSchema } from "./git-checkpoint"
import { NativeUndoSchema } from "./native-undo-record"
import { OperationRuntimeError } from "./operation-contracts"

let RefChangeSchema = z.object({
    ref: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
})

let WorktreeFingerprintSchema = z.object({
    index: z.string(),
    worktree: z.string(),
})

let WorktreeChangeSchema = z.object({
    path: z.string(),
    before: WorktreeFingerprintSchema,
    after: WorktreeFingerprintSchema,
})

let StoredOperationContentSchema = OperationSummarySchema.extend({
    gitCommonDirectory: z.string(),
    expectedGitLockfiles: z.array(z.string()),
    refChanges: z.array(RefChangeSchema),
    worktreeChanges: z.array(WorktreeChangeSchema),
    lifecycle: z.object({ before: WorktreeStateSchema, after: WorktreeStateSchema.optional() }).optional(),
    checkpoint: z.object({ restore: GitCheckpointSchema, expected: GitCheckpointSchema }).optional(),
    nativeUndo: NativeUndoSchema.optional(),
})

let StoredOperationSchema = StoredOperationContentSchema.extend({
    integrity: z.string().regex(/^[0-9a-f]{64}$/),
})

let OperationEventSchema = z.object({
    schemaVersion: z.literal(1),
    type: z.literal("operation"),
    executionId: z.string(),
    operation: StoredOperationSchema,
})

let TransitionEventSchema = z.object({
    schemaVersion: z.literal(1),
    type: z.literal("transition"),
    executionId: z.string(),
    action: z.enum(["undo", "redo"]),
    operationId: z.string(),
    timestamp: z.string(),
    operation: StoredOperationSchema.optional(),
})

export let HistoryEventSchema = z.discriminatedUnion("type", [OperationEventSchema, TransitionEventSchema])

let JournalPhaseSchema = z.enum([
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

export let JournalEventSchema = z.object({
    schemaVersion: z.literal(1),
    executionId: z.string(),
    operationId: z.string(),
    action: z.enum(["apply", "undo", "redo"]),
    phase: JournalPhaseSchema,
    timestamp: z.string(),
    operation: StoredOperationSchema.optional(),
    abandonedOperationIds: z.array(z.string()).optional(),
})

export type RefChange = z.infer<typeof RefChangeSchema>

export type WorktreeFingerprint = z.infer<typeof WorktreeFingerprintSchema>

export type StoredOperation = z.infer<typeof StoredOperationSchema>

export type HistoryEvent = z.infer<typeof HistoryEventSchema>

export type JournalPhase = z.infer<typeof JournalPhaseSchema>

export type JournalEvent = z.infer<typeof JournalEventSchema>

export interface JournalExecution {
    intent: JournalEvent & { operation: StoredOperation }
    phases: Set<JournalPhase>
}

export interface HistoryProjection {
    operations: StoredOperation[]
    position: number
}

export function sealOperation(content: z.input<typeof StoredOperationContentSchema>): StoredOperation {
    let parsed = StoredOperationContentSchema.parse(content)
    return { ...parsed, integrity: operationIntegrity(parsed) }
}

export function validateOperationIntegrity(
    operation: StoredOperation,
    code: "operation.history-corrupt" | "operation.journal-corrupt",
) {
    let { integrity, ...content } = operation
    if (integrity != operationIntegrity(content))
        throw new OperationRuntimeError(code, "A stored Laneway Operation failed its integrity check.")
}

function operationIntegrity(content: z.output<typeof StoredOperationContentSchema>) {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(content)).digest("hex")
}
