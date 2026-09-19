import type { ChangesInventory, CommitDraft, LocalPreview, LocalRequest, LocalResult } from "@git-workbench/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"

export function CommitComposer(
    handle: Handle<{
        api: Window["workbench"]
        repositoryId: string
        path: string
        virtual: boolean
        inventory?: ChangesInventory
        renderFiles(view: "unstaged" | "staged", stage?: (files: string[]) => void, busy?: boolean): RemixNode
        changed(refreshGraph?: boolean): Promise<void>
        busyChanged?(busy: boolean): void
        refresh(): void
        showIgnored: boolean
        toggleIgnored(value: boolean): void
    }>,
) {
    const { props } = handle
    let open = false, busy = false, loaded = false
    let draft: CommitDraft = { title: "", message: "", branch: "" }
    let preview: LocalPreview | undefined
    let notice = ""
    let hook: LocalResult | undefined
    let stashOpen = false, stashLabel = ""
    let stashesOpen = false, applyId = "", destination = props.path
    const update = () => void handle.update()
    const previewRequest = (): LocalRequest => ({ action: "stage", path: props.path, unstage: false })
    async function refreshPreview() {
        const result = await props.api.localOperation(props.repositoryId, previewRequest())
        if (!result.ok)
            throw new Error(result.error.message)
        preview = result.result.preview
        if (!draft.branch)
            draft.branch = preview?.suggestedBranch ?? ""
    }
    handle.queueTask(async () => {
        try {
            draft = await props.api.readCommitDraft(props.repositoryId, props.path)
            await refreshPreview()
            loaded = true
        } catch (error) {
            notice = String(error)
        }
        update()
    })
    async function save() {
        try {
            await props.api.saveCommitDraft(props.repositoryId, props.path, { ...draft })
        } catch (error) {
            notice = `Could not save commit draft: ${String(error)}`
            update()
        }
    }
    async function run(request: LocalRequest, expected?: string) {
        const fresh = await props.api.localOperation(props.repositoryId, request)
        if (!fresh.ok)
            throw new Error(fresh.error.message)
        const token = fresh.result.preview!.token
        if (expected && expected != token) {
            await props.changed()
            preview = fresh.result.preview
            throw new Error("Working Changes changed. Review the refreshed files, then try again.")
        }
        const response = await props.api.localOperation(props.repositoryId, request, token)
        if (!response.ok)
            throw new Error(response.error.message)
        await props.changed(request.action != "commit" && request.action != "branch-create")
        await refreshPreview()
        if (response.result.status == "failed") {
            await props.changed()
            throw new Error(response.result.message)
        }
        return response.result
    }
    async function act(action: () => Promise<void>) {
        if (busy)
            return
        busy = true
        props.busyChanged?.(true)
        notice = ""
        update()
        try {
            await action()
        } catch (error) {
            notice = error instanceof Error ? error.message : String(error)
        } finally {
            busy = false
            props.busyChanged?.(false)
            update()
        }
    }
    async function commit() {
        await save()
        if (!preview?.branch || preview.unborn && draft.branch != preview.branch)
            await run({ action: "branch-create", name: draft.branch, path: props.path }, preview?.token)
        const result = await run(
            { action: "commit", path: props.path, title: draft.title, message: draft.message, acceptHooks: hook?.hookToken },
            preview?.token,
        )
        if (result.status == "hook-review") {
            hook = result
            return
        }
        hook = undefined
        open = false
        draft = { title: "", message: "", branch: "" }
        await save()
        notice = result.message ?? "Commit created."
        await props.changed()
    }
    const files = () => props.inventory?.files.filter(file => !file.ignored) ?? []
    const staged = () => files().filter(file => file.staged)
    const stage = (paths: string[], unstage: boolean) =>
        void act(async () => {
            hook = undefined
            await run({ action: "stage", path: props.path, files: paths, unstage }, preview?.token)
        })
    return () => (
        <section class="commit-composer" mix={composerStyle}>
            <header class="commit-header">
                <h3>Working Changes</h3>
                <div class="commit-header-actions">
                    <button
                        disabled={busy || !loaded || !files().length}
                        mix={on("click", () =>
                            void act(async () => {
                                await refreshPreview()
                                open = true
                            }))}
                    >
                        Commit…
                    </button>
                    <button
                        aria-label="Stash Working Changes"
                        title="Stash Working Changes"
                        disabled={busy || !files().length}
                        mix={on("click", () => {
                            stashOpen = !stashOpen
                            update()
                        })}
                    >
                        {stashIcon("create")}
                    </button>
                    <button
                        aria-label="Show stashes"
                        title="Show stashes"
                        disabled={busy}
                        mix={on("click", () =>
                            void act(async () => {
                                await refreshPreview()
                                stashesOpen = !stashesOpen
                            }))}
                    >
                        {stashIcon("list")}
                    </button>
                    <button aria-label="Refresh Working Changes" title="Refresh Working Changes" disabled={busy} mix={on("click", props.refresh)}>↻</button>
                </div>
            </header>
            {loaded && (!preview?.branch || preview.unborn) && (
                <label>
                    Branch name<input
                        aria-label="New branch name"
                        value={draft.branch}
                        disabled={busy}
                        mix={on("input", event => {
                            draft.branch = event.currentTarget.value
                            void save()
                            update()
                        })}
                    />
                </label>
            )}
            {open
                ? (
                    <>
                        <input
                            aria-label="Commit title"
                            placeholder="Commit title (required)"
                            value={draft.title}
                            disabled={busy}
                            mix={[
                                ref(element => element.focus()),
                                on("input", event => {
                                    draft.title = event.currentTarget.value
                                    hook = undefined
                                    void save()
                                    update()
                                }),
                            ]}
                        />
                        <textarea
                            aria-label="Commit message"
                            placeholder="Message (optional)"
                            rows={3}
                            value={draft.message}
                            disabled={busy}
                            mix={on("input", event => {
                                draft.message = event.currentTarget.value
                                hook = undefined
                                void save()
                                update()
                            })}
                        />
                        <div class="commit-bulk-actions">
                            <button
                                disabled={busy || !files().some(file => file.unstaged || file.untracked)}
                                mix={on("click", () =>
                                    stage(
                                        files().filter(file => file.unstaged || file.untracked).flatMap(file =>
                                            file.oldPath ? [file.oldPath, file.path] : [file.path]
                                        ),
                                        false,
                                    ))}
                            >
                                Stage all
                            </button>
                            <button
                                disabled={busy || !staged().length}
                                mix={on("click", () => stage(staged().flatMap(file => file.oldPath ? [file.oldPath, file.path] : [file.path]), true))}
                            >
                                Unstage all
                            </button>
                        </div>
                        <div class="commit-actions">
                            <button
                                class="commit-submit"
                                disabled={busy || !draft.title.trim() || !files().length || (!preview?.branch && !draft.branch.trim()) || Boolean(hook)}
                                mix={on("click", () => void act(commit))}
                            >
                                {busy ? "Working…" : staged().length ? `Commit staged (${staged().length})` : `Commit all changes (${files().length})`}
                            </button>
                            <button
                                disabled={busy}
                                mix={on("click", () => {
                                    open = false
                                    hook = undefined
                                    void save()
                                    update()
                                })}
                            >
                                Cancel
                            </button>
                        </div>
                    </>
                )
                : null}
            {hook && (
                <div class="commit-hook-review" role="alert">
                    <strong>Hook changed files</strong>
                    <ul>{hook.changedFiles?.map(path => <li>{path}</li>)}</ul>
                    <p>Continue with the prepared commit, or cancel to review the changes.</p>
                    <div class="commit-actions">
                        <button
                            disabled={busy}
                            mix={on("click", () => {
                                hook = undefined
                                update()
                            })}
                        >
                            Cancel
                        </button>
                        <button disabled={busy} mix={on("click", () => void act(commit))}>Continue commit</button>
                    </div>
                </div>
            )}
            {stashOpen && (
                <div class="commit-stash-form">
                    <input
                        aria-label="Stash label"
                        placeholder="Stash label (optional)"
                        value={stashLabel}
                        mix={on("input", event => {
                            stashLabel = event.currentTarget.value
                        })}
                    />
                    <div class="commit-actions">
                        <button
                            disabled={busy}
                            mix={on("click", () =>
                                void act(async () => {
                                    await run({ action: "stash-create", path: props.path, label: stashLabel })
                                    stashOpen = false
                                    stashesOpen = true
                                }))}
                        >
                            Stash all changes
                        </button>
                        <button
                            disabled={busy}
                            mix={on("click", () => {
                                stashOpen = false
                                update()
                            })}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
            {stashesOpen && (
                <div class="commit-stashes">
                    {preview?.stashes.map(stash => (
                        <div class="commit-stash" key={stash.objectId}>
                            <span title={stash.objectId}>
                                {stash.label}
                                <small>{stash.branch ?? "Unassigned"}</small>
                            </span>
                            <button
                                disabled={busy}
                                mix={on("click", () => {
                                    applyId = stash.objectId
                                    update()
                                })}
                            >
                                Apply…
                            </button>
                            <button
                                disabled={busy}
                                mix={on("click", () =>
                                    void act(async () => {
                                        await run({ action: "stash-drop", objectId: stash.objectId })
                                    }))}
                            >
                                Drop
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {applyId && (
                <div>
                    <label>
                        Destination worktree<select
                            aria-label="Stash destination"
                            value={destination}
                            mix={on("change", event => {
                                destination = event.currentTarget.value
                            })}
                        >
                            {preview?.worktrees.map(worktree => <option value={worktree.path}>{worktree.name} · {worktree.branch ?? "detached"}</option>)}
                        </select>
                    </label>
                    <div class="commit-actions">
                        <button
                            disabled={busy}
                            mix={on("click", () =>
                                void act(async () => {
                                    await run({ action: "stash-apply", path: destination, objectId: applyId })
                                    applyId = ""
                                }))}
                        >
                            Apply stash
                        </button>
                        <button
                            disabled={busy}
                            mix={on("click", () => {
                                applyId = ""
                                update()
                            })}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
            <label class="ignored-toggle">
                <input type="checkbox" checked={props.showIgnored} mix={on("change", event => props.toggleIgnored(event.currentTarget.checked))} />Show ignored
            </label>
            {props.inventory && !files().length && <p class="inspection-muted">No Working Changes</p>}
            {(staged().length > 0 || open) && (
                <>
                    <div class="staged-divider" role="separator" aria-label="Staged changes">
                        <span>Staged · {staged().length}</span>
                    </div>
                    {props.renderFiles("staged", open ? paths => stage(paths, true) : undefined, busy)}
                </>
            )}
            {props.renderFiles("unstaged", open ? paths => stage(paths, false) : undefined, busy)}
            {notice && <p role="status" class="commit-notice">{notice}</p>}
        </section>
    )
}

const composerStyle = css({
    "& .commit-header": {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 10px",
        background: "var(--accent-wash)",
        borderBottom: "1px solid var(--line)",
    },
    "& .commit-header h3": { fontSize: "12px", margin: 0 },
    "& .commit-header-actions": { display: "flex", alignItems: "center", gap: "4px" },
    "& .commit-header-actions button": { minWidth: "26px", minHeight: "26px", padding: "3px 6px" },
    "& .commit-header-actions svg": { display: "block" },
    "& .ignored-toggle": { display: "flex", alignItems: "center", gap: "5px", color: "var(--muted)", fontSize: "11px", padding: "5px 8px" },
    "& .ignored-toggle input": { width: "14px", height: "14px", minHeight: 0, padding: 0, margin: "0 3px 0 0", flex: "0 0 14px" },
    "& > input, & > textarea, & label input, & select, & .commit-stash-form input": {
        width: "100%",
        marginTop: "6px",
        padding: "7px 8px",
        border: "1px solid var(--line-strong)",
        borderRadius: "4px",
        background: "var(--field)",
        color: "var(--text)",
        font: "inherit",
    },
    "& > textarea": { resize: "vertical" },
    "& button:not(.composition-handle)": {
        border: "1px solid var(--line-strong)",
        borderRadius: "4px",
        background: "var(--control)",
        color: "var(--text)",
        padding: "5px 8px",
        font: "inherit",
    },
    "& button:disabled": { opacity: 0.5 },
    "& button:focus-visible, & input:focus-visible, & textarea:focus-visible, & select:focus-visible": {
        outline: "2px solid var(--accent)",
        outlineOffset: "2px",
    },
    "& .commit-actions": { display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" },
    "& .commit-submit": { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)" },
    "& .staged-divider": { display: "flex", alignItems: "center", gap: "8px", margin: "10px 0 6px", fontSize: "11px", color: "var(--muted)" },
    "& .staged-divider::before, & .staged-divider::after": { content: "''", flex: 1, height: "1px", background: "var(--line)" },
    "& .commit-bulk-actions": { display: "flex", justifyContent: "flex-end", gap: "8px" },
    "& .commit-bulk-actions button": { padding: "3px 0", border: 0, color: "var(--muted)", background: "transparent" },
    "& .commit-hook-review, & .commit-stash-form": { marginTop: "8px", padding: "8px", border: "1px solid var(--line-strong)" },
    "& .commit-stash": { display: "flex", alignItems: "center", gap: "6px", padding: "7px 0", borderBottom: "1px solid var(--line)" },
    "& .commit-stash span": { flex: 1, minWidth: 0, overflowWrap: "anywhere" },
    "& .commit-stash small": { display: "block", color: "var(--muted)" },
    "& .commit-notice": { padding: "6px 0", fontSize: "12px", overflowWrap: "anywhere" },
})

function stashIcon(kind: "create" | "list") {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M2.5 4.5h11v8h-11zM4 2.5h8v2M5 7h6M5 9.5h6" />
            {kind == "create" && <path d="M8 6v5M5.5 8.5h5" />}
        </svg>
    )
}
