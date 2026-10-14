import { z } from "zod"
import { type EntryError } from "./workspace"

export type DiffLayout = "unified" | "split"

export type DiffSource =
    | { kind: "working"; worktreePath: string }
    | { kind: "commit"; objectId: string; parentId?: string }
    /** `mergeBase` starts the diff at the branches' merge base instead of `fromRef`'s tip, so only `toRef`'s own changes show. */
    | { kind: "branches"; fromRef: string; toRef: string; mergeBase?: boolean }
    | { kind: "comparison"; fromObjectId: string; toObjectId: string }

export interface ChangedFile {
    path: string
    oldPath?: string
    status: string
    staged: boolean
    unstaged: boolean
    untracked: boolean
    ignored: boolean
    conflicted: boolean
    submodule?: string
    oldMode?: string
    newMode?: string
}

export interface ChangesRequest {
    source: DiffSource
    includeIgnored?: boolean
    offset?: number
}

export interface ChangesInventory {
    source: DiffSource
    version: string
    files: ChangedFile[]
    parents: string[]
    nextOffset?: number
}

export type DiffView = "combined" | "staged" | "unstaged" | "base" | "ours" | "theirs"

export interface FileDiffRequest {
    source: DiffSource
    path: string
    view?: DiffView
    entireFile?: boolean
    offset?: number
    inventoryVersion?: string
    // Bypass preview snapshots and validate fresh content before using a selection or extending a page.
    expectedVersion?: string
}

export interface DiffLine {
    id: number
    kind: "context" | "addition" | "deletion" | "hunk" | "notice"
    text: string
    oldLine?: number
    newLine?: number
    hunk: number
}

export interface FileDiffPage {
    source: DiffSource
    file: ChangedFile
    view: DiffView
    entireFile?: boolean
    version: string
    lines: DiffLine[]
    nextOffset?: number
    summary: string[]
    selectable: boolean
}

export interface ChangeSelection {
    source: DiffSource
    path: string
    version: string
    lineIds: number[]
    rename: boolean
}

export type ChangesResult = { ok: true; inventory: ChangesInventory } | { ok: false; error: EntryError }

export type FileDiffResult = { ok: true; page: FileDiffPage } | { ok: false; error: EntryError }

export let DiffSourceSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("branches"),
        fromRef: z.string().regex(/^refs\/(heads|remotes)\/.+/),
        toRef: z.string().regex(/^refs\/(heads|remotes)\/.+/),
        mergeBase: z.boolean().optional(),
    }),
    z.object({
        kind: z.literal("comparison"),
        fromObjectId: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        toObjectId: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    }),
    z.object({ kind: z.literal("working"), worktreePath: z.string().min(1) }),
    z.object({
        kind: z.literal("commit"),
        objectId: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        parentId: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
    }),
])

export let ChangesRequestSchema = z.object({
    source: DiffSourceSchema,
    includeIgnored: z.boolean().optional(),
    offset: z.number().int().nonnegative().optional(),
})

export let FileDiffRequestSchema = z.object({
    source: DiffSourceSchema,
    path: z.string().min(1),
    view: z.enum(["combined", "staged", "unstaged", "base", "ours", "theirs"]).optional(),
    entireFile: z.boolean().optional(),
    offset: z.number().int().nonnegative().optional(),
    inventoryVersion: z.string().optional(),
    expectedVersion: z.string().optional(),
})
