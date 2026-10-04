import { z } from "zod"

export const WorktreeRecoverySchema = z.object({
    operationId: z.string(),
    worktreeId: z.string(),
    path: z.string(),
    head: z.string(),
    branchRef: z.string().optional(),
    message: z.string(),
    backupPath: z.string().optional(),
})
export type WorktreeRecovery = z.infer<typeof WorktreeRecoverySchema>

export const RecoveryRequestSchema = z.object({
    operationId: z.string().uuid(),
    action: z.enum(["restore", "remove"]),
})
export type RecoveryRequest = z.infer<typeof RecoveryRequestSchema>

export const RecoveryStatusResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("recovery-status"),
    worktrees: z.array(WorktreeRecoverySchema),
})
export type RecoveryStatusResult = z.infer<typeof RecoveryStatusResultSchema>

export type RecoveryActionResult =
    | { ok: true; backupPath?: string }
    | { ok: false; error: { message: string } }
