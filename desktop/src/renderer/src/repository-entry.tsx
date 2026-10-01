import type { EntryDefaults, EntryError, EntryProgress, EntryResult, Workspace } from "@laneway/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import { errorMessage, type NoticeState } from "./feedback"
import { type EntryActions, EntryOptions } from "./workspace"

type Operation = "idle" | "cloning" | "initializing" | "cancelling"

interface CloneState {
    source: string
    parent: string
    name: string
    nameEdited: boolean
    error?: EntryError
    progress?: string
}

interface InitState {
    parent: string
    name: string
    branch: string
    error?: EntryError
}

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

    async function loadDefaults(form: "clone" | "init"): Promise<EntryDefaults | undefined> {
        try {
            return await options.api.entryDefaults(form)
        } catch (error) {
            showFailure("entry.defaults", error)
            return undefined
        }
    }

    async function openClone() {
        const defaults = await loadDefaults("clone")
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
        const defaults = await loadDefaults("init")
        initialize = emptyInit()
        initialize.parent = defaults?.parent ?? ""
        await options.update()
        initDialog.showModal()
        initName.focus()
    }

    async function browseCloneParent() {
        try {
            const selected = await options.api.chooseDirectory(clone.parent || undefined)
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
        const source = clone.source
        try {
            const name = await options.api.suggestCloneDirectoryName(source)
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
            const selected = await options.api.chooseDirectory(initialize.parent || undefined)
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
}

function AddDialog(handle: Handle<EntryActions & { dialogRef(node: HTMLDialogElement): void; close(): void }>) {
    return () => (
        <dialog class="add-dialog" aria-labelledby="add-heading" mix={[addDialog, ref(handle.props.dialogRef)]}>
            <header mix={addDialogHeader}>
                <h2 id="add-heading" mix={addHeading}>
                    Add repository
                </h2>
            </header>
            <EntryOptions
                busy={handle.props.busy}
                openRepository={handle.props.openRepository}
                openClone={handle.props.openClone}
                openInitialize={handle.props.openInitialize}
            />
            <footer class="dialog-actions" mix={dialogActions}>
                <button class="text-button" type="button" mix={[on("click", handle.props.close)]}>Cancel</button>
            </footer>
        </dialog>
    )
}

function CloneDialog(
    handle: Handle<{
        state: CloneState
        operation: Operation
        dialogRef(node: HTMLDialogElement): void
        sourceRef(node: HTMLInputElement): void
        errorRef(node: HTMLElement): void
        setSource(value: string): void
        setParent(value: string): void
        setName(value: string): void
        browse(): void
        submit(): void
        cancel(): void
    }>,
) {
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
                <form
                    class="entry-form"
                    mix={[
                        entryForm,
                        on("submit", event => {
                            event.preventDefault()
                            handle.props.submit()
                        }),
                    ]}
                >
                    <header mix={entryFormHeader}>
                        <h2 id="clone-heading" mix={cloneHeading}>
                            Clone repository
                        </h2>
                    </header>
                    <label for="clone-source" mix={entryFormLabel}>
                        Git source
                    </label>
                    <input
                        id="clone-source"
                        name="source"
                        autocomplete="off"
                        spellcheck={false}
                        placeholder="https://host/team/repository.git"
                        required
                        value={handle.props.state.source}
                        disabled={busy}
                        mix={[ref(handle.props.sourceRef), on("input", event => handle.props.setSource(event.currentTarget.value))]}
                    />
                    <label for="clone-parent" mix={entryFormLabel}>
                        Parent directory
                    </label>
                    <div class="field-with-action" mix={fieldWithAction}>
                        <input
                            id="clone-parent"
                            name="parent"
                            autocomplete="off"
                            spellcheck={false}
                            required
                            value={handle.props.state.parent}
                            disabled={busy}
                            mix={[cloneParent, on("input", event => handle.props.setParent(event.currentTarget.value))]}
                        />
                        <button type="button" disabled={busy} mix={[fieldWithActionButton, on("click", handle.props.browse)]}>
                            Browse
                        </button>
                    </div>
                    <label for="clone-name" mix={entryFormLabel}>
                        Directory name
                    </label>
                    <input
                        id="clone-name"
                        name="name"
                        autocomplete="off"
                        spellcheck={false}
                        placeholder="repository"
                        required
                        value={handle.props.state.name}
                        disabled={busy}
                        mix={[on("input", event => handle.props.setName(event.currentTarget.value))]}
                    />
                    {handle.props.state.progress && (
                        <div class="progress-block" mix={progressBlock}>
                            <span mix={progressBlockSpan}>
                            </span>
                            <p mix={progressBlockP}>
                                {handle.props.state.progress}
                            </p>
                        </div>
                    )}
                    <div class="form-error" role="alert" tabIndex={-1} hidden={!handle.props.state.error} mix={[formError, ref(handle.props.errorRef)]}>
                        {handle.props.state.error ? entryErrorMessage(handle.props.state.error) : ""}
                    </div>
                    <footer class="dialog-actions" mix={cloneDialogDialogActions}>
                        <button class="text-button" type="button" mix={[on("click", handle.props.cancel)]}>
                            {busy ? (handle.props.operation == "cancelling" ? "Stopping…" : "Cancel clone") : "Cancel"}
                        </button>
                        <button class="primary-button" type="submit" disabled={busy}>Clone and open</button>
                    </footer>
                </form>
            </dialog>
        )
    }
}

