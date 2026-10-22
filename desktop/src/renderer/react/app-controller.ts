import type { Appearance, BranchHistoryCommit, FileListView, OpenRepository, RepositoryIdentity, Workspace, WorkspaceColumn } from "@laneway/shared"
import { defaultFileListView } from "@laneway/shared"
import { type BranchRebase, createBranchRebase } from "./branch-rebase"
import { type BranchWorkspace, createBranchWorkspace } from "./branch-workspace"
import { type CommandLens, createCommandLens, type LensResult } from "./command-lens"
import { type CommitComposer, createCommitComposer } from "./commit-composer"
import { type Composition, createComposition } from "./composition"
import { type Conflicts, createConflicts } from "./conflicts"
import { undoWindowMs } from "./discard"
import { orderedFiles } from "./file-list-view"
import { createGitSettings, type GitSettings } from "./git-settings"
import { createInspection, type Inspection } from "./inspection"
import { createLocalBranches, type LocalBranches } from "./local-branches"
import { errorMessage, type Notice } from "./notice"
import { createPublish, type Publish } from "./publish"
import { createPullLatest, type PullLatest } from "./pull-latest"
import { createRepositoryEntry, type RepositoryEntry } from "./repository-entry"
import { createRepositoryIdentityEditor, type RepositoryIdentityEditor } from "./repository-identity"
import { createReword, type Reword } from "./reword"
import { createStashes, type Stashes } from "./stashes"
import { createStore, type Store } from "./store"
import { createWorktreeActions, type WorktreeActions } from "./worktree-actions"
import { workspaceGraph } from "./worktree-columns"

type Api = Window["laneway"]

export type AppSnapshot =
    | { status: "starting" }
    | { status: "failed"; error: string }
    | {
        status: "ready"
        appearance: Appearance
        workspace: Workspace
        /** Opening or selecting a repository is under way. */
        opening: boolean
        /** How every file list lays out and groups its files. */
        fileListView: FileListView
        /** Whether commit rows show when each commit was authored. */
        showCommitAges: boolean
        notice?: Notice
    }

type Ready = Extract<AppSnapshot, { status: "ready" }>

export interface AppController extends Store<AppSnapshot> {
    readonly entry: RepositoryEntry
    readonly gitSettings: GitSettings
    readonly identity: RepositoryIdentityEditor
    /** The active repository's Workspace Columns. */
    readonly columns: BranchWorkspace
    /** The files and commits each column shows. */
    readonly inspection: Inspection
    /** Creating, renaming, and deleting local branches. */
    readonly branches: LocalBranches
    /** Worktree operations, and undoing and redoing the Operation History. */
    readonly worktrees: WorktreeActions
    /** Every stash in the repository, applied or dropped. */
    readonly stashes: Stashes
    /** Rebasing branches from the Branch Graph. */
    readonly rebase: BranchRebase
    readonly lens: CommandLens
    /** Resolving conflicts that rewrites deferred. */
    readonly conflicts: Conflicts
    readonly pull: PullLatest
    /** Publishing the focused column's stack, which stays outside Operation History. */
    readonly publish: Publish
    /** Moving and copying files, commits, and branches between columns. */
    readonly composition: Composition
    /** Loads the app state; also retries after a failed start. */
    start(): Promise<void>
    toggleAppearance(): Promise<void>
    /** Shows every file list in the new view at once; a failed save only loses it for the next start. */
    setFileListView(view: FileListView): Promise<void>
    /** Shows or hides every commit row's age at once; a failed save only loses it for the next start. */
    setShowCommitAges(shown: boolean): Promise<void>
    /** Commits and stashes a column's worktree; an operation refreshes the column, and the Branch Graph when it changed. */
    composer(repositoryId: string, columnId: string, path: string, blocked: boolean): CommitComposer
    /** Rewords a commit on a local branch; `close` runs once it is rewritten. */
    reword(repositoryId: string, branchRef: string, commit: BranchHistoryCommit, close: () => void): Reword
    openRepository(): Promise<void>
    selectRepository(id: string): Promise<void>
    /** Goes where a Command Lens result points: a repository, a branch in its Branch Graph, or a column command. */
    activateLensResult(result: LensResult): Promise<void>
    closeRepository(id: string): Promise<void>
    /** Asks for a directory, starting from `path`. */
    chooseDirectory(path?: string): Promise<string | undefined>
    /** Asks for a missing repository's new location. */
    locateRepository(id: string): Promise<void>
    /** Shows a repository's new name and icon at once, and saves them once changes pause. */
    customizeRepository(id: string, identity: RepositoryIdentity): void
    /** Takes every open repository's id in the new order. */
    reorderRepositories(ids: string[]): Promise<void>
    /** Replaces a Workspace State that can't be read with an empty one. */
    resetWorkspace(): Promise<void>
    /** Shows a notice in place of the current one; the returned function withdraws it if it is still showing. */
    notify(notice: Notice): () => void
    dismissNotice(notice: Notice): void
    dispose(): void
}

