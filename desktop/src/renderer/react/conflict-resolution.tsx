import type { BranchGraphBranchNode } from "@laneway/shared"
import { UnresolvedFile } from "@pierre/diffs"
import { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import { Button as AriaButton } from "react-aria-components"
import { type Conflicts, type ConflictSides, conflictSides, type ConflictView, type ConflictViewFile, type ResolutionAction, resolutionReview, subjectKey } from "./conflicts"
import { IconButton, MoreMenu } from "./controls"
import { useRowMenu } from "./dense-row"
import { DiffLines } from "./diff-lines"
import { highlighter } from "./diff-renderer"
import { FileLabel } from "./file-tree"
import { CheckIcon, MergeToolIcon, TakeLeftIcon, TakeRightIcon, WarningIcon } from "./icons"
import { errorMessage } from "./notice"
import { Button } from "./ui/Button"
import { ChevronRight } from "./ui/icons"
import { MenuItem } from "./ui/Menu"
import { useSnapshot } from "./use-snapshot"

interface ResolutionProps {
    conflicts: Conflicts
    repositoryId: string
    /** The conflict's ID. */
    subject: string
    /** The worktree whose current files a resolution can take. */
    path?: string
    /**
     * The other files of the conflicted commit, leaving out `conflicted` ones; without it, every file of the commit,
     * for choosing changes outside the conflicted lines.
     */
    files?(conflicted?: string[]): ReactNode
}

/**
 * A conflict resolved in place: each conflicted file taken whole from either side, merged hunk by hunk, or handed
 * to the configured merge tool, then the whole resolution accepted. Progress is kept until it is discarded.
 */
export function ConflictResolution({ conflicts, repositoryId, subject, path, files }: ResolutionProps) {
    let state = useSnapshot(conflicts).subjects[subjectKey(repositoryId, subject)]
    let [selecting, setSelecting] = useState(false)
    useEffect(() => void conflicts.inspect(repositoryId, subject), [conflicts, repositoryId, subject])
    let view = state?.view
    let busy = state?.busy ?? true
    let sides = conflictSides(view, state?.summary)
    let resolved = view?.files.filter(file => file.resolved).length ?? 0
    let remaining = (view?.files.length ?? 0) - resolved
    let act = (action: ResolutionAction) => conflicts.act(repositoryId, subject, action)
    return (
        <article className="conflict-resolution" aria-label="Conflict resolution" aria-busy={busy}>
            {!view && !state?.error && <p className="column-placeholder" role="status">Loading conflict…</p>}
            {state?.error && (
                <div className="resolution-error" role="alert">
                    <span>{state.error}</span>
                    <Button variant="quiet" isDisabled={busy} onPress={() => void conflicts.inspect(repositoryId, subject)}>Reload</Button>
                </div>
            )}
            {view && (
                <>
                    {files && (
                        <Button variant="quiet" className="resolution-mode" onPress={() => setSelecting(!selecting)}>
                            {selecting ? "Back to conflict resolution" : "Select changes outside conflicted lines"}
                        </Button>
                    )}
                    {selecting
                        ? files?.()
                        : (
                            <>
                                <div className="conflict-files" aria-label="Conflicted files">
                                    {view.files.map(file => (
                                        <ConflictFileRow
                                            key={file.path}
                                            conflicts={conflicts}
                                            repositoryId={repositoryId}
                                            subject={subject}
                                            view={view}
                                            file={file}
                                            busy={busy}
                                            path={path}
                                            sides={sides}
                                            act={act}
                                        />
                                    ))}
                                </div>
                                {files?.(view.files.map(file => file.path))}
                            </>
                        )}
                    <footer className="resolution-footer">
                        <div className="resolution-progress" role="status">
                            <strong>{busy ? "Working…" : view.ready ? "Ready to accept" : `${remaining} ${remaining == 1 ? "file" : "files"} left`}</strong>
                            <span>{resolved} of {view.files.length} files resolved</span>
                        </div>
                        <Button variant="secondary" isDisabled={busy || !view.candidate.revision} onPress={() => void act({ action: "cancel" })}>
                            Discard progress
                        </Button>
                        {state?.summary?.kind == "working" && (
                            <Button
                                variant="secondary"
                                isDisabled={busy}
                                onPress={() => void act({ action: "keep-stashed" })}
                            >
                                Keep stashed
                            </Button>
                        )}
                        <Button variant="accent" className="accept-resolution" isDisabled={busy || !view.ready} onPress={() => void act({ action: "accept" })}>
                            <CheckIcon />
                            Accept resolution
                        </Button>
                    </footer>
                </>
            )}
        </article>
    )
}

interface FileRowProps {
    conflicts: Conflicts
    repositoryId: string
    subject: string
    view: ConflictView
    file: ConflictViewFile
    busy: boolean
    path?: string
    sides: ConflictSides
    act(action: ResolutionAction): Promise<boolean>
}

/** A conflicted file: whole-file choices on its row, and once opened, its merge or its resolved review. */
function ConflictFileRow({ conflicts, repositoryId, subject, view, file, busy, path, sides, act }: FileRowProps) {
    let [expanded, setExpanded] = useState(false)
    // Files whose contents weren't read with the conflict load as they open, once per revision of the resolution.
    let version = JSON.stringify([view.subject.input, view.candidate.revision])
    let [loaded, setLoaded] = useState<{ version: string; view?: ConflictView; error?: string }>()
    let loading = expanded && file.loaded === false && loaded?.version != version
    useEffect(() => {
        if (!loading)
            return
        let live = true
        conflicts.loadFile(repositoryId, subject, file.path).then(
            detail => live && setLoaded({ version, view: detail }),
            error => live && setLoaded({ version, error: errorMessage(error) }),
        )
        return () => {
            live = false
        }
    }, [loading, conflicts, repositoryId, subject, file.path, version])
    let current = loaded?.version == version && loaded.view && file.loaded === false ? loaded.view : view
    let shown = current.files.find(candidate => candidate.path == file.path) ?? file
    let entry = current.candidate.files[shown.path] ?? shown.provisional
    let readable = shown.resultText != null && !!entry && ["100644", "100755"].includes(entry.mode)
    let review = useMemo(() => expanded && shown.loaded !== false && shown.resolved ? resolutionReview(current, shown) : undefined, [expanded, current, shown])
    let expandable = file.loaded === false || readable || file.resolved
    let choices = () => (
        <>
            <MenuItem onAction={() => void act({ action: "choose", file: file.path, side: "left" })}>{sides.left.action}</MenuItem>
            <MenuItem onAction={() => void act({ action: "choose", file: file.path, side: "right" })}>{sides.right.action}</MenuItem>
            <MenuItem onAction={() => void act({ action: "tool", file: file.path })}>Merge tool</MenuItem>
            {path && <MenuItem onAction={() => void act({ action: "use-file", file: file.path, path })}>Use current file</MenuItem>}
            {view.subject.suggestion && (
                <MenuItem onAction={() => void act({ action: "choose", file: file.path, side: "suggestion" })}>Use previous result</MenuItem>
            )}
        </>
    )
    let { row, openMenu } = useRowMenu<HTMLDivElement>(busy ? undefined : { label: `Actions for ${file.path}`, items: choices })
    return (
        <div className="conflict-file" data-file={file.path} data-resolved={file.resolved}>
            <div ref={row} className="conflict-file-row" onContextMenu={openMenu}>
                <AriaButton
                    className="conflict-file-toggle"
                    aria-label={file.path}
                    aria-expanded={expandable ? expanded : undefined}
                    isDisabled={!expandable}
                    onPress={() => setExpanded(!expanded)}
                >
                    <ChevronRight className="toggle-chevron" />
                    <span className={file.resolved ? "resolved-mark" : "pending-mark"} role="img" aria-label={file.resolved ? "Resolved" : "Unresolved"}>
                        {file.resolved ? <CheckIcon /> : <WarningIcon />}
                    </span>
                    <FileLabel
                        file={{
                            path: file.path,
                            status: "modified",
                            staged: false,
                            unstaged: false,
                            untracked: false,
                            ignored: false,
                            conflicted: !file.resolved,
                        }}
                        showFolder
                    />
                </AriaButton>
                <span className="conflict-file-actions">
                    <IconButton label={sides.left.action} small isDisabled={busy} onPress={() => void act({ action: "choose", file: file.path, side: "left" })}>
                        <TakeLeftIcon />
                    </IconButton>
                    <IconButton
                        label={sides.right.action}
                        small
                        isDisabled={busy}
                        onPress={() => void act({ action: "choose", file: file.path, side: "right" })}
                    >
                        <TakeRightIcon />
                    </IconButton>
                    <IconButton label="Merge tool" small isDisabled={busy} onPress={() => void act({ action: "tool", file: file.path })}>
                        <MergeToolIcon />
                    </IconButton>
                    {(path || view.subject.suggestion) && (
                        <MoreMenu label={`More actions for ${file.path}`}>
                            {path && <MenuItem onAction={() => void act({ action: "use-file", file: file.path, path })}>Use current file</MenuItem>}
                            {view.subject.suggestion && (
                                <MenuItem onAction={() => void act({ action: "choose", file: file.path, side: "suggestion" })}>Use previous result</MenuItem>
                            )}
                        </MoreMenu>
                    )}
                </span>
            </div>
            {expanded && (
                <div className="conflict-file-content">
                    {loading && <p className="column-placeholder" role="status">Loading diff…</p>}
                    {loaded?.version == version && loaded.error && <p className="column-placeholder" role="alert">{loaded.error}</p>}
                    {!loading && readable && !shown.resolved && (
                        <MergeResolution
                            name={shown.path}
                            contents={shown.resultText!}
                            sides={sides}
                            busy={busy}
                            onResolve={content => act({ action: "edit", file: shown.path, content })}
                        />
                    )}
                    {!loading && shown.resolved && review && (
                        <div className="resolution-review" aria-label="Resolution review">
                            <div className="review-heading">Compared with: {sides.left.label}</div>
                            {review.lines.length
                                ? <DiffLines page={review} layout="unified" wrap={false} showWhitespace={false} selected={[]} select={() => {}} />
                                : (
                                    <p className="column-placeholder">
                                        {current.candidate.files[shown.path] === null
                                            ? "This file will be deleted."
                                            : shown.resultText === null
                                            ? "Binary or structural file selected."
                                            : "No changes from the current version."}
                                    </p>
                                )}
                        </div>
                    )}
                    {!loading && shown.loaded !== false && !readable && !shown.resolved && (
                        <p className="column-placeholder">Use a whole-file choice or the external merge tool for this file.</p>
                    )}
                </div>
            )}
        </div>
    )
}

/**
 * Merging a file's conflicted hunks with Pierre's conflict view: each hunk keeps either side or both. The choice
 * is saved before the view moves on, and a new result draws afresh.
 */
function MergeResolution({ name, contents, sides, busy, onResolve }: {
    name: string
    contents: string
    sides: ConflictSides
    busy: boolean
    onResolve(contents: string): Promise<boolean>
}) {
    let host = useRef<HTMLDivElement>(null)
    let scrollbar = useRef<HTMLDivElement>(null)
    let pending = useRef(false)
    let [saving, setSaving] = useState(false)
    let [error, setError] = useState("")
    let latest = useEffectEvent(() => ({ busy, sides, onResolve }))
    useEffect(() => {
        let node = host.current
        let bar = scrollbar.current
        if (!node || !bar)
            return
        let lifetime = new AbortController()
        let shadow = node.shadowRoot ?? node.attachShadow({ mode: "open" })
        let container = document.createElement("div")
        shadow.replaceChildren(container)
        // Pierre's own scrollbar sits under the file's last line, often out of view; one pinned under the view drives
        // its lines, as the diff column's does.
        let pierre: ShadowRoot | undefined
        let track = bar.firstElementChild as HTMLElement
        let lines = () => pierre?.querySelector<HTMLElement>("[data-code]")
        bar.hidden = true
        bar.addEventListener("scroll", () => {
            let pane = lines()
            if (pane)
                pane.scrollLeft = bar.scrollLeft
        }, { passive: true, signal: lifetime.signal })
        let follow = (event: Event) => {
            if (event.target instanceof HTMLElement && event.target.hasAttribute("data-code"))
                bar.scrollLeft = event.target.scrollLeft
        }
        // Measured on the next frame: showing the scrollbar inside the browser's ResizeObserver loop resizes the
        // column around it, which the browser reports as undelivered notifications.
        let frame = 0
        let measure = () => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                let pane = lines()
                let range = pane ? pane.scrollWidth - pane.clientWidth : 0
                bar.hidden = range <= 0
                track.style.width = `${bar.clientWidth + range}px`
                bar.scrollLeft = pane?.scrollLeft ?? 0
            })
        }
        let resize = new ResizeObserver(measure)
        resize.observe(node)
        let sheet = new CSSStyleSheet()
        // Pierre's scrollbar gives way to the pinned one, and side headings stay in view as the lines scroll, keeping
        // their buttons within reach.
        sheet.replaceSync(`
            :host { --diffs-font-family: var(--font-family-mono); --diffs-font-size: 12px; --diffs-line-height: 24px;
                --diffs-scrollbar-gutter-override: 0px; }
            [data-code] { scrollbar-width: none; }
            [data-merge-conflict-marker-row] {
                position: sticky;
                left: var(--diffs-column-number-width, 0);
                box-sizing: border-box;
                width: var(--diffs-column-content-width, auto);
                display: flex;
                align-items: center;
                gap: 12px;
                font-family: var(--diffs-header-font-fallback);
                font-size: 11px;
                font-weight: 600;
                color: var(--text-color-placeholder);
                background: var(--tray-background);
                box-shadow: inset 0 1px var(--border-color), inset 0 -1px var(--border-color);
                user-select: none;
            }
            [data-merge-conflict-marker-row]::after { content: none !important; }
            [data-merge-conflict-marker-row] button { margin-left: auto; margin-right: 8px; }
            [data-merge-conflict-marker-row] button::after { content: none !important; }
            [data-merge-conflict-action-separator] { display: none !important; }
        `)
        let dark = matchMedia("(prefers-color-scheme: dark)")
        let viewer = new UnresolvedFile({
            theme: { light: "github-light", dark: "github-dark" },
            themeType: dark.matches ? "dark" : "light",
            preferredHighlighter: highlighter,
            disableFileHeader: true,
            disableErrorHandling: true,
            expandUnchanged: true,
            onPostRender: (element, _instance, phase) => {
                let root = element.shadowRoot
                if (phase == "unmount" || !root)
                    return
                if (!root.adoptedStyleSheets.includes(sheet))
                    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
                if (pierre != root) {
                    pierre = root
                    // Scrolling the lines themselves, as a touchpad does, moves the scrollbar with them.
                    root.addEventListener("scroll", follow, { capture: true, passive: true, signal: lifetime.signal })
                }
                placeSideControls(root, latest().sides)
                measure()
            },
            onMergeConflictAction: (choice, instance) => {
                let { busy: working, onResolve: resolve } = latest()
                if (pending.current || working)
                    return
                let result = instance.resolveConflict(choice.conflict.conflictIndex, choice.resolution)
                if (!result)
                    return
                pending.current = true
                setSaving(true)
                // The current view stays until the choice is saved.
                void resolve(result.file.contents).finally(() => {
                    pending.current = false
                    setSaving(false)
                })
            },
        })
        try {
            viewer.render({ file: { name, contents }, containerWrapper: container })
        } catch (reason) {
            queueMicrotask(() => setError(errorMessage(reason)))
        }
        let appearance = () => {
            viewer.setOptions({ ...viewer.options, themeType: dark.matches ? "dark" : "light" })
            viewer.rerender()
        }
        dark.addEventListener("change", appearance, { signal: lifetime.signal })
        return () => {
            lifetime.abort()
            resize.disconnect()
            cancelAnimationFrame(frame)
            viewer.cleanUp()
        }
    }, [name, contents])
    return (
        <section className="merge-resolution" aria-label={`Merge resolution for ${name}`} aria-busy={saving || busy}>
            <div className="merge-sides">
                <div>
                    <strong>{sides.left.label}</strong>
                    <span>{sides.left.description}</span>
                </div>
                <div>
                    <strong>{sides.right.label}</strong>
                    <span>{sides.right.description}</span>
                </div>
            </div>
            {error && <p className="column-placeholder" role="alert">{error}</p>}
            <div ref={host} className="pierre-merge" inert={saving || busy} />
            {/* Sticks to the bottom of the scrolling column while any of the merge is in view. */}
            <div ref={scrollbar} className="diff-scrollbar" aria-hidden="true">
                <div className="diff-scrollbar-track" />
            </div>
        </section>
    )
}

