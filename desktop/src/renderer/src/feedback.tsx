import { css, type Handle, on } from "remix/ui"

export interface NoticeState {
    code: string
    message: string
    // Confirmations close themselves; failures and guidance wait for the user.
    transient?: boolean
    /** How long a transient notice stays when it needs longer than the default, such as an undo window. */
    duration?: number
    /** One follow-up the notice offers, such as undoing what it reports. */
    action?: { label: string; run(): void }
    /** Called once the notice leaves the screen, whether dismissed, timed out, or replaced. */
    closed?(): void
}

let transientDuration = 5_000

let notice = css({
    position: "fixed",
    zIndex: "30",
    right: "14px",
    bottom: "12px",
    width: "min(460px, calc(100vw - 28px))",
    padding: "11px 12px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto auto",
    alignItems: "center",
    gap: "10px",
    border: "1px solid var(--line-strong)",
    borderLeft: "3px solid var(--accent)",
    borderRadius: "6px",
    background: "var(--raised)",
    boxShadow: "var(--shadow-popover)",
    animation: "notice-in 140ms ease-out both",
    "@media (forced-colors: active)": {
        boxShadow: "none",
    },
    "&[hidden]": {
        display: "none",
    },
})

let noticeSmall = css({
    color: "var(--accent)",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0",
    textTransform: "none",
})

let noticeP = css({
    margin: "4px 0 0",
    fontSize: "13px",
    lineHeight: "1.45",
})

let noticeAction = css({
    fontWeight: "600",
    letterSpacing: "0",
    textTransform: "none",
    minHeight: "24px",
    padding: "0 10px",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "var(--control)",
    font: "inherit",
    fontSize: "12px",
    cursor: "pointer",
    "&:hover": {
        background: "var(--control-hover)",
    },
})

let noticeClose = css({
    fontWeight: "500",
    letterSpacing: "0",
    textTransform: "none",
    width: "24px",
    minHeight: "24px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--muted)",
    border: "0",
    borderRadius: "4px",
    background: "transparent",
    fontSize: "14px",
    lineHeight: "1",
    "&:hover": {
        color: "var(--text)",
        background: "var(--hover)",
    },
})

let bootstrapState = css({
    height: "100%",
    padding: "32px",
    display: "grid",
    placeItems: "center",
    overflow: "auto",
    textAlign: "center",
})

let bootstrapStateDiv = css({
    maxWidth: "520px",
})

let eyebrow = css({
    color: "var(--muted)",
})

let bootstrapStateH1 = css({
    margin: "8px 0",
    fontSize: "18px",
    fontWeight: "600",
})

let bootstrapStateP = css({
    color: "var(--muted)",
})

let primaryButton = css({
    marginTop: "14px",
})

export function Notice(handle: Handle<{ notice?: NoticeState; dismiss(): void }>) {
    let shown: NoticeState | undefined, timer: number | undefined, hovered = false, focused = false
    let stop = () => window.clearTimeout(timer)
    // The countdown waits while the pointer or focus is on the notice, so it never closes mid-read.
    let schedule = () => {
        stop()
        if (shown?.transient && !hovered && !focused)
            timer = window.setTimeout(() => handle.props.dismiss(), shown.duration ?? transientDuration)
    }
    handle.signal.addEventListener("abort", stop, { once: true })

    return () => {
        if (handle.props.notice != shown) {
            shown = handle.props.notice
            schedule()
        }
        return (
            <div
                class="notice"
                mix={[
                    notice,
                    on("pointerenter", () => {
                        hovered = true
                        stop()
                    }),
                    on("pointerleave", () => {
                        hovered = false
                        schedule()
                    }),
                    on("focusin", () => {
                        focused = true
                        stop()
                    }),
                    on("focusout", event => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                            focused = false
                            schedule()
                        }
                    }),
                ]}
                role="status"
                aria-live="polite"
                hidden={!handle.props.notice}
            >
                <div>
                    <small mix={noticeSmall}>
                        {handle.props.notice?.code ?? ""}
                    </small>
                    <p mix={noticeP}>
                        {handle.props.notice?.message ?? ""}
                    </p>
                </div>
                {handle.props.notice?.action && (
                    <button
                        type="button"
                        class="notice-action"
                        mix={[noticeAction, on("click", () => handle.props.notice?.action?.run())]}
                    >
                        {handle.props.notice.action.label}
                    </button>
                )}
                <button id="notice-close" type="button" aria-label="Dismiss" mix={[noticeClose, on("click", handle.props.dismiss)]}>
                    ×
                </button>
            </div>
        )
    }
}

export function FatalError(handle: Handle<{ message: string; retry(): void }>) {
    return () => (
        <main class="bootstrap-state fatal" mix={bootstrapState}>
            <div role="alert" mix={bootstrapStateDiv}>
                <p class="eyebrow" mix={eyebrow}>
                    Application startup failed
                </p>
                <h1 mix={bootstrapStateH1}>
                    Laneway could not start.
                </h1>
                <p mix={bootstrapStateP}>
                    {handle.props.message}
                </p>
                <button class="primary-button" type="button" mix={[primaryButton, on("click", handle.props.retry)]}>
                    Retry
                </button>
            </div>
        </main>
    )
}

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
