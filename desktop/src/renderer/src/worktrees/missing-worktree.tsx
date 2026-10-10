import type { BranchGraphWorktree, WorktreeRequest } from "@laneway/shared"
import { css, type Handle, on } from "remix/ui"

let missingWorktree = css({
    margin: "8px",
    padding: "12px",
    border: "1px solid var(--warning-edge)",
    borderRadius: "var(--radius-card)",
    background: "var(--warning-wash)",
    fontSize: "12px",
    "& h3": { margin: "0 0 6px", fontSize: "13px", color: "var(--warning)" },
    "& p": { margin: "0 0 12px", color: "var(--muted)", lineHeight: "1.5" },
    "& .missing-worktree-actions": { display: "flex", gap: "8px" },
    "& button": { minHeight: "30px", padding: "4px 12px", borderRadius: "var(--radius)", fontSize: "12px" },
})

export function MissingWorktreePanel(
    handle: Handle<{
        worktree: BranchGraphWorktree
        busy: boolean
        prepare(request: WorktreeRequest): Promise<void>
        chooseDirectory(path?: string): Promise<string | undefined>
    }>,
) {
    return () => (
        <section class="missing-worktree" aria-label="Missing worktree" mix={missingWorktree}>
            <h3>Worktree directory missing</h3>
            <p>Locate the directory to repair this worktree, or remove its registration.</p>
            <div class="missing-worktree-actions">
                <button
                    type="button"
                    class="primary-button"
                    disabled={handle.props.busy}
                    mix={on("click", async () => {
                        let destination = await handle.props.chooseDirectory(handle.props.worktree.path)
                        if (destination)
                            await handle.props.prepare({ action: "repair", path: handle.props.worktree.path, destination })
                    })}
                >
                    Repair
                </button>
                <button
                    type="button"
                    class="secondary-button"
                    disabled={handle.props.busy || handle.props.worktree.locked}
                    title={handle.props.worktree.locked ? "Unlock worktree to remove" : undefined}
                    mix={on(
                        "click",
                        () => handle.props.prepare({ action: "remove", path: handle.props.worktree.path, preserve: true, allowIgnoredLoss: false }),
                    )}
                >
                    Remove
                </button>
            </div>
        </section>
    )
}
