import { z } from "zod"
import type { BranchHistoryCommit, ChangedFile, EntryError } from "./index"

export const FileHistorySourceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("branch"), ref: z.string().regex(/^refs\/(heads|remotes)\/[^\0]+$/) }),
    z.object({ kind: z.literal("worktree"), worktreePath: z.string().min(1) }),
    z.object({ kind: z.literal("commit"), objectId: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }),
])
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const path = z.string().min(1).refine(value => !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") && !value.split("/").includes(".."))
export const FileHistoryRequestSchema = z.object({
    source: FileHistorySourceSchema,
    path,
    cursor: z.object({ objectId, path }).optional(),
    blame: z.object({ objectId, path, offset: z.number().int().nonnegative().optional() }).optional(),
})
export type FileHistorySource = z.infer<typeof FileHistorySourceSchema>
export type FileHistoryRequest = z.infer<typeof FileHistoryRequestSchema>
export interface FileHistoryEntry extends BranchHistoryCommit {
    path: string
    previousPath?: string
    followedParent?: string
    status: string
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
}
export type FileHistoryResult = { ok: true; page: FileHistoryPage } | { ok: false; error: EntryError }
