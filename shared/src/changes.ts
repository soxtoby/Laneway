import { z } from "zod"
import { type EntryError } from "./workspace"

export type DiffLayout = "unified" | "split"

/** How a change file list lays out its rows and whether it groups them first. */
export interface FileListView {
    layout: FileListLayout
    grouping: FileListGrouping
}
/** Flat rows show their folders inline; a tree nests rows under collapsible folders. */
export type FileListLayout = "flat" | "tree"
/** `change` groups by added, changed, and removed; `kind` groups docs, implementation, test, and generated files. */
export type FileListGrouping = "none" | "change" | "kind"

export let defaultFileListView: FileListView = { layout: "flat", grouping: "none" }

/** One end of a Branch Comparison. Branch identities follow their tips, so a comparison between them stays live. */
export type ComparisonRef =
    | { kind: "commit"; objectId: string }
    | { kind: "branch"; ref: string }
    /** The merge base of `ref` and `withRef`, so a diff from here to `withRef` shows only `withRef`'s own changes. */
    | { kind: "merge-base"; ref: string; withRef: string }

export type DiffSource =
    | { kind: "working"; worktreePath: string }
    | { kind: "commit"; objectId: string; parentId?: string }
    /** Resolves to a `comparison` between the refs' current object IDs. */
    | { kind: "refs"; from: ComparisonRef; to: ComparisonRef }
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

export interface FileImageRequest {
    source: DiffSource
    path: string
    view?: DiffView
    inventoryVersion?: string
    /** Download Git LFS objects that are not in the local store instead of reporting them as `lfs`. */
    fetchLfs?: boolean
}

/** One version of a file's bytes. An `lfs` version is a pointer whose object has not been downloaded yet. */
export type FileContent =
    | { state: "ready"; bytes: Uint8Array; size: number }
    | { state: "lfs"; size: number }
    | { state: "unavailable"; reason: string }

export interface FileImagePage {
    source: DiffSource
    file: ChangedFile
    view: DiffView
    version: string
    /** Absent when the file was added, or when the view shows one conflict stage. */
    old?: FileContent
    /** Absent when the file was deleted. */
    new?: FileContent
}

export type ChangesResult = { ok: true; inventory: ChangesInventory } | { ok: false; error: EntryError }

export type FileDiffResult = { ok: true; page: FileDiffPage } | { ok: false; error: EntryError }

export type FileImageResult = { ok: true; page: FileImagePage } | { ok: false; error: EntryError }

/** Any file as one side of a comparison has it, such as a changed Markdown document or a picture it shows. */
export interface FileVersionRequest {
    source: DiffSource
    path: string
    view?: DiffView
    /** The version the comparison starts from, or the one it ends at. */
    side: "old" | "new"
    fetchLfs?: boolean
}

/** A file's content in one version, or `missing` when that version doesn't have the file. */
export type FileVersion = FileContent | { state: "missing" }

export type FileVersionResult = { ok: true; content: FileVersion } | { ok: false; error: EntryError }

/** A picture from the web that a Markdown document shows. */
export type RemoteImageResult = { ok: true; bytes: Uint8Array; mimeType: string } | { ok: false; reason: string }

let objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
let branchRefSchema = z.string().regex(/^refs\/(heads|remotes)\/.+/)

export let ComparisonRefSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("commit"), objectId: objectIdSchema }),
    z.object({ kind: z.literal("branch"), ref: branchRefSchema }),
    z.object({ kind: z.literal("merge-base"), ref: branchRefSchema, withRef: branchRefSchema }),
])

export let DiffSourceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("refs"), from: ComparisonRefSchema, to: ComparisonRefSchema }),
    z.object({ kind: z.literal("comparison"), fromObjectId: objectIdSchema, toObjectId: objectIdSchema }),
    z.object({ kind: z.literal("working"), worktreePath: z.string().min(1) }),
    z.object({ kind: z.literal("commit"), objectId: objectIdSchema, parentId: objectIdSchema.optional() }),
])

export let FileListViewSchema = z.object({
    layout: z.enum(["flat", "tree"]),
    grouping: z.enum(["none", "change", "kind"]),
})

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

export let FileImageRequestSchema = z.object({
    source: DiffSourceSchema,
    path: z.string().min(1),
    view: z.enum(["combined", "staged", "unstaged", "base", "ours", "theirs"]).optional(),
    inventoryVersion: z.string().optional(),
    fetchLfs: z.boolean().optional(),
})

export let FileVersionRequestSchema = z.object({
    source: DiffSourceSchema,
    path: z.string().min(1),
    view: z.enum(["combined", "staged", "unstaged", "base", "ours", "theirs"]).optional(),
    side: z.enum(["old", "new"]),
    fetchLfs: z.boolean().optional(),
})