function InitDialog(
    handle: Handle<{
        state: InitState
        operation: Operation
        dialogRef(node: HTMLDialogElement): void
        nameRef(node: HTMLInputElement): void
        errorRef(node: HTMLElement): void
        setParent(value: string): void
        setName(value: string): void
        setBranch(value: string): void
        browse(): void
        submit(): void
        close(): void
    }>,
) {
    return () => {
        const busy = handle.props.operation == "initializing"
        return (
            <dialog
                aria-labelledby="init-heading"
                mix={[
                    ref(handle.props.dialogRef),
                    on("cancel", event => {
                        if (busy)
                            event.preventDefault()
                    }),
                ]}
            >
                <form
                    class="entry-form"
                    mix={[
                        entryForm,
                        on("submit", event => {
                            event.preventDefault()
                            handle.props.submit()
                        }),
                    ]}
                >
                    <header mix={entryFormHeader}>
                        <h2 id="init-heading" mix={initHeading}>
                            Initialize repository
                        </h2>
                    </header>
                    <label for="init-parent" mix={entryFormLabel}>
                        Parent directory
                    </label>
                    <div class="field-with-action" mix={fieldWithAction}>
                        <input
                            id="init-parent"
                            name="parent"
                            autocomplete="off"
                            spellcheck={false}
                            required
                            value={handle.props.state.parent}
                            disabled={busy}
                            mix={[initParent, on("input", event => handle.props.setParent(event.currentTarget.value))]}
                        />
                        <button type="button" disabled={busy} mix={[fieldWithActionButton, on("click", handle.props.browse)]}>
                            Browse
                        </button>
                    </div>
                    <label for="init-name" mix={entryFormLabel}>
                        Directory name
                    </label>
                    <input
                        id="init-name"
                        name="name"
                        autocomplete="off"
                        spellcheck={false}
                        required
                        value={handle.props.state.name}
                        disabled={busy}
                        mix={[ref(handle.props.nameRef), on("input", event => handle.props.setName(event.currentTarget.value))]}
                    />
                    <label for="init-branch" mix={entryFormLabel}>
                        Initial branch{" "}
                        <span mix={entryFormSpan}>
                            optional
                        </span>
                    </label>
                    <input
                        id="init-branch"
                        name="branch"
                        autocomplete="off"
                        spellcheck={false}
                        placeholder="Use system Git default"
                        value={handle.props.state.branch}
                        disabled={busy}
                        mix={[on("input", event => handle.props.setBranch(event.currentTarget.value))]}
                    />
                    <p class="field-note">Existing files stay untouched. Git creates only its repository data.</p>
                    <div class="form-error" role="alert" tabIndex={-1} hidden={!handle.props.state.error} mix={[formError, ref(handle.props.errorRef)]}>
                        {handle.props.state.error ? entryErrorMessage(handle.props.state.error) : ""}
                    </div>
                    <footer class="dialog-actions" mix={cloneDialogDialogActions}>
                        <button class="text-button" type="button" disabled={busy} mix={[on("click", handle.props.close)]}>Cancel</button>
                        <button class="primary-button" type="submit" disabled={busy}>Initialize and open</button>
                    </footer>
                </form>
            </dialog>
        )
    }
}

function emptyClone(): CloneState {
    return { source: "", parent: "", name: "", nameEdited: false }
}

function emptyInit(): InitState {
    return { parent: "", name: "", branch: "" }
}

function entryErrorMessage(error: EntryError) {
    return error.destination ? `${error.message}\nPartial clone preserved at ${error.destination}` : error.message
}

const addDialog = css({
    width: "min(420px, calc(100vw - 48px))",
})

const addDialogHeader = css({
    padding: "10px 14px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
})

const addHeading = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

const dialogActions = css({
    marginTop: "0",
})

const entryForm = css({
    padding: "0 14px",
})

const entryFormHeader = css({
    padding: "10px 14px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
    marginLeft: "-14px",
    marginRight: "-14px",
})

const cloneHeading = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

const entryFormLabel = css({
    display: "block",
    margin: "14px 0 5px",
})

const fieldWithAction = css({
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
})

const cloneParent = css({
    borderRadius: "4px 0 0 4px",
})

const fieldWithActionButton = css({
    padding: "0 11px",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderLeft: "0",
    borderRadius: "0 4px 4px 0",
    background: "var(--control)",
    fontSize: "12px",
    "&:hover:not(:disabled)": {
        background: "var(--control-hover)",
    },
})

const progressBlock = css({
    position: "relative",
    marginTop: "16px",
    padding: "10px 12px 10px 30px",
    overflow: "hidden",
    border: "1px solid var(--line)",
    borderRadius: "4px",
    background: "var(--canvas)",
    "&::before": {
        position: "absolute",
        top: "14px",
        left: "13px",
        width: "6px",
        height: "6px",
        content: '""',
        borderRadius: "50%",
        background: "var(--accent)",
    },
})

const progressBlockSpan = css({
    position: "absolute",
    top: "0",
    left: "0",
    width: "26%",
    height: "2px",
    background: "var(--accent)",
    animation: "progress-sweep 1.3s ease-in-out infinite alternate",
    "@media (forced-colors: active)": {
        background: "Highlight",
    },
})

const progressBlockP = css({
    margin: "0",
    overflow: "hidden",
    fontFamily: "var(--mono)",
    fontSize: "12px",
    lineHeight: "1.35",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const formError = css({
    marginTop: "14px",
    padding: "10px 12px",
    color: "var(--danger)",
    border: "1px solid var(--danger-edge)",
    borderRadius: "4px",
    background: "var(--danger-wash)",
    fontSize: "12px",
    lineHeight: "1.5",
    "&[hidden]": {
        display: "none",
    },
})

const cloneDialogDialogActions = css({
    marginLeft: "-14px",
    marginRight: "-14px",
})

const initHeading = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

const initParent = css({
    borderRadius: "4px 0 0 4px",
})

const entryFormSpan = css({
    color: "var(--faint)",
    fontWeight: "400",
})
