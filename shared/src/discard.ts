import { z } from "zod"

let relativePath = z.string().min(1)

export let DiffLineSchema = z.object({
    id: z.number().int().nonnegative(),
    kind: z.enum(["context", "addition", "deletion", "hunk", "notice"]),
    text: z.string(),
    oldLine: z.number().int().optional(),
    newLine: z.number().int().optional(),
    hunk: z.number().int(),
})

/**
 * A Working Changes Discard. It runs outside the Operation History: the discarded content waits in
 * the worktree's git directory for a short undo window and is then released.
 */
export let DiscardRequestSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("files"),
        worktreePath: z.string().min(1),
        /** `staged` returns index and worktree content to HEAD; `unstaged` returns worktree content to the index. */
        view: z.enum(["staged", "unstaged"]),
        files: z.array(z.object({ path: relativePath, oldPath: relativePath.optional(), untracked: z.boolean() })).min(1),
    }),
    z.object({
        kind: z.literal("lines"),
        worktreePath: z.string().min(1),
        path: relativePath,
        /** The displayed diff from the index to the worktree, which the file on disk must still match. */
        lines: z.array(DiffLineSchema).min(1),
        lineIds: z.array(z.number().int().nonnegative()).min(1),
    }),
])
export type DiscardRequest = z.infer<typeof DiscardRequestSchema>

export type DiscardResult =
    /** `undoable` is false when the original content could not be set aside, so the discard is final. */
    | { ok: true; id: string; undoable: boolean }
    | { ok: false; error: { message: string } }

export type DiscardUndoResult =
    /** `kept` lists files left alone because they changed again after the discard. */
    | { ok: true; kept: string[] }
    | { ok: false; error: { message: string } }
