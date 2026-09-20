import { css, type Handle, on } from "remix/ui"

export interface NoticeState {
    code: string
    message: string
}

export function Notice(handle: Handle<{ notice?: NoticeState; dismiss(): void }>) {
    return () => (
        <div class="notice" mix={notice} role="status" aria-live="polite" hidden={!handle.props.notice}>
            <div>
                <small mix={noticeSmall}>
                    {handle.props.notice?.code ?? ""}
                </small>
                <p mix={noticeP}>
                    {handle.props.notice?.message ?? ""}
                </p>
            </div>
            <button id="notice-close" type="button" aria-label="Dismiss" mix={[noticeClose, on("click", handle.props.dismiss)]}>
                ×
            </button>
        </div>
    )
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

const notice = css({
    position: "fixed",
    zIndex: "30",
    right: "14px",
    bottom: "12px",
    width: "min(460px, calc(100vw - 28px))",
    padding: "11px 12px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
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

const noticeSmall = css({
    color: "var(--accent)",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0",
    textTransform: "none",
})

const noticeP = css({
    margin: "4px 0 0",
    fontSize: "13px",
    lineHeight: "1.45",
})

const noticeClose = css({
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

const bootstrapState = css({
    height: "100%",
    padding: "32px",
    display: "grid",
    placeItems: "center",
    overflow: "auto",
    textAlign: "center",
})

const bootstrapStateDiv = css({
    maxWidth: "520px",
})

const eyebrow = css({
    color: "var(--muted)",
})

const bootstrapStateH1 = css({
    margin: "8px 0",
    fontSize: "18px",
    fontWeight: "600",
})

const bootstrapStateP = css({
    color: "var(--muted)",
})

const primaryButton = css({
    marginTop: "14px",
})
