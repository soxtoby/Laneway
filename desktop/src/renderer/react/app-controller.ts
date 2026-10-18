import type { Appearance, OpenRepository, Workspace } from "@laneway/shared"
import { type ColumnPreview, readColumnPreview } from "./column-preview"
import { createGitSettings, type GitSettings } from "./git-settings"
import { errorMessage, type Notice } from "./notice"
import { createRepositoryEntry, type RepositoryEntry } from "./repository-entry"
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
        /** The active repository's columns; absent when it is missing or nothing is open. */
        preview?: ColumnPreview
        notice?: Notice
    }

type Ready = Extract<AppSnapshot, { status: "ready" }>

export interface AppController extends Store<AppSnapshot> {
    readonly entry: RepositoryEntry
    readonly gitSettings: GitSettings
    /** Loads the app state; also retries after a failed start. */
    start(): Promise<void>
    toggleAppearance(): Promise<void>
    openRepository(): Promise<void>
    selectRepository(id: string): Promise<void>
    closeRepository(id: string): Promise<void>
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
    // A preview read overtaken by a later one is dropped.
    let previewRead = 0
    let previewRepositoryId: string | undefined
    let unsubscribe = [
        api.onRepositoryChanged(change => {
            if (ready()?.workspace.activeRepositoryId == change.repositoryId)
                void loadPreview()
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

    // Each workspace change that can move the active repository reloads its columns.
    function showWorkspace(workspace: Workspace) {
        update({ workspace })
        void loadPreview()
    }

    // A refresh keeps the current columns on screen until the new ones arrive; another repository's don't.
    async function loadPreview() {
        let current = ready()
        let active = current && activeRepository(current.workspace)
        let read = ++previewRead
        if (active?.status != "available") {
            previewRepositoryId = undefined
            update({ preview: undefined })
            return
        }
        if (active.id != previewRepositoryId) {
            previewRepositoryId = active.id
            update({ preview: { status: "loading" } })
        }
        let preview: ColumnPreview
        try {
            preview = await readColumnPreview(api, active)
        } catch (error) {
            preview = { status: "failed", error: errorMessage(error) }
        }
        if (read == previewRead)
            update({ preview })
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

    let controller: AppController = {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        entry,
        gitSettings,

        async start() {
            store.publish({ status: "starting" })
            try {
                let state = await api.getState()
                gitSettings.load(state.settings)
                store.publish({ status: "ready", appearance: state.appearance, workspace: state.workspace, opening: false })
                if (state.workspace.persistenceError?.code == "workspace.partial")
                    notify({ code: state.workspace.persistenceError.code, message: state.workspace.persistenceError.message })
                void loadPreview()
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
            for (let stop of unsubscribe)
                stop()
            store.clear()
        },
    }
    return controller
}
