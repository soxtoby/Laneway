import { z } from "zod"

export let OperationSummarySchema = z.object({
    id: z.string(),
    timestamp: z.string(),
    kind: z.string(),
    summary: z.string(),
    affectedRefs: z.array(z.string()),
    affectedWorktrees: z.array(z.string()),
})

export let OperationAvailabilityReasonSchema = z.enum([
    "empty",
    "ref-changed",
    "index-changed",
    "worktree-changed",
    "git-lockfile-present",
    "precondition-failed",
])

export let OperationTransitionResultSchema = z.object({
    type: z.literal("result"),
    command: z.enum(["undo", "redo"]),
    status: z.enum(["performed", "unavailable"]),
    reason: OperationAvailabilityReasonSchema.optional(),
    operation: OperationSummarySchema.optional(),
})

export let OperationHistoryEntrySchema = OperationSummarySchema.extend({
    state: z.enum(["applied", "undone"]),
    isNextUndo: z.boolean(),
    isNextRedo: z.boolean(),
})

export let OperationAvailabilitySchema = z.object({
    available: z.boolean(),
    operationId: z.string().optional(),
    reason: OperationAvailabilityReasonSchema.optional(),
})

export let OperationHistoryResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("history"),
    position: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    entries: z.array(OperationHistoryEntrySchema).max(10),
    undo: OperationAvailabilitySchema,
    redo: OperationAvailabilitySchema,
})

export let TestMutationResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("test-mutation"),
    operation: OperationSummarySchema,
})

export let WorktreeResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("worktree"),
    operation: OperationSummarySchema,
})

export type WorktreeResult = z.infer<typeof WorktreeResultSchema>

export let RecoveredExecutionSchema = z.object({
    action: z.enum(["apply", "undo", "redo"]),
    operation: OperationSummarySchema,
})

export let RecoveryResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("recover"),
    status: z.enum(["clean", "recovered"]),
    recovered: z.array(RecoveredExecutionSchema),
    backupPath: z.string().optional(),
})

export type OperationSummary = z.infer<typeof OperationSummarySchema>

export type OperationAvailabilityReason = z.infer<typeof OperationAvailabilityReasonSchema>

export type OperationTransitionResult = z.infer<typeof OperationTransitionResultSchema>

export type OperationHistoryEntry = z.infer<typeof OperationHistoryEntrySchema>

export type OperationAvailability = z.infer<typeof OperationAvailabilitySchema>

export type OperationHistoryResult = z.infer<typeof OperationHistoryResultSchema>

export type TestMutationResult = z.infer<typeof TestMutationResultSchema>

export type RecoveredExecution = z.infer<typeof RecoveredExecutionSchema>

export type RecoveryResult = z.infer<typeof RecoveryResultSchema>
