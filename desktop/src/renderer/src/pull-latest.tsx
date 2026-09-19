import type { BranchGraph, PullProgress, PullResult, PullStackOutcome, PullStackStatus } from "@git-workbench/shared"
import { css, type Handle, on, ref } from "remix/ui"

export interface PullControl {
    // Disabled when the repository has no remotes; the hint explains why.
    available: boolean
    hint: string
    running?: { message: string }
    start(): void
    cancel(): void
}

interface Options {
    api: Window["workbench"]
    update(): Promise<AbortSignal>
    signal: AbortSignal
    // Open Workspace Column branch refs, frozen when Pull latest is activated.
    scope(repositoryId: string): string[]
    graph(repositoryId: string): BranchGraph | undefined
    completed(repositoryId: string): Promise<void>
    notify(notice: { code: string; message: string }): void
    openBranch(repositoryId: string, branchName: string): void
}

export function createPullLatest(options: Options) {
    const running = new Map<string, { message: string; cancelling: boolean }>()
    let outcome: { repositoryId: string; result: PullResult } | undefined
    let error: { repositoryId: string; message: string } | undefined
    let returnFocus: HTMLElement | null = null
    const unsubscribe = options.api.onPullProgress((progress: PullProgress) => {
        const active = running.get(progress.repositoryId)
        if (active && !active.cancelling) {
            active.message = progress.message
            void options.update()
        }
    })
    options.signal.addEventListener("abort", unsubscribe, { once: true })

    async function start(repositoryId: string) {
        if (running.has(repositoryId))
            return
        const graph = options.graph(repositoryId)
        const branches = options.scope(repositoryId)
        returnFocus = document.activeElement as HTMLElement | null
        running.set(repositoryId, { message: "Fetching…", cancelling: false })
        error = undefined
        await options.update()
        try {
            const response = await options.api.pullLatest(repositoryId, { branches, remote: graph?.selectedRemote })
            if (!response.ok)
                throw new Error(response.error.message)
            // Only outcomes that need the user's attention interrupt them; a clean pull is confirmed in passing.
            if (needsAttention(response.result))
                outcome = { repositoryId, result: response.result }
            else
                options.notify({ code: "pull.latest", message: response.result.message })
        } catch (reason) {
            error = { repositoryId, message: reason instanceof Error ? reason.message : String(reason) }
        } finally {
            running.delete(repositoryId)
        }
        await options.completed(repositoryId)
        await options.update()
    }

    async function cancel(repositoryId: string) {
        const active = running.get(repositoryId)
        if (!active || active.cancelling)
            return
        active.cancelling = true
        active.message = "Cancelling at the next safe boundary…"
        await options.update()
        await options.api.cancelPull(repositoryId)
    }

    function close() {
        outcome = undefined
        error = undefined
        void options.update().then(() => returnFocus?.focus())
    }

    return {
        busy: (repositoryId: string) => running.has(repositoryId),
        control(repositoryId: string): PullControl {
            const graph = options.graph(repositoryId)
            const remotes = graph?.availableRemotes ?? []
            const active = running.get(repositoryId)
            return {
                available: Boolean(graph) && remotes.length > 0,
                hint: !graph ? "Loading the Branch Graph…" : remotes.length == 0 ? "Add a remote to pull." : "Fetch and synchronize open stacks",
                running: active ? { message: active.message } : undefined,
                start: () => void start(repositoryId),
                cancel: () => void cancel(repositoryId),
            }
        },
        render(repositoryId: string) {
            if (outcome?.repositoryId != repositoryId && error?.repositoryId != repositoryId)
                return null
            return (
                <PullOutcome
                    result={outcome?.result}
                    error={error?.message}
                    close={close}
                    resolve={branch => {
                        close()
                        options.openBranch(repositoryId, branch)
                    }}
                />
            )
        },
    }
}

function needsAttention(result: PullResult) {
    return result.fetches.some(fetch => fetch.status == "failed")
        || result.stacks.some(stack => stack.status != "updated" && stack.status != "current")
}

const statusLabels: Record<PullStackStatus, string> = {
    updated: "Updated",
    current: "Already current",
    "needs-resolution": "Needs resolution",
    skipped: "Skipped",
    failed: "Failed",
    cancelled: "Not started",
}

