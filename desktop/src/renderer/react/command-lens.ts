import type { BranchGraph, Workspace } from "@laneway/shared"
import { workspaceGraph } from "../src/worktrees/worktree-columns"
import { repositoryName } from "./repositories"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export type LensResult =
    | { kind: "repository"; repositoryId: string; nodeId: string; label: string; detail: string; score: number }
    | { kind: "branch"; repositoryId: string; nodeId: string; label: string; detail: string; score: number }
    | { kind: "command"; repositoryId: string; nodeId: string; label: string; detail: string; score: number; delta: number }

export interface LensSnapshot {
    open: boolean
    query: string
    /** Every branch of each open repository, read as the Lens opens, so filtered branches are found too. */
    graphs: Record<string, BranchGraph>
}

export interface CommandLens extends Store<LensSnapshot> {
    open(): void
    close(): void
    setQuery(query: string): void
}

/** The Command Lens: keyboard-first search across open repositories, their branches, and column commands. */
export function createCommandLens({ api, workspace }: { api: Pick<Api, "readBranchGraph">; workspace(): Workspace | undefined }): CommandLens {
    let store = createStore<LensSnapshot>({ open: false, query: "", graphs: {} })
    let set = (change: Partial<LensSnapshot>) => store.publish({ ...store.snapshot(), ...change })
    let opening = 0
    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        open() {
            if (store.snapshot().open)
                return
            let generation = ++opening
            set({ open: true, query: "", graphs: {} })
            for (let repository of workspace()?.repositories ?? []) {
                if (repository.status != "available")
                    continue
                void api.readBranchGraph(repository.id, false, true).then(result => {
                    if (result.ok && generation == opening && store.snapshot().open)
                        set({ graphs: { ...store.snapshot().graphs, [repository.id]: result.graph } })
                })
            }
        },

        close() {
            opening++
            set({ open: false })
        },

        setQuery: query => set({ query }),
    }
}

/**
 * What the Lens offers for `query`: moving the focused column, then repositories and branches by how well their
 * names match, the active repository's first. A branch is found in the Lens's own read, else in its shown graph.
 */
export function lensResults(
    { workspace, graphs, shown, activeId, focusedColumnId, query }: {
        workspace: Workspace
        graphs: Record<string, BranchGraph>
        /** The Branch Graphs on screen, by repository, for any the Lens hasn't read yet. */
        shown: Record<string, BranchGraph | undefined>
        activeId?: string
        focusedColumnId?: string
        query: string
    },
): LensResult[] {
    let needle = query.trim().toLocaleLowerCase()
    if (!needle)
        return []
    let results: LensResult[] = []
    if (activeId && focusedColumnId) {
        for (let command of [{ label: "Move column left", delta: -1 }, { label: "Move column right", delta: 1 }]) {
            let score = textScore(command.label, needle)
            if (score > 0) {
                results.push({
                    kind: "command",
                    repositoryId: activeId,
                    nodeId: focusedColumnId,
                    label: command.label,
                    detail: command.delta < 0 ? "Ctrl+Shift+<" : "Ctrl+Shift+>",
                    score,
                    delta: command.delta,
                })
            }
        }
    }
    for (let repository of workspace.repositories) {
        let name = repositoryName(repository)
        let score = textScore(name, needle)
        if (score > 0) {
            let detail = repository.status == "available" ? repository.info.selectedWorktree : "Unavailable"
            results.push({ kind: "repository", repositoryId: repository.id, nodeId: repository.id, label: name, detail, score })
        }
        let graph = graphs[repository.id] ?? shown[repository.id]
        for (let branch of graph ? workspaceGraph(graph).branches : []) {
            let branchScore = Math.max(...[branch.name, ...branch.aliases].map(value => textScore(value, needle)))
            if (branchScore > 0)
                results.push({ kind: "branch", repositoryId: repository.id, nodeId: branch.id, label: branch.name, detail: name, score: branchScore })
        }
    }
    return results.sort((left, right) =>
        Number(right.repositoryId == activeId) - Number(left.repositoryId == activeId) || right.score - left.score
        || left.label.localeCompare(right.label, undefined, { numeric: true })
    )
}

// Whole names score highest, then prefixes, then a word's prefix, then anywhere.
function textScore(value: string, query: string) {
    let text = value.toLocaleLowerCase()
    if (text == query)
        return 4
    if (text.startsWith(query))
        return 3
    if (text.split(/[/_.-]+/).some(part => part.startsWith(query)))
        return 2
    return text.includes(query) ? 1 : 0
}
