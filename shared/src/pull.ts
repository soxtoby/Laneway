import { z } from "zod"
import { OperationSummarySchema } from "./operation-history"

let oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)

export let PullRequestSchema = z.object({
    // Branches whose Active Stacks are in scope, frozen at activation: a Workspace Column's, or those named.
    branches: z.array(z.string().regex(/^refs\/heads\/.+/)),
    // Every open Workspace Column's branch. An open stack sharing a branch above its Base with one in scope joins it,
    // so no open branch is left built on history the pull replaced.
    open: z.array(z.string().regex(/^refs\/heads\/.+/)).optional(),
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

export let FetchRequestSchema = z.object({
    // Open Workspace Column branches; their Active Stacks are left for Pull latest.
    branches: z.array(z.string().regex(/^refs\/heads\/.+/)),
    remote: z.string().min(1).optional(),
})
export type FetchRequest = z.infer<typeof FetchRequestSchema>

export let FetchResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("fetch"),
    status: z.enum(["no-remotes", "fetched", "cancelled"]),
    message: z.string(),
    fetches: z.array(PullFetchSchema),
    // Local branches moved to their upstream's tip.
    fastForwarded: z.array(z.string()),
})
export type FetchResult = z.infer<typeof FetchResultSchema>

export type FetchActionResult = { ok: true; result: FetchResult } | { ok: false; error: { message: string } }
