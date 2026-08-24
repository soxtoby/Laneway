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
    "git.smoke-failed",
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

export const GitSmokeResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("git-smoke"),
    gitVersion: z.string(),
    repositoryRoot: z.string(),
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
    GitSmokeResultSchema,
    CancelledEventSchema,
    ErrorEventSchema,
])

export type ErrorCode = z.infer<typeof ErrorCodeSchema>
export type ProgressEvent = z.infer<typeof ProgressEventSchema>
export type EchoResult = z.infer<typeof EchoResultSchema>
export type GitSmokeResult = z.infer<typeof GitSmokeResultSchema>
export type CancelledEvent = z.infer<typeof CancelledEventSchema>
export type ErrorEvent = z.infer<typeof ErrorEventSchema>
export type EngineMessage = z.infer<typeof EngineMessageSchema>
