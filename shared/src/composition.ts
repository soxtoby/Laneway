import { z } from "zod"

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const branch = z.string().min(1)
export const CompositionSourceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("working"), worktreePath: z.string().min(1) }),
    z.object({ kind: z.literal("commit"), objectId: oid, parentId: oid.optional(), branch: branch.optional() }),
    z.object({ kind: z.literal("branch"), branch, tip: oid }),
])
export const CompositionTargetSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("working"), worktreePath: z.string().min(1) }),
    z.object({ kind: z.literal("commit"), objectId: oid, branch }),
    z.object({ kind: z.literal("seam"), parentId: oid, branch }),
    z.object({ kind: z.literal("branch"), branch, tip: oid }),
])
export const CompositionRequestSchema = z.object({
    action: z.literal("compose"),
    source: CompositionSourceSchema,
    target: CompositionTargetSchema,
    mode: z.enum(["move", "copy"]),
    files: z.array(z.object({ path: z.string().min(1), version: z.string().optional(), lineIds: z.array(z.number().int().nonnegative()).min(1).optional() }))
        .optional(),
    inventoryVersion: z.string().optional(),
    selectedRemote: z.string().optional(),
    view: z.enum(["combined", "staged", "unstaged"]).default("combined"),
    message: z.string().default(""),
    descendants: z.boolean().default(true),
    allowConflicts: z.boolean().default(false),
})
export const CompositionPreviewSchema = z.object({
    branches: z.array(z.string()),
    removed: z.array(z.string()),
    conflicts: z.array(z.object({ subject: z.string(), files: z.array(z.string()) })),
    published: z.array(z.string()),
    skipped: z.array(z.string()),
    noop: z.boolean(),
    /** Commits a branch rebase takes onto its destination, oldest first. */
    commits: z.array(z.object({ objectId: oid, subject: z.string() })).optional(),
})
export type CompositionRequest = z.infer<typeof CompositionRequestSchema>
export type CompositionSource = z.infer<typeof CompositionSourceSchema>
export type CompositionTarget = z.infer<typeof CompositionTargetSchema>
export type CompositionPreview = z.infer<typeof CompositionPreviewSchema>
