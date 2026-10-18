import type { Appearance, OpenRepository, Workspace } from "@laneway/shared"
import { type ColumnPreview, readColumnPreview } from "./column-preview"

type Api = Window["laneway"]

export interface Notice {
    code: string
    message: string
    /** Confirmations close themselves; failures and guidance wait for the user. */
    transient?: boolean
    /** How long a transient notice stays when it needs longer than the default, such as an undo window. */
    duration?: number
    /** One follow-up the notice offers, such as undoing what it reports. */
    action?: { label: string; run(): void }
    /** Called once the notice leaves the screen, whether dismissed, timed out, or replaced. */
    closed?(): void
}

export type AppSnapshot =
    | { status: "starting" }
    | { status: "failed"; error: string }
    | {
        status: "ready"
        appearance: Appearance
        workspace: Workspace
        /** The active repository's columns; absent when it is missing or nothing is open. */
        preview?: ColumnPreview
        notice?: Notice
    }

type Ready = Extract<AppSnapshot, { status: "ready" }>

export interface AppController {
    subscribe(listener: () => void): () => void
    /** The same object until something changes, as `useSyncExternalStore` requires. */
    snapshot(): AppSnapshot
    /** Loads the app state; also retries after a failed start. */
    start(): Promise<void>
    toggleAppearance(): Promise<void>
    openRepository(): Promise<void>
    selectRepository(id: string): Promise<void>
    closeRepository(id: string): Promise<void>
    /** Takes every open repository's id in the new order. */
    reorderRepositories(ids: string[]): Promise<void>
    /** Shows a notice in place of the current one; the returned function withdraws it if it is still showing. */
    notify(notice: Notice): () => void
    dismissNotice(notice: Notice): void
    dispose(): void
}

export function createAppController(api: Api): AppController {
    let snapshot: AppSnapshot = { status: "starting" }
    let listeners = new Set<() => void>()
    // A preview read overtaken by a later one is dropped.
    let previewRead = 0
    let previewRepositoryId: string | undefined
    let unsubscribe = api.onRepositoryChanged(change => {
        let ready = readySnapshot()
        if (ready?.workspace.activeRepositoryId == change.repositoryId)
            void loadPreview()
    })

    function publish(next: AppSnapshot) {
        snapshot = next
        for (let listener of listeners)
            listener()
    }

    function readySnapshot() {
        return snapshot.status == "ready" ? snapshot : undefined
    }

    function update(change: Partial<Ready>) {
        let ready = readySnapshot()
        if (ready)
            publish({ ...ready, ...change })
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
        let ready = readySnapshot()
        let active = ready && activeRepository(ready.workspace)
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

    function notify(notice: Notice) {
        let replaced = readySnapshot()?.notice
        update({ notice })
        replaced?.closed?.()
        return () => controller.dismissNotice(notice)
    }

    let controller: AppController = {
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        snapshot: () => snapshot,

        async start() {
            publish({ status: "starting" })
            try {
                let state = await api.getState()
                publish({ status: "ready", appearance: state.appearance, workspace: state.workspace })
                if (state.workspace.persistenceError?.code == "workspace.partial")
                    notify({ code: state.workspace.persistenceError.code, message: state.workspace.persistenceError.message })
                void loadPreview()
            } catch (error) {
                publish({ status: "failed", error: errorMessage(error) })
            }
        },

        // The main process applies the appearance to Electron's native theme, which the kit's
        // prefers-color-scheme rules follow, so the page changes once the setting is saved.
        async toggleAppearance() {
            let ready = readySnapshot()
            if (!ready)
                return
            try {
                update({ appearance: await api.setAppearance(ready.appearance == "dark" ? "light" : "dark") })
            } catch (error) {
                notify({ code: "settings.appearance.failed", message: errorMessage(error) })
            }
        },

        async openRepository() {
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
        },

        async selectRepository(id) {
            try {
                showWorkspace(await api.selectRepository(id))
            } catch (error) {
                notify({ code: "repository.select.failed", message: errorMessage(error) })
            }
        },

        async closeRepository(id) {
            try {
                showWorkspace(await api.closeRepository(id))
            } catch (error) {
                notify({ code: "repository.close.failed", message: errorMessage(error) })
            }
        },

        // The new order shows at once; a dropped repository already appears in its slot while the workspace saves.
        async reorderRepositories(ids) {
            let ready = readySnapshot()
            if (!ready)
                return
            let workspace = {
                ...ready.workspace,
                repositories: [...ready.workspace.repositories].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
            }
            update({ workspace })
            try {
                update({ workspace: await api.updateWorkspace(workspace) })
            } catch (error) {
                notify({ code: "workspace.save.failed", message: errorMessage(error) })
            }
        },

        notify,

        dismissNotice(notice) {
            if (readySnapshot()?.notice != notice)
                return
            update({ notice: undefined })
            notice.closed?.()
        },

        dispose() {
            unsubscribe()
            listeners.clear()
        },
    }
    return controller
}

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
