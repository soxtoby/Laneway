import { z } from "zod"

export let WorktreeRequestSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("create"),
        branch: z.string().min(1).optional(),
        commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
        move: z.boolean().default(false),
    }),
    z.object({ action: z.literal("switch"), path: z.string(), branch: z.string().min(1), move: z.boolean().default(false) }),
    z.object({ action: z.literal("rename"), path: z.string(), basename: z.string().min(1) }),
    z.object({ action: z.literal("repair"), path: z.string(), destination: z.string() }),
    z.object({ action: z.literal("remove"), path: z.string(), preserve: z.boolean().default(true) }),
    z.object({ action: z.literal("unlock"), path: z.string() }),
])
export type WorktreeRequest = z.infer<typeof WorktreeRequestSchema>

export let RegisteredWorktreeSchema = z.object({
    id: z.string(),
    path: z.string(),
    name: z.string(),
    head: z.string(),
    branchRef: z.string().optional(),
    main: z.boolean(),
    locked: z.boolean(),
    lockReason: z.string().optional(),
    missing: z.boolean(),
    gitDirectory: z.string(),
})
export type RegisteredWorktree = z.infer<typeof RegisteredWorktreeSchema>

export let WorktreeListResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("worktree-list"),
    worktrees: z.array(RegisteredWorktreeSchema),
})

export interface WorktreePreview {
    request: WorktreeRequest
    worktrees: RegisteredWorktree[]
    destination?: string
    affected: string[]
    /** Up to twenty worktree-relative ignored entries, with whole ignored directories shown as `name/`. */
    ignored: string[]
    /** Every ignored entry, including those beyond the first twenty. */
    ignoredCount: number
    dirty: boolean
    uniqueCommits: boolean
    populatedSubmodules: boolean
    token: string
}

export type WorktreePreviewResult = { ok: true; preview: WorktreePreview } | { ok: false; error: { message: string } }
export type WorktreeActionResult = { ok: true } | { ok: false; error: { message: string } }
