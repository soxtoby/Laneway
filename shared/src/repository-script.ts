import { z } from "zod"
import { type RepositoryIcon, RepositoryIconSchema } from "./repository-icon"

/**
 * A Repository Script: a command the user saves for one repository or for every repository, run in a worktree's
 * directory. A File Script is one that runs on a file there.
 */
export interface RepositoryScript {
    id: string
    name: string
    /**
     * One line for the system shell, run as if typed in the worktree's directory. A File Script's names its file as
     * `{file}` and the line chosen in its diff as `{line}`.
     */
    command: string
    /** Drawn as a Repository Icon is; the name's initials show without one. */
    icon?: RepositoryIcon
    /** Runs in a terminal window that stays open, rather than with no window. */
    terminal?: boolean
    /** A File Script runs on a file, from the file's own button; any other runs on the worktree, from its column's. */
    target?: "file"
}

/** The script every repository has, which can't be changed or removed: opening the worktree in the file manager. */
export const openFolderScriptId = "open-folder"

/** The File Script every repository has, which can't be changed or removed: copying the file's path. */
export const copyPathScriptId = "copy-path"

/** A repository's own scripts and the ones its script buttons repeat. */
export interface RepositoryScripts {
    scripts?: RepositoryScript[]
    /**
     * The last script run on a worktree, which may be `openFolderScriptId` or one saved for every repository; opening
     * the folder before any.
     */
    lastScriptId?: string
    /** The last File Script run, likewise, which may be `copyPathScriptId`; copying the path before any. */
    lastFileScriptId?: string
}

/** The file a File Script runs on. */
export interface ScriptFile {
    /** From the worktree's directory. */
    path: string
    /** The line chosen in the file's diff, from 1. */
    line?: number
}

export type ScriptRunResult =
    | { ok: true }
    | { ok: false; message: string; output?: string }

export let RepositoryScriptSchema: z.ZodType<RepositoryScript> = z.object({
    id: z.string().trim().min(1).max(64).refine(id => id != openFolderScriptId && id != copyPathScriptId),
    name: z.string().trim().min(1).max(80),
    command: z.string().trim().min(1).max(4000).regex(/^[^\r\n]*$/),
    icon: RepositoryIconSchema.optional(),
    terminal: z.boolean().optional(),
    target: z.literal("file").optional(),
})
