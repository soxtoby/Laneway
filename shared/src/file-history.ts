import { z } from "zod"
import type { BranchHistoryCommit, ChangedFile, EntryError } from "./index"

export let FileHistorySourceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("branch"), ref: z.string().regex(/^refs\/(heads|remotes)\/[^\0]+$/) }),
    z.object({ kind: z.literal("worktree"), worktreePath: z.string().min(1) }),
    z.object({ kind: z.literal("commit"), objectId: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }),
])

let objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
let path = z.string().min(1).refine(value => !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") && !value.split("/").includes(".."))

export let FileHistoryRequestSchema = z.object({
    source: FileHistorySourceSchema,
    path,
    limit: z.number().int().min(1).max(40).optional(),
    cursor: z.object({ objectId, path }).optional(),
    blame: z.object({ objectId, path, offset: z.number().int().nonnegative().optional() }).optional(),
    related: z.object({ objectId, path, parentId: objectId.optional(), offset: z.number().int().nonnegative().optional() }).optional(),
    choices: z.array(z.object({ objectId, path, previousPath: path })).max(100).optional(),
    composition: z.object({ tip: objectId, primaryTip: objectId }).optional(),
})

export type FileHistorySource = z.infer<typeof FileHistorySourceSchema>
export type FileHistoryRequest = z.infer<typeof FileHistoryRequestSchema>

export interface FileHistoryEntry extends BranchHistoryCommit {
    path: string
    previousPath?: string
    followedParent?: string
    status: string
    candidates?: string[]
    composable?: boolean
}

export interface BlameLine {
    objectId: string
    path: string
    originalLine: number
    line: number
    text: string
    author: string
}

export interface FileHistoryPage {
    tip?: string
    entries: FileHistoryEntry[]
    working?: ChangedFile
    cursor?: { objectId: string; path: string }
    blame?: BlameLine[]
    nextBlameOffset?: number
    notice?: string
    related?: RelatedFile[]
    nextRelatedOffset?: number
}

export interface RelatedFile {
    path: string
    objectId: string
    evidence: "rename/copy" | "shared lines" | "changed together"
    score: number
}

export type FileHistoryResult = { ok: true; page: FileHistoryPage } | { ok: false; error: EntryError }
