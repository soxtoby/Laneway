import type { ChangedFile, DiffLine, DiscardRequest } from "@laneway/shared"
import type { Notice } from "./notice"

interface Options {
    api: Pick<Window["laneway"], "discardChanges" | "undoDiscard" | "settleDiscard">
    notify(notice: Notice): () => void
    /** Re-reads a worktree's Working Changes after a discard or its undo. */
    changed(repositoryId: string, worktreePath: string): Promise<void> | void
}
interface Pending {
    id: string
    repositoryId: string
    worktreePath: string
    /** The paths this discard touched, or one path for a line discard. */
    paths: string[]
    lines: number
}

export let undoWindowMs = 8_000

/**
 * Working Changes Discards from the renderer's side. A discard applies at once and shows a notice
 * with Undo; while that notice stays, further discards join it so one Undo restores them all. When
 * the notice leaves the screen the discards settle and become final.
 */
export function createDiscards(options: Options) {
    let pending: Pending[] = []
    let current: { notice: Notice; withdraw(): void } | undefined
    let busy = false

    return {
        files(repositoryId: string, worktreePath: string, view: "staged" | "unstaged", files: ChangedFile[]) {
            return perform(
                repositoryId,
                worktreePath,
                { kind: "files", worktreePath, view, files: files.map(file => ({ path: file.path, oldPath: file.oldPath, untracked: file.untracked })) },
                { paths: files.map(file => file.path), lines: 0 },
            )
        },
        lines(repositoryId: string, worktreePath: string, path: string, lines: DiffLine[], lineIds: number[]) {
            return perform(repositoryId, worktreePath, { kind: "lines", worktreePath, path, lines, lineIds }, { paths: [path], lines: lineIds.length })
        },
        /** Starts undoing the pending discards; false when there is nothing to undo. */
        undo(): boolean {
            // A discard or undo still in flight swallows the keystroke rather than passing it on to an unrelated undo.
            if (busy)
                return true
            if (!pending.length)
                return false
            void undoPending()
            return true
        },
        pending: () => pending.length,
    }

    async function perform(repositoryId: string, worktreePath: string, request: DiscardRequest, summary: Pick<Pending, "paths" | "lines">) {
        if (busy)
            return
        busy = true
        try {
            let result = await options.api.discardChanges(repositoryId, request)
            if (!result.ok) {
                options.notify({ code: "working.discard.failed", message: result.error.message })
                return
            }
            if (result.undoable) {
                pending.push({ id: result.id, repositoryId, worktreePath, ...summary })
                show()
            } else {
                options.notify({ code: "working.discarded", message: `Discarded ${describe([{ ...summary }])}.`, transient: true })
            }
            await options.changed(repositoryId, worktreePath)
        } finally {
            busy = false
        }
    }

    function show() {
        let notice: Notice = {
            code: "working.discarded",
            message: `Discarded ${describe(pending)}`,
            transient: true,
            duration: undoWindowMs,
            action: { label: "Undo", run: () => void undoPending() },
            closed: () => {
                // A newer discard notice has taken over the same pending list, so only the latest settles it.
                if (current?.notice == notice) {
                    current = undefined
                    settle()
                }
            },
        }
        current = { notice, withdraw: () => undefined }
        current.withdraw = options.notify(notice)
    }

    function settle() {
        for (let item of pending.splice(0))
            void options.api.settleDiscard(item.repositoryId, item.id)
    }

    async function undoPending() {
        if (busy || !pending.length)
            return
        busy = true
        let items = pending.splice(0).reverse()
        let shown = current
        current = undefined
        shown?.withdraw()
        try {
            let kept: string[] = [], failures: string[] = []
            for (let item of items) {
                let result = await options.api.undoDiscard(item.repositoryId, item.id)
                if (result.ok)
                    kept.push(...result.kept)
                else
                    failures.push(result.error.message)
            }
            for (let [repositoryId, worktreePath] of new Map(items.map(item => [item.repositoryId, item.worktreePath])))
                await options.changed(repositoryId, worktreePath)

            if (failures.length)
                options.notify({ code: "working.discard.undo-failed", message: failures[0] })
            else if (kept.length)
                options.notify({ code: "working.discard.kept", message: `Kept ${list(kept)}, which changed after the discard.` })
            else
                options.notify({ code: "working.discard.undone", message: "Discard undone.", transient: true })
        } finally {
            busy = false
        }
    }
}

/** "src/file.txt", "3 files", "4 lines in src/file.txt", or "2 files and 4 lines". */
function describe(items: Pick<Pending, "paths" | "lines">[]) {
    let files = items.filter(item => !item.lines)
    let lines = items.filter(item => item.lines)
    let parts: string[] = []
    let paths = [...new Set(files.flatMap(item => item.paths))]
    if (paths.length == 1)
        parts.push(paths[0])
    else if (paths.length)
        parts.push(`${paths.length} files`)
    let count = lines.reduce((total, item) => total + item.lines, 0)
    if (lines.length == 1)
        parts.push(`${count} ${count == 1 ? "line" : "lines"} in ${lines[0].paths[0]}`)
    else if (lines.length)
        parts.push(`${count} lines`)

    return parts.join(" and ")
}

function list(paths: string[]) {
    return paths.length <= 2 ? paths.join(" and ") : `${paths[0]} and ${paths.length - 1} more files`
}
