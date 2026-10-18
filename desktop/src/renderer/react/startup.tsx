/** @jsxImportSource react */
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
