import type { BranchGraph, BranchGraphWorktree, WorktreePreview, WorktreeRequest } from "@laneway/shared"
import { css, on, ref } from "remix/ui"
import { MissingWorktreePanel } from "./missing-worktree"
import { WorktreeControls } from "./worktree-controls"
import type { Column } from "./worktree-controls"

interface Options {
    api: Window["laneway"]
    update(): Promise<AbortSignal>
    completed(repositoryId: string, request: WorktreeRequest, columnId?: string): Promise<void>
}

let dialogStyle = css({
    width: "460px",
    maxWidth: "calc(100vw - 32px)",
    maxHeight: "80vh",
    overflow: "auto",
    color: "var(--text)",
    background: "var(--panel)",
    border: "1px solid var(--line)",
    boxShadow: "var(--shadow-dialog)",
    "&::backdrop": { background: "var(--scrim)" },
    borderRadius: "8px",
    padding: "20px",
    "& h2": { margin: "0 0 16px", fontSize: "17px", fontWeight: 600 },
    "& p, & li": { overflowWrap: "anywhere", fontSize: "13px", lineHeight: 1.5 },
    "& label": { display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "13px", lineHeight: 1.5, marginBlock: "12px" },
    "& [role='alert']": { color: "var(--danger)", background: "var(--danger-wash)", padding: "10px", borderRadius: "4px" },
})
let affectedPathsStyle = css({ display: "grid", gap: "8px", marginBottom: "16px" })
let workingChangesStyle = css({
    marginTop: "14px",
    padding: "10px 12px",
    border: "1px solid var(--warning-edge)",
    borderRadius: "5px",
    background: "var(--warning-wash)",
    color: "var(--text)",
    "& > strong": { fontSize: "13px", fontWeight: 600 },
    "& p": { margin: "4px 0 0", color: "var(--muted)" },
    "& label": { margin: "10px 0 0" },
})
let affectedPathStyle = css({
    display: "grid",
    gap: "4px",
    padding: "10px 12px",
    border: "1px solid var(--line)",
    borderRadius: "5px",
    background: "var(--canvas)",
    "& strong": { fontSize: "13px", fontWeight: 600, overflowWrap: "anywhere" },
    "& span": { fontFamily: "var(--mono)", fontSize: "11px", lineHeight: 1.5, color: "var(--muted)", overflowWrap: "anywhere" },
})
let dialogFooterStyle = css({
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    margin: "20px -20px -20px",
    padding: "12px 20px",
    borderTop: "1px solid var(--line)",
    background: "var(--canvas)",
})
let dialogButtonStyle = css({
    minHeight: "32px",
    padding: "0 14px",
    borderRadius: "4px",
    fontFamily: "inherit",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    "&:disabled": { opacity: 0.5, cursor: "default" },
})
let removeButtonStyle = css({
    color: "var(--danger)",
    background: "var(--danger-wash)",
    border: "1px solid var(--danger-edge)",
    "&:hover:not(:disabled)": { background: "var(--danger)", color: "var(--panel)" },
})

