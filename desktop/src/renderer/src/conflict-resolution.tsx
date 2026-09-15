import type { BranchGraphBranchNode, ConflictRequest, ConflictResult, Workspace } from "@git-workbench/shared"
import { css, type Handle, on, ref } from "remix/ui"
import { ResolutionReview, resolutionReview } from "./conflict-content"
import { fileActionButton, fileLabel, InspectionItem } from "./file-list"

interface Options {
    api: Window["workbench"]
    workspace(): Workspace
    update(): Promise<AbortSignal>
    changed(repositoryId: string): Promise<void>
    persist(repositoryId: string): Promise<void>
}
export function createConflictResolution(options: Options) {
    const open = new Map<string, string | undefined>()
    const key = (repository: string, column: string) => `${repository}:${column}`
    const selected = (repository: string, column: string) => {
        const id = key(repository, column)
        if (!open.has(id))
            open.set(id, options.workspace().repositories.find(r => r.id == repository)?.columns.find(c => c.id == column)?.resolutionSubject)
        return open.get(id)
    }
    function select(repository: string, column: string, subject?: string) {
        open.set(key(repository, column), subject)
        void options.persist(repository)
        void options.update()
    }
    return {
        selected,
        open: select,
        controls(repository: string, column: BranchGraphBranchNode, path?: string) {
            if (!column.unresolved)
                return null
            return (
                <ConflictControls
                    key={`${repository}:${column.id}`}
                    api={options.api}
                    repository={repository}
                    branch={column}
                    path={path}
                    open={subject => select(repository, column.id, subject)}
                    changed={() => options.changed(repository)}
                />
            )
        },
        column(repository: string, column: string, path?: string, tip?: string) {
            const subject = selected(repository, column)
            return subject
                ? (
                    <ConflictResolutionColumn
                        key={`${repository}:${subject}:${tip ?? ""}`}
                        api={options.api}
                        repository={repository}
                        subject={subject}
                        path={path}
                        close={() => select(repository, column)}
                        changed={() => options.changed(repository)}
                    />
                )
                : null
        },
    }
}

function ConflictControls(
    handle: Handle<
        { api: Window["workbench"]; repository: string; branch: BranchGraphBranchNode; path?: string; open(subject: string): void; changed(): Promise<void> }
    >,
) {
    let result: ConflictResult | undefined
    let error = "", busy = false, requested = ""
    async function run(request: ConflictRequest) {
        busy = true
        error = ""
        await handle.update()
        try {
            const response = await handle.props.api.conflictOperation(handle.props.repository, request)
            if (!response.ok)
                throw new Error(response.error.message)
            result = response.result
            if (request.action != "list")
                await handle.props.changed()
        } catch (e) {
            error = e instanceof Error ? e.message : String(e)
        } finally {
            busy = false
            void handle.update()
        }
    }
    return () => {
        const props = handle.props
        const ids = props.branch.unresolved?.subjects ?? []
        const next = JSON.stringify(props.branch.unresolved)
        if (requested != next) {
            requested = next
            handle.queueTask(() => run({ action: "list" }))
        }
        const conflicts = result?.conflicts.filter(c => ids.includes(c.id) && c.kind == "working") ?? []
        const recovery = result?.recovery.find(r => r.stack == props.branch.unresolved?.stackId || r.branch == props.branch.name || !r.branch)
        if (!conflicts.length && !recovery && !props.branch.unresolved?.recovery && !error)
            return null
        return (
            <section aria-label="Unresolved conflicts" mix={controlsStyle}>
                <strong>{props.branch.unresolved?.recovery ? "Recovery required" : "Unresolved"}</strong>
                {props.branch.unresolved?.recovery && !recovery && <p>{props.branch.unresolved.recovery}</p>}
                {conflicts.map(conflict => (
                    <div>
                        <button disabled={busy} mix={on("click", () => props.open(conflict.id))}>
                            {conflict.title} {conflict.commit ? `(${conflict.commit.slice(0, 8)})` : ""}
                        </button>
                        {conflict.suspended && props.path && (
                            <button
                                disabled={busy}
                                mix={on("click", () => void run({ action: "resume-working", subject: conflict.id, path: props.path! }))}
                            >
                                Resume Working Changes
                            </button>
                        )}
                    </div>
                ))}
                {recovery && (
                    <div>
                        <p>{recovery.message}</p>
                        {recovery.stack != "untracked" && (
                            <>
                                <button disabled={busy} mix={on("click", () => void run({ action: "restore", stack: recovery.stack, path: props.path }))}>
                                    Restore unresolved stack
                                </button>
                                {recovery.candidates.map(adopt => (
                                    <button
                                        disabled={busy}
                                        mix={on("click", () => void run({ action: "restore", stack: recovery.stack, adopt }))}
                                    >
                                        Use {adopt}
                                    </button>
                                ))}
                                <details>
                                    <summary>Discard recovery</summary>
                                    <p>The intended branches stay at their current tips. Private Operation History retains the earlier update.</p>
                                    <button disabled={busy} mix={on("click", () => void run({ action: "discard", stack: recovery.stack }))}>
                                        Discard unresolved update
                                    </button>
                                </details>
                            </>
                        )}
                    </div>
                )}
                {error && <p role="alert">{error}</p>}
            </section>
        )
    }
}

