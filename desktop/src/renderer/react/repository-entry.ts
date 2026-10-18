import type { EntryDefaults, EntryError, EntryProgress, EntryResult, Workspace } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export type EntryDialog = "add" | "clone" | "initialize"
export type EntryOperation = "idle" | "cloning" | "initializing" | "cancelling"

export interface CloneForm {
    source: string
    parent: string
    name: string
    /** Once the user types a name, a changed source no longer suggests one. */
    nameEdited: boolean
    progress?: string
    error?: EntryError
}

export interface InitializeForm {
    parent: string
    name: string
    branch: string
    error?: EntryError
}

export interface EntrySnapshot {
    dialog?: EntryDialog
    operation: EntryOperation
    clone: CloneForm
    initialize: InitializeForm
}

export interface RepositoryEntry extends Store<EntrySnapshot> {
    openAdd(): void
    /** Runs the Open action from the Add dialog, which closes first. */
    openRepository(): void
    openClone(): Promise<void>
    openInitialize(): Promise<void>
    /** Closes the dialog, except while Git runs: a clone stops instead, and initializing can't be left. */
    dismiss(): Promise<void>
    setClone(change: Partial<Pick<CloneForm, "source" | "parent" | "name">>): void
    setInitialize(change: Partial<Pick<InitializeForm, "parent" | "name" | "branch">>): void
    browseCloneParent(): Promise<void>
    browseInitializeParent(): Promise<void>
    submitClone(): Promise<void>
    submitInitialize(): Promise<void>
    updateProgress(progress: EntryProgress): void
}

interface EntryOptions {
    api: Api
    notify(notice: Notice): void
    workspaceOpened(workspace: Workspace): void
    openRepository(): Promise<void>
}

/** Adding a repository: the Add dialog's choices, and cloning or initializing one with progress and cancellation. */
export function createRepositoryEntry({ api, notify, workspaceOpened, openRepository }: EntryOptions): RepositoryEntry {
    let store = createStore<EntrySnapshot>({ operation: "idle", clone: emptyClone(), initialize: emptyInitialize() })
    let state = store.snapshot
    let update = (change: Partial<EntrySnapshot>) => store.publish({ ...state(), ...change })
    let updateClone = (change: Partial<CloneForm>) => update({ clone: { ...state().clone, ...change } })
    let updateInitialize = (change: Partial<InitializeForm>) => update({ initialize: { ...state().initialize, ...change } })

    async function loadDefaults(form: "clone" | "init"): Promise<EntryDefaults | undefined> {
        try {
            return await api.entryDefaults(form)
        } catch (error) {
            showFailure("entry.defaults", error)
            return undefined
        }
    }

    async function suggestCloneName() {
        let { source, nameEdited } = state().clone
        if (nameEdited)
            return
        try {
            let name = await api.suggestCloneDirectoryName(source)
            let clone = state().clone
            if (!clone.nameEdited && clone.source == source)
                updateClone({ name })
        } catch (error) {
            showFailure("clone.suggest-name", error)
        }
    }

    async function browse(current: string, action: string) {
        try {
            return await api.chooseDirectory(current || undefined)
        } catch (error) {
            showFailure(action, error)
            return undefined
        }
    }

    async function finish(result: EntryResult, form: "clone" | "initialize") {
        if (result.ok) {
            workspaceOpened(result.workspace)
            update(form == "clone" ? { dialog: undefined, clone: emptyClone() } : { dialog: undefined, initialize: emptyInitialize() })
            let done = form == "clone" ? "cloned" : "initialized"
            notify({ code: `repository.${done}`, message: `Repository ${done} and opened.`, transient: true })
            return
        }
        // A cancelled clone keeps its values and its dialog for another try.
        if (result.error.code == "git.cancelled") {
            updateClone({ progress: undefined })
            return
        }
        if (form == "clone")
            updateClone({ progress: undefined, error: result.error })
        else
            updateInitialize({ error: result.error })
        if (result.error.destination)
            notify({ code: result.error.code, message: entryErrorMessage(result.error) })
    }

    function showFailure(action: string, error: unknown) {
        notify({ code: `${action}.failed`, message: errorMessage(error) })
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        openAdd() {
            update({ dialog: "add" })
        },

        openRepository() {
            update({ dialog: undefined })
            void openRepository()
        },

        async openClone() {
            update({ dialog: undefined })
            let defaults = await loadDefaults("clone")
            update({ dialog: "clone", clone: { ...emptyClone(), parent: defaults?.parent ?? "", source: defaults?.source ?? "" } })
            if (defaults?.source)
                await suggestCloneName()
        },

        async openInitialize() {
            update({ dialog: undefined })
            let defaults = await loadDefaults("init")
            update({ dialog: "initialize", initialize: { ...emptyInitialize(), parent: defaults?.parent ?? "" } })
        },

        async dismiss() {
            let { operation } = state()
            if (operation == "initializing" || operation == "cancelling")
                return
            if (operation != "cloning") {
                update({ dialog: undefined })
                return
            }
            update({ operation: "cancelling", clone: { ...state().clone, progress: "Stopping Git" } })
            try {
                await api.cancelEntry()
            } catch (error) {
                showFailure("repository.cancel", error)
                update({ operation: "idle" })
            }
        },

        setClone(change) {
            updateClone({ ...change, ...change.name != undefined ? { nameEdited: true } : {} })
            if (change.source != undefined)
                void suggestCloneName()
        },

        setInitialize(change) {
            updateInitialize(change)
        },

        async browseCloneParent() {
            let selected = await browse(state().clone.parent, "clone.browse")
            if (selected)
                updateClone({ parent: selected })
        },

        async browseInitializeParent() {
            let selected = await browse(state().initialize.parent, "initialize.browse")
            if (selected)
                updateInitialize({ parent: selected })
        },

        async submitClone() {
            let { source, parent, name } = state().clone
            update({ operation: "cloning", clone: { ...state().clone, error: undefined, progress: "Starting Git" } })
            try {
                await finish(await api.cloneRepository(source, parent, name), "clone")
            } catch (error) {
                updateClone({ progress: undefined })
                showFailure("repository.clone", error)
            } finally {
                update({ operation: "idle" })
            }
        },

        async submitInitialize() {
            let { parent, name, branch } = state().initialize
            update({ operation: "initializing", initialize: { ...state().initialize, error: undefined } })
            try {
                await finish(await api.initializeRepository(parent, name, branch || undefined), "initialize")
            } catch (error) {
                showFailure("repository.initialize", error)
            } finally {
                update({ operation: "idle" })
            }
        },

        updateProgress(progress) {
            let { operation } = state()
            if (operation == "cloning" || operation == "cancelling")
                updateClone({ progress: progress.message })
        },
    }
}

/** An entry failure's message, with where a partial clone was kept. */
export function entryErrorMessage(error: EntryError) {
    return error.destination ? `${error.message}\nPartial clone preserved at ${error.destination}` : error.message
}

function emptyClone(): CloneForm {
    return { source: "", parent: "", name: "", nameEdited: false }
}

function emptyInitialize(): InitializeForm {
    return { parent: "", name: "", branch: "" }
}