// Pierre's own buttons move into each side's heading, keeping their conflict indices and delegated actions; the
// markers saved in partly resolved files never change.
function placeSideControls(shadow: ShadowRoot, sides: ConflictSides) {
    let next: string | undefined
    let open: string[] = []
    for (let row of shadow.querySelectorAll<HTMLElement>("[data-merge-conflict-actions], [data-merge-conflict-marker-row]")) {
        if (row.hasAttribute("data-merge-conflict-actions")) {
            let both = row.querySelector<HTMLButtonElement>('[data-merge-conflict-action="both"]')
            next = both?.dataset.mergeConflictConflictIndex
            if (both)
                both.textContent = "Keep both"
            continue
        }
        let kind = row.dataset.mergeConflict
        if (kind == "marker-start" && next != undefined) {
            open.push(next)
            next = undefined
        }
        let index = open.at(-1)
        if (kind == "marker-end")
            open.pop()
        if (index == undefined || (kind != "marker-start" && kind != "marker-end"))
            continue
        let side = kind == "marker-start" ? sides.left : sides.right
        let action = kind == "marker-start" ? "current" : "incoming"
        let button = shadow.querySelector<HTMLButtonElement>(`[data-merge-conflict-action="${action}"][data-merge-conflict-conflict-index="${index}"]`)
        if (!button)
            continue
        let label = document.createElement("span")
        label.textContent = side.label
        label.title = side.description
        button.textContent = "Keep this"
        button.setAttribute("aria-label", `Keep ${side.label.toLowerCase()}`)
        row.replaceChildren(label, button)
    }
}

