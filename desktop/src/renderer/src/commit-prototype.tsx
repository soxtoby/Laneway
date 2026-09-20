// THROWAWAY: compare compact inline, expandable, and real-index staging on the existing route.
// All mutations are simulated. Nothing in this module calls the Laneway IPC API.
import { addEventListeners, css, type Handle, on } from "remix/ui"

type Variant = "A" | "B" | "C"
type FileState = { path: string; head: string; work: string; staged?: string; selected: boolean }
type Stash = { label: string; branch: string; files: FileState[] }
const variants: Variant[] = ["A", "B", "C"]
const names = { A: "File selection", B: "File selection · expanded", C: "Staging divider" }
const sample = (): FileState[] => [{ path: "src/branch-list.tsx", head: "showBranches(all)", work: "showBranches(involved)", selected: true }, {
    path: "src/branch-list.css",
    head: "gap: 12px;",
    work: "gap: 6px;",
    selected: true,
}, { path: "docs/navigation.md", head: "", work: "Open a branch without switching worktrees.", selected: true }]

export function CommitPrototype(handle: Handle) {
    const query = new URLSearchParams(location.search).get("variant")
    let variant: Variant = query == "B" || query == "C" ? query : "A"
    let files = sample()
    let message = ""
    let body = ""
    let expanded = variant == "B"
    let showStashes = false
    let stashForm = false
    let stashLabel = ""
    let virtual = false
    let branch = "feature/laneway"
    let scenario = "ordinary"
    let notice = ""
    let preview: { path: string; kind: "work" | "staged" } | undefined
    let hookPrompt = false
    let hookEdited = false
    let freshnessPending = false
    let applyTarget: number | undefined
    let destination = "inspection · feature/laneway"
    let stashes: Stash[] = [{ label: "Branch filtering experiment", branch: "feature/laneway", files: sample() }]
    let operations: string[] = []
    let undo: (() => void) | undefined

    const dirty = () => files.filter(file => file.work != file.head || (file.staged !== undefined && file.staged != file.head))
    const staged = () => files.filter(file => file.staged !== undefined && file.staged != file.head)
    const unstaged = () => files.filter(file => file.work != (file.staged ?? file.head))
    const included = () => variant == "C" ? staged().length ? staged() : dirty() : dirty().filter(file => file.selected)
    const update = () => void handle.update()
    const click = (action: () => void) =>
        on<HTMLButtonElement, "click">("click", () => {
            action()
            update()
        })

    function switchVariant(step: number) {
        variant = variants[(variants.indexOf(variant) + step + variants.length) % variants.length]
        expanded = variant == "B"
        const url = new URL(location.href)
        url.searchParams.set("variant", variant)
        history.replaceState(null, "", url)
        hookPrompt = false
        notice = ""
        update()
    }
    addEventListeners(window, handle.signal, {
        keydown(event) {
            const target = event.target
            if (target instanceof Element && target.closest("input, textarea, select, [contenteditable], [role=dialog]"))
                return
            if (event.key == "ArrowLeft" || event.key == "ArrowRight") {
                event.preventDefault()
                switchVariant(event.key == "ArrowLeft" ? -1 : 1)
            }
        },
    })

    function checkpoint(label: string) {
        const prior = structuredClone({ files, stashes, operations, virtual, branch, message, body })
        undo = () => {
            ;({ files, stashes, operations, virtual, branch, message, body } = prior)
            notice = `Undid ${label.toLowerCase()}.`
            undo = undefined
        }
        operations.push(label)
    }
    function loadScenario(value: string) {
        scenario = value
        files = sample()
        message = ""
        body = ""
        notice = ""
        hookPrompt = false
        freshnessPending = false
        hookEdited = false
        preview = undefined
        undo = undefined
        operations = []
        applyTarget = undefined
        virtual = value == "virtual" || value == "initial"
        branch = value == "initial" ? "main" : virtual ? "worktree/inspection" : "feature/laneway"
        if (value == "staged" || value == "edited")
            files[0].staged = files[0].work
        if (value == "edited")
            files[0].work = "showBranches(involved, { includePrimary: true })"
        if (value == "clean")
            files = []
        if (value == "initial")
            files.forEach(file => file.head = "")
    }
    function commit(continueHook = false) {
        if (!message.trim() || !included().length || !branch.trim())
            return
        if (freshnessPending) {
            freshnessPending = false
            notice = "Working Changes changed. Review the refreshed files, then commit again."
            return
        }
        if (virtual) {
            checkpoint(`Create branch ${branch}`)
            virtual = false
        }
        if (scenario == "failed-hook") {
            notice = "Commit blocked: pre-commit hook failed. Your changes and draft remain."
            return
        }
        if (scenario == "hook" && !continueHook) {
            if (!hookEdited) {
                for (const file of included()) {
                    file.work += " // hook formatted"
                    if (variant == "C" && staged().includes(file))
                        file.staged = file.work
                }
                hookEdited = true
            }
            hookPrompt = true
            return
        }
        checkpoint(`Commit: ${message.trim()}`)
        const targets = included()
        const useIndex = variant == "C" && staged().length > 0
        for (const file of targets) {
            file.head = useIndex ? file.staged! : file.work
            file.staged = undefined
        }
        files = dirty()
        notice = `Committed ${targets.length} file${targets.length == 1 ? "" : "s"} to ${branch}.`
        message = ""
        body = ""
        hookPrompt = false
        expanded = false
        preview = undefined
    }
    function stashAll() {
        checkpoint("Stash Working Changes")
        stashes.unshift({ label: stashLabel.trim() || "Working Changes", branch, files: structuredClone(files) })
        files = []
        stashForm = false
        stashLabel = ""
        showStashes = true
        notice = "Working Changes stashed."
    }
    function applyStash() {
        if (applyTarget === undefined)
            return
        if (destination.startsWith("inspection") && dirty().length) {
            notice = "Stash application requires a clean worktree. Commit or stash Working Changes first."
            return
        }
        checkpoint("Apply stash")
        const stash = stashes.splice(applyTarget, 1)[0]
        if (destination.startsWith("inspection"))
            files = structuredClone(stash.files)
        notice = `Applied “${stash.label}” to ${destination}. Stash removed; Undo restores it.`
        applyTarget = undefined
    }

    function fileRows(list: FileState[], kind: "selection" | "unstaged" | "staged") {
        return (
            <div class="cp-files">
                {list.length
                    ? list.map(file => (
                        <div key={`${kind}:${file.path}`}>
                            <div class="cp-file">
                                {kind == "selection" && (
                                    <input
                                        type="checkbox"
                                        aria-label={`Include ${file.path}`}
                                        checked={file.selected}
                                        mix={on("change", event => {
                                            file.selected = event.currentTarget.checked
                                            update()
                                        })}
                                    />
                                )}
                                <span class="cp-status">{file.head ? "M" : "A"}</span>
                                <button
                                    class="cp-path"
                                    mix={click(() =>
                                        preview = preview?.path == file.path && preview.kind == (kind == "staged" ? "staged" : "work")
                                            ? undefined
                                            : { path: file.path, kind: kind == "staged" ? "staged" : "work" }
                                    )}
                                >
                                    {file.path}
                                </button>
                                {expanded && kind != "selection" && (
                                    <button
                                        class="cp-small"
                                        aria-label={`${kind == "staged" ? "Unstage" : "Stage"} ${file.path}`}
                                        mix={click(() => file.staged = kind == "staged" ? undefined : file.work)}
                                    >
                                        {kind == "staged" ? "−" : "+"}
                                    </button>
                                )}
                            </div>
                            {preview?.path == file.path && preview.kind == (kind == "staged" ? "staged" : "work") && (
                                <div class="cp-diff">
                                    <pre class="cp-deletion">− {(kind == "unstaged" ? file.staged ?? file.head : file.head) || "(new file)"}</pre>
                                    <pre class="cp-addition">+ {kind == "staged" ? file.staged : file.work}</pre>
                                </div>
                            )}
                        </div>
                    ))
                    : <p class="cp-empty">{kind == "staged" ? "Nothing staged — commit will include all changes." : "No changes"}</p>}
            </div>
        )
    }
    function messageFields() {
        return (
            <div class="cp-message">
                <input
                    aria-label="Commit title"
                    placeholder="Commit title (required)"
                    value={message}
                    mix={on("input", event => {
                        message = event.currentTarget.value
                        update()
                    })}
                />
                <textarea
                    aria-label="Commit message"
                    placeholder="Message (optional)"
                    rows={3}
                    value={body}
                    mix={on("input", event => {
                        body = event.currentTarget.value
                        update()
                    })}
                />
            </div>
        )
    }
    function actions() {
        const count = included().length
        const title = variant == "C"
            ? staged().length ? `Commit staged (${count})` : `Commit all changes (${count})`
            : `Commit ${count} file${count == 1 ? "" : "s"}`
        return (
            <div class="cp-actions">
                <button class="cp-primary" disabled={!message.trim() || !count || !branch.trim()} mix={click(() => commit())}>{title}</button>
                <button
                    mix={click(() => {
                        expanded = false
                        hookPrompt = false
                    })}
                >
                    Cancel
                </button>
            </div>
        )
    }

    return () => {
        return (
            <section class="commit-prototype" mix={styles} aria-label="Commit prototype">
                <header class="cp-heading">
                    <h3>Working Changes</h3>
                    <span>{dirty().length} files</span>
                    <button class="cp-text" mix={click(() => showStashes = !showStashes)}>Stashes ({stashes.length})</button>
                </header>
                {virtual && (
                    <label class="cp-branch">
                        {scenario == "initial" ? "Initial branch" : "Create branch before commit"}
                        <input
                            aria-label="New branch name"
                            value={branch}
                            mix={on("input", event => {
                                branch = event.currentTarget.value
                                update()
                            })}
                        />
                        <small>Worktree: inspection</small>
                    </label>
                )}
                {variant != "C" && (
                    <div class="cp-inline">
                        {fileRows(dirty(), "selection")}
                    </div>
                )}
                {variant == "C" && (
                    <div class="cp-staging">
                        {fileRows(unstaged(), "unstaged")}
                        {(staged().length > 0 || expanded) && (
                            <>
                                <div class="cp-divider" role="separator" aria-label="Staged changes">
                                    <span>Staged · {staged().length}</span>
                                </div>
                                {fileRows(staged(), "staged")}
                            </>
                        )}
                        {expanded && (
                            <div class="cp-actions cp-stage-actions">
                                <button class="cp-text" disabled={!unstaged().length} mix={click(() => unstaged().forEach(file => file.staged = file.work))}>
                                    Stage all +
                                </button>
                                {(staged().length > 0 || expanded) && (
                                    <button
                                        class="cp-text"
                                        disabled={!staged().length}
                                        mix={click(() => files.forEach(file => file.staged = undefined))}
                                    >
                                        Unstage all −
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
                {expanded
                    ? (
                        <div class="cp-inline-composer">
                            {messageFields()}
                            {actions()}
                        </div>
                    )
                    : (
                        <div class="cp-actions">
                            <button disabled={!included().length} mix={click(() => expanded = true)}>Create commit</button>
                            <button disabled={!dirty().length} mix={click(() => stashForm = !stashForm)}>Stash…</button>
                        </div>
                    )}
                {stashForm && (
                    <div class="cp-stash-form">
                        <label>
                            Stash all {dirty().length} changed files
                            <input
                                aria-label="Stash label"
                                placeholder="Label (optional)"
                                value={stashLabel}
                                mix={on("input", event => {
                                    stashLabel = event.currentTarget.value
                                })}
                            />
                        </label>
                        <div class="cp-actions">
                            <button class="cp-primary" mix={click(stashAll)}>Create stash</button>
                            <button mix={click(() => stashForm = false)}>Cancel</button>
                        </div>
                    </div>
                )}
                {showStashes && (
                    <section class="cp-stash-list" aria-label="Stashes">
                        <header class="cp-subheading">Repository stashes</header>
                        {stashes.map((stash, index) => (
                            <div class="cp-stash" key={index}>
                                <div>
                                    <strong>{stash.label}</strong>
                                    <small>{stash.branch || "Unassigned"} · {stash.files.length} files</small>
                                </div>
                                <button mix={click(() => applyTarget = index)}>Apply…</button>
                                <button
                                    mix={click(() => {
                                        checkpoint("Drop stash")
                                        stashes.splice(index, 1)
                                        notice = "Stash dropped. Undo restores it."
                                    })}
                                >
                                    Drop
                                </button>
                            </div>
                        ))}
                        {!stashes.length && <p class="cp-empty">No stashes</p>}
                    </section>
                )}
                {applyTarget !== undefined && (
                    <div class="cp-prompt" role="dialog" aria-label="Apply stash">
                        <strong>Apply “{stashes[applyTarget]?.label}”</strong>
                        <label>
                            Destination worktree
                            <select
                                aria-label="Destination worktree"
                                value={destination}
                                mix={on("change", event => {
                                    destination = event.currentTarget.value
                                    update()
                                })}
                            >
                                <option>inspection · feature/laneway</option>
                                <option>review · main</option>
                            </select>
                        </label>
                        <div class="cp-actions">
                            <button class="cp-primary" mix={click(applyStash)}>Apply stash</button>
                            <button mix={click(() => applyTarget = undefined)}>Cancel</button>
                        </div>
                    </div>
                )}
                {hookPrompt && (
                    <div class="cp-prompt" role="dialog" aria-label="Hook changed files">
                        <strong>Hook changed files</strong>
                        <ul>{included().map(file => <li>{file.path}</li>)}</ul>
                        <p>Continue with these changes, or cancel to review.</p>
                        <div class="cp-actions">
                            <button
                                mix={click(() => {
                                    hookPrompt = false
                                    notice = "Commit cancelled. Hook edits and your draft remain."
                                })}
                            >
                                Cancel
                            </button>
                            <button class="cp-primary" mix={click(() => commit(true))}>Continue commit</button>
                        </div>
                    </div>
                )}
                {notice && <div class="cp-notice" role="status">{notice}{undo && <button class="cp-text" mix={click(() => undo?.())}>Undo</button>}</div>}
                {process.env.NODE_ENV != "production" && (
                    <aside class="cp-lab" aria-label="Prototype controls">
                        <div class="cp-switcher">
                            <button aria-label="Previous variant" mix={click(() => switchVariant(-1))}>←</button>
                            <strong>{variant} — {names[variant]}</strong>
                            <button aria-label="Next variant" mix={click(() => switchVariant(1))}>→</button>
                            <span>THROWAWAY · SIMULATED GIT</span>
                        </div>
                        <div class="cp-scenarios">
                            <label>
                                Scenario{" "}
                                <select
                                    aria-label="Scenario"
                                    value={scenario}
                                    mix={on("change", event => {
                                        loadScenario(event.currentTarget.value)
                                        update()
                                    })}
                                >
                                    <option value="ordinary">Nothing staged</option>
                                    <option value="staged">Existing staged file</option>
                                    <option value="edited">Edited after staging</option>
                                    <option value="virtual">Virtual Branch</option>
                                    <option value="initial">First commit</option>
                                    <option value="hook">Hook changes files</option>
                                    <option value="failed-hook">Hook fails</option>
                                    <option value="clean">Clean worktree</option>
                                </select>
                            </label>
                            <button
                                mix={click(() => {
                                    loadScenario(scenario)
                                })}
                            >
                                Reset
                            </button>
                            <button
                                disabled={!files.length}
                                mix={click(() => {
                                    files[0].work += " // edited"
                                    files.push({ path: "new-note.txt", head: "", work: "New editor content", selected: false })
                                    freshnessPending = variant != "C" || !staged().length
                                    notice = "Simulated external edit and new file."
                                })}
                            >
                                External edit
                            </button>
                            <button
                                mix={click(() => {
                                    expanded = false
                                    preview = undefined
                                    notice = "Simulated restart: message draft retained."
                                })}
                            >
                                Restart composer
                            </button>
                        </div>
                        <details>
                            <summary>Prototype state · {included().length} included · {staged().length} staged · {operations.length} operations</summary>
                            <pre>{JSON.stringify({ variant, branch, virtual, message, body, files, stashes: stashes.map(stash => stash.label), operations }, null, 2)}</pre>
                        </details>
                    </aside>
                )}
            </section>
        )
    }
}

const styles = css({
    fontSize: "12px",
    padding: "10px 12px 14px",
    borderBottom: "1px solid var(--line)",
    "& h3, & p": { margin: 0 },
    "& button": {
        cursor: "pointer",
        border: "1px solid var(--line-strong)",
        borderRadius: "4px",
        padding: "5px 9px",
        background: "var(--control)",
        color: "var(--text)",
        font: "inherit",
    },
    "& button:hover": { background: "var(--control-hover)" },
    "& button:disabled": { opacity: 0.45, cursor: "default" },
    "& button:focus-visible, & input:focus-visible, & textarea:focus-visible, & select:focus-visible": {
        outline: "2px solid var(--accent)",
        outlineOffset: "2px",
    },
    "& input:not([type=checkbox]), & textarea, & select": {
        minWidth: 0,
        width: "100%",
        border: "1px solid var(--line-strong)",
        borderRadius: "4px",
        padding: "7px 8px",
        background: "var(--field)",
        color: "var(--text)",
        font: "inherit",
    },
    "& input[type=checkbox]": { accentColor: "var(--accent)", width: "14px", height: "14px", margin: "0 3px 0 0" },
    "& textarea": { resize: "vertical" },
    "& .cp-heading": { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" },
    "& .cp-heading h3": { fontSize: "13px", fontWeight: 650 },
    "& .cp-heading > span, & small, & .cp-empty, & .cp-summary": { color: "var(--muted)" },
    "& .cp-heading > button": { marginLeft: "auto" },
    "& .cp-text": { border: 0, background: "transparent", padding: "3px 0", color: "var(--muted)" },
    "& .cp-files": { marginBottom: "8px" },
    "& .cp-divider": { display: "flex", alignItems: "center", gap: "8px", margin: "10px 0 6px", color: "var(--muted)", fontSize: "11px" },
    "& .cp-divider::before, & .cp-divider::after": { content: "''", height: "1px", flex: 1, background: "var(--line)" },
    "& .cp-stage-actions": { justifyContent: "flex-end", gap: "12px" },
    "& .cp-file": { display: "flex", alignItems: "center", gap: "6px", minHeight: "29px" },
    "& .cp-status": { color: "var(--accent)", font: "11px var(--mono)", width: "12px" },
    "& .cp-path": {
        border: 0,
        background: "transparent",
        flex: 1,
        minWidth: 0,
        textAlign: "left",
        padding: "5px 0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    "& .cp-small": { padding: "1px 7px", fontSize: "16px" },
    "& .cp-message": { display: "grid", gap: "6px", marginTop: "10px" },
    "& .cp-message .cp-text": { justifySelf: "start" },
    "& .cp-actions": { display: "flex", alignItems: "center", gap: "7px", marginTop: "8px" },
    "& .cp-primary": { background: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-ink)", fontWeight: 600 },
    "& .cp-primary:hover": { background: "var(--accent-hover)" },
    "& .cp-subheading": { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: 600, margin: "10px 0 4px" },
    "& .cp-subheading button": { marginLeft: "auto", fontWeight: 400 },
    "& .cp-expand": { width: "100%", display: "flex", justifyContent: "space-between", textAlign: "left", marginTop: "10px", padding: "10px" },
    "& .cp-composer": { padding: "10px", border: "1px solid var(--accent-edge)", borderRadius: "5px", background: "var(--accent-wash)" },
    "& .cp-empty": { padding: "8px 0", fontSize: "11px" },
    "& .cp-branch": { display: "grid", gap: "5px", padding: "8px", marginBottom: "8px", background: "var(--accent-wash)" },
    "& .cp-stash-form, & .cp-prompt": {
        marginTop: "10px",
        padding: "10px",
        border: "1px solid var(--line-strong)",
        borderRadius: "4px",
        background: "var(--raised)",
    },
    "& .cp-stash-form label, & .cp-prompt label": { display: "grid", gap: "6px", marginTop: "6px" },
    "& .cp-stash": { display: "flex", alignItems: "center", gap: "6px", padding: "8px 0", borderTop: "1px solid var(--line)" },
    "& .cp-stash > div": { flex: 1, minWidth: 0 },
    "& .cp-stash strong, & .cp-stash small": { display: "block", fontSize: "11px" },
    "& .cp-diff": { marginTop: "10px", border: "1px solid var(--line)", overflow: "auto", userSelect: "text" },
    "& .cp-diff header": { padding: "6px", fontSize: "11px" },
    "& .cp-diff pre": { margin: 0, padding: "5px 7px", font: "11px var(--mono)" },
    "& .cp-deletion": { background: "var(--danger-wash)", color: "var(--danger)" },
    "& .cp-addition": { background: "var(--accent-wash)", color: "var(--accent)" },
    "& .cp-notice": { marginTop: "10px", padding: "8px", background: "var(--accent-wash)", borderLeft: "2px solid var(--accent)" },
    "& .cp-notice button": { marginLeft: "8px" },
    "& .cp-lab": {
        position: "fixed",
        zIndex: 1000,
        bottom: "14px",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(740px, calc(100vw - 28px))",
        padding: "8px 12px",
        background: "var(--raised)",
        border: "1px solid var(--line-strong)",
        borderRadius: "8px",
        boxShadow: "var(--shadow-popover)",
    },
    "& .cp-switcher": { display: "flex", alignItems: "center", justifyContent: "center", gap: "12px" },
    "& .cp-switcher strong": { minWidth: "180px", textAlign: "center" },
    "& .cp-switcher span": { color: "var(--faint)", fontSize: "9px", letterSpacing: "0.06em" },
    "& .cp-scenarios": { display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", marginTop: "8px", flexWrap: "wrap" },
    "& .cp-scenarios label": { display: "flex", alignItems: "center", gap: "6px" },
    "& .cp-scenarios select": { width: "170px", padding: "4px" },
    "& .cp-lab details": { marginTop: "6px", fontSize: "10px", color: "var(--muted)" },
    "& .cp-lab summary": { cursor: "pointer" },
    "& .cp-lab pre": { maxHeight: "180px", overflow: "auto", userSelect: "text" },
})
