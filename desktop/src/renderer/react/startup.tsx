import type { EntryError } from "@laneway/shared"
import { Button } from "./ui/Button"

export function Starting() {
    return (
        <main className="startup" aria-live="polite">
            <p className="startup-detail">Starting Laneway…</p>
        </main>
    )
}

export function StartupFailed({ error, onRetry }: { error: string; onRetry(): void }) {
    return (
        <main className="startup">
            <div role="alert" className="startup-alert">
                <p className="startup-detail">Application startup failed</p>
                <h1 className="startup-title">Laneway could not start.</h1>
                <p className="startup-detail">{error}</p>
                <Button variant="accent" onPress={onRetry}>Retry</Button>
            </div>
        </main>
    )
}

/**
 * Laneway started without its saved Workspace State. Repositories that couldn't be restored are a
 * notice instead; a state it can't read at all offers a reset.
 */
export function WorkspaceRecovery({ error, onReset }: { error: EntryError; onReset(): void }) {
    let resettable = error.code == "workspace.corrupt" || error.code == "workspace.unsupported-version"
    return (
        <aside className="workspace-recovery" aria-live="assertive">
            <div>
                <strong>Workspace State needs attention</strong>
                <p className="workspace-recovery-detail">{error.message}</p>
            </div>
            {resettable && <Button variant="secondary" onPress={onReset}>Reset workspace</Button>}
        </aside>
    )
}
