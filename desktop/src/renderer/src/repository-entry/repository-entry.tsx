import type { EntryDefaults, EntryProgress, EntryResult, Workspace } from "@laneway/shared"
import { type RemixNode } from "remix/ui"
import { errorMessage, type NoticeState } from "../feedback"
import { AddDialog, CloneDialog, entryErrorMessage, InitDialog } from "./repository-entry-dialogs"
import type { CloneState, InitState, Operation } from "./repository-entry-dialogs"

interface RepositoryEntryOptions {
    api: Window["laneway"]
    update(): Promise<AbortSignal>
    workspaceOpened(workspace: Workspace): void
    notify(notice: NoticeState): void
    openRepository(): Promise<void>
}

export interface RepositoryEntry {
    readonly busy: boolean
    openAdd(): void
    openClone(): Promise<void>
    openInitialize(): Promise<void>
    updateProgress(progress: EntryProgress): void
    render(): RemixNode
}

export function createRepositoryEntry(options: RepositoryEntryOptions): RepositoryEntry {
    let operation: Operation = "idle"
    let clone: CloneState = emptyClone()
    let initialize: InitState = emptyInit()
    let addDialog: HTMLDialogElement
    let cloneDialog: HTMLDialogElement
    let cloneSource: HTMLInputElement
    let cloneError: HTMLElement
    let initDialog: HTMLDialogElement
    let initName: HTMLInputElement
    let initError: HTMLElement

    return {
        get busy() {
            return operation != "idle"
        },
        openAdd() {
            addDialog.showModal()
        },
        openClone,
        openInitialize,
        updateProgress(progress) {
            if (operation != "cloning" && operation != "cancelling")
                return
            clone.progress = progress.message
            options.update()
        },
        render() {
            return (
                <>
                    <AddDialog
                        busy={operation != "idle"}
                        dialogRef={node => addDialog = node}
                        close={() => addDialog.close()}
                        openRepository={() => chooseEntry(() => void options.openRepository())}
                        openClone={() => chooseEntry(() => void openClone())}
                        openInitialize={() => chooseEntry(() => void openInitialize())}
                    />
                    <CloneDialog
                        state={clone}
                        operation={operation}
                        dialogRef={node => cloneDialog = node}
                        sourceRef={node => cloneSource = node}
                        errorRef={node => cloneError = node}
                        setSource={value => {
                            clone.source = value
                            options.update()
                            void suggestCloneName()
                        }}
                        setParent={value => {
                            clone.parent = value
                            options.update()
                        }}
                        setName={value => {
                            clone.name = value
                            clone.nameEdited = true
                            options.update()
                        }}
                        browse={browseCloneParent}
                        submit={submitClone}
                        cancel={cancelClone}
                    />
                    <InitDialog
                        state={initialize}
                        operation={operation}
                        dialogRef={node => initDialog = node}
                        nameRef={node => initName = node}
                        errorRef={node => initError = node}
                        setParent={value => {
                            initialize.parent = value
                            options.update()
                        }}
                        setName={value => {
                            initialize.name = value
                            options.update()
                        }}
                        setBranch={value => {
                            initialize.branch = value
                            options.update()
                        }}
                        browse={browseInitParent}
                        submit={submitInitialize}
                        close={() => initDialog.close()}
                    />
                </>
            )
        },
    }

    function chooseEntry(action: () => void) {
        addDialog.close()
        action()
    }

    async function openClone() {
        let defaults = await loadDefaults("clone")
        clone = emptyClone()
        clone.parent = defaults?.parent ?? ""
        if (defaults?.source) {
            clone.source = defaults.source
            void suggestCloneName()
        }
        await options.update()
        cloneDialog.showModal()
        cloneSource.focus()
    }

    async function openInitialize() {
        let defaults = await loadDefaults("init")
        initialize = emptyInit()
        initialize.parent = defaults?.parent ?? ""
        await options.update()
        initDialog.showModal()
        initName.focus()
    }

    async function loadDefaults(form: "clone" | "init"): Promise<EntryDefaults | undefined> {
        try {
            return await options.api.entryDefaults(form)
        } catch (error) {
            showFailure("entry.defaults", error)
            return undefined
        }
    }

    async function browseCloneParent() {
        try {
            let selected = await options.api.chooseDirectory(clone.parent || undefined)
            if (selected) {
                clone.parent = selected
                await options.update()
            }
        } catch (error) {
            showFailure("clone.browse", error)
            await options.update()
        }
    }

    async function suggestCloneName() {
        if (clone.nameEdited)
            return
        let source = clone.source
        try {
            let name = await options.api.suggestCloneDirectoryName(source)
            if (!clone.nameEdited && clone.source == source) {
                clone.name = name
                await options.update()
            }
        } catch (error) {
            showFailure("clone.suggest-name", error)
            await options.update()
        }
    }

    async function browseInitParent() {
        try {
            let selected = await options.api.chooseDirectory(initialize.parent || undefined)
            if (selected) {
                initialize.parent = selected
                await options.update()
            }
        } catch (error) {
            showFailure("initialize.browse", error)
            await options.update()
        }
    }

    async function submitClone() {
        clone.error = undefined
        clone.progress = "Starting Git"
        await setOperation("cloning")

        try {
            await finishEntry(await options.api.cloneRepository(clone.source, clone.parent, clone.name), "clone")
        } catch (error) {
            clone.progress = undefined
            showFailure("repository.clone", error)
        } finally {
            await setOperation("idle")
        }
    }

    async function submitInitialize() {
        initialize.error = undefined
        await setOperation("initializing")
        try {
            await finishEntry(await options.api.initializeRepository(initialize.parent, initialize.name, initialize.branch || undefined), "init")
        } catch (error) {
            showFailure("repository.initialize", error)
        } finally {
            await setOperation("idle")
        }
    }

    async function finishEntry(result: EntryResult, form: "clone" | "init") {
        if (result.ok) {
            options.workspaceOpened(result.workspace)
            if (form == "clone") {
                cloneDialog.close()
                clone = emptyClone()
            } else {
                initDialog.close()
                initialize = emptyInit()
            }
            options.notify({
                code: `repository.${form == "clone" ? "cloned" : "initialized"}`,
                message: `Repository ${form == "clone" ? "cloned" : "initialized"} and opened.`,
                transient: true,
            })
            return
        }
        if (result.error.code == "git.cancelled") {
            clone.progress = undefined
            return
        }
        if (form == "clone")
            clone.error = result.error
        else
            initialize.error = result.error
        clone.progress = undefined
        if (result.error.destination)
            options.notify({ code: result.error.code, message: entryErrorMessage(result.error) })
        await options.update()
        let error = form == "clone" ? cloneError : initError
        queueMicrotask(() => error.focus())
    }

    async function cancelClone() {
        if (operation == "cloning" || operation == "cancelling") {
            if (operation == "cloning") {
                await setOperation("cancelling")
                clone.progress = "Stopping Git"
                try {
                    await options.api.cancelEntry()
                } catch (error) {
                    showFailure("repository.cancel", error)
                    await setOperation("idle")
                }
                await options.update()
            }
            return
        }
        cloneDialog.close()
    }

    async function setOperation(value: Operation) {
        operation = value
        document.body.classList.toggle("busy", value != "idle")
        await options.update()
    }

    function showFailure(action: string, error: unknown) {
        options.notify({ code: `${action}.failed`, message: errorMessage(error) })
    }
}

function emptyClone(): CloneState {
    return { source: "", parent: "", name: "", nameEdited: false }
}

function emptyInit(): InitState {
    return { parent: "", name: "", branch: "" }
}
