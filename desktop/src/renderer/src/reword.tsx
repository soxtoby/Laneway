import type { LocalPreview, RewordRequest } from "@laneway/shared"
import { css, type Handle, on, ref } from "remix/ui"
import type { NoticeState } from "./feedback"

// The fields match the commit composer's, so rewording reads as editing the message that was committed.
let rewordStyle = css({
    display: "grid",
    gap: "6px",
    padding: "8px 10px 10px",
    borderBottom: "1px solid var(--line)",
    background: "var(--accent-wash)",
    fontSize: "12px",
    "& input, & textarea": {
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        minHeight: "30px",
        margin: 0,
        padding: "6px 8px",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--radius)",
        background: "var(--field)",
        color: "var(--text)",
        font: "inherit",
        fontSize: "13px",
        lineHeight: "1.4",
    },
    "& :is(input, textarea):hover:not(:disabled)": { borderColor: "var(--faint)" },
    "& textarea": { minHeight: "72px", resize: "vertical" },
    "& p": { margin: 0, overflowWrap: "anywhere" },
    "& .reword-warning": { color: "var(--warning)", fontWeight: 600 },
    "& .reword-actions": { display: "flex", justifyContent: "flex-end", gap: "6px" },
    "& button": {
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--radius)",
        background: "var(--control)",
        color: "var(--text)",
        padding: "5px 8px",
        font: "inherit",
    },
    "& button:disabled": { opacity: 0.5 },
    "& .reword-submit": { background: "var(--accent)", color: "var(--accent-ink)", borderColor: "var(--accent)", fontWeight: 600 },
    "& .reword-submit:hover:not(:disabled)": { background: "var(--accent-hover)", borderColor: "var(--accent-hover)" },
    // Filled buttons turn neutral when disabled, like the commit form's, instead of fading.
    "& .reword-submit:disabled": { opacity: 1, color: "var(--muted)", borderColor: "var(--line)", background: "var(--control)", fontWeight: 500 },
    "& button:focus-visible, & input:focus-visible, & textarea:focus-visible": { outline: "2px solid var(--ring)", outlineOffset: "2px" },
})

/** Edits one commit's title and message in place. Applying reviews the rewrite first: published history and
 * commits that replay would empty wait for an explicit decision, and anything else is rewritten straight away. */
export function RewordForm(
    handle: Handle<{
        api: Pick<Window["laneway"], "localOperation">
        repositoryId: string
        /** The local branch whose history shows the commit. */
        branch: string
        commit: { objectId: string; subject: string; body?: string }
        selectedRemote?: string
        notify(notice: NoticeState): () => void
        /** Runs after the commit is rewritten and before the form closes. */
        changed(): Promise<void>
        busyChanged?(busy: boolean): void
        close(): void
    }>,
) {
    let { props } = handle
    let title = props.commit.subject, message = props.commit.body ?? ""
    let busy = false, notice = ""
    // A reviewed rewrite that is waiting for the user's decision.
    let preview: LocalPreview | undefined
    let update = () => {
        if (!handle.signal.aborted)
            void handle.update()
    }
    let request = (): RewordRequest => ({
        action: "reword",
        objectId: props.commit.objectId,
        branch: props.branch,
        title,
        message,
        selectedRemote: props.selectedRemote,
    })
    let edited = () => title.trim() != props.commit.subject || message.trimEnd() != (props.commit.body ?? "").trimEnd()
    return () => {
        let composition = preview?.composition
        return (
            <section class="reword-form" aria-label={`Reword commit ${props.commit.subject}`} mix={rewordStyle}>
                <input
                    aria-label="Commit title"
                    placeholder="Commit title (required)"
                    value={title}
                    disabled={busy}
                    mix={[
                        ref(element => element.focus()),
                        on("input", event => {
                            title = event.currentTarget.value
                            preview = undefined
                            update()
                        }),
                    ]}
                />
                <textarea
                    aria-label="Commit message"
                    placeholder="Message (optional)"
                    rows={3}
                    value={message}
                    disabled={busy}
                    mix={on("input", event => {
                        message = event.currentTarget.value
                        preview = undefined
                        update()
                    })}
                />
                {!!composition?.published.length && (
                    <p class="reword-warning" role="alert">
                        Rewrites history already published on {composition.published.join(", ")}. The next Publish needs force-with-lease.
                    </p>
                )}
                {!!composition?.removed.length && <p>Remove empty commits: {composition.removed.map(commit => commit.slice(0, 8)).join(", ")}</p>}
                {!!composition?.branches.length && <p>Affected: {composition.branches.join(", ")}</p>}
                {notice && <p role="status">{notice}</p>}
                <div class="reword-actions">
                    <button type="button" disabled={busy} mix={on("click", () => props.close())}>
                        Cancel
                    </button>
                    {preview
                        ? (
                            <button type="button" class="reword-submit" disabled={busy} mix={on("click", () => void act(execute))}>
                                Rewrite history
                            </button>
                        )
                        : (
                            <button type="button" class="reword-submit" disabled={busy || !title.trim() || !edited()} mix={on("click", () => void act(apply))}>
                                {busy ? "Working…" : "Apply"}
                            </button>
                        )}
                </div>
            </section>
        )
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

    // The engine applies a reword in the same call unless it rewrites published history or drops emptied commits;
    // then it returns a preview, and the user's confirmation applies it with that preview's token.
    async function apply() {
        let result = await send()
        if (result.status == "performed")
            await completed(result.message)
        else if (result.preview)
            preview = result.preview
        else
            throw new Error("Laneway could not review the reword.")
    }

    async function execute() {
        if (!preview)
            return

        let token = preview.token
        preview = undefined
        await completed((await send(token)).message)
    }

    async function send(token?: string) {
        let response = await props.api.localOperation(props.repositoryId, request(), token)
        if (!response.ok)
            throw new Error(response.error.message)
        if (response.result.status == "failed")
            throw new Error(response.result.message)
        return response.result
    }

    async function completed(message?: string) {
        props.notify({ code: "reword.applied", message: message ?? "Commit reworded.", transient: true })
        await props.changed()
        props.close()
    }
}
