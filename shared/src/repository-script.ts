import { z } from "zod"
import { type RepositoryIcon, RepositoryIconSchema } from "./repository-icon"

/** A Repository Script: a command the user saves for a repository, run in a worktree's directory. */
export interface RepositoryScript {
    id: string
    name: string
    /** One line for the system shell, run as if typed in the worktree's directory. */
    command: string
    /** Drawn as a Repository Icon is; the name's initials show without one. */
    icon?: RepositoryIcon
    /** Runs in a terminal window that stays open, rather than with no window. */
    terminal?: boolean
}

/** The script every repository has, which can't be changed or removed: opening the worktree in the file manager. */
export const openFolderScriptId = "open-folder"

/** A repository's scripts and the one its worktree columns' script buttons repeat. */
export interface RepositoryScripts {
    scripts?: RepositoryScript[]
    /** The last script run, which may be `openFolderScriptId`; opening the folder before any. */
    lastScriptId?: string
}

export type ScriptRunResult =
    | { ok: true }
    | { ok: false; message: string; output?: string }

export let RepositoryScriptSchema: z.ZodType<RepositoryScript> = z.object({
    id: z.string().trim().min(1).max(64).refine(id => id != openFolderScriptId),
    name: z.string().trim().min(1).max(80),
    command: z.string().trim().min(1).max(4000).regex(/^[^\r\n]*$/),
    icon: RepositoryIconSchema.optional(),
    terminal: z.boolean().optional(),
})
