import type { BranchGraphMarker, ChangesInventory, CommitDraft, LocalPreview, LocalRequest, LocalResult } from "@laneway/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import { Icon } from "./icons"

export function CommitComposer(
    handle: Handle<{
        api: Window["laneway"]
        repositoryId: string
        path: string
        virtual: boolean
        inventory?: ChangesInventory
        /** `stage` is given only while the commit form is open; dropping files on a list calls it for that list's direction. */
        renderFiles(view: "unstaged" | "staged", stage?: (files: string[], unstage: boolean) => void): RemixNode
        changed(refreshGraph?: boolean): Promise<void>
        busyChanged?(busy: boolean): void
        showIgnored: boolean
        toggleIgnored(value: boolean): void
        /** Stashes recorded on this column's branch; shown above Working Changes. */
        stashes?: BranchGraphMarker[]
        /** Whether a stash's files are showing, and a toggle and renderer for them. */
        stashOpen?(stash: BranchGraphMarker): boolean
        toggleStash?(stash: BranchGraphMarker): void
        renderStash?(stash: BranchGraphMarker): RemixNode
    }>,
) {
    const { props } = handle
    let open = false, busy = false, loaded = false
    let draft: CommitDraft = { title: "", message: "", branch: "" }
    let preview: LocalPreview | undefined
    let notice = ""
    let hook: LocalResult | undefined
    let stashOpen = false, stashLabel = "", commitMenuOpen = false
    // A preview refresh in flight; mutations wait for it so they always send the newest token.
    let refreshing: Promise<void> | undefined
    const update = () => void handle.update()
    const previewRequest = (): LocalRequest => ({ action: "stage", path: props.path, unstage: false })
    let previewGeneration = 0
    async function refreshPreview() {
        // Overlapping refreshes may finish out of order; only the newest result may become the preview.
        const generation = ++previewGeneration
        const result = await props.api.localOperation(props.repositoryId, previewRequest())
        if (!result.ok)
            throw new Error(result.error.message)
        if (generation != previewGeneration)
            return
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
    // Previews take a second of Git work, so they never block the form; the engine validates the
    // token at execution and any stale request is refreshed and reported.
    function refreshInBackground() {
        refreshing = refreshPreview().catch(error => {
            notice = String(error)
        }).finally(() => {
            refreshing = undefined
            update()
        })
    }
    async function save() {
        try {
            await props.api.saveCommitDraft(props.repositoryId, props.path, { ...draft })
        } catch (error) {
            notice = `Could not save commit draft: ${String(error)}`
            update()
        }
    }
    async function run(request: LocalRequest) {
        await refreshing
        const response = await props.api.localOperation(props.repositoryId, request, preview?.token)
        if (!response.ok) {
            // A rejected token means Working Changes moved on; show the current files for another attempt.
            await props.changed(false)
            refreshInBackground()
            throw new Error(response.error.message)
        }
        // Only stash operations change what the Branch Graph shows; commits refresh it themselves.
        await props.changed(request.action.startsWith("stash"))
        refreshInBackground()
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
            await run({ action: "branch-create", name: draft.branch, path: props.path })
        const result = await run({ action: "commit", path: props.path, title: draft.title, message: draft.message, acceptHooks: hook?.hookToken })
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
            await run({ action: "stage", path: props.path, files: paths, unstage })
        })
    const clean = () => Boolean(props.inventory) && !files().length && !open && !stashOpen
    return () => (
        <section class="commit-composer" mix={composerStyle}>
            {props.stashes?.map(stash => {
                const open = props.stashOpen?.(stash) ?? false
                return (
                    <div class="branch-stash" key={stash.id} data-expanded={open ? "true" : "false"}>
                        <div class="branch-stash-row">
                            <button
                                type="button"
                                class="branch-stash-toggle"
                                aria-expanded={open}
                                aria-label={`Stash ${stash.label}: ${stashMessage(stash)}`}
                                title={stash.tooltip}
                                mix={on("click", () => props.toggleStash?.(stash))}
                            >
                                <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
                                <Icon name="stash" size={14} />
                                <span class="branch-stash-message">{stashMessage(stash)}</span>
                                <small>{stash.label}</small>
                            </button>
                            <button
                                type="button"
                                class="branch-stash-apply"
                                aria-label={`Apply stash ${stash.label}`}
                                disabled={busy}
                                mix={on(
                                    "click",
                                    () => void act(async () => void await run({ action: "stash-apply", path: props.path, objectId: stash.objectId })),
                                )}
                            >
                                Apply
                            </button>
                            <button
                                type="button"
                                class="branch-stash-drop"
                                aria-label={`Drop stash ${stash.label}`}
                                title="Drop stash"
                                disabled={busy}
                                mix={on("click", () => void act(async () => void await run({ action: "stash-drop", objectId: stash.objectId })))}
                            >
                                <Icon name="close" size={13} />
                            </button>
                        </div>
                        {open && props.renderStash?.(stash)}
                    </div>
                )
            })}
            {/* A clean worktree collapses to one quiet row that still takes drops, so dragging doesn't shift the layout. */}
            <div class={clean() ? "commit-card clean" : "commit-card"}>
                <header class="commit-header">
                    <h3>
                        <Icon name="folder" size={14} />
                        {clean() ? "No Working Changes" : "Working Changes"}
                    </h3>
                    {/* The form's own Commit button takes over while composing. */}
                    <div
                        hidden={clean() || open}
                        class="commit-split"
                        mix={[
                            on("keydown", event => {
                                if (event.key == "Escape" && commitMenuOpen) {
                                    event.stopPropagation()
                                    commitMenuOpen = false
                                    update()
                                }
                            }),
                            on("focusout", event => {
                                if (commitMenuOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                    commitMenuOpen = false
                                    update()
                                }
                            }),
                        ]}
                    >
                        <button
                            class="commit-open"
                            disabled={busy || !loaded || !files().length}
                            mix={on("click", () => {
                                open = true
                                update()
                                refreshInBackground()
                            })}
                        >
                            Commit…
                        </button>
                        <button
                            class="commit-more"
                            aria-label="More commit actions"
                            aria-haspopup="menu"
                            aria-expanded={commitMenuOpen}
                            disabled={busy || !files().length}
                            mix={on("click", () => {
                                commitMenuOpen = !commitMenuOpen
                                update()
                            })}
                        >
                            <Icon name="chevron-down" size={12} />
                        </button>
                        {commitMenuOpen && (
                            <div class="commit-menu" role="menu">
                                <button
                                    role="menuitem"
                                    mix={[
                                        ref(node => node.focus()),
                                        on("click", () => {
                                            commitMenuOpen = false
                                            stashOpen = true
                                            update()
                                        }),
                                    ]}
                                >
                                    Stash Working Changes…
                                </button>
                            </div>
                        )}
                    </div>
                </header>
                {loaded && !clean() && (!preview?.branch || preview.unborn) && (
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
                                <button
                                    class="commit-submit"
                                    disabled={busy || !draft.title.trim() || !files().length || (!preview?.branch && !draft.branch.trim()) || Boolean(hook)}
                                    mix={on("click", () => void act(commit))}
                                >
                                    {busy ? "Working…" : staged().length ? `Commit staged (${staged().length})` : `Commit all changes (${files().length})`}
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
                                mix={on("click", () => {
                                    stashOpen = false
                                    update()
                                })}
                            >
                                Cancel
                            </button>
                            <button
                                class="commit-submit"
                                disabled={busy}
                                mix={on("click", () =>
                                    void act(async () => {
                                        await run({ action: "stash-create", path: props.path, label: stashLabel })
                                        stashOpen = false
                                    }))}
                            >
                                Stash all changes
                            </button>
                        </div>
                    </div>
                )}
                {/* Staged files sit above the divider; the rest of Working Changes sits below it. */}
                {(staged().length > 0 || open) && (
                    <>
                        {props.renderFiles("staged", open ? stage : undefined)}
                        <div class="staged-divider" role="separator" aria-label="Staged changes">
                            <span>Staged · {staged().length}</span>
                        </div>
                    </>
                )}
                {props.renderFiles("unstaged", open ? stage : undefined)}
                {notice && <p role="status" class="commit-notice">{notice}</p>}
            </div>
        </section>
    )
}

