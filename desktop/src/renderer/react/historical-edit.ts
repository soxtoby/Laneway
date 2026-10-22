import type { HistoricalEditRequest } from "@laneway/shared"
import type { TransferSelection } from "./composition"
import type { ColumnInspection } from "./inspection"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

/** A return waiting to hear what happens to the Historical Working Changes left in its worktree. */
export interface ReturnChoice {
    repositoryId: string
    path: string
    /** The original branch's name, which the return goes back to. */
    branch: string
    /** How many files remain, when the worktree could be read. */
    count?: number
}

export interface HistoricalEditsSnapshot {
    /** An entry, return, or restart is under way. */
    busy: boolean
    choosing?: ReturnChoice
    /** Why the chosen return failed, shown with the choice. */
    error?: string
}

/**
 * Entering, returning from, and restarting a worktree's Historical Edit. Applying changes is ordinary composition.
 * Entry and a clean return go at once and record nothing; Drop and Bring along are operations that offer Undo.
 */
export interface HistoricalEdits extends Store<HistoricalEditsSnapshot> {
    enter(repositoryId: string, path: string, commit: string): Promise<void>
    /** Returns at once when no Historical Working Changes remain; otherwise asks whether to drop or bring them. */
    return(repositoryId: string, path: string, branch: string): Promise<void>
    choose(mode: "drop" | "bring"): Promise<void>
    cancelReturn(): void
    /** Pins a stale session to its branch's latest tip. */
    restart(repositoryId: string, path: string): Promise<void>
}

interface HistoricalEditOptions {
    api: Pick<Api, "historicalEdit" | "readChanges">
    notify(notice: Notice): void
    mutating(busy: boolean): void
    /** Runs after an operation moved the worktree, its changes, or its session. */
    changed(): Promise<void>
    /** Offers to undo an operation the Operation History recorded. */
    offerUndo(repositoryId: string, message: string): void
}

export function createHistoricalEdits({ api, notify, mutating, changed, offerUndo }: HistoricalEditOptions): HistoricalEdits {
    let store = createStore<HistoricalEditsSnapshot>({ busy: false })
    let state = store.snapshot
    let set = (change: Partial<HistoricalEditsSnapshot>) => store.publish({ ...state(), ...change })

    async function run(repositoryId: string, request: HistoricalEditRequest) {
        if (state().busy)
            return
        set({ busy: true, error: undefined })
        mutating(true)
        try {
            let response = await api.historicalEdit(repositoryId, request)
            if (!response.ok)
                throw new Error(response.error.message)
            set({ choosing: undefined })
            await changed()
            if (response.result.operation)
                offerUndo(repositoryId, response.result.message)
            else if (request.action != "enter")
                notify({ code: "edit.completed", message: response.result.message, transient: true })
        } catch (error) {
            if (state().choosing)
                set({ error: errorMessage(error) })
            else
                notify({ code: "edit.failed", message: errorMessage(error) })
        } finally {
            set({ busy: false })
            mutating(false)
        }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        enter: (repositoryId, path, commit) => run(repositoryId, { action: "enter", path, commit }),

        async return(repositoryId, path, branch) {
            // Changes saved between this read and the return make the Engine refuse it; returning again asks.
            let count = await remaining(repositoryId, path)
            if (count == 0)
                await run(repositoryId, { action: "return", path, mode: "clean" })
            else
                set({ choosing: { repositoryId, path, branch, count } })
        },

        async choose(mode) {
            let choice = state().choosing
            if (choice)
                await run(choice.repositoryId, { action: "return", path: choice.path, mode })
        },

        cancelReturn() {
            if (!state().busy)
                set({ choosing: undefined, error: undefined })
        },

        restart: (repositoryId, path) => run(repositoryId, { action: "restart", path }),
    }

    /**
     * How many Historical Working Changes remain, read afresh because the column's last read may be missing or old.
     * An unreadable worktree asks anyway: the Engine returns a clean one whichever way the choice goes.
     */
    async function remaining(repositoryId: string, path: string) {
        let result = await api.readChanges(repositoryId, `edit:return:${path}`, { source: { kind: "working", worktreePath: path } }).catch(() => undefined)
        return result?.ok ? result.inventory.files.filter(file => !file.ignored).length : undefined
    }
}

/**
 * What Apply changes moves into the edited commit, by ordinary composition's selection rules: the lines chosen
 * in one diff, otherwise the chosen files, otherwise every Historical Working Change.
 */
export function applySelection(repositoryId: string, path: string, inspected: ColumnInspection | undefined, selectedRemote?: string): TransferSelection {
    let common = { repositoryId, selectedRemote, source: { kind: "working" as const, worktreePath: path } }
    let lines = Object.values(inspected?.diffs ?? {}).find(diff => diff.group.startsWith("working-") && diff.page && diff.selection?.lineIds.length)
    let chosen = inspected?.selected.filter(id => id.startsWith("working-")) ?? []
    let group = chosen[0]?.slice(0, chosen[0].indexOf(":"))
    if (lines) {
        let { page, selection } = lines as Required<typeof lines>
        return {
            ...common,
            files: [{ path: lines.path, version: page.version, entireFile: page.entireFile, lineIds: selection.lineIds }],
            view: lines.view == "staged" || lines.view == "unstaged" ? lines.view : "combined",
            label: `${selection.lineIds.length} lines in ${lines.path}`,
        }
    } else if (group) {
        return {
            ...common,
            files: chosen.map(id => ({ path: id.slice(group.length + 1) })),
            inventoryVersion: inspected?.files[group]?.inventory?.version,
            view: group == "working-staged" ? "staged" : "unstaged",
            label: chosen.length == 1 ? chosen[0]!.slice(group.length + 1) : `${chosen.length} files`,
        }
    } else {
        return { ...common, inventoryVersion: inspected?.files.working?.inventory?.version, label: "Historical Working Changes" }
    }
}
