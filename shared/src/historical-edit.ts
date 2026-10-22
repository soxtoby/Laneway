import { z } from "zod"
import { OperationSummarySchema } from "./operation-history"

let oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)

/** The journaled context of one worktree's Historical Edit, stored at its private session ref. */
export let HistoricalEditSessionSchema = z.object({
    version: z.literal(1),
    worktreeId: z.string(),
    path: z.string(),
    /** The original branch, as a full ref. Return targets its current tip. */
    branch: z.string().regex(/^refs\/heads\/.+/),
    /** The original branch's tip as last seen by this session; any other movement makes the session stale. */
    tip: oid,
    /** The commit the user chose to edit from, which labels kept Historical Working Changes. */
    selected: oid,
    /** The commit currently checked out detached: the selected commit as rewritten by Apply and other transfers. */
    commit: oid,
    /** The ordinary stash holding the Working Changes from before the session, if there were any. */
    stash: oid.optional(),
    /** The temporary branch of an Unresolved Stack that pauses the session until its conflicts resolve. */
    unresolved: z.string().optional(),
})
export type HistoricalEditSession = z.infer<typeof HistoricalEditSessionSchema>

export let HistoricalEditStateSchema = z.enum(["active", "paused", "stale"])
export type HistoricalEditState = z.infer<typeof HistoricalEditStateSchema>

export let HistoricalEditSchema = HistoricalEditSessionSchema.extend({
    state: HistoricalEditStateSchema,
    /** Why the session is paused or stale. */
    reason: z.string().optional(),
})
export type HistoricalEdit = z.infer<typeof HistoricalEditSchema>

export let HistoricalEditRequestSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("enter"), path: z.string().min(1), commit: oid }),
    /** `clean` refuses when Historical Working Changes remain; `drop` and `bring` decide what happens to them. */
    z.object({ action: z.literal("return"), path: z.string().min(1), mode: z.enum(["clean", "drop", "bring"]).default("clean") }),
    z.object({ action: z.literal("restart"), path: z.string().min(1) }),
    z.object({ action: z.literal("status") }),
])
export type HistoricalEditRequest = z.infer<typeof HistoricalEditRequestSchema>

export let HistoricalEditResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("edit"),
    message: z.string(),
    sessions: z.array(HistoricalEditSchema),
    operation: OperationSummarySchema.optional(),
})
export type HistoricalEditResult = z.infer<typeof HistoricalEditResultSchema>

export type HistoricalEditActionResult = { ok: true; result: HistoricalEditResult } | { ok: false; error: { message: string } }
