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

let StashEntrySchema = z.object({ object: z.string(), message: z.string() })

let SubmoduleSchema = z.object({
    path: z.string(),
    head: z.string(),
    branchRef: z.string().optional(),
    stash: z.string().optional(),
    remotes: z.array(z.tuple([z.string(), z.string()])),
})

/** A linked worktree's registration, with its Working Changes retained when the registration is removed. */
export let RegistrationSchema = z.object({
    id: z.string(),
    path: z.string(),
    head: z.string(),
    branchRef: z.string().optional(),
    locked: z.boolean(),
    lockReason: z.string().optional(),
    stash: z.string().optional(),
    index: z.string().optional(),
    indexObjects: z.array(z.string()).optional(),
    submodules: z.array(SubmoduleSchema).default([]),
})

let TreesSchema = z.object({ index: z.string(), files: z.string() })

/** One change a Laneway Operation made, from its before side to its after side; applying the inverse swaps the sides. */
export let ChangeSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ref"), ref: z.string(), before: z.string().nullable(), after: z.string().nullable() }),
    z.object({ type: z.literal("head"), path: z.string(), before: z.string(), after: z.string() }),
    z.object({ type: z.literal("tree"), path: z.string(), before: TreesSchema, after: TreesSchema }),
    z.object({ type: z.literal("stashes"), before: z.array(StashEntrySchema), after: z.array(StashEntrySchema) }),
    z.object({ type: z.literal("config"), key: z.string(), before: z.array(z.string()), after: z.array(z.string()) }),
    z.object({ type: z.literal("metadata"), before: z.string().nullable(), after: z.string().nullable() }),
    z.object({ type: z.literal("worktree"), id: z.string(), before: RegistrationSchema.nullable(), after: RegistrationSchema.nullable() }),
])

/** The repository facts an operation may change, read in a handful of launches regardless of worktree count. */
export let SnapshotSchema = z.object({
    refs: z.record(z.string(), z.string()),
    worktrees: z.array(z.object({
        id: z.string(),
        path: z.string(),
        main: z.boolean(),
        head: z.string(),
        branchRef: z.string().optional(),
        locked: z.boolean(),
        lockReason: z.string().optional(),
        missing: z.boolean(),
    })),
    stashes: z.array(StashEntrySchema),
    branchConfig: z.array(z.tuple([z.string(), z.string()])),
    metadata: z.string().nullable(),
})

let StoredOperationContentSchema = OperationSummarySchema.extend({
    gitCommonDirectory: z.string(),
    expectedGitLockfiles: z.array(z.string()),
    refChanges: z.array(RefChangeSchema),
    worktreeChanges: z.array(WorktreeChangeSchema),
    /** The changes the operation made, in its forward direction ([ADR 0023](../../../docs/adr/0023-undo-reverses-recorded-changes.md)). */
    changes: z.array(ChangeSchema).optional(),
    /** The worktree a removal takes away, retained with its Working Changes before anything happens. */
    removing: RegistrationSchema.optional(),
    /** Journaled so an interruption reverses it, but never entered in Operation History. */
    transient: z.boolean().optional(),
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

/** Current executions journal intent, recorded, history-committed, and finalized; the rest are read from older journals. */
let JournalPhaseSchema = z.enum([
    "intent",
    "recorded",
    "recovery-retained",
    "preconditions-verified",
    "worktrees-committed",
    "refs-committed",
    "history-committed",
    "finalized",
    "cancelled",
    "aborted",
])

export let crashPhases = ["intent", "recorded", "history-committed", "finalized"] as const satisfies JournalPhase[]

export let JournalEventSchema = z.object({
    schemaVersion: z.literal(1),
    executionId: z.string(),
    operationId: z.string(),
    action: z.enum(["apply", "undo", "redo"]),
    phase: JournalPhaseSchema,
    timestamp: z.string(),
    operation: StoredOperationSchema.optional(),
    /** The repository as the execution found it, which recovery compares against when the record was never written. */
    snapshot: SnapshotSchema.optional(),
    abandonedOperationIds: z.array(z.string()).optional(),
})

export type RefChange = z.infer<typeof RefChangeSchema>

export type WorktreeFingerprint = z.infer<typeof WorktreeFingerprintSchema>

export type Change = z.infer<typeof ChangeSchema>

export type Registration = z.infer<typeof RegistrationSchema>

export type Snapshot = z.infer<typeof SnapshotSchema>

export type StashEntry = z.infer<typeof StashEntrySchema>

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