function PullOutcome(handle: Handle<{ result?: PullResult; error?: string; close(): void; resolve(branch: string): void }>) {
    return () => {
        const { result, error } = handle.props
        const counts = new Map<PullStackStatus, number>()
        for (const stack of result?.stacks ?? [])
            counts.set(stack.status, (counts.get(stack.status) ?? 0) + 1)
        return (
            <dialog
                class="pull-outcome"
                aria-label="Pull latest outcome"
                mix={[
                    dialogStyle,
                    ref(dialog => dialog.showModal()),
                    on("cancel", event => {
                        event.preventDefault()
                        handle.props.close()
                    }),
                ]}
            >
                <h2>Pull latest</h2>
                {error && <p class="pull-error" mix={errorStyle}>{error}</p>}
                {result && (
                    <>
                        <p class="pull-summary">{result.message}</p>
                        {result.fetches.length > 0 && (
                            <ul class="pull-fetches" mix={fetchList}>
                                {result.fetches.map(fetch => (
                                    <li class={fetch.status}>
                                        <span mix={statusBadge}>{fetch.status == "fetched" ? "Fetched" : "Fetch failed"}</span> {fetch.remote}
                                        {fetch.message && <span mix={detailStyle}>{fetch.message}</span>}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {counts.size > 0 && (
                            <p class="pull-counts" mix={countsStyle}>
                                {[...counts].map(([status, count]) => `${count} ${statusLabels[status].toLocaleLowerCase()}`).join(" · ")}
                            </p>
                        )}
                        <div class="pull-stacks">
                            {result.stacks.map(stack => <StackOutcome stack={stack} resolve={handle.props.resolve} />)}
                        </div>
                        {result.operation && <p mix={detailStyle}>Undo reverses this pull's local changes across stacks. Fetched history stays available.</p>}
                    </>
                )}
                <footer mix={footerStyle}>
                    <button class="primary-button" type="button" mix={[buttonStyle, on("click", handle.props.close)]}>Close</button>
                </footer>
            </dialog>
        )
    }
}

function StackOutcome(handle: Handle<{ stack: PullStackOutcome; resolve(branch: string): void }>) {
    return () => {
        const { stack } = handle.props
        const tip = stack.branches.at(-1) ?? ""
        return (
            <details class={`pull-stack ${stack.status}`} mix={stackStyle} open={stack.status != "current" && stack.status != "updated"}>
                <summary mix={summaryStyle}>
                    <span class="pull-status" mix={statusBadge} data-status={stack.status}>{statusLabels[stack.status]}</span>
                    <strong>{tip}</strong>
                    {stack.branches.length > 1 && <span mix={detailStyle}>on {stack.branches.slice(0, -1).join(" › ")}</span>}
                </summary>
                <div mix={bodyStyle}>
                    <p>Stack: {stack.branches.join(" › ")}</p>
                    {stack.message && <p>{stack.message}</p>}
                    {stack.status == "needs-resolution" && (
                        <button type="button" mix={[buttonStyle, on("click", () => handle.props.resolve(tip))]}>Resolve in {tip}</button>
                    )}
                    {(stack.status == "updated" || stack.status == "needs-resolution") && (
                        <p mix={detailStyle}>Rewritten branches keep their publication pending until you Publish.</p>
                    )}
                </div>
            </details>
        )
    }
}

const dialogStyle = css({
    width: "520px",
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
    "& h2": { margin: "0 0 12px", fontSize: "17px", fontWeight: 600 },
    "& p": { margin: "6px 0", overflowWrap: "anywhere", fontSize: "13px", lineHeight: 1.5 },
})
const errorStyle = css({ color: "var(--danger)" })
const fetchList = css({
    margin: "6px 0",
    padding: "0",
    listStyle: "none",
    display: "grid",
    gap: "4px",
    fontSize: "13px",
    "& li": { display: "flex", gap: "8px", alignItems: "baseline" },
})
const countsStyle = css({ color: "var(--muted)" })
const detailStyle = css({ color: "var(--muted)", fontSize: "12px" })
const statusBadge = css({
    display: "inline-block",
    padding: "1px 6px",
    borderRadius: "999px",
    border: "1px solid var(--line-strong)",
    fontSize: "11px",
    fontWeight: 600,
    whiteSpace: "nowrap",
    '&[data-status="updated"]': { color: "var(--accent)" },
    '&[data-status="needs-resolution"], &[data-status="failed"]': { color: "var(--danger)", borderColor: "var(--danger)" },
    '&[data-status="skipped"], &[data-status="cancelled"]': { color: "var(--warning)" },
})
const stackStyle = css({ border: "1px solid var(--line)", borderRadius: "6px", margin: "6px 0", background: "var(--panel-deep)" })
const summaryStyle = css({ display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", cursor: "pointer", fontSize: "13px" })
const bodyStyle = css({ padding: "0 10px 10px 10px", display: "grid", gap: "4px" })
const footerStyle = css({ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" })
const buttonStyle = css({
    minHeight: "30px",
    padding: "0 12px",
    borderRadius: "4px",
    fontSize: "13px",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    background: "var(--control)",
    "&:hover:not(:disabled)": { background: "var(--control-hover)" },
})
