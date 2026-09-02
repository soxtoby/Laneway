import type { EntryError, EntryProgress, EntryResult, Workspace } from "@git-workbench/shared"
import { on, ref, type Handle, type RemixNode } from "remix/ui"
import { errorMessage, type NoticeState } from "./feedback"
import { EntryOptions, type EntryActions } from "./workspace"

type Operation = "idle" | "cloning" | "initializing" | "cancelling"

interface CloneState {
    source: string
    destination: string
    destinationEdited: boolean
    error?: EntryError
    progress?: string
}

interface InitState {
    path: string
    branch: string
    error?: EntryError
}

interface RepositoryEntryOptions {
    api: Window["workbench"]
    defaultCloneParent: string
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
    let initialize: InitState = { path: "", branch: "" }
    let addDialog: HTMLDialogElement
    let cloneDialog: HTMLDialogElement
    let cloneSource: HTMLInputElement
    let cloneError: HTMLElement
    let initDialog: HTMLDialogElement
    let initPath: HTMLInputElement
    let initError: HTMLElement

    async function setOperation(value: Operation) {
        operation = value
        document.body.classList.toggle("busy", value != "idle")
        await options.update()
    }

    function showFailure(action: string, error: unknown) {
        options.notify({ code: `${action}.failed`, message: errorMessage(error) })
    }

    function chooseEntry(action: () => void) {
        addDialog.close()
        action()
    }

    async function openClone() {
        clone = emptyClone()
        await options.update()
        cloneDialog.showModal()
        cloneSource.focus()
    }

    async function openInitialize() {
        initialize = { path: "", branch: "" }
        await options.update()
        initDialog.showModal()
        initPath.focus()
    }

    async function browseCloneDestination() {
        try {
            const selected = await options.api.chooseDirectory(clone.destination || options.defaultCloneParent)
            if (selected) {
                clone.destination = selected
                clone.destinationEdited = true
                await options.update()
            }
        } catch (error) {
            showFailure("clone.browse", error)
            await options.update()
        }
    }

    async function suggestCloneDestination() {
        if (clone.destinationEdited)
            return
        const source = clone.source
        try {
            const destination = await options.api.suggestCloneDestination(source, options.defaultCloneParent)
            if (!clone.destinationEdited && clone.source == source) {
                clone.destination = destination
                await options.update()
            }
        } catch (error) {
            showFailure("clone.suggest-destination", error)
            await options.update()
        }
    }

    async function browseInitPath() {
        try {
            const selected = await options.api.chooseDirectory(initialize.path || options.defaultCloneParent)
            if (selected) {
                initialize.path = selected
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
            await finishEntry(await options.api.cloneRepository(clone.source, clone.destination), "clone")
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
            await finishEntry(await options.api.initializeRepository(initialize.path, initialize.branch || undefined), "init")
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
                initialize = { path: "", branch: "" }
            }
            options.notify({
                code: `repository.${form == "clone" ? "cloned" : "initialized"}`,
                message: `Repository ${form == "clone" ? "cloned" : "initialized"} and opened.`,
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
        const error = form == "clone" ? cloneError : initError
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
                            void suggestCloneDestination()
                        }}
                        setDestination={value => {
                            clone.destination = value
                            clone.destinationEdited = true
                            options.update()
                        }}
                        browse={browseCloneDestination}
                        submit={submitClone}
                        cancel={cancelClone}
                    />
                    <InitDialog
                        state={initialize}
                        operation={operation}
                        dialogRef={node => initDialog = node}
                        pathRef={node => initPath = node}
                        errorRef={node => initError = node}
                        setPath={value => {
                            initialize.path = value
                            options.update()
                        }}
                        setBranch={value => {
                            initialize.branch = value
                            options.update()
                        }}
                        browse={browseInitPath}
                        submit={submitInitialize}
                        close={() => initDialog.close()}
                    />
                </>
            )
        },
    }
}

function AddDialog(handle: Handle<EntryActions & { dialogRef(node: HTMLDialogElement): void; close(): void }>) {
    return () => (
        <dialog class="add-dialog" aria-labelledby="add-heading" mix={[ref(handle.props.dialogRef)]}>
            <header><h2 id="add-heading">Add repository</h2></header>
            <EntryOptions busy={handle.props.busy} openRepository={handle.props.openRepository} openClone={handle.props.openClone} openInitialize={handle.props.openInitialize} />
            <footer class="dialog-actions"><button class="text-button" type="button" mix={[on("click", handle.props.close)]}>Cancel</button></footer>
        </dialog>
    )
}

