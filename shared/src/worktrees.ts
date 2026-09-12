import { z } from "zod"

export const WorktreeRequestSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("create"),
        branch: z.string().min(1).optional(),
        commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
        move: z.boolean().default(false),
    }),
    z.object({ action: z.literal("switch"), path: z.string(), branch: z.string().min(1), move: z.boolean().default(false) }),
    z.object({ action: z.literal("rename"), path: z.string(), basename: z.string().min(1) }),
    z.object({ action: z.literal("repair"), path: z.string(), destination: z.string() }),
    z.object({ action: z.literal("remove"), path: z.string(), preserve: z.boolean().default(true), allowIgnoredLoss: z.boolean().default(false) }),
    z.object({ action: z.literal("unlock"), path: z.string() }),
])
export type WorktreeRequest = z.infer<typeof WorktreeRequestSchema>

export interface RegisteredWorktree {
    id: string
    path: string
    name: string
    head: string
    branchRef?: string
    main: boolean
    locked: boolean
    lockReason?: string
    missing: boolean
    gitDirectory: string
}

export interface WorktreePreview {
    request: WorktreeRequest
    worktrees: RegisteredWorktree[]
    destination?: string
    affected: string[]
    ignored: string[]
    dirty: boolean
    uniqueCommits: boolean
    populatedSubmodules: boolean
    token: string
}

export type WorktreePreviewResult = { ok: true; preview: WorktreePreview } | { ok: false; error: { message: string } }
export type WorktreeActionResult = { ok: true } | { ok: false; error: { message: string } }