export function createAppController(api: Api): AppController {
    let store = createStore<AppSnapshot>({ status: "starting" })
    let identitySave: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = [
        api.onRepositoryChanged(change => {
            if (ready()?.workspace.activeRepositoryId == change.repositoryId)
                void columns.refresh()
        }),
        api.onEntryProgress(progress => entry.updateProgress(progress)),
    ]

    function ready() {
        let snapshot = store.snapshot()
        return snapshot.status == "ready" ? snapshot : undefined
    }

    function update(change: Partial<Ready>) {
        let current = ready()
        if (current)
            store.publish({ ...current, ...change })
    }

    function activeRepository(workspace: Workspace): OpenRepository | undefined {
        return workspace.repositories.find(repository => repository.id == workspace.activeRepositoryId)
    }

    // Each workspace change that can move the active repository shows that repository's columns.
    function showWorkspace(workspace: Workspace) {
        update({ workspace })
        let active = activeRepository(workspace)
        if (active?.status == "available")
            columns.activate(active.id)
        else
            columns.deactivate()
    }

    async function whileOpening(action: () => Promise<void>) {
        update({ opening: true })
        try {
            await action()
        } finally {
            update({ opening: false })
        }
    }

    function notify(notice: Notice) {
        let replaced = ready()?.notice
        update({ notice })
        replaced?.closed?.()
        return () => controller.dismissNotice(notice)
    }

    let entry = createRepositoryEntry({ api, notify, workspaceOpened: showWorkspace, openRepository: () => controller.openRepository() })
    let gitSettings = createGitSettings({ api, notify })
    let identity = createRepositoryIdentityEditor({
        api,
        workspace: () => ready()?.workspace,
        commit: (id, chosen) => controller.customizeRepository(id, chosen),
    })

    let inspection = createInspection({
        api,
        notify,
        displayOrder: files => orderedFiles(files, ready()?.fileListView ?? defaultFileListView).map(entry => entry.file),
    })
    let columns = createBranchWorkspace({
        api,
        notify,
        inspection,
        workspace: () => ready()?.workspace,
        saveColumns: (repositoryId, layout) => saveRepository(repositoryId, layout),
        checkMissing: async repositoryId => {
            let { workspace } = await api.getState()
            if (workspace.repositories.some(repository => repository.id == repositoryId && repository.status == "missing"))
                showWorkspace(workspace)
        },
    })

    // History rewrites leave chosen files stale and move commits that the graph and every worktree show.
    async function rewritten() {
        inspection.rewritten()
        await columns.refresh(false)
        inspection.refreshWorking()
    }

    // An operation that goes without asking shows Undo for the undo window. Undo undoes the Operation History's
    // latest operation, so the notice goes as soon as another operation starts.
    let withdrawUndo = () => {}
    function offerUndo(repositoryId: string, code: string, message: string) {
        withdrawUndo = notify({
            code,
            message,
            transient: true,
            duration: undoWindowMs,
            action: { label: "Undo", run: () => void worktrees.transition(repositoryId, "undo") },
        })
    }

    function mutating(busy: boolean) {
        if (busy)
            withdrawUndo()
        columns.mutating(busy)
    }

    let branches = createLocalBranches({
        api,
        notify,
        mutating,
        completed: async (repositoryId, request, preview) => {
            if (request.action == "branch-rename") {
                columns.renamed(`refs/heads/${request.name}`, `refs/heads/${request.newName}`)
                inspection.renamed(`refs/heads/${request.name}`, `refs/heads/${request.newName}`)
            }
            await columns.refresh(false)
            if (request.action == "branch-create")
                columns.open(`branch:refs/heads/${request.name}`)
            if (request.action == "branch-delete") {
                let commits = preview.uniqueCommits ? " and the commits only it held" : ""
                offerUndo(repositoryId, "branch.deleted", `Deleted branch ${request.name}${commits}.`)
            }
        },
    })

    let worktrees = createWorktreeActions({
        api,
        mutating,
        completed: async (repositoryId, request, columnId) => {
            if (request.action == "switch" && columnId)
                columns.switched(columnId, request.path)
            await columns.refresh(false)
            inspection.refreshWorking()
            if (request.action == "remove")
                offerUndo(repositoryId, "worktree.removed", `Removed worktree ${request.path.split(/[\\/]/).pop()}.`)
        },
        transitioned: rewritten,
    })

    let conflicts = createConflicts({
        api,
        changed: async () => {
            withdrawUndo()
            await rewritten()
        },
    })

    // A transfer that chose to resolve now opens its first conflict where it shows: Working Changes a stash couldn't
    // restore in their column, or a conflicted commit in the column whose stack holds it.
    async function resolveFirstConflict(repositoryId: string) {
        let response = await api.conflictOperation(repositoryId, { action: "list" })
        let first = response.ok ? response.result.conflicts.find(conflict => !conflict.suspended) : undefined
        if (first?.kind == "working")
            conflicts.open(repositoryId, first.id)
        else if (first)
            inspection.resolveConflict(first.id)
    }

    let composition = createComposition({
        api,
        notify,
        mutating,
        changed: rewritten,
        resolve: repositoryId => void resolveFirstConflict(repositoryId),
    })

    let rebase = createBranchRebase({
        api,
        notify,
        mutating,
        completed: rewritten,
        // The lowest unresolved branch's column shows every conflict above it.
        resolve(_repositoryId, names) {
            let branches = columns.snapshot().graph ? workspaceGraph(columns.snapshot().graph!).branches : []
            let name = names.find(candidate => branches.some(branch => branch.name == candidate && branch.unresolved)) ?? names[0]
            if (name)
                columns.open(`branch:refs/heads/${name}`)
        },
    })

    let lens = createCommandLens({ api, workspace: () => ready()?.workspace })

    // A pull starts from the header, so it pulls the active repository's open stacks.
    let pull = createPullLatest({
        api,
        notify,
        mutating,
        scope: () => columns.snapshot().columns.flatMap(column => column.kind == "branch" ? [column.branch.preferredRef] : []),
        graph: () => columns.snapshot().graph,
        completed: async () => {
            await columns.refresh(false)
            inspection.refreshWorking()
        },
    })

    // A publish changes no local commits, so it leaves the Undo notice for the latest operation in place: its
    // confirmation waits for a notice offering Undo to close rather than replacing it, which would withdraw the Undo
    // and settle pending discards.
    let waitingConfirmation: Notice | undefined
    let publish = createPublish({
        api,
        notify(notice) {
            if (ready()?.notice?.action)
                waitingConfirmation = notice
            else
                notify(notice)
        },
        remote: () => columns.snapshot().graph?.selectedRemote,
        pull: repositoryId => void pull.start(repositoryId),
        completed: () => columns.refresh(false),
    })

    let stashes = createStashes({
        api,
        mutating,
        completed: async () => {
            await columns.refresh(false)
            inspection.refreshWorking()
        },
    })

    async function saveRepository(repositoryId: string, layout: { columns: WorkspaceColumn[]; focusedColumnId?: string; layoutInitialized: boolean }) {
        let current = ready()
        if (!current)
            return
        let repositories = current.workspace.repositories.map(repository => repository.id == repositoryId ? { ...repository, ...layout } : repository)
        let workspace = { ...current.workspace, repositories }
        update({ workspace })
        try {
            update({ workspace: await api.updateWorkspace(workspace) })
        } catch (error) {
            notify({ code: "workspace.write-failed", message: errorMessage(error) })
        }
    }

    async function saveWorkspace() {
        let current = ready()
        if (!current)
            return
        try {
            update({ workspace: await api.updateWorkspace(current.workspace) })
        } catch (error) {
            notify({ code: "workspace.save.failed", message: errorMessage(error) })
        }
    }

    let controller: AppController = {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        entry,
        gitSettings,
        identity,
        columns,
        inspection,
        branches,
        worktrees,
        stashes,
        rebase,
        lens,
        conflicts,
        pull,
        publish,
        composition,

        async start() {
            store.publish({ status: "starting" })
            try {
                let state = await api.getState()
                gitSettings.load(state.settings)
                store.publish({
                    status: "ready",
                    appearance: state.appearance,
                    workspace: state.workspace,
                    opening: false,
                    fileListView: state.fileListView,
                    showCommitAges: state.showCommitAges,
                })
                if (state.workspace.persistenceError?.code == "workspace.partial")
                    notify({ code: state.workspace.persistenceError.code, message: state.workspace.persistenceError.message })
                showWorkspace(state.workspace)
            } catch (error) {
                store.publish({ status: "failed", error: errorMessage(error) })
            }
        },

        // The main process applies the appearance to Electron's native theme, which the kit's
        // prefers-color-scheme rules follow, so the page changes once the setting is saved.
        async toggleAppearance() {
            let current = ready()
            if (!current)
                return
            try {
                update({ appearance: await api.setAppearance(current.appearance == "dark" ? "light" : "dark") })
            } catch (error) {
                notify({ code: "settings.appearance.failed", message: errorMessage(error) })
            }
        },

        async setFileListView(view) {
            update({ fileListView: view })
            try {
                await api.setFileListView(view)
            } catch (error) {
                notify({ code: "settings.file-list-view.failed", message: errorMessage(error) })
            }
        },

        async setShowCommitAges(shown) {
            update({ showCommitAges: shown })
            try {
                await api.setShowCommitAges(shown)
            } catch (error) {
                notify({ code: "settings.commit-ages.failed", message: errorMessage(error) })
            }
        },

        composer: (repositoryId, columnId, path, blocked) =>
            createCommitComposer({
                api,
                repositoryId,
                path,
                blocked,
                notify,
                mutating,
                changed: async refreshGraph => {
                    await inspection.readWorking(columnId, true)
                    if (refreshGraph)
                        await columns.refresh(false)
                },
            }),

        reword: (repositoryId, branchRef, commit, close) =>
            createReword({
                api,
                repositoryId,
                branch: branchRef,
                commit,
                selectedRemote: columns.snapshot().graph?.selectedRemote,
                notify,
                mutating,
                changed: rewritten,
                close,
            }),

        chooseDirectory: path => api.chooseDirectory(path),

        openRepository: () =>
            whileOpening(async () => {
                try {
                    let result = await api.openRepository()
                    if (result.ok) {
                        showWorkspace(result.workspace)
                        notify({ code: "repository.opened", message: "Repository opened.", transient: true })
                    } else if (result.error.code != "git.cancelled") {
                        notify({ code: result.error.code, message: result.error.message })
                    }
                } catch (error) {
                    notify({ code: "repository.open.failed", message: errorMessage(error) })
                }
            }),

        selectRepository: id =>
            whileOpening(async () => {
                // Choosing the repository already shown shows or hides its Branch Graph instead.
                if (id == ready()?.workspace.activeRepositoryId)
                    return columns.toggleGraph()
                try {
                    showWorkspace(await api.selectRepository(id))
                } catch (error) {
                    notify({ code: "repository.select.failed", message: errorMessage(error) })
                }
            }),

        async activateLensResult(result) {
            lens.close()
            if (result.kind == "command")
                return columns.move(result.nodeId, result.delta)
            if (result.repositoryId != ready()?.workspace.activeRepositoryId)
                await controller.selectRepository(result.repositoryId)
            if (result.kind == "branch")
                columns.reveal(result.repositoryId, result.nodeId)
        },

        async closeRepository(id) {
            try {
                showWorkspace(await api.closeRepository(id))
            } catch (error) {
                notify({ code: "repository.close.failed", message: errorMessage(error) })
            }
        },

        async locateRepository(id) {
            try {
                showWorkspace(await api.locateRepository(id))
            } catch (error) {
                notify({ code: "repository.locate.failed", message: errorMessage(error) })
            }
        },

        // Typing a name coalesces into one save shortly after it pauses.
        customizeRepository(id, chosen) {
            let current = ready()
            if (!current)
                return
            let repositories = current.workspace.repositories.map(repository => {
                if (repository.id != id)
                    return repository
                let customized = { ...repository, ...chosen }
                if (!chosen.label)
                    delete customized.label
                if (!chosen.icon)
                    delete customized.icon
                return customized
            })
            update({ workspace: { ...current.workspace, repositories } })
            clearTimeout(identitySave)
            identitySave = setTimeout(() => void saveWorkspace(), 200)
        },

        // The new order shows at once; a dropped repository already appears in its slot while the workspace saves.
        async reorderRepositories(ids) {
            let current = ready()
            if (!current)
                return
            let workspace = {
                ...current.workspace,
                repositories: [...current.workspace.repositories].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
            }
            update({ workspace })
            try {
                update({ workspace: await api.updateWorkspace(workspace) })
            } catch (error) {
                notify({ code: "workspace.save.failed", message: errorMessage(error) })
            }
        },

        async resetWorkspace() {
            try {
                showWorkspace(await api.resetWorkspace())
            } catch (error) {
                notify({ code: "workspace.reset.failed", message: errorMessage(error) })
            }
        },

        notify,

        dismissNotice(notice) {
            if (ready()?.notice != notice)
                return
            update({ notice: undefined })
            notice.closed?.()
            // A publish's confirmation that waited for this notice shows now, unless closing it showed another.
            if (waitingConfirmation && !ready()?.notice) {
                notify(waitingConfirmation)
                waitingConfirmation = undefined
            }
        },

        dispose() {
            clearTimeout(identitySave)
            composition.dispose()
            pull.dispose()
            publish.dispose()
            for (let stop of unsubscribe)
                stop()
            store.clear()
        },
    }
    return controller
}