function CloneDialog(handle: Handle<{
    state: CloneState
    operation: Operation
    dialogRef(node: HTMLDialogElement): void
    sourceRef(node: HTMLInputElement): void
    errorRef(node: HTMLElement): void
    setSource(value: string): void
    setDestination(value: string): void
    browse(): void
    submit(): void
    cancel(): void
}>) {
    return () => {
        const busy = handle.props.operation == "cloning" || handle.props.operation == "cancelling"
        return (
            <dialog
                aria-labelledby="clone-heading"
                mix={[
                    ref(handle.props.dialogRef),
                    on("cancel", event => {
                        if (busy) {
                            event.preventDefault()
                            handle.props.cancel()
                        }
                    }),
                ]}
            >
                <form class="entry-form" mix={[on("submit", event => {
                    event.preventDefault()
                    handle.props.submit()
                })]}>
                    <header><h2 id="clone-heading">Clone repository</h2></header>
                    <label for="clone-source">Git source</label>
                    <input id="clone-source" name="source" autocomplete="off" spellcheck={false} placeholder="https://host/team/repository.git" required value={handle.props.state.source} disabled={busy} mix={[ref(handle.props.sourceRef), on("input", event => handle.props.setSource(event.currentTarget.value))]} />
                    <label for="clone-destination">Destination</label>
                    <div class="field-with-action">
                        <input id="clone-destination" name="destination" autocomplete="off" spellcheck={false} required value={handle.props.state.destination} disabled={busy} mix={[on("input", event => handle.props.setDestination(event.currentTarget.value))]} />
                        <button type="button" disabled={busy} mix={[on("click", handle.props.browse)]}>Browse</button>
                    </div>
                    {handle.props.state.progress && <div class="progress-block"><span></span><p>{handle.props.state.progress}</p></div>}
                    <div class="form-error" role="alert" tabIndex={-1} hidden={!handle.props.state.error} mix={[ref(handle.props.errorRef)]}>{handle.props.state.error ? entryErrorMessage(handle.props.state.error) : ""}</div>
                    <footer class="dialog-actions">
                        <button class="text-button" type="button" mix={[on("click", handle.props.cancel)]}>{busy ? (handle.props.operation == "cancelling" ? "Stopping…" : "Cancel clone") : "Cancel"}</button>
                        <button class="primary-button" type="submit" disabled={busy}>Clone and open</button>
                    </footer>
                </form>
            </dialog>
        )
    }
}

function InitDialog(handle: Handle<{
    state: InitState
    operation: Operation
    dialogRef(node: HTMLDialogElement): void
    pathRef(node: HTMLInputElement): void
    errorRef(node: HTMLElement): void
    setPath(value: string): void
    setBranch(value: string): void
    browse(): void
    submit(): void
    close(): void
}>) {
    return () => {
        const busy = handle.props.operation == "initializing"
        return (
            <dialog aria-labelledby="init-heading" mix={[ref(handle.props.dialogRef), on("cancel", event => {
                if (busy)
                    event.preventDefault()
            })]}>
                <form class="entry-form" mix={[on("submit", event => {
                    event.preventDefault()
                    handle.props.submit()
                })]}>
                    <header><h2 id="init-heading">Initialize repository</h2></header>
                    <label for="init-path">Directory</label>
                    <div class="field-with-action">
                        <input id="init-path" name="path" autocomplete="off" spellcheck={false} required value={handle.props.state.path} disabled={busy} mix={[ref(handle.props.pathRef), on("input", event => handle.props.setPath(event.currentTarget.value))]} />
                        <button type="button" disabled={busy} mix={[on("click", handle.props.browse)]}>Browse</button>
                    </div>
                    <label for="init-branch">Initial branch <span>optional</span></label>
                    <input id="init-branch" name="branch" autocomplete="off" spellcheck={false} placeholder="Use system Git default" value={handle.props.state.branch} disabled={busy} mix={[on("input", event => handle.props.setBranch(event.currentTarget.value))]} />
                    <p class="field-note">Existing files stay untouched. Git creates only its repository data.</p>
                    <div class="form-error" role="alert" tabIndex={-1} hidden={!handle.props.state.error} mix={[ref(handle.props.errorRef)]}>{handle.props.state.error ? entryErrorMessage(handle.props.state.error) : ""}</div>
                    <footer class="dialog-actions">
                        <button class="text-button" type="button" disabled={busy} mix={[on("click", handle.props.close)]}>Cancel</button>
                        <button class="primary-button" type="submit" disabled={busy}>Initialize and open</button>
                    </footer>
                </form>
            </dialog>
        )
    }
}

function emptyClone(): CloneState {
    return { source: "", destination: "", destinationEdited: false }
}

function entryErrorMessage(error: EntryError) {
    return error.destination ? `${error.message}\nPartial clone preserved at ${error.destination}` : error.message
}