const composerStyle = css({
    // Stashes and working changes are cards, each tinted by kind so drawers read apart from branches.
    "& .branch-stash, & .commit-card": {
        margin: "8px 8px 0",
        // clip, unlike hidden, leaves sticky diff headers and scrollbars pinned to the column's viewport.
        overflow: "clip",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius)",
        background: "var(--panel)",
    },
    // Rows draw their own bottom rules; the card's edge replaces the last one. A trailing -1px pulls the
    // card's bottom up over that rule, whichever row is last, and the card's overflow clips it.
    "& :is(.commit-card:not(.clean), .branch-stash[data-expanded=true])::after": { content: '""', display: "block", marginTop: "-1px" },
    "& .branch-stash": { borderColor: "var(--stash-edge)" },
    "& .branch-stash > :not(.branch-stash-row)": { background: "color-mix(in srgb, var(--stash) 4%, var(--panel))" },
    "& .commit-card": { borderColor: "var(--accent-edge)" },
    "& .branch-stash-row": {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        minHeight: "34px",
        padding: "0 6px 0 0",
        background: "var(--stash-wash)",
    },
    "& button.branch-stash-toggle": {
        flex: 1,
        minWidth: 0,
        height: "34px",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "0 0 0 10px",
        border: 0,
        borderRadius: 0,
        color: "var(--text)",
        background: "transparent",
        textAlign: "left",
        fontSize: "13px",
        fontWeight: 600,
        cursor: "pointer",
    },
    "& .branch-stash-row:hover": { background: "color-mix(in srgb, var(--stash) 14%, var(--panel))" },
    "& .branch-stash-toggle > svg:first-child": { color: "var(--faint)" },
    "& .branch-stash-toggle > svg:nth-child(2)": { color: "var(--stash-ink)" },
    "& .branch-stash-toggle svg": { flex: "0 0 auto" },
    "& .branch-stash-message": { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" },
    "& .branch-stash-toggle small": { flex: "0 0 auto", color: "var(--muted)", fontSize: "11px", fontWeight: 500 },
    "& button.branch-stash-apply": {
        height: "24px",
        padding: "0 9px",
        display: "inline-flex",
        alignItems: "center",
        color: "var(--stash-ink)",
        borderColor: "var(--stash-edge)",
        background: "var(--panel)",
        fontSize: "12px",
        fontWeight: 600,
        lineHeight: 1,
    },
    "& button.branch-stash-apply:hover:not(:disabled)": { color: "#fff", background: "var(--stash)", borderColor: "var(--stash)" },
    "& button.branch-stash-drop": {
        width: "24px",
        height: "24px",
        padding: 0,
        display: "grid",
        placeItems: "center",
        color: "var(--muted)",
        border: 0,
        background: "transparent",
    },
    "& button.branch-stash-drop:hover:not(:disabled)": { color: "var(--danger)", background: "var(--danger-wash)" },
    "& .commit-header": {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: "38px",
        padding: "0 6px 0 10px",
        background: "var(--accent-wash)",
        borderBottom: "1px solid var(--line)",
    },
    "& .commit-header h3": { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, margin: 0 },
    "& .commit-header h3 svg": { color: "var(--accent-hover)" },
    "& .commit-split[hidden]": { display: "none" },
    "& .commit-card.clean": { borderColor: "var(--line)" },
    "& .commit-card.clean .commit-header": { minHeight: "34px", borderBottom: 0, background: "transparent" },
    "& .commit-card.clean h3": { color: "var(--muted)", fontWeight: 500 },
    "& .commit-card.clean h3 svg": { color: "var(--faint)" },
    // Commit is a split button; its menu holds the rarer Working Changes operations.
    "& .commit-split": { position: "relative", display: "flex" },
    "& .commit-split > button": {
        height: "28px",
        display: "inline-grid",
        placeItems: "center",
        color: "var(--accent-ink)",
        borderColor: "var(--accent)",
        background: "var(--accent)",
        fontWeight: 600,
    },
    "& .commit-split > button:hover:not(:disabled)": { background: "var(--accent-hover)", borderColor: "var(--accent-hover)" },
    "& .commit-split > button:disabled": { opacity: 1, color: "var(--muted)", borderColor: "var(--line)", background: "var(--control)", fontWeight: 500 },
    "& .commit-split > .commit-open": { padding: "0 12px", borderRadius: "var(--radius) 0 0 var(--radius)" },
    "& .commit-split > .commit-more": {
        width: "24px",
        padding: 0,
        marginLeft: "-1px",
        borderRadius: "0 var(--radius) var(--radius) 0",
        borderLeftColor: "color-mix(in srgb, var(--accent-ink) 25%, var(--accent))",
    },
    "& .commit-split svg": { display: "block" },
    "& .commit-menu": {
        position: "absolute",
        zIndex: 20,
        top: "calc(100% + 4px)",
        right: 0,
        minWidth: "200px",
        padding: "4px",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--radius)",
        background: "var(--raised)",
        boxShadow: "var(--shadow-popover)",
    },
    "& .commit-menu button": { width: "100%", border: 0, background: "transparent", textAlign: "left", padding: "6px 8px" },
    "& .commit-menu button:hover, & .commit-menu button:focus-visible": { background: "var(--hover)" },
    // The title and message share one field style; the fields sit inside the card, under its header.
    "& .commit-card > :is(input, textarea), & label input, & select, & .commit-stash-form input": {
        display: "block",
        width: "100%",
        height: "auto",
        minHeight: "30px",
        marginTop: "6px",
        padding: "6px 8px",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--radius)",
        background: "var(--field)",
        color: "var(--text)",
        font: "inherit",
        fontSize: "13px",
        lineHeight: "1.4",
    },
    // The title and message sit directly under the header, inset like the rows beneath them.
    "& .commit-card > :is(input, textarea)": { width: "calc(100% - 16px)", margin: "8px 8px 0" },
    "& .commit-card > :is(input, textarea):hover:not(:disabled)": { borderColor: "var(--faint)" },
    "& .commit-card > textarea": { minHeight: "72px", resize: "vertical" },
    // Low specificity so specific buttons, like the stash rows, can restyle it.
    "& button:where(:not(.composition-handle))": {
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--radius)",
        background: "var(--control)",
        color: "var(--text)",
        padding: "5px 8px",
        font: "inherit",
    },
    "& button:disabled": { opacity: 0.5 },
    "& button:focus-visible, & input:focus-visible, & textarea:focus-visible, & select:focus-visible": {
        outline: "2px solid var(--ring)",
        outlineOffset: "2px",
    },
    "& .commit-actions": { display: "flex", justifyContent: "flex-end", gap: "6px", margin: "8px 8px 0", flexWrap: "wrap" },
    "& .commit-submit": { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)", fontWeight: 600 },
    "& .commit-submit:hover:not(:disabled)": { background: "var(--accent-hover)", borderColor: "var(--accent-hover)" },
    // Filled buttons turn neutral when disabled, like the header's Commit… button, instead of fading.
    "& .commit-submit:disabled": { opacity: 1, color: "var(--muted)", borderColor: "var(--line)", background: "var(--control)", fontWeight: 500 },
    "& .staged-divider": { display: "flex", alignItems: "center", gap: "8px", margin: "10px 0 6px", fontSize: "11px", color: "var(--muted)" },
    "& .staged-divider::before, & .staged-divider::after": { content: "''", flex: 1, height: "1px", background: "var(--line)" },
    "& .commit-bulk-actions": { display: "flex", justifyContent: "flex-end", gap: "8px", margin: "4px 8px 0" },
    "& .commit-bulk-actions button": { padding: "3px 0", border: 0, color: "var(--muted)", background: "transparent" },
    "& .commit-bulk-actions button:hover:not(:disabled)": { color: "var(--text)", textDecoration: "underline" },
    "& .commit-hook-review, & .commit-stash-form": { marginTop: "8px", padding: "8px", border: "1px solid var(--line-strong)" },
    "& .commit-notice": { padding: "6px 0", fontSize: "12px", overflowWrap: "anywhere" },
})

/** The stash's own message, without Git's "On <branch>:" prefix that the column already implies. */
function stashMessage(stash: BranchGraphMarker) {
    return stash.tooltip.replace(/^(?:WIP on|On) [^:]+:\s*/, "") || stash.label
}
