import { z } from "zod"
import { CompositionPreviewSchema, CompositionRequestSchema, RewordRequestSchema } from "./composition"

let oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)

export let LocalRequestSchema = z.discriminatedUnion("action", [
    CompositionRequestSchema,
    RewordRequestSchema,
    z.object({
        action: z.literal("commit"),
        path: z.string(),
        title: z.string().trim().min(1),
        message: z.string().default(""),
        acceptHooks: z.string().optional(),
    }),
    z.object({ action: z.literal("stage"), path: z.string(), files: z.array(z.string().min(1)).optional(), unstage: z.boolean().default(false) }),
    z.object({ action: z.literal("branch-create"), name: z.string().min(1), commit: oid.optional(), path: z.string().optional() }),
    z.object({ action: z.literal("branch-rename"), name: z.string().min(1), newName: z.string().min(1) }),
    z.object({ action: z.literal("branch-delete"), name: z.string().min(1), confirmed: z.boolean().default(false) }),
    z.object({ action: z.literal("stash-create"), path: z.string(), label: z.string().default("") }),
    z.object({ action: z.literal("stash-apply"), path: z.string(), objectId: oid }),
    z.object({ action: z.literal("stash-drop"), objectId: oid }),
])
export type LocalRequest = z.infer<typeof LocalRequestSchema>

export let LocalPreviewSchema = z.object({
    composition: CompositionPreviewSchema.optional(),
    token: z.string(),
    affected: z.array(z.string()),
    uniqueCommits: z.boolean(),
    branch: z.string().optional(),
    unborn: z.boolean(),
    suggestedBranch: z.string(),
    staged: z.boolean(),
    files: z.array(z.string()),
    stashes: z.array(z.object({ objectId: z.string(), label: z.string(), branch: z.string().nullable() })),
    worktrees: z.array(z.object({ path: z.string(), name: z.string(), branch: z.string().optional() })),
})
export type LocalPreview = z.infer<typeof LocalPreviewSchema>

export let LocalResultSchema = z.object({
    type: z.literal("result"),
    command: z.enum(["local", "local-preview"]),
    status: z.enum(["performed", "preview", "hook-review", "failed"]),
    preview: LocalPreviewSchema.optional(),
    message: z.string().optional(),
    changedFiles: z.array(z.string()).optional(),
    hookToken: z.string().optional(),
})
export type LocalResult = z.infer<typeof LocalResultSchema>
export type LocalActionResult = { ok: true; result: LocalResult } | { ok: false; error: { message: string; code?: string } }

export interface CommitDraft {
    title: string
    message: string
    branch: string
}

export let CommitDraftSchema = z.object({ title: z.string(), message: z.string(), branch: z.string() })
