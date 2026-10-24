import { z } from "zod"

let oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
let branchRef = z.string().regex(/^refs\/heads\/.+/)

export let PublishRequestSchema = z.discriminatedUnion("action", [
    // A branch's Active Stack, planned without fetching.
    z.object({ action: z.literal("plan"), branch: branchRef, remote: z.string().min(1).optional() }),
    // Each branch's Active Stack, as `plan` would plan it, from one reading of the repository and without the latest receipt.
    z.object({ action: z.literal("plans"), branches: z.array(branchRef).min(1), remote: z.string().min(1).optional() }),
    // The token of a reviewed plan; publication is refused if planning now gives a different result.
    z.object({ action: z.literal("publish"), branch: branchRef, remote: z.string().min(1).optional(), token: z.string().optional() }),
    z.object({ action: z.literal("resume"), receipt: z.string().min(1) }),
    z.object({ action: z.literal("restore"), receipt: z.string().min(1) }),
])
export type PublishRequest = z.infer<typeof PublishRequestSchema>

export let PublishUpdateSchema = z.object({
    branch: z.string(),
    remote: z.string(),
    // The same-named destination on the remote.
    ref: branchRef,
    // The remote tip the lease requires; null requires the ref to be absent.
    expected: oid.nullable(),
    // null deletes the remote branch, which only restoration does.
    target: oid.nullable(),
    // create: no remote branch yet; update: fast-forward; force: lease-guarded non-fast-forward; delete: restoration of a created branch.
    kind: z.enum(["create", "update", "force", "delete"]),
    // Record <remote>/<branch> as the branch's upstream once published.
    setUpstream: z.boolean(),
})
export type PublishUpdate = z.infer<typeof PublishUpdateSchema>

export let PublishUpdateStatusSchema = z.enum(["pending", "published", "stale", "failed"])
export type PublishUpdateStatus = z.infer<typeof PublishUpdateStatusSchema>

export let PublishReceiptSchema = z.object({
    version: z.literal(1),
    id: z.string(),
    timestamp: z.string(),
    kind: z.enum(["publish", "restore"]),
    // The receipt whose earlier remote tips a restoration publishes.
    restores: z.string().optional(),
    // Stack order: the Base Branch first, the column's branch last.
    stack: z.array(z.string()),
    mode: z.enum(["atomic", "sequential"]).optional(),
    updates: z.array(PublishUpdateSchema.extend({ status: PublishUpdateStatusSchema, message: z.string().optional() })),
})
export type PublishReceipt = z.infer<typeof PublishReceiptSchema>

export let PublishPlanSchema = z.object({
    stack: z.array(z.string()),
    updates: z.array(PublishUpdateSchema),
    token: z.string(),
    // Why nothing can be published, when something prevents it.
    blocked: z.string().optional(),
    // The newest receipt touching this stack, for Resume and restoration.
    receipt: PublishReceiptSchema.optional(),
})
export type PublishPlan = z.infer<typeof PublishPlanSchema>

export let PublishBranchPlanSchema = z.object({
    branch: branchRef,
    // The plan's summary, as a `plan` result's message, or why the branch couldn't be planned.
    message: z.string(),
    plan: PublishPlanSchema.optional(),
})
export type PublishBranchPlan = z.infer<typeof PublishBranchPlanSchema>

export let PublishResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("publish"),
    // stale: a lease no longer matched the remote; the next action is Pull latest.
    status: z.enum(["planned", "nothing", "blocked", "published", "partial", "stale", "failed"]),
    message: z.string(),
    plan: PublishPlanSchema.optional(),
    // A `plans` request's plans, in request order.
    plans: z.array(PublishBranchPlanSchema).optional(),
    receipt: PublishReceiptSchema.optional(),
})
export type PublishResult = z.infer<typeof PublishResultSchema>

export function publishReceiptStatus(receipt: PublishReceipt): "published" | "partial" | "stale" | "failed" {
    let published = receipt.updates.filter(update => update.status == "published").length
    return published == receipt.updates.length
        ? "published"
        : receipt.updates.some(update => update.status == "stale")
        ? "stale"
        : published
        ? "partial"
        : "failed"
}

export interface PublishProgress {
    repositoryId: string
    message: string
    completed: number
    total: number
}

export type PublishActionResult = { ok: true; result: PublishResult } | { ok: false; error: { message: string } }
