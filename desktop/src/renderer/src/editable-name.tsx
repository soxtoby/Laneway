import { css, type Handle, on, ref } from "remix/ui"

// Class selectors on the controls outrank the composer's generic button styling.
let styles = css({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    flex: "1 1 auto",
    minWidth: "0",
    "& .editable-name-button": {
        minWidth: "0",
        maxWidth: "100%",
        margin: "0 -5px",
        padding: "2px 5px",
        border: "1px solid transparent",
        borderRadius: "var(--radius)",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        cursor: "text",
    },
    "& .editable-name-button:hover:not(:disabled)": { borderColor: "var(--line-strong)", background: "var(--field)" },
    "& .editable-name-button:disabled": { cursor: "default" },
    "& .editable-name-input": {
        flex: "1 1 auto",
        minWidth: "0",
        height: "26px",
        margin: "0 0 0 -5px",
        padding: "0 5px",
        border: "1px solid var(--line-strong)",
        borderRadius: "var(--radius)",
        background: "var(--field)",
        color: "var(--text)",
        font: "inherit",
    },
    "& small[role=alert]": {
        flex: "0 1 auto",
        minWidth: "0",
        color: "var(--danger)",
        fontSize: "11px",
        fontWeight: "500",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
})

/**
 * A name shown as text until it is clicked or F2 is pressed, then edited in place. Enter keeps the new
 * name through `commit`, Escape restores the old one, and the editor stays open showing any error.
 */
export function EditableName(
    handle: Handle<{
        name: string
        /** What the name belongs to, for assistive labels: "branch feature/x". */
        label: string
        disabled?: boolean
        /** Returns a message to keep the editor open, or nothing once the new name is accepted. */
        commit(name: string): Promise<string | undefined | void> | string | undefined | void
        /** Leaving the field keeps the typed name instead of discarding it; renames should wait for Enter. */
        saveOnBlur?: boolean
    }>,
) {
    let editing = false, busy = false, value = "", error = ""
    let update = () => void handle.update()
    return () =>
        editing
            ? (
                <span class="editable-name editing" mix={styles}>
                    <input
                        class="editable-name-input"
                        aria-label={`New name for ${handle.props.label}`}
                        value={value}
                        disabled={busy}
                        mix={[
                            ref(element => {
                                element.focus()
                                element.select?.()
                            }),
                            on("input", event => {
                                value = event.currentTarget.value
                                error = ""
                            }),
                            on("keydown", event => {
                                if (event.key == "Enter") {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    void finish()
                                } else if (event.key == "Escape") {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    cancel()
                                }
                            }),
                            // Finishing removes the field, which blurs it again; nothing is left to do then.
                            on("blur", () => {
                                if (editing && !busy)
                                    handle.props.saveOnBlur ? void finish() : cancel()
                            }),
                        ]}
                    />
                    {error && <small role="alert">{error}</small>}
                </span>
            )
            : (
                <span class="editable-name" mix={styles}>
                    <button
                        type="button"
                        class="editable-name-button"
                        aria-label={`Rename ${handle.props.label}`}
                        title={handle.props.disabled ? undefined : "Click or press F2 to rename"}
                        disabled={handle.props.disabled}
                        mix={[
                            on("click", start),
                            on("keydown", event => {
                                if (event.key == "F2") {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    start()
                                }
                            }),
                        ]}
                    >
                        {handle.props.name}
                    </button>
                </span>
            )

    function start() {
        if (handle.props.disabled)
            return

        editing = true
        value = handle.props.name
        error = ""
        update()
    }

    async function finish() {
        let name = value.trim()
        if (busy)
            return
        if (!name || name == handle.props.name)
            return cancel()
        busy = true
        update()

        try {
            error = await handle.props.commit(name) || ""
            if (!error)
                editing = false
        } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason)
        } finally {
            busy = false
            update()
        }
    }

    function cancel() {
        editing = false
        error = ""
        update()
    }
}
