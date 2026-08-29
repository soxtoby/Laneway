import { on, type Handle } from "remix/ui"

export interface NoticeState {
    code: string
    message: string
}

export function Notice(handle: Handle<{ notice?: NoticeState; dismiss(): void }>) {
    return () => (
        <div class="notice" role="status" aria-live="polite" hidden={!handle.props.notice}>
            <div><small>{handle.props.notice?.code ?? ""}</small><p>{handle.props.notice?.message ?? ""}</p></div>
            <button id="notice-close" type="button" aria-label="Dismiss" mix={[on("click", handle.props.dismiss)]}>×</button>
        </div>
    )
}

export function FatalError(handle: Handle<{ message: string; retry(): void }>) {
    return () => (
        <main class="bootstrap-state fatal">
            <div role="alert">
                <p class="eyebrow">Application startup failed</p>
                <h1>Git Workbench could not start.</h1>
                <p>{handle.props.message}</p>
                <button class="primary-button" type="button" mix={[on("click", handle.props.retry)]}>Retry</button>
            </div>
        </main>
    )
}

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
