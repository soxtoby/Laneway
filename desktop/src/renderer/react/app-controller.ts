import type { Appearance, FileListView, OpenRepository, RepositoryIdentity, Workspace, WorkspaceColumn } from "@laneway/shared"
import { type BranchWorkspace, createBranchWorkspace } from "./branch-workspace"
import { type CommitComposer, createCommitComposer } from "./commit-composer"
import { createGitSettings, type GitSettings } from "./git-settings"
import { createInspection, type Inspection } from "./inspection"
import { errorMessage, type Notice } from "./notice"
import { createRepositoryEntry, type RepositoryEntry } from "./repository-entry"
import { createRepositoryIdentityEditor, type RepositoryIdentityEditor } from "./repository-identity"
import { createStore, type Store } from "./store"

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
        notice?: Notice
    }

type Ready = Extract<AppSnapshot, { status: "ready" }>

export interface AppController extends Store<AppSnapshot> {
    readonly entry: RepositoryEntry
    readonly gitSettings: GitSettings
    readonly identity: RepositoryIdentityEditor
    /** The active repository's Workspace Columns. */
    readonly columns: BranchWorkspace
    /** The files each column shows. */
    readonly inspection: Inspection
    /** Loads the app state; also retries after a failed start. */
    start(): Promise<void>
    toggleAppearance(): Promise<void>
    /** Shows every file list in the new view at once; a failed save only loses it for the next start. */
    setFileListView(view: FileListView): Promise<void>
    /** Commits and stashes a column's worktree; an operation refreshes the column, and the Branch Graph when it changed. */
    composer(repositoryId: string, columnId: string, path: string, blocked: boolean): CommitComposer
    openRepository(): Promise<void>
    selectRepository(id: string): Promise<void>
    closeRepository(id: string): Promise<void>
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

    let inspection = createInspection({ api, notify })
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

        async start() {
            store.publish({ status: "starting" })
            try {
                let state = await api.getState()
                gitSettings.load(state.settings)
                store.publish({ status: "ready", appearance: state.appearance, workspace: state.workspace, opening: false, fileListView: state.fileListView })
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

        composer: (repositoryId, columnId, path, blocked) =>
            createCommitComposer({
                api,
                repositoryId,
                path,
                blocked,
                notify,
                mutating: busy => columns.mutating(busy),
                changed: async refreshGraph => {
                    await inspection.readWorking(columnId, true)
                    if (refreshGraph)
                        await columns.refresh(false)
                },
            }),

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
                try {
                    showWorkspace(await api.selectRepository(id))
                } catch (error) {
                    notify({ code: "repository.select.failed", message: errorMessage(error) })
                }
            }),

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
        },

        dispose() {
            clearTimeout(identitySave)
            for (let stop of unsubscribe)
                stop()
            store.clear()
        },
    }
    return controller
}
