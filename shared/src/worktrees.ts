import { z } from "zod"

/**
 * A checkout of a remote-tracking branch makes a local branch to track it. When a local branch already has its name,
 * `reset` moves that branch to it and `new` makes one under the next free name instead.
 */
let LocalBranchChoiceSchema = z.enum(["reset", "new"]).optional()

export let WorktreeRequestSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("create"),
        branch: z.string().min(1).optional(),
        commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
        move: z.boolean().default(false),
        local: LocalBranchChoiceSchema,
    }),
    z.object({ action: z.literal("switch"), path: z.string(), branch: z.string().min(1), move: z.boolean().default(false), local: LocalBranchChoiceSchema }),
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

/** The local branch a checkout of a remote-tracking branch makes, or resets, to track it. */
export interface TrackingBranch {
    remoteRef: string
    /** The remote branch's name on its remote, which the local branch takes. */
    name: string
    /** A local branch has the name already. */
    taken: boolean
    /** The name with the first counter no local branch has, for a new branch beside a taken one. */
    alternative: string
}

/** The local branch a checkout of a remote-tracking branch leaves checked out, given the choice made for a taken name. */
export function trackingBranchName(tracking: TrackingBranch, choice?: "reset" | "new") {
    return tracking.taken && choice == "new" ? tracking.alternative : tracking.name
}

export interface WorktreePreview {
    request: WorktreeRequest
    worktrees: RegisteredWorktree[]
    destination?: string
    /** Set when the request checks out a remote-tracking branch. */
    tracking?: TrackingBranch
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
