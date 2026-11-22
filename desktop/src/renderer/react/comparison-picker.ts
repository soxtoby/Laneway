import type { CommitDetails, ComparisonRef } from "@laneway/shared"
import type { BranchWorkspace, ColumnsSnapshot } from "./branch-workspace"
import { textScore } from "./command-lens"
import { commitCredit, comparisonCommit, refName } from "./comparison-columns"
import type { Inspection, InspectionSnapshot } from "./inspection"
import { errorMessage } from "./notice"
import { createStore } from "./store"
import { workspaceGraph } from "./worktree-columns"

export interface RefChoice {
    id: string
    label: string
    detail: string
    target: ComparisonRef | string
}

interface PickerState {
    repositoryId: string
    sourceId?: string
    from?: ComparisonRef
    to?: ComparisonRef
    workspace: RefChoice[]
    repository?: RefChoice[]
    query: string
    busy?: boolean
    error?: string
}

export type ComparisonPicker = ReturnType<typeof createComparisonPicker>

export function createComparisonPicker(
    api: Pick<Window["laneway"], "comparisonRefs" | "resolveComparisonCommit">,
    columns: BranchWorkspace,
    inspection: Inspection,
) {
    let store = createStore<PickerState | undefined>(undefined)
    let generation = 0
    function close() {
        generation++
        store.publish(undefined)
    }
    return {
        snapshot: store.snapshot,
        subscribe: store.subscribe,
        close,
        open(to?: ComparisonRef, sourceId?: string) {
            let snapshot = columns.snapshot()
            let { repositoryId, focusedId } = snapshot
            if (!repositoryId)
                return
            let session = ++generation
            store.publish({
                repositoryId,
                sourceId: sourceId ?? snapshot.columns.find(column =>
                    column.kind == "branch" && to?.kind == "branch" && column.branch.preferredRef == to.ref
                )?.id ?? focusedId,
                to,
                query: "",
                workspace: workspaceChoices(snapshot, inspection.snapshot()),
            })
            void api.comparisonRefs(repositoryId).then(result => {
                if (generation == session) {
                    let state = store.snapshot()!
                    let repository = result.ok ? result.refs.map(refChoice) : []
                    let choices = new Map(repository.map(choice => [choice.id, choice]))
                    store.publish({
                        ...state,
                        workspace: state.workspace.map(choice => choices.get(choice.id) ?? choice),
                        repository,
                        error: result.ok ? undefined : result.error.message,
                    })
                }
            }).catch(error => {
                if (generation == session)
                    store.publish({ ...store.snapshot()!, repository: [], error: errorMessage(error) })
            })
        },
        search(query: string) {
            let state = store.snapshot()
            if (state && !state.busy)
                store.publish({ ...state, query, error: undefined })
        },
        async choose(choice: RefChoice) {
            let state = store.snapshot()
            if (!state || state.busy)
                return
            let session = generation
            try {
                let ref = choice.target
                if (typeof ref == "string") {
                    store.publish({ ...state, busy: true, error: undefined })
                    let result = await api.resolveComparisonCommit(state.repositoryId, ref)
                    if (!result.ok)
                        throw new Error(result.error.message)
                    ref = { kind: "commit", objectId: result.objectId, details: result.details }
                }
                if (generation != session || columns.snapshot().repositoryId != state.repositoryId)
                    return
                if (state.to || state.from) {
                    columns.openComparison(state.sourceId, state.from ?? ref, state.to ?? ref)
                    close()
                } else {
                    store.publish({ ...store.snapshot()!, from: ref, query: "", error: undefined, busy: false })
                }
            } catch (error) {
                if (generation == session)
                    store.publish({ ...store.snapshot()!, error: errorMessage(error), busy: false })
            }
        },
    }
}

export function pickerChoices(state: PickerState) {
    let query = state.query.trim(), needle = query.toLocaleLowerCase()
    let seen = new Set<string>()
    let matches = (items: RefChoice[]) => {
        let ranked = items.flatMap(choice => {
            if (seen.has(choice.id))
                return []
            let score = needle ? Math.max(textScore(choice.label, needle), textScore(choice.id, needle), textScore(choice.detail, needle)) : 1
            if (!score)
                return []
            seen.add(choice.id)
            return [{ choice, score }]
        })
        if (needle)
            ranked.sort((a, b) => b.score - a.score)
        return ranked.map(match => match.choice)
    }
    let other = state.from ?? state.to
    let otherId = other && refChoice(other).id
    let workspace = matches(state.workspace.filter(choice => choice.id != otherId))
    let repository = matches(state.repository ?? [])
    let revision = state.repository && query && ![...workspace, ...repository].some(item => item.label == query || item.id == query)
        ? [{ id: "revision:" + query, label: /^[0-9a-f]{4,64}$/i.test(query) ? "Entered commit" : query, detail: "Resolve revision", target: query }]
        : []
    return { workspace, repository: repository.slice(0, 60), more: repository.length > 60, revision }
}

function workspaceChoices(columns: ColumnsSnapshot, inspection: InspectionSnapshot) {
    let choices: RefChoice[] = []
    let graph = columns.graph && workspaceGraph(columns.graph)
    let selected = columns.graphView.selectedId
    let branch = graph?.branches.find(item => item.id == selected)
    let tag = graph?.tags.find(item => item.id == selected)
    if (branch)
        choices.push(refChoice({ kind: "branch", ref: branch.preferredRef }))
    if (tag)
        choices.push(refChoice({ kind: "commit", objectId: tag.objectId, tag: tag.name }))

    for (let column of columns.columns) {
        if (column.kind == "branch")
            choices.push(refChoice({ kind: "branch", ref: column.branch.preferredRef }))
        if (column.kind == "virtual")
            choices.push(refChoice({ kind: "commit", objectId: column.branch.objectId, details: column.branch.details }))
    }
    for (let column of columns.columns) {
        if (column.kind == "comparison")
            choices.push(...[column.comparison.from.ref, column.comparison.to.ref].filter(ref => ref.kind != "merge-base").map(ref => refChoice(ref)))
        let inspected = inspection.columns[column.id]
        let addCommit = (commit: CommitDetails & { objectId: string }) => choices.push(refChoice(comparisonCommit(commit)))
        for (let history of Object.values(inspected?.history ?? {})) {
            if (history.open && history.page) {
                choices.push(refChoice({ kind: "branch", ref: history.page.branchRef }))
                history.page.commits.filter(commit => inspected?.files[commit.objectId]?.open).forEach(addCommit)
            }
        }
        for (let view of inspection.auxiliary[column.id] ?? []) {
            if (view.kind == "commit")
                addCommit(view.entry)
            if (view.kind == "history")
                view.page?.entries.filter(entry => view.expanded.includes(entry.objectId)).forEach(addCommit)
        }
    }
    return choices
}

function refChoice(ref: ComparisonRef): RefChoice {
    let label = refName(ref)
    if (ref.kind == "branch")
        return { id: ref.ref, label, detail: ref.ref.startsWith("refs/remotes/") ? "Remote branch" : "Branch", target: ref }
    if (ref.kind == "commit" && ref.tag)
        return { id: `refs/tags/${ref.tag}:${ref.objectId}`, label, detail: ref.details ? `Tag · ${ref.details.subject}` : "Tag", target: ref }
    if (ref.kind == "commit") {
        let detail = ref.details ? commitCredit(ref.details) : "Commit"
        return { id: ref.objectId, label, detail, target: ref }
    }
    return { id: label, label, detail: "Merge base", target: ref }
}