export function createWorktreeActions(options: Options) {
    let preview: WorktreePreview | undefined
    let repositoryId = "", columnId: string | undefined
    let error = "", busy = false, preserve = true
    let returnFocus: HTMLElement | null = null
    let undoRepository: string | undefined, restoredName = ""
    return {
        busy: () => busy,
        prepare,
        transition,
        controls(id: string, column: Column, path: string | undefined, graph: BranchGraph) {
            return (
                <WorktreeControls
                    column={column}
                    path={path}
                    graph={graph}
                    busy={busy}
                    prepare={request => prepare(id, request, column.id)}
                    chooseDirectory={options.api.chooseDirectory}
                />
            )
        },
        missingControls(id: string, column: Column, worktree: BranchGraphWorktree) {
            return (
                <MissingWorktreePanel
                    worktree={worktree}
                    busy={busy}
                    prepare={request => prepare(id, request, column.id)}
                    chooseDirectory={options.api.chooseDirectory}
                />
            )
        },
        dialog() {
            if (!preview && !error)
                return null
            let request = preview?.request
            return (
                <dialog
                    aria-label="Worktree operation"
                    mix={[
                        dialogStyle,
                        ref(dialog => dialog.showModal()),
                        on("cancel", event => {
                            event.preventDefault()
                            close()
                        }),
                    ]}
                >
                    <h2>{request ? `${request.action[0]!.toUpperCase()}${request.action.slice(1)} worktree` : "Worktree operation"}</h2>
                    {preview && (
                        <>
                            {preview.destination && (
                                <p>
                                    Destination: <strong>{preview.destination}</strong>
                                </p>
                            )}
                            <div mix={affectedPathsStyle}>
                                {preview.affected.map(path => (
                                    <div mix={affectedPathStyle}>
                                        <strong>{path.split(/[\\/]/).pop()}</strong>
                                        <span>{path}</span>
                                    </div>
                                ))}
                            </div>
                            {(request?.action == "switch" || request?.action == "create") && (
                                <p>
                                    Working Changes are stashed before switching. A previous holder stays detached. Existing stashes remain available for
                                    explicit application.
                                </p>
                            )}
                            {request?.action == "remove" && (
                                <>
                                    {preview.dirty || preview.uniqueCommits
                                        ? (
                                            <div mix={workingChangesStyle}>
                                                <strong>{preview.dirty ? "Working Changes detected" : "Worktree-only commits detected"}</strong>
                                                <p>
                                                    {preview.dirty
                                                        ? "Keep these changes available after removing the worktree."
                                                        : "Keep these commits reachable after removing the worktree."}
                                                </p>
                                                <label>
                                                    <input
                                                        type="checkbox"
                                                        checked={preserve}
                                                        mix={on("change", event => {
                                                            preserve = event.currentTarget.checked
                                                            void options.update()
                                                        })}
                                                    />
                                                    {preview.uniqueCommits
                                                        ? preview.dirty ? "Create a protective branch and stash Working Changes" : "Create a protective branch"
                                                        : "Stash Working Changes"}
                                                </label>
                                            </div>
                                        )
                                        : <p>Remove this worktree and its column.</p>}
                                    {!preserve && (
                                        <p>Delete Working Changes and Worktree-only Commits from visible state. Git state remains retained for undo.</p>
                                    )}
                                    {preview.worktrees.some(item => item.missing && item.path == request.path) && (
                                        <p>Remove the missing registration. Unavailable file contents cannot be recovered.</p>
                                    )}
                                    {preview.ignoredCount > 0 && (
                                        <p>
                                            Deletes ignored files, which are outside undo: {preview.ignored.slice(0, 3).join(", ")}
                                            {preview.ignoredCount > 3 ? ` and ${preview.ignoredCount - 3} more` : ""}.
                                        </p>
                                    )}
                                </>
                            )}
                        </>
                    )}
                    {error && <p role="alert">{error}</p>}
                    {undoRepository && (
                        <form
                            mix={on("submit", event => {
                                event.preventDefault()
                                void transition(undoRepository!, "undo", restoredName)
                            })}
                        >
                            <label>
                                Restore within the same parent:{" "}
                                <input
                                    aria-label="Restored worktree basename"
                                    value={restoredName}
                                    mix={on("input", event => {
                                        restoredName = event.currentTarget.value
                                        void options.update()
                                    })}
                                />
                            </label>
                            <button class="primary-button" mix={dialogButtonStyle} disabled={busy || !restoredName}>Restore worktree</button>
                        </form>
                    )}
                    <footer mix={dialogFooterStyle}>
                        <button class="secondary-button" type="button" disabled={busy} mix={[dialogButtonStyle, on("click", close)]}>Cancel</button>
                        {preview && (
                            <button
                                type="button"
                                class={request?.action == "remove" ? undefined : "primary-button"}
                                disabled={busy}
                                mix={[dialogButtonStyle, ...(request?.action == "remove" ? [removeButtonStyle] : []), on("click", execute)]}
                            >
                                {busy ? "Working…" : request?.action == "remove" ? "Remove worktree" : "Confirm"}
                            </button>
                        )}
                    </footer>
                </dialog>
            )
        },
    }

    async function prepare(id: string, request: WorktreeRequest, sourceColumn?: string) {
        if (busy)
            return

        repositoryId = id
        columnId = sourceColumn
        returnFocus = document.activeElement as HTMLElement | null
        busy = true
        error = ""
        undoRepository = undefined
        preserve = true
        await options.update()

        try {
            let result = await options.api.previewWorktree(id, request)
            if (result.ok)
                preview = result.preview
            else
                error = result.error.message
        } catch (reason) {
            error = String(reason)
        }
        busy = false
        await options.update()
    }

    function close() {
        if (busy)
            return

        preview = undefined
        error = ""
        void options.update().then(() => returnFocus?.focus())
    }

    async function execute() {
        if (!preview || busy)
            return

        busy = true
        error = ""
        await options.update()

        try {
            // Preservation choices leave the token intact; the Engine re-reads the worktree under its
            // lock and refuses when anything the user reviewed has changed since.
            let request = preview.request.action == "remove" ? { ...preview.request, preserve, allowIgnoredLoss: true } : preview.request
            let result = await options.api.executeWorktree(repositoryId, request, preview.token)
            if (!result.ok)
                throw new Error(result.error.message)
            preview = undefined
            await options.completed(repositoryId, request, columnId)
        } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason)
        }
        busy = false
        await options.update()
    }

    async function transition(id: string, action: "undo" | "redo", basename?: string) {
        if (busy)
            return

        busy = true
        error = ""
        await options.update()

        try {
            let result = await options.api.transitionOperation(id, action, basename)
            if (!result.ok)
                throw new Error(result.error.message)
            undoRepository = undefined
            await options.completed(id, { action: "unlock", path: "" })
        } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason)
            undoRepository = action == "undo" && /occupied/.test(error) ? id : undefined
        }
        busy = false
        await options.update()
    }
}
