import { z } from "zod"

export const ENGINE_VERSION = "0.1.0"

export const ExitCode = {
    ok: 0,
    failure: 1,
    usage: 2,
    cancelled: 3,
} as const

export const ErrorCodeSchema = z.enum([
    "usage.invalid-argument",
    "usage.unknown-command",
    "engine.internal",
    "git.unavailable",
    "git.too-old",
    "git.invalid-root",
    "git.bare-repository",
    "git.missing-main-worktree",
    "git.unsupported-format",
    "git.authentication-required",
    "git.destination-conflict",
    "git.cancelled",
    "git.command-failed",
    "settings.corrupt",
    "settings.write-failed",
    "operation.history-corrupt",
    "operation.internal",
    "operation.journal-corrupt",
    "operation.locked",
    "operation.precondition-failed",
    "operation.recovery-blocked",
])

export const ProgressEventSchema = z.object({
    type: z.literal("progress"),
    command: z.string(),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    message: z.string(),
})

export const EchoResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("echo"),
    message: z.string(),
})

export const OperationSummarySchema = z.object({
    id: z.string(),
    timestamp: z.string(),
    kind: z.string(),
    summary: z.string(),
    affectedRefs: z.array(z.string()),
    affectedWorktrees: z.array(z.string()),
})

export const OperationAvailabilityReasonSchema = z.enum([
    "empty",
    "ref-changed",
    "index-changed",
    "worktree-changed",
    "git-lockfile-present",
    "precondition-failed",
])

export const OperationTransitionResultSchema = z.object({
    type: z.literal("result"),
    command: z.enum(["undo", "redo"]),
    status: z.enum(["performed", "unavailable"]),
    reason: OperationAvailabilityReasonSchema.optional(),
    operation: OperationSummarySchema.optional(),
})

export const OperationHistoryEntrySchema = OperationSummarySchema.extend({
    state: z.enum(["applied", "undone"]),
    isNextUndo: z.boolean(),
    isNextRedo: z.boolean(),
})

export const OperationAvailabilitySchema = z.object({
    available: z.boolean(),
    operationId: z.string().optional(),
    reason: OperationAvailabilityReasonSchema.optional(),
})

export const OperationHistoryResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("history"),
    position: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    entries: z.array(OperationHistoryEntrySchema).max(10),
    undo: OperationAvailabilitySchema,
    redo: OperationAvailabilitySchema,
})

export const TestMutationResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("test-mutation"),
    operation: OperationSummarySchema,
})

export const RecoveredExecutionSchema = z.object({
    action: z.enum(["apply", "undo", "redo"]),
    operation: OperationSummarySchema,
})

export const RecoveryResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("recover"),
    status: z.enum(["clean", "recovered"]),
    recovered: z.array(RecoveredExecutionSchema),
})

export const CancelledEventSchema = z.object({
    type: z.literal("cancelled"),
    command: z.string(),
    message: z.string(),
})

export const ErrorEventSchema = z.object({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
})

export const EngineMessageSchema = z.union([
    ProgressEventSchema,
    EchoResultSchema,
    OperationTransitionResultSchema,
    OperationHistoryResultSchema,
    TestMutationResultSchema,
    RecoveryResultSchema,
    CancelledEventSchema,
    ErrorEventSchema,
])

export type ErrorCode = z.infer<typeof ErrorCodeSchema>
export type ProgressEvent = z.infer<typeof ProgressEventSchema>
export type EchoResult = z.infer<typeof EchoResultSchema>
export type OperationSummary = z.infer<typeof OperationSummarySchema>
export type OperationAvailabilityReason = z.infer<typeof OperationAvailabilityReasonSchema>
export type OperationTransitionResult = z.infer<typeof OperationTransitionResultSchema>
export type OperationHistoryEntry = z.infer<typeof OperationHistoryEntrySchema>
export type OperationAvailability = z.infer<typeof OperationAvailabilitySchema>
export type OperationHistoryResult = z.infer<typeof OperationHistoryResultSchema>
export type TestMutationResult = z.infer<typeof TestMutationResultSchema>
export type RecoveredExecution = z.infer<typeof RecoveredExecutionSchema>
export type RecoveryResult = z.infer<typeof RecoveryResultSchema>
export type CancelledEvent = z.infer<typeof CancelledEventSchema>
export type ErrorEvent = z.infer<typeof ErrorEventSchema>
export type EngineMessage = z.infer<typeof EngineMessageSchema>

export type ObjectFormat = "sha1" | "sha256"

export interface GitInstallationInfo {
    path: string
    version: string
}

export interface RepositoryInfo {
    id: string
    root: string
    mainWorktree: string
    selectedWorktree: string
    commonDirectory: string
    gitDirectory: string
    objectFormat: ObjectFormat
    shallow: boolean
    partial: boolean
    sparse: boolean
    git: GitInstallationInfo
}

export interface WorkbenchSession {
    repositories: RepositoryInfo[]
    activeRepositoryId?: string
}

export type EntryErrorCode =
    | "git.unavailable"
    | "git.too-old"
    | "git.invalid-root"
    | "git.bare-repository"
    | "git.missing-main-worktree"
    | "git.unsupported-format"
    | "git.authentication-required"
    | "git.destination-conflict"
    | "git.cancelled"
    | "git.command-failed"
    | "settings.corrupt"
    | "settings.write-failed"

export interface EntryError {
    code: EntryErrorCode
    message: string
    destination?: string
    canRemoveDestination?: boolean
}

export type EntryResult =
    | { ok: true; session: WorkbenchSession }
    | { ok: false; error: EntryError }

export interface EntryProgress {
    message: string
}

export interface GitSettingsState {
    path: string
    override?: string
    git?: GitInstallationInfo
    error?: EntryError
}