type ResolutionAction =
    | Omit<Extract<ConflictRequest, { action: "choose" }>, "subject" | "input" | "revision" | "hunk">
    | { action: "accept" | "cancel" | "keep-stashed" }
    | { action: "use-file"; file: string; path: string }
    | { action: "tool"; file: string }

export function ConflictResolutionColumn(
    handle: Handle<{ api: Window["workbench"]; repository: string; subject: string; path?: string; close(): void; changed(): Promise<void> }>,
) {
    let view: ConflictResult["view"], summary: ConflictResult["conflicts"][number] | undefined
    let error = "", busy = false, loaded = false
    let element: HTMLElement
    async function run(request: ConflictRequest) {
        if (busy)
            return
        busy = true
        error = ""
        await handle.update()
        try {
            const response = await handle.props.api.conflictOperation(handle.props.repository, request)
            if (!response.ok)
                throw new Error(response.error.message)
            view = response.result.view
            summary = response.result.conflicts.find(c => c.id == handle.props.subject) ?? summary
            if (request.action == "accept" || request.action == "keep-stashed") {
                await handle.props.changed()
                handle.props.close()
            }
        } catch (e) {
            error = e instanceof Error ? e.message : String(e)
        } finally {
            busy = false
            void handle.update()
        }
    }
    function action(request: ResolutionAction) {
        element.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => menu.open = false)
        if (view)
            void run({ ...request, subject: view.subject.id, input: view.subject.input, revision: view.candidate.revision } as ConflictRequest)
    }
    return () => {
        const props = handle.props
        if (!loaded) {
            loaded = true
            handle.queueTask(async () => {
                await run({ action: "inspect", subject: props.subject })
                element.scrollIntoView({ block: "nearest", inline: "nearest" })
            })
        }
        const resolved = view?.files.filter(f => f.resolved).length ?? 0
        const remaining = (view?.files.length ?? 0) - resolved
        const rightLabel = summary?.kind == "working" ? "stashed changes" : "this commit"
        return (
            <article
                class="conflict-resolution-column"
                aria-label="Conflict Resolution Column"
                aria-busy={busy}
                mix={[columnStyle, ref(node => element = node)]}
            >
                <header class="resolution-header">
                    <div class="resolution-heading">
                        <span>Resolve conflict{summary?.branch ? " · " + summary.branch : ""}</span>
                        <h2 title={summary?.title}>{summary?.title ?? "Loading conflict…"}</h2>
                    </div>
                    <button class="icon-button" aria-label="Close conflict resolution" title="Close" mix={on("click", props.close)}>
                        {resolutionIcon("close")}
                    </button>
                </header>
                {error && (
                    <div class="resolution-error" role="alert">
                        <span>{error}</span>
                        <button disabled={busy} mix={on("click", () => void run({ action: "inspect", subject: props.subject }))}>Reload</button>
                    </div>
                )}
                {view && (
                    <>
                        <div class="resolution-list-heading">
                            <strong>
                                Conflicted files <span>{view.files.length}</span>
                            </strong>
                            <button disabled={busy || !view.candidate.revision} mix={on("click", () => action({ action: "cancel" }))}>
                                Discard resolution progress
                            </button>
                        </div>
                        <div class="resolution-content">
                            <ul class="conflict-file-list" aria-label="Conflicted files">
                                {view.files.map(file => (
                                    <ConflictFileRow
                                        key={file.path}
                                        view={view!}
                                        file={file}
                                        busy={busy}
                                        path={props.path}
                                        rightLabel={rightLabel}
                                        action={action}
                                    />
                                ))}
                            </ul>
                        </div>
                        <footer class="resolution-footer">
                            <div class="resolution-progress" role="status">
                                <strong>
                                    {busy ? "Working…" : view.ready ? "Ready to accept" : remaining + (remaining == 1 ? " file left" : " files left")}
                                </strong>
                                <span>{resolved} of {view.files.length} files resolved</span>
                            </div>
                            {summary?.kind == "working" && (
                                <button disabled={busy} mix={on("click", () => action({ action: "keep-stashed" }))}>Keep stashed</button>
                            )}
                            <button class="accept-resolution" disabled={busy || !view.ready} mix={on("click", () => action({ action: "accept" }))}>
                                {resolutionIcon("check")}Accept resolution
                            </button>
                        </footer>
                    </>
                )}
            </article>
        )
    }
}

