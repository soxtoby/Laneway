import type { BranchGraphBranchNode, ChangedFile, ConflictRequest, ConflictResult } from "@git-workbench/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import { ResolutionReview, resolutionReview } from "./conflict-content"
import { fileActionButton, fileLabel, InspectionItem } from "./file-list"
import { type ConflictSides, MergeResolution } from "./merge-resolution"

interface Options {
    api: Window["workbench"]
    changed(repositoryId: string): Promise<void>
}
export function createConflictResolution(options: Options) {
    return {
        controls(repository: string, column: BranchGraphBranchNode, path?: string) {
            return column.unresolved
                ? (
                    <ConflictControls
                        key={repository + ":" + column.id}
                        api={options.api}
                        repository={repository}
                        branch={column}
                        path={path}
                        changed={() => options.changed(repository)}
                    />
                )
                : null
        },
    }
}

function ConflictControls(
    handle: Handle<
        { api: Window["workbench"]; repository: string; branch: BranchGraphBranchNode; path?: string; changed(): Promise<void> }
    >,
) {
    let result: ConflictResult | undefined
    let error = "", busy = false, requested = "", selected: string | undefined
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
                        <button
                            disabled={busy}
                            aria-expanded={selected == conflict.id}
                            mix={on("click", () => {
                                selected = selected == conflict.id ? undefined : conflict.id
                                void handle.update()
                            })}
                        >
                            {conflict.title} {conflict.commit ? `(${conflict.commit.slice(0, 8)})` : ""}
                        </button>
                        {selected == conflict.id && !conflict.suspended && (
                            <ConflictResolution
                                key={conflict.id}
                                api={props.api}
                                repository={props.repository}
                                subject={conflict.id}
                                path={props.path}
                                changed={props.changed}
                            />
                        )}
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
    | { action: "edit"; file: string; content: string }

type ConflictView = NonNullable<ConflictResult["view"]>
const conflictFileCache = new Map<string, ConflictView>()

export function ConflictResolution(
    handle: Handle<{
        api: Window["workbench"]
        repository: string
        subject: string
        path?: string
        changed(): Promise<void>
        renderFiles?(files: ChangedFile[], renderFile: (file: ChangedFile) => RemixNode): RemixNode
    }>,
) {
    let view: ConflictResult["view"], summary: ConflictResult["conflicts"][number] | undefined
    let error = "", busy = false, loaded = false
    let element: HTMLElement
    async function run(request: ConflictRequest) {
        if (busy)
            return false
        busy = true
        error = ""
        await handle.update()
        try {
            const response = await handle.props.api.conflictOperation(handle.props.repository, request)
            if (!response.ok)
                throw new Error(response.error.message)
            view = response.result.view
            summary = response.result.conflicts.find(c => c.id == handle.props.subject) ?? summary
            if (request.action == "accept" || request.action == "keep-stashed")
                await handle.props.changed()
            return true
        } catch (e) {
            error = e instanceof Error ? e.message : String(e)
            return false
        } finally {
            busy = false
            void handle.update()
        }
    }
    async function loadFile(file: string) {
        const current = view!
        const key = JSON.stringify([handle.props.repository, current.subject.id, current.subject.input, current.candidate.revision, file])
        const cached = conflictFileCache.get(key)
        if (cached)
            return cached
        const item = current.files.find(item => item.path == file)!
        if (!item.resolved) {
            const entry = file in current.candidate.files ? current.candidate.files[file] : item.provisional
            const resultText = entry && entry.mode != "160000" ? await handle.props.api.readConflictContent(handle.props.repository, entry.object) : null
            const loaded = { ...current, files: current.files.map(item => item.path == file ? { ...item, loaded: true, resultText } : item) }
            conflictFileCache.set(key, loaded)
            if (conflictFileCache.size > 16)
                conflictFileCache.delete(conflictFileCache.keys().next().value!)
            return loaded
        }
        const response = await handle.props.api.conflictOperation(handle.props.repository, { action: "inspect", subject: current.subject.id, files: [file] })
        if (!response.ok)
            throw new Error(response.error.message)
        const loaded = response.result.view!
        if (loaded.subject.input != current.subject.input || loaded.candidate.revision != current.candidate.revision)
            throw new Error("Resolution progress changed. Reload the conflict before continuing.")
        conflictFileCache.set(key, loaded)
        if (conflictFileCache.size > 16)
            conflictFileCache.delete(conflictFileCache.keys().next().value!)
        return loaded
    }
    async function action(request: ResolutionAction) {
        element.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => menu.open = false)
        if (view)
            return run({ ...request, subject: view.subject.id, input: view.subject.input, revision: view.candidate.revision } as ConflictRequest)
        return false
    }
    return () => {
        const props = handle.props
        if (!loaded) {
            loaded = true
            handle.queueTask(() => run({ action: "inspect", subject: props.subject, files: [] }))
        }
        const resolved = view?.files.filter(f => f.resolved).length ?? 0
        const remaining = (view?.files.length ?? 0) - resolved
        const working = summary?.kind == "working"
        const sides: ConflictSides = {
            left: {
                label: working ? "Current files" : "Before this commit",
                action: working ? "Use pre-stash version" : "Use version before this commit",
                description: working ? "Files before restoring the stash." : "Destination files, including earlier commits in this stack.",
            },
            right: {
                label: working ? "Stashed changes" : "This commit",
                action: working ? "Use stashed changes" : "Use this commit",
                description: working ? `Stash ${view?.sourceCommit.slice(0, 8) ?? ""}` : `${view?.sourceCommit.slice(0, 8) ?? ""} · ${summary?.title ?? ""}`,
            },
        }
        return (
            <article
                class="inline-conflict-resolution"
                aria-label="Conflict resolution"
                aria-busy={busy}
                mix={[resolutionStyle, ref(node => element = node)]}
            >
                {!view && !error && <p role="status">Loading conflict…</p>}
                {error && (
                    <div class="resolution-error" role="alert">
                        <span>{error}</span>
                        <button disabled={busy} mix={on("click", () => void run({ action: "inspect", subject: props.subject, files: [] }))}>Reload</button>
                    </div>
                )}
                {view && (
                    <>
                        {props.renderFiles
                            ? props.renderFiles(
                                view.files.map(file => ({
                                    path: file.path,
                                    status: file.resolved ? "modified" : "conflicted",
                                    conflicted: !file.resolved,
                                    staged: false,
                                    unstaged: false,
                                    untracked: false,
                                    ignored: false,
                                })),
                                file => {
                                    const conflict = view!.files.find(candidate => candidate.path == file.path)
                                    return conflict
                                        ? (
                                            <ConflictFileRow
                                                key={file.path}
                                                view={view!}
                                                file={conflict}
                                                busy={busy}
                                                path={props.path}
                                                sides={sides}
                                                action={action}
                                                loadFile={loadFile}
                                            />
                                        )
                                        : undefined
                                },
                            )
                            : (
                                <div class="conflict-file-list" aria-label="Conflicted files">
                                    {view.files.map(file => (
                                        <ConflictFileRow
                                            key={file.path}
                                            view={view!}
                                            file={file}
                                            busy={busy}
                                            path={props.path}
                                            sides={sides}
                                            action={action}
                                            loadFile={loadFile}
                                        />
                                    ))}
                                </div>
                            )}
                        <footer class="resolution-footer">
                            <div class="resolution-progress" role="status">
                                <strong>
                                    {busy
                                        ? "Working…"
                                        : view.ready
                                        ? "Ready to accept"
                                        : remaining + (remaining == 1 ? " file left" : " files left")}
                                </strong>
                                <span>{resolved} of {view.files.length} files resolved</span>
                            </div>
                            <button
                                title="Discard resolution progress"
                                disabled={busy || !view.candidate.revision}
                                mix={on("click", () => void action({ action: "cancel" }))}
                            >
                                Discard progress
                            </button>
                            {summary?.kind == "working" && (
                                <button disabled={busy} mix={on("click", () => void action({ action: "keep-stashed" }))}>
                                    Keep stashed
                                </button>
                            )}
                            <button class="accept-resolution" disabled={busy || !view.ready} mix={on("click", () => void action({ action: "accept" }))}>
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
        sides: ConflictSides
        action(request: ResolutionAction): Promise<boolean>
        loadFile(file: string): Promise<ConflictView>
    }>,
) {
    let expanded = false, reviewVersion = ""
    let detail: ConflictView | undefined, loading = false, loadError = "", attempted = ""
    let review: ReturnType<typeof resolutionReview> | undefined
    let contents = handle.props.file.resultText, reset = 0
    return () => {
        let { view, file } = handle.props
        const { path, sides, action, busy } = handle.props
        const versionKey = JSON.stringify([view.subject.input, view.candidate.revision])
        if (detail && (detail.subject.input != view.subject.input || detail.candidate.revision != view.candidate.revision))
            detail = undefined
        if (expanded && file.loaded === false && !detail && !loading && attempted != versionKey) {
            attempted = versionKey
            loading = true
            loadError = ""
            handle.queueTask(async () => {
                try {
                    detail = await handle.props.loadFile(file.path)
                } catch (error) {
                    loadError = error instanceof Error ? error.message : String(error)
                } finally {
                    loading = false
                    void handle.update()
                }
            })
        }
        if (detail && file.loaded === false) {
            view = detail
            file = detail.files.find(item => item.path == file.path)!
        }
        const leftLabel = sides.left.label.toLowerCase(), rightLabel = sides.right.label.toLowerCase()
        if (contents != file.resultText) {
            contents = file.resultText
            reset++
        }
        const entry = view.candidate.files[file.path] ?? file.provisional
        const readable = file.resultText != null && !!entry && ["100644", "100755"].includes(entry.mode)
        const version = view.candidate.revision
        if (expanded && file.loaded !== false && file.resolved && version != reviewVersion) {
            review = resolutionReview(view, file)
            reviewVersion = version
        }
        return (
            <div class="conflict-file" data-file={file.path} data-resolved={file.resolved}>
                <InspectionItem
                    title={file.path}
                    expanded={expanded}
                    actions={busy
                        ? []
                        : [
                            { label: sides.left.action, run: () => action({ action: "choose", file: file.path, side: "left" }) },
                            { label: sides.right.action, run: () => action({ action: "choose", file: file.path, side: "right" }) },
                            { label: "Merge tool", run: () => action({ action: "tool", file: file.path }) },
                            ...(path
                                ? [{
                                    label: "Use current file",
                                    run: () => action({ action: "use-file", file: file.path, path }),
                                }]
                                : []),
                        ]}
                    choose={file.loaded === false || readable || file.resolved
                        ? () => {
                            expanded = !expanded
                            if (expanded)
                                attempted = ""
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
                                aria-label={sides.left.action}
                                title={file.left ? `Use the entire file: ${leftLabel}. ${sides.left.description}` : `Delete this file: absent in ${leftLabel}.`}
                                mix={[fileActionButton, on("click", () => void action({ action: "choose", file: file.path, side: "left" }))]}
                            >
                                {resolutionIcon("take-left")}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                aria-label={sides.right.action}
                                title={file.right
                                    ? `Use the entire file from ${rightLabel}. ${sides.right.description}`
                                    : `Delete this file: absent in ${rightLabel}.`}
                                mix={[fileActionButton, on("click", () => void action({ action: "choose", file: file.path, side: "right" }))]}
                            >
                                {resolutionIcon("take-right")}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                aria-label="Merge tool"
                                title="Resolve this file in your configured Git merge tool"
                                mix={[fileActionButton, on("click", () => void action({ action: "tool", file: file.path }))]}
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
                                            <button disabled={busy} mix={on("click", () => void action({ action: "use-file", file: file.path, path }))}>
                                                Use current file
                                            </button>
                                        )}
                                        {view.subject.suggestion && (
                                            <button
                                                disabled={busy}
                                                mix={on("click", () => void action({ action: "choose", file: file.path, side: "suggestion" }))}
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
                    {expanded && loading && <p role="status">Loading diff…</p>}
                    {expanded && loadError && <p role="alert">{loadError}</p>}
                    {expanded && readable && !file.resolved && (
                        <MergeResolution
                            key={reset}
                            name={file.path}
                            contents={file.resultText!}
                            subject={view.subject}
                            sides={sides}
                            busy={busy}
                            resolve={content => action({ action: "edit", file: file.path, content })}
                        />
                    )}
                    {expanded && file.resolved && review && (
                        <div class="file-review">
                            <div class="review-heading">Compared with: {sides.left.label}</div>
                            <ResolutionReview key={review.version} page={review} file={file} deleted={view.candidate.files[file.path] === null} />
                        </div>
                    )}
                    {expanded && file.loaded !== false && !readable && !file.resolved && (
                        <p>Use a whole-file choice or the external merge tool for this file.</p>
                    )}
                </InspectionItem>
            </div>
        )
    }
}
function resolutionIcon(kind: "check" | "conflict" | "tool" | "more" | "take-left" | "take-right") {
    const paths = {
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
    "& > div > button, & > div > details button": { ...control, margin: "2px" },
    "& > strong": { color: "var(--warning)" },
})
const resolutionStyle = css({
    minWidth: "0",
    color: "var(--text)",
    fontSize: "12px",
    "& :where(.resolution-footer, .resolution-error) > button": control,
    "& svg": { flexShrink: "0" },
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
        gap: "8px",
        flexWrap: "wrap",
        alignItems: "center",
        minHeight: "44px",
        padding: "8px 12px",
        boxSizing: "border-box",
        borderTop: "1px solid var(--line-strong)",
        background: "var(--raised)",
        "& > button": { flexShrink: "0", whiteSpace: "nowrap" },
    },
    "& .resolution-progress": {
        flex: "0 0 100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "4px 12px",
        whiteSpace: "nowrap",
        "& strong": { fontSize: "12px", fontWeight: "500" },
        "& span": { fontSize: "11px", color: "var(--muted)" },
    },
    "& .accept-resolution": {
        marginLeft: "auto",
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
