import type { RecoveryRequest, WorktreeRecovery } from "@laneway/shared"
import { css, type Handle, on } from "remix/ui"

let recoveryPanel = css({
    alignSelf: "start",
    margin: "12px",
    padding: "14px",
    border: "1px solid var(--warning-edge)",
    borderRadius: "var(--radius-card)",
    background: "var(--warning-wash)",
    fontSize: "13px",
    overflowWrap: "anywhere",
    "& h3": { margin: "0 0 10px", fontSize: "14px", color: "var(--warning)" },
    "& p": { margin: "0 0 12px", lineHeight: "1.5" },
    "& .recovery-path, & details": { fontSize: "11px", color: "var(--muted)" },
    "& .recovery-actions": { display: "flex", gap: "8px", marginBottom: "12px" },
    "& .recovery-actions button": { minHeight: "32px", padding: "6px 12px", borderRadius: "var(--radius-control)", fontSize: "12px" },
    "& .recovery-help": { color: "var(--muted)", fontSize: "12px" },
    "& .recovery-error": { color: "var(--danger)" },
    "& summary": { cursor: "pointer" },
    "& details p": { margin: "8px 0 0" },
})

export function WorktreeRecoveryPanel(
    handle: Handle<{
        recovery: WorktreeRecovery
        busy: boolean
        error?: string
        resolve(action: RecoveryRequest["action"]): void
    }>,
) {
    return () => (
        <section class="worktree-recovery" mix={recoveryPanel} aria-label="Worktree recovery">
            <h3>Worktree removal interrupted</h3>
            <p>{handle.props.recovery.message}</p>
            <p class="recovery-path">{handle.props.recovery.path}</p>
            <div class="recovery-actions">
                <button type="button" class="primary-button" disabled={handle.props.busy} mix={on("click", () => handle.props.resolve("restore"))}>
                    Recover
                </button>
                <button type="button" class="secondary-button" disabled={handle.props.busy} mix={on("click", () => handle.props.resolve("remove"))}>
                    Remove
                </button>
            </div>
            <p class="recovery-help">Recover restores the saved worktree and backs up leftover files.</p>
            <p class="recovery-help">Remove deletes leftover files and keeps only the saved Git state for Undo.</p>
            {handle.props.busy && <p role="status">Resolving worktree removal…</p>}
            {handle.props.error && <p class="recovery-error" role="alert">{handle.props.error}</p>}
            <details>
                <summary>Details</summary>
                <p>Operation: {handle.props.recovery.operationId}</p>
                {handle.props.recovery.backupPath && <p>Files preserved at: {handle.props.recovery.backupPath}</p>}
            </details>
        </section>
    )
}