/**
 * A branch's conflicts outside its commits: Working Changes a stash couldn't restore, and an unresolved stack that
 * needs recovering, restored or discarded.
 */
export function ConflictControls({ conflicts, repositoryId, branch, path }: {
    conflicts: Conflicts
    repositoryId: string
    branch: BranchGraphBranchNode
    path?: string
}) {
    let snapshot = useSnapshot(conflicts)
    let list = snapshot.lists[repositoryId]
    let unresolved = JSON.stringify(branch.unresolved)
    useEffect(() => void conflicts.list(repositoryId), [conflicts, repositoryId, unresolved])
    let ids = branch.unresolved?.subjects ?? []
    let working = list?.result?.conflicts.filter(conflict => ids.includes(conflict.id) && conflict.kind == "working") ?? []
    let recovery = list?.result?.recovery.find(item => item.stack == branch.unresolved?.stackId || item.branch == branch.name || !item.branch)
    let [selected, setSelected] = useState<string>()
    // A conflict asked to open, as after a transfer chose to resolve now, opens here once.
    let [seen, setSeen] = useState(snapshot.requested?.serial)
    let requested = snapshot.requested
    if (requested && requested.serial != seen && requested.repositoryId == repositoryId && ids.includes(requested.subject)) {
        setSeen(requested.serial)
        setSelected(requested.subject)
    }
    let busy = list?.busy ?? false
    if (!working.length && !recovery && !branch.unresolved?.recovery && !list?.error)
        return null
    return (
        <section className="conflict-controls" aria-label="Unresolved conflicts">
            <strong className="conflict-controls-title">{branch.unresolved?.recovery ? "Recovery required" : "Unresolved"}</strong>
            {branch.unresolved?.recovery && !recovery && <p>{branch.unresolved.recovery}</p>}
            {working.map(conflict => (
                <div key={conflict.id} className="working-conflict">
                    <Button
                        variant="secondary"
                        isDisabled={busy}
                        aria-expanded={selected == conflict.id}
                        onPress={() => setSelected(selected == conflict.id ? undefined : conflict.id)}
                    >
                        {conflict.title} {conflict.commit ? `(${conflict.commit.slice(0, 8)})` : ""}
                    </Button>
                    {selected == conflict.id && !conflict.suspended && (
                        <ConflictResolution conflicts={conflicts} repositoryId={repositoryId} subject={conflict.id} path={path} />
                    )}
                    {conflict.suspended && path && (
                        <Button
                            variant="secondary"
                            isDisabled={busy}
                            onPress={() => void conflicts.run(repositoryId, { action: "resume-working", subject: conflict.id, path })}
                        >
                            Resume Working Changes
                        </Button>
                    )}
                </div>
            ))}
            {recovery && (
                <div className="conflict-recovery">
                    <p>{recovery.message}</p>
                    {recovery.stack != "untracked" && (
                        <>
                            <div className="conflict-recovery-actions">
                                <Button
                                    variant="secondary"
                                    isDisabled={busy}
                                    onPress={() => void conflicts.run(repositoryId, { action: "restore", stack: recovery.stack, path })}
                                >
                                    Restore unresolved stack
                                </Button>
                                {recovery.candidates.map(adopt => (
                                    <Button
                                        key={adopt}
                                        variant="secondary"
                                        isDisabled={busy}
                                        onPress={() => void conflicts.run(repositoryId, { action: "restore", stack: recovery.stack, adopt })}
                                    >
                                        Use {adopt}
                                    </Button>
                                ))}
                            </div>
                            <details className="conflict-discard">
                                <summary>Discard recovery</summary>
                                <p>The intended branches stay at their current tips. Private Operation History retains the earlier update.</p>
                                <Button
                                    variant="secondary"
                                    isDisabled={busy}
                                    onPress={() => void conflicts.run(repositoryId, { action: "discard", stack: recovery.stack })}
                                >
                                    Discard unresolved update
                                </Button>
                            </details>
                        </>
                    )}
                </div>
            )}
            {list?.error && <p className="column-placeholder" role="alert">{list.error}</p>}
        </section>
    )
}