function ConflictFileRow(
    handle: Handle<{
        view: NonNullable<ConflictResult["view"]>
        file: NonNullable<ConflictResult["view"]>["files"][number]
        busy: boolean
        path?: string
        rightLabel: string
        action(request: ResolutionAction): void
    }>,
) {
    let expanded = false, reviewVersion = ""
    let review: ReturnType<typeof resolutionReview> | undefined
    return () => {
        const { view, file, busy, path, rightLabel, action } = handle.props
        const version = view.candidate.revision
        if (expanded && file.resolved && version != reviewVersion) {
            review = resolutionReview(view, file)
            reviewVersion = version
        }
        return (
            <li class="conflict-file" data-file={file.path} data-resolved={file.resolved}>
                <InspectionItem
                    title={file.path}
                    expanded={expanded && file.resolved}
                    actions={busy
                        ? []
                        : [
                            { label: "Use updated stack", run: () => action({ action: "choose", file: file.path, side: "left" }) },
                            { label: "Use " + rightLabel, run: () => action({ action: "choose", file: file.path, side: "right" }) },
                            { label: "Merge tool", run: () => action({ action: "tool", file: file.path }) },
                            ...(path
                                ? [{
                                    label: "Use current file",
                                    run: () => action({ action: "use-file", file: file.path, path }),
                                }]
                                : []),
                        ]}
                    choose={file.resolved
                        ? () => {
                            expanded = !expanded
                            void handle.update()
                        }
                        : undefined}
                    label={
                        <>
                            <span
                                class={file.resolved ? "resolved-mark" : "pending-mark"}
                                role="img"
                                aria-label={file.resolved ? "Resolved" : "Unresolved"}
                                title={file.resolved ? "Resolved" : "Unresolved"}
                            >
                                {resolutionIcon(file.resolved ? "check" : "conflict")}
                            </span>
                            {fileLabel(file.path)}
                        </>
                    }
                    controls={
                        <div class="conflict-file-actions">
                            <button
                                type="button"
                                disabled={busy}
                                aria-label="Use updated stack"
                                title={file.left ? "Use the entire file from the updated stack" : "The updated stack deletes this file"}
                                mix={[fileActionButton, on("click", () => action({ action: "choose", file: file.path, side: "left" }))]}
                            >
                                {resolutionIcon("take-left")}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                aria-label={"Use " + rightLabel}
                                title={file.right ? "Use the entire file from " + rightLabel : "The " + rightLabel + " version deletes this file"}
                                mix={[fileActionButton, on("click", () => action({ action: "choose", file: file.path, side: "right" }))]}
                            >
                                {resolutionIcon("take-right")}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                aria-label="Merge tool"
                                title="Resolve this file in your configured Git merge tool"
                                mix={[fileActionButton, on("click", () => action({ action: "tool", file: file.path }))]}
                            >
                                {resolutionIcon("tool")}
                            </button>
                            {(path || view.subject.suggestion) && (
                                <details class="resolution-menu">
                                    <summary title="More file actions" aria-label={"More actions for " + file.path} mix={fileActionButton}>
                                        {resolutionIcon("more")}
                                    </summary>
                                    <div class="resolution-menu-items">
                                        {path && (
                                            <button disabled={busy} mix={on("click", () => action({ action: "use-file", file: file.path, path }))}>
                                                Use current file
                                            </button>
                                        )}
                                        {view.subject.suggestion && (
                                            <button
                                                disabled={busy}
                                                mix={on("click", () => action({ action: "choose", file: file.path, side: "suggestion" }))}
                                            >
                                                Use previous result
                                            </button>
                                        )}
                                    </div>
                                </details>
                            )}
                        </div>
                    }
                >
                    {expanded && file.resolved && review && (
                        <div class="file-review">
                            <div class="review-heading">Compared with updated stack</div>
                            <ResolutionReview key={review.version} page={review} file={file} deleted={view.candidate.files[file.path] === null} />
                        </div>
                    )}
                </InspectionItem>
            </li>
        )
    }
}
function resolutionIcon(kind: "close" | "check" | "conflict" | "tool" | "more" | "take-left" | "take-right") {
    const paths = {
        close: "m4 4 8 8M12 4l-8 8",
        check: "m3 8 3 3 7-7",
        conflict: "M8 2 15 14H1ZM8 6v4m0 1.5v1",
        tool: "M2 3h4v10H2ZM10 3h4v10h-4M6 8h4m-2-2 2 2-2 2",
        more: "M3 7v2m5-2v2m5-2v2",
        "take-left": "M11 2h3v12h-3M2 8h7M6 5l3 3-3 3",
        "take-right": "M5 2H2v12h3m9-6H7m3-3L7 8l3 3",
    }
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path d={paths[kind]} />
        </svg>
    )
}
const control = {
    minHeight: "26px",
    padding: "3px 8px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "var(--control)",
    font: "inherit",
    fontSize: "12px",
    cursor: "pointer",
    "&:hover:not(:disabled)": { background: "var(--control-hover)" },
    "&:disabled": { opacity: "0.45", cursor: "default" },
}
const controlsStyle = css({
    padding: "8px",
    borderBottom: "1px solid var(--line)",
    color: "var(--text)",
    fontSize: "12px",
    "& button": { ...control, margin: "2px" },
    "& strong": { color: "var(--warning)" },
})
const columnStyle = css({
    flex: "0 0 560px",
    width: "560px",
    minWidth: "420px",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--line-strong)",
    background: "var(--panel)",
    color: "var(--text)",
    fontSize: "12px",
    overflow: "hidden",
    "& :where(.resolution-header, .resolution-list-heading, .resolution-footer, .resolution-error) > button": control,
    "& svg": { flexShrink: "0" },
    "& .resolution-header": {
        minHeight: "44px",
        flexShrink: "0",
        boxSizing: "border-box",
        padding: "6px 10px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        borderBottom: "1px solid var(--line)",
        background: "var(--panel-deep)",
    },
    "& .resolution-heading": {
        flex: "1",
        minWidth: "0",
        "& > span": { color: "var(--muted)", fontSize: "10px" },
        "& h2": { fontSize: "12px", fontWeight: "600", lineHeight: "18px", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden", margin: "0" },
    },
    "& .icon-button": { width: "26px", padding: "0", borderColor: "transparent", background: "transparent" },
    "& .resolution-list-heading": {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        padding: "5px 12px",
        flexShrink: "0",
        background: "var(--raised)",
        borderBottom: "1px solid var(--line)",
        "& strong": { fontWeight: "500" },
        "& strong span": { marginLeft: "6px", color: "var(--muted)" },
        "& button": { borderColor: "transparent", background: "transparent", fontSize: "11px" },
    },
    "& .resolution-content": { flex: "1", minHeight: "0", overflow: "auto" },
    "& .conflict-file-list": { listStyle: "none", padding: "0", margin: "0" },
    "& .resolved-mark": { color: "var(--accent)", display: "inline-flex", flex: "0 0 14px" },
    "& .pending-mark": { color: "var(--warning)", display: "inline-flex", flex: "0 0 14px" },
    "& .conflict-file-actions": { display: "flex", alignItems: "center", gap: "4px", marginLeft: "auto", flex: "0 0 auto" },
    "& .conflict-file:has(.resolution-menu[open])": { position: "relative", zIndex: "7" },
    "& .resolution-menu": {
        position: "relative",
        "& summary": { listStyle: "none" },
        "&[open] summary": { background: "var(--control-hover)" },
    },
    "& .resolution-menu-items": {
        position: "absolute",
        right: "0",
        top: "30px",
        width: "180px",
        zIndex: "5",
        padding: "4px",
        border: "1px solid var(--line-strong)",
        borderRadius: "5px",
        background: "var(--panel)",
        boxShadow: "var(--shadow-popover)",
        "& button": {
            width: "100%",
            textAlign: "left",
            border: "0",
            background: "transparent",
            minHeight: "26px",
            padding: "4px 8px",
            color: "var(--text)",
            font: "inherit",
            cursor: "pointer",
            "&:hover": { background: "var(--control-hover)" },
        },
    },
    "& .file-review": { borderTop: "1px solid var(--line)" },
    "& .review-heading": { padding: "6px 12px", color: "var(--muted)", fontSize: "11px", background: "var(--accent-wash)" },
    "& .resolution-footer": {
        display: "flex",
        flex: "0 0 auto",
        gap: "12px",
        alignItems: "center",
        minHeight: "56px",
        padding: "8px 12px",
        boxSizing: "border-box",
        borderTop: "1px solid var(--line-strong)",
        background: "var(--raised)",
    },
    "& .resolution-progress": {
        flex: "1",
        display: "grid",
        gap: "3px",
        "& strong": { fontSize: "12px", fontWeight: "500" },
        "& span": { fontSize: "11px", color: "var(--muted)" },
    },
    "& .accept-resolution": {
        minHeight: "30px",
        background: "var(--accent)",
        color: "var(--accent-ink)",
        borderColor: "var(--accent)",
        "&:hover:not(:disabled)": { background: "var(--accent-hover)" },
    },
    "& .resolution-error": {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        color: "var(--danger)",
        borderBottom: "1px solid var(--line)",
        "& span": { flex: "1" },
    },
})
