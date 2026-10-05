import type { BranchGraphBranchNode, LocalPreview, LocalRequest } from "@laneway/shared"
import { css, on, ref } from "remix/ui"
let dialogStyle = css({
    width: "min(480px, calc(100vw - 32px))",
    margin: "auto",
    padding: "18px",
    border: "1px solid var(--line-strong)",
    borderRadius: "6px",
    background: "var(--panel)",
    color: "var(--text)",
    boxShadow: "var(--shadow-dialog)",
    "&::backdrop": { background: "var(--scrim)" },
    "& h2": { margin: "0 0 12px", fontSize: "16px" },
    "& input:not([type=checkbox]), & select": {
        width: "100%",
        marginTop: "6px",
        padding: "7px",
        border: "1px solid var(--line-strong)",
        borderRadius: "4px",
        background: "var(--field)",
        color: "var(--text)",
    },
    "& footer": { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" },
    "& button": { padding: "5px 9px", background: "var(--control)", color: "var(--text)", border: "1px solid var(--line-strong)", borderRadius: "4px" },
    "& .stash-action-row": { display: "flex", alignItems: "center", gap: "6px", padding: "8px 0", borderBottom: "1px solid var(--line)" },
    "& .stash-action-row span": { flex: 1, minWidth: 0, overflowWrap: "anywhere" },
    "& small": { display: "block", color: "var(--muted)" },
})

export function createLocalBranchActions(options: {
    api: Window["laneway"]
    update(): Promise<AbortSignal>
    completed(repositoryId: string, request: LocalRequest): Promise<void>
}) {
    let repositoryId = "", mode: "branch-create" | "branch-rename" | "branch-delete" | "stashes" | undefined
    let name = "", original = "", commit = "", error = "", busy = false, confirmed = false
    let preview: LocalPreview | undefined
    let destination = "", selectedStash = ""
    let returnFocus: HTMLElement | undefined
    let update = () => void options.update()
    return {
        busy: () => busy,
        perform,
        open(id: string, branch: BranchGraphBranchNode, action: "branch-create" | "branch-rename" | "branch-delete") {
            repositoryId = id
            mode = action
            original = branch.name
            name = action == "branch-create" ? "" : branch.name
            commit = branch.tip
            preview = undefined
            confirmed = false
            error = ""
            returnFocus = document.activeElement as HTMLElement
            update()
            if (action == "branch-delete") {
                void inspect(request()).then(value => {
                    preview = value
                    update()
                }).catch(reason => {
                    error = String(reason)
                    update()
                })
            }
        },
        atCommit(id: string, objectId: string) {
            repositoryId = id
            mode = "branch-create"
            name = ""
            commit = objectId
            preview = undefined
            error = ""
            update()
        },
        async stashes(id: string, path: string, objectId = "") {
            repositoryId = id
            mode = "stashes"
            destination = path
            selectedStash = objectId
            error = ""
            preview = undefined
            update()

            try {
                preview = await inspect({ action: "stage", path, unstage: false })
            } catch (reason) {
                error = String(reason)
            }
            update()
        },
        render() {
            if (!mode)
                return null
            return (
                <dialog
                    aria-label="Local Git operation"
                    mix={[
                        dialogStyle,
                        ref(element => element.showModal()),
                        on("cancel", event => {
                            event.preventDefault()
                            if (!busy)
                                close()
                        }),
                    ]}
                >
                    <h2>
                        {mode == "stashes"
                            ? "Stashes"
                            : mode == "branch-create"
                            ? "Create branch"
                            : mode == "branch-rename"
                            ? "Rename branch"
                            : "Delete branch"}
                    </h2>
                    {mode == "branch-delete"
                        ? (
                            <>
                                <p>
                                    Delete <strong>{original}</strong>? Checked-out worktrees stay at the same commit with their Working Changes intact.
                                </p>
                                {preview?.uniqueCommits && (
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={confirmed}
                                            mix={on("change", event => {
                                                confirmed = event.currentTarget.checked
                                                update()
                                            })}
                                        />
                                        Delete commits not protected by another branch or tag
                                    </label>
                                )}
                            </>
                        )
                        : mode != "stashes"
                        ? (
                            <label>
                                Branch name<input
                                    aria-label="Branch name"
                                    value={name}
                                    disabled={busy}
                                    mix={[
                                        ref(element => element.focus()),
                                        on("input", event => {
                                            name = event.currentTarget.value
                                            update()
                                        }),
                                    ]}
                                />
                            </label>
                        )
                        : (
                            <>
                                {preview?.stashes.map(stash => (
                                    <div class="stash-action-row" key={stash.objectId}>
                                        <span>
                                            {stash.label}
                                            <small>{stash.branch ?? "Unassigned"}</small>
                                        </span>
                                        <button
                                            disabled={busy}
                                            mix={on("click", () => {
                                                selectedStash = stash.objectId
                                                update()
                                            })}
                                        >
                                            Apply…
                                        </button>
                                        <button disabled={busy} mix={on("click", () => void execute({ action: "stash-drop", objectId: stash.objectId }))}>
                                            Drop
                                        </button>
                                    </div>
                                ))}
                                {preview && !preview.stashes.length && <p>No stashes.</p>}
                                {selectedStash && (
                                    <label>
                                        Destination worktree<select
                                            value={destination}
                                            mix={on("change", event => {
                                                destination = event.currentTarget.value
                                            })}
                                        >
                                            {preview?.worktrees.map(worktree => (
                                                <option value={worktree.path}>{worktree.name} · {worktree.branch ?? "detached"}</option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                            </>
                        )}
                    {error && <p role="alert">{error}</p>}
                    <footer>
                        {mode != "stashes" && (
                            <button
                                disabled={busy || !name.trim() || (mode == "branch-delete" && (!preview || preview.uniqueCommits && !confirmed))}
                                mix={on("click", () => void execute())}
                            >
                                {mode == "branch-delete" ? "Delete" : mode == "branch-create" ? "Create branch" : "Rename"}
                            </button>
                        )}
                        {mode == "stashes" && selectedStash && (
                            <button
                                disabled={busy}
                                mix={on("click", () => void execute({ action: "stash-apply", path: destination, objectId: selectedStash }))}
                            >
                                Apply stash
                            </button>
                        )}
                        <button disabled={busy} mix={on("click", close)}>{mode == "stashes" ? "Close" : "Cancel"}</button>
                    </footer>
                </dialog>
            )
        },
    }

    function request(): LocalRequest {
        if (mode == "branch-create")
            return { action: mode, name, commit }
        if (mode == "branch-rename")
            return { action: mode, name: original, newName: name }
        return { action: "branch-delete", name: original, confirmed }
    }

    /** Runs one operation straight away, for controls that edit in place rather than through the dialog. */
    async function perform(id: string, value: LocalRequest) {
        let fresh = await inspect(value, id)
        let response = await options.api.localOperation(id, value, fresh.token)
        if (!response.ok)
            throw new Error(response.error.message)
        if (response.result.status == "failed")
            throw new Error(response.result.message)
        await options.completed(id, value)
    }

    async function execute(value = request()) {
        if (busy)
            return

        busy = true
        error = ""
        update()

        try {
            // The delete dialog already holds a preview; the engine re-verifies its token at execution,
            // so a second preview here would only add a round trip before the branch disappears.
            let reviewed = value.action == "branch-delete" ? preview : undefined
            let fresh = reviewed ?? await inspect(value)
            if (value.action == "branch-delete" && fresh.uniqueCommits && !confirmed) {
                preview = fresh
                return
            }
            let response = await options.api.localOperation(repositoryId, value, fresh.token)
            if (!response.ok) {
                if (reviewed) {
                    let current = await inspect(value).catch(() => undefined)
                    if (current && current.token != reviewed.token) {
                        confirmed = false
                        preview = current
                        throw new Error("The branch changed. Review deletion again.")
                    }
                }
                throw new Error(response.error.message)
            }
            if (response.result.status == "failed")
                throw new Error(response.result.message)
            await options.completed(repositoryId, value)
            if (mode == "stashes") {
                preview = await inspect(value.action == "stash-drop" ? { action: "stage", path: destination, unstage: false } : value)
                selectedStash = ""
            } else {
                close()
            }
        } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason)
        } finally {
            busy = false
            update()
        }
    }

    async function inspect(value: LocalRequest, id = repositoryId) {
        let response = await options.api.localOperation(id, value)
        if (!response.ok)
            throw new Error(response.error.message)
        return response.result.preview!
    }

    function close() {
        mode = undefined
        preview = undefined
        error = ""
        void options.update().then(() => returnFocus?.focus())
    }
}
