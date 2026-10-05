import type { EntryError } from "@laneway/shared"
import { css, type Handle, on, ref } from "remix/ui"
import { type EntryActions, EntryOptions } from "../workspace"

export type Operation = "idle" | "cloning" | "initializing" | "cancelling"

export interface CloneState {
    source: string
    parent: string
    name: string
    nameEdited: boolean
    error?: EntryError
    progress?: string
}

export interface InitState {
    parent: string
    name: string
    branch: string
    error?: EntryError
}

let addDialog = css({
    width: "min(420px, calc(100vw - 48px))",
})

let addDialogHeader = css({
    padding: "10px 14px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
})

let addHeading = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

let dialogActions = css({
    marginTop: "0",
})

let entryForm = css({
    padding: "0 14px",
})

let entryFormHeader = css({
    padding: "10px 14px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
    marginLeft: "-14px",
    marginRight: "-14px",
})

let cloneHeading = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

let entryFormLabel = css({
    display: "block",
    margin: "14px 0 5px",
})

let fieldWithAction = css({
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
})

let cloneParent = css({
    borderRadius: "4px 0 0 4px",
})

let fieldWithActionButton = css({
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

let progressBlock = css({
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

let progressBlockSpan = css({
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

let progressBlockP = css({
    margin: "0",
    overflow: "hidden",
    fontFamily: "var(--mono)",
    fontSize: "12px",
    lineHeight: "1.35",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let formError = css({
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

let cloneDialogDialogActions = css({
    marginLeft: "-14px",
    marginRight: "-14px",
})

let initHeading = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

let initParent = css({
    borderRadius: "4px 0 0 4px",
})

let entryFormSpan = css({
    color: "var(--faint)",
    fontWeight: "400",
})

export function AddDialog(handle: Handle<EntryActions & { dialogRef(node: HTMLDialogElement): void; close(): void }>) {
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

export function CloneDialog(
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
        let busy = handle.props.operation == "cloning" || handle.props.operation == "cancelling"
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

export function InitDialog(
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
        let busy = handle.props.operation == "initializing"
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

export function entryErrorMessage(error: EntryError) {
    return error.destination ? `${error.message}\nPartial clone preserved at ${error.destination}` : error.message
}
