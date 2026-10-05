import { z } from "zod"
import { ConflictResultSchema } from "./conflicts"
import { LocalResultSchema } from "./local-operations"
import { OperationHistoryResultSchema, OperationTransitionResultSchema, RecoveryResultSchema, TestMutationResultSchema, WorktreeResultSchema } from "./operation-history"
import { PullResultSchema } from "./pull"
import { RecoveryStatusResultSchema } from "./worktree-recovery"

export let engineVersion = "0.1.0"

export let ExitCode = {
    ok: 0,
    failure: 1,
    usage: 2,
    cancelled: 3,
} as const

export let ErrorCodeSchema = z.enum([
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

export let ProgressEventSchema = z.object({
    type: z.literal("progress"),
    command: z.string(),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    message: z.string(),
})

export let EchoResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("echo"),
    message: z.string(),
})

export let CancelledEventSchema = z.object({
    type: z.literal("cancelled"),
    command: z.string(),
    message: z.string(),
})

export let ErrorEventSchema = z.object({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
})

export let EngineMessageSchema = z.union([
    ProgressEventSchema,
    EchoResultSchema,
    OperationTransitionResultSchema,
    OperationHistoryResultSchema,
    TestMutationResultSchema,
    WorktreeResultSchema,
    LocalResultSchema,
    ConflictResultSchema,
    PullResultSchema,
    RecoveryResultSchema,
    RecoveryStatusResultSchema,
    CancelledEventSchema,
    ErrorEventSchema,
])

export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export type ProgressEvent = z.infer<typeof ProgressEventSchema>

export type EchoResult = z.infer<typeof EchoResultSchema>

export type CancelledEvent = z.infer<typeof CancelledEventSchema>

export type ErrorEvent = z.infer<typeof ErrorEventSchema>

export type EngineMessage = z.infer<typeof EngineMessageSchema>
