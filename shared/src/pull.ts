import { z } from "zod"
import { OperationSummarySchema } from "./operation-history"

let oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)

export let PullRequestSchema = z.object({
    // Open Workspace Column branches whose Active Stacks are in scope, frozen at activation.
    branches: z.array(z.string().regex(/^refs\/heads\/.+/)),
    remote: z.string().min(1).optional(),
})
export type PullRequest = z.infer<typeof PullRequestSchema>

export let PullFetchSchema = z.object({
    remote: z.string(),
    status: z.enum(["fetched", "failed"]),
    message: z.string().optional(),
})
export type PullFetch = z.infer<typeof PullFetchSchema>

export let PullStackStatusSchema = z.enum(["updated", "current", "needs-resolution", "skipped", "failed", "cancelled"])
export type PullStackStatus = z.infer<typeof PullStackStatusSchema>

export let PullStackOutcomeSchema = z.object({
    id: z.string(),
    // Stack order: the Base Branch first, the column's branch last.
    branches: z.array(z.string()),
    base: z.object({ ref: z.string(), before: oid.nullable(), after: oid.nullable() }).optional(),
    status: PullStackStatusSchema,
    message: z.string().optional(),
    conflicts: z.number().int().nonnegative().optional(),
    workingConflicts: z.number().int().nonnegative().optional(),
})
export type PullStackOutcome = z.infer<typeof PullStackOutcomeSchema>

export let PullResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("pull"),
    status: z.enum(["no-remotes", "fetched", "updated", "cancelled"]),
    message: z.string(),
    fetches: z.array(PullFetchSchema),
    stacks: z.array(PullStackOutcomeSchema),
    operation: OperationSummarySchema.optional(),
})
export type PullResult = z.infer<typeof PullResultSchema>

export interface PullProgress {
    repositoryId: string
    message: string
    completed: number
    total: number
}

export type PullActionResult = { ok: true; result: PullResult } | { ok: false; error: { message: string } }
