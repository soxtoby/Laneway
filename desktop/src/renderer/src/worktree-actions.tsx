import type { BranchGraph, BranchGraphBranchNode, BranchGraphVirtualBranch, WorktreePreview, WorktreeRequest } from "@laneway/shared"
import { css, type Handle, on, ref } from "remix/ui"
import { CommandLens } from "./command-lens"
import { Icon } from "./icons"

type Column = BranchGraphBranchNode | BranchGraphVirtualBranch
interface Options {
    api: Window["laneway"]
    update(): Promise<AbortSignal>
    completed(repositoryId: string, request: WorktreeRequest, columnId?: string): Promise<void>
}

export function createWorktreeActions(options: Options) {
    let preview: WorktreePreview | undefined
    let repositoryId = "", columnId: string | undefined
    let error = "", busy = false, preserve = true
    let returnFocus: HTMLElement | null = null
    let undoRepository: string | undefined, restoredName = ""
    async function prepare(id: string, request: WorktreeRequest, sourceColumn?: string) {
        if (busy)
            return
        repositoryId = id
        columnId = sourceColumn
        returnFocus = document.activeElement as HTMLElement | null
        busy = true
        error = ""
        undoRepository = undefined
        preserve = true
        await options.update()
        try {
            const result = await options.api.previewWorktree(id, request)
            if (result.ok)
                preview = result.preview
            else
                error = result.error.message
        } catch (reason) {
            error = String(reason)
        }
        busy = false
        await options.update()
    }
    function close() {
        if (busy)
            return
        preview = undefined
        error = ""
        void options.update().then(() => returnFocus?.focus())
    }
    async function execute() {
        if (!preview || busy)
            return
        busy = true
        error = ""
        await options.update()
        try {
            const request = preview.request.action == "remove" ? { ...preview.request, preserve, allowIgnoredLoss: true } : preview.request
            // Changed preservation choices need a matching preview token, while retaining
            // the original evidence check for changes made while the dialog was open.
            const original = await options.api.previewWorktree(repositoryId, preview.request)
            if (!original.ok || original.preview.token != preview.token)
                throw new Error("Worktree state changed. Cancel and review the operation again.")
            const fresh = await options.api.previewWorktree(repositoryId, request)
            if (!fresh.ok)
                throw new Error(fresh.error.message)
            const result = await options.api.executeWorktree(repositoryId, request, fresh.preview.token)
            if (!result.ok)
                throw new Error(result.error.message)
            preview = undefined
            await options.completed(repositoryId, request, columnId)
        } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason)
        }
        busy = false
        await options.update()
    }
    async function transition(id: string, action: "undo" | "redo", basename?: string) {
        if (busy)
            return
        busy = true
        error = ""
        await options.update()
        try {
            const result = await options.api.transitionOperation(id, action, basename)
            if (!result.ok)
                throw new Error(result.error.message)
            undoRepository = undefined
            await options.completed(id, { action: "unlock", path: "" })
        } catch (reason) {
            error = reason instanceof Error ? reason.message : String(reason)
            undoRepository = action == "undo" && /occupied/.test(error) ? id : undefined
        }
        busy = false
        await options.update()
    }
    return {
        busy: () => busy,
        prepare,
        transition,
        controls(id: string, column: Column, path: string | undefined, graph: BranchGraph) {
            return (
                <WorktreeControls
                    column={column}
                    path={path}
                    graph={graph}
                    busy={busy}
                    prepare={request => prepare(id, request, column.id)}
                    chooseDirectory={options.api.chooseDirectory}
                />
            )
        },
        dialog() {
            if (!preview && !error)
                return null
            const request = preview?.request
            return (
                <dialog
                    aria-label="Worktree operation"
                    mix={[
                        dialogStyle,
                        ref(dialog => dialog.showModal()),
                        on("cancel", event => {
                            event.preventDefault()
                            close()
                        }),
                    ]}
                >
                    <h2>{request ? `${request.action[0]!.toUpperCase()}${request.action.slice(1)} worktree` : "Worktree operation"}</h2>
                    {preview && (
                        <>
                            {preview.destination && (
                                <p>
                                    Destination: <strong>{preview.destination}</strong>
                                </p>
                            )}
                            <div mix={affectedPathsStyle}>
                                {preview.affected.map(path => (
                                    <div mix={affectedPathStyle}>
                                        <strong>{path.split(/[\\/]/).pop()}</strong>
                                        <span>{path}</span>
                                    </div>
                                ))}
                            </div>
                            {(request?.action == "switch" || request?.action == "create") && (
                                <p>
                                    Working Changes are stashed before switching. A previous holder stays detached. Existing stashes remain available for
                                    explicit application.
                                </p>
                            )}
                            {request?.action == "remove" && (
                                <>
                                    {preview.dirty || preview.uniqueCommits
                                        ? (
                                            <div mix={workingChangesStyle}>
                                                <strong>{preview.dirty ? "Working Changes detected" : "Worktree-only commits detected"}</strong>
                                                <p>
                                                    {preview.dirty
                                                        ? "Keep these changes available after removing the worktree."
                                                        : "Keep these commits reachable after removing the worktree."}
                                                </p>
                                                <label>
                                                    <input
                                                        type="checkbox"
                                                        checked={preserve}
                                                        mix={on("change", event => {
                                                            preserve = event.currentTarget.checked
                                                            void options.update()
                                                        })}
                                                    />
                                                    {preview.uniqueCommits
                                                        ? preview.dirty ? "Create a protective branch and stash Working Changes" : "Create a protective branch"
                                                        : "Stash Working Changes"}
                                                </label>
                                            </div>
                                        )
                                        : <p>Remove this worktree and its column.</p>}
                                    {!preserve && (
                                        <p>Delete Working Changes and Worktree-only Commits from visible state. Git state remains retained for undo.</p>
                                    )}
                                    {preview.worktrees.some(item => item.missing && item.path == request.path) && (
                                        <p>Remove the missing registration. Unavailable file contents cannot be recovered.</p>
                                    )}
                                </>
                            )}
                        </>
                    )}
                    {error && <p role="alert">{error}</p>}
                    {undoRepository && (
                        <form
                            mix={on("submit", event => {
                                event.preventDefault()
                                void transition(undoRepository!, "undo", restoredName)
                            })}
                        >
                            <label>
                                Restore within the same parent:{" "}
                                <input
                                    aria-label="Restored worktree basename"
                                    value={restoredName}
                                    mix={on("input", event => {
                                        restoredName = event.currentTarget.value
                                        void options.update()
                                    })}
                                />
                            </label>
                            <button class="primary-button" mix={dialogButtonStyle} disabled={busy || !restoredName}>Restore worktree</button>
                        </form>
                    )}
                    <footer mix={dialogFooterStyle}>
                        <button class="secondary-button" type="button" disabled={busy} mix={[dialogButtonStyle, on("click", close)]}>Cancel</button>
                        {preview && (
                            <button
                                type="button"
                                class={request?.action == "remove" ? undefined : "primary-button"}
                                disabled={busy}
                                mix={[dialogButtonStyle, ...(request?.action == "remove" ? [removeButtonStyle] : []), on("click", execute)]}
                            >
                                {busy ? "Working…" : request?.action == "remove" ? "Remove worktree" : "Confirm"}
                            </button>
                        )}
                    </footer>
                </dialog>
            )
        },
    }
}

function WorktreeControls(
    handle: Handle<{
        column: Column
        path?: string
        graph: BranchGraph
        busy: boolean
        prepare(request: WorktreeRequest): Promise<void>
        chooseDirectory(path?: string): Promise<string | undefined>
    }>,
) {
    let editing = false, name = "", menuOpen = false, choosingBranch = false, query = ""
    let menuButton: HTMLButtonElement, nameButton: HTMLButtonElement
    const menuId = `${handle.id}-worktree-menu`
    function closeMenu(focus = false) {
        menuOpen = false
        void handle.update().then(() => {
            if (focus)
                menuButton.focus()
        })
    }
    async function prepare(request: WorktreeRequest) {
        closeMenu(true)
        await handle.update()
        await handle.props.prepare(request)
    }
    function closeBranches() {
        choosingBranch = false
        void handle.update().then(() => menuButton.focus())
    }
    return () => {
        const props = handle.props
        const worktrees = [...props.graph.branches.flatMap(branch => branch.checkedOut), ...props.graph.virtualBranches.map(branch => branch.worktree)]
            .filter((item, index, items) => items.findIndex(other => other.path == item.path) == index)
        const worktree = worktrees.find(item => item.path == props.path)
        const rename = async () => {
            if (!editing || !worktree)
                return
            editing = false
            await handle.update()
            nameButton.focus()
            if (name && name != worktree.name)
                await props.prepare({ action: "rename", path: worktree.path, basename: name })
        }
        return (
            <div class="column-worktree" mix={controlStyle}>
                {worktree
                    ? (
                        <div mix={titleStyle}>
                            <div mix={titleRowStyle}>
                                {editing
                                    ? (
                                        <input
                                            aria-label="Worktree directory name"
                                            value={name}
                                            mix={[
                                                nameInputStyle,
                                                ref(input => {
                                                    input.focus()
                                                    input.select()
                                                }),
                                                on("input", event => {
                                                    name = event.currentTarget.value
                                                }),
                                                on("blur", rename),
                                                on("keydown", event => {
                                                    if (event.key == "Enter") {
                                                        event.preventDefault()
                                                        void rename()
                                                    } else if (event.key == "Escape") {
                                                        event.preventDefault()
                                                        event.stopPropagation()
                                                        editing = false
                                                        void handle.update().then(() => nameButton.focus())
                                                    }
                                                }),
                                            ]}
                                        />
                                    )
                                    : (
                                        <button
                                            type="button"
                                            aria-label="Rename worktree"
                                            title={worktree.main
                                                ? "Main worktree"
                                                : worktree.locked
                                                ? "Unlock worktree to rename"
                                                : worktree.missing
                                                ? "Locate worktree to rename"
                                                : "Rename directory"}
                                            disabled={props.busy || worktree.main || worktree.locked || worktree.missing}
                                            mix={[
                                                nameStyle,
                                                ref(node => nameButton = node),
                                                on("click", () => {
                                                    name = worktree.name
                                                    editing = true
                                                    void handle.update()
                                                }),
                                            ]}
                                        >
                                            {worktree.name}
                                        </button>
                                    )}
                                {worktree.missing && <span mix={stateChip}>Missing</span>}
                                {worktree.locked && <span mix={stateChip} title={worktree.lockReason ?? "Locked"}>Locked</span>}
                            </div>
                            <small class="column-worktree-path" title={worktree.path} mix={pathStyle}>{worktree.path}</small>
                        </div>
                    )
                    : null}
                <button
                    type="button"
                    aria-label={worktree ? "Worktree actions" : "Check out branch"}
                    title={worktree ? "Worktree actions" : "Check out branch…"}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-controls={menuId}
                    disabled={props.busy}
                    mix={[
                        iconStyle,
                        ref(node => menuButton = node),
                        on("click", () => {
                            menuOpen = !menuOpen
                            void handle.update()
                        }),
                        on("keydown", event => {
                            if (event.key == "ArrowDown") {
                                event.preventDefault()
                                menuOpen = true
                                void handle.update()
                            }
                        }),
                    ]}
                >
                    <Icon name="more" size={15} />
                </button>
                {menuOpen && (
                    <div
                        id={menuId}
                        role="menu"
                        aria-label="Worktree actions"
                        mix={[
                            menuStyle,
                            ref((node, signal) => {
                                node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
                                document.addEventListener("pointerdown", event => {
                                    if (!node.contains(event.target as Node) && !menuButton.contains(event.target as Node))
                                        closeMenu()
                                }, { signal })
                            }),
                            on("focusout", event => {
                                if (
                                    event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)
                                    && event.relatedTarget != menuButton
                                ) {
                                    closeMenu()
                                }
                            }),
                            on("keydown", event => {
                                if (event.key == "Escape") {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    closeMenu(true)
                                } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                                    event.preventDefault()
                                    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]
                                    const index = items.indexOf(document.activeElement as HTMLButtonElement)
                                    const next = event.key == "Home" ? 0 : event.key == "End"
                                        ? items.length - 1
                                        : (index + (event.key == "ArrowDown" ? 1 : -1) + items.length) % items.length
                                    items[next]?.focus()
                                }
                            }),
                        ]}
                    >
                        {worktree && !worktree.missing && (
                            <button
                                type="button"
                                role="menuitem"
                                aria-label="Switch worktree branch"
                                disabled={props.busy}
                                mix={[
                                    menuItemStyle,
                                    on("click", () => {
                                        menuOpen = false
                                        choosingBranch = true
                                        query = ""
                                        void handle.update()
                                    }),
                                ]}
                            >
                                Switch branch…
                            </button>
                        )}
                        {!worktree && props.column.kind == "branch"
                            && worktrees.map(item => (
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={props.busy || item.missing}
                                    title={item.path}
                                    mix={[
                                        menuItemStyle,
                                        on("click", () =>
                                            prepare({
                                                action: "switch",
                                                path: item.path,
                                                branch: props.column.kind == "branch" ? props.column.preferredRef : "",
                                                move: true,
                                            })),
                                    ]}
                                >
                                    {item.name} · {item.branchRef?.replace("refs/heads/", "") ?? props.graph.branches.find(branch =>
                                        branch.checkedOut.some(tree => tree.path == item.path)
                                    )?.name ?? "detached"}
                                    <small mix={menuPathStyle}>{item.path}</small>
                                </button>
                            ))}
                        {!worktree && props.column.kind == "branch" && (
                            <button
                                type="button"
                                role="menuitem"
                                disabled={props.busy}
                                mix={[
                                    menuItemStyle,
                                    on("click", () =>
                                        prepare({
                                            action: "create",
                                            branch: props.column.kind == "branch" ? props.column.preferredRef : "",
                                            move: true,
                                        })),
                                ]}
                            >
                                New worktree
                            </button>
                        )}
                        {worktree && !worktree.main && (
                            <>
                                {worktree.locked && (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        disabled={props.busy}
                                        title={worktree.lockReason}
                                        mix={[menuItemStyle, on("click", () => prepare({ action: "unlock", path: worktree.path }))]}
                                    >
                                        Unlock worktree
                                    </button>
                                )}
                                {worktree.missing && (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        disabled={props.busy}
                                        mix={[
                                            menuItemStyle,
                                            on("click", async () => {
                                                closeMenu(true)
                                                const destination = await props.chooseDirectory(worktree.path)
                                                if (destination)
                                                    await prepare({ action: "repair", path: worktree.path, destination })
                                            }),
                                        ]}
                                    >
                                        Locate and repair
                                    </button>
                                )}
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={props.busy || worktree.locked}
                                    mix={[
                                        menuItemStyle,
                                        on("click", () => prepare({ action: "remove", path: worktree.path, preserve: true, allowIgnoredLoss: false })),
                                    ]}
                                >
                                    {worktree.missing ? "Remove missing worktree" : "Remove worktree…"}
                                </button>
                            </>
                        )}
                    </div>
                )}
                {choosingBranch && worktree && (
                    <CommandLens
                        prompt={`Switch ${worktree.name} to branch…`}
                        query={query}
                        results={props.graph.branches
                            .filter(branch =>
                                branch.localRefs.length > 0 && !branch.checkedOut.some(item => item.path == worktree.path)
                                && branch.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
                            )
                            .map(branch => ({
                                kind: "branch" as const,
                                repositoryId: props.graph.repositoryId,
                                nodeId: branch.id,
                                label: branch.name,
                                detail: branch.localRefs[0]!,
                                score: 1,
                            }))}
                        inputRef={() => {}}
                        setQuery={value => {
                            query = value
                            void handle.update()
                        }}
                        close={closeBranches}
                        activate={async result => {
                            const branch = props.graph.branches.find(item => item.id == result.nodeId)?.localRefs[0]
                            if (!branch)
                                return
                            closeBranches()
                            await handle.update()
                            await props.prepare({ action: "switch", path: worktree.path, branch, move: true })
                        }}
                    />
                )}
            </div>
        )
    }
}

// Lives inside the column header: `display: contents` lets the name sit beside the kind icon
// while the overflow button lands at the far right of the header's action group.
const controlStyle = css({
    display: "contents",
    color: "var(--text)",
    "& > [aria-haspopup='menu']": { order: "2" },
})
// The worktree's name sits over its path so the column says both what it is and where it lives.
const titleStyle = css({
    flex: "1 1 auto",
    minWidth: 0,
    display: "grid",
    alignContent: "center",
})
const titleRowStyle = css({
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "6px",
})
const pathStyle = css({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--muted)",
    fontSize: "11px",
    lineHeight: "14px",
})
const nameStyle = css({
    flex: "1 1 auto",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    padding: "2px 4px",
    margin: "0 0 0 -4px",
    textAlign: "left",
    border: "1px solid transparent",
    borderRadius: "var(--radius)",
    color: "var(--text)",
    background: "transparent",
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    fontSize: "15px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    cursor: "text",
    "&:hover:not(:disabled)": { borderColor: "var(--line-strong)", background: "var(--panel-deep)" },
    "&:disabled": { opacity: 1, cursor: "default" },
})
const nameInputStyle = css({
    flex: "1 1 auto",
    minWidth: 0,
    width: "auto",
    height: "26px",
    padding: "0 4px",
    margin: "0 0 0 -4px",
    border: "1px solid var(--focus)",
    borderRadius: "var(--radius)",
    font: "inherit",
    fontSize: "14px",
    fontWeight: 600,
    color: "var(--text)",
    background: "var(--panel)",
})
const stateChip = css({
    flex: "0 0 auto",
    padding: "1px 6px",
    color: "var(--warning)",
    border: "1px solid var(--warning-edge)",
    borderRadius: "4px",
    background: "var(--warning-wash)",
    fontSize: "10.5px",
    fontWeight: 600,
})
const iconStyle = css({
    flexShrink: 0,
    width: "28px",
    height: "28px",
    padding: 0,
    display: "grid",
    placeItems: "center",
    border: "1px solid transparent",
    borderRadius: "var(--radius)",
    color: "var(--muted)",
    background: "transparent",
    cursor: "pointer",
    "&:hover:not(:disabled)": { color: "var(--text)", borderColor: "var(--line)", background: "var(--control-hover)" },
    "&:disabled": { opacity: 0.5, cursor: "default" },
})
const menuStyle = css({
    position: "absolute",
    zIndex: 20,
    top: "100%",
    right: "6px",
    minWidth: "220px",
    maxWidth: "calc(100% - 8px)",
    maxHeight: "320px",
    overflow: "auto",
    padding: "4px",
    border: "1px solid var(--line-strong)",
    borderRadius: "var(--radius)",
    background: "var(--raised)",
    boxShadow: "var(--shadow-popover)",
    whiteSpace: "normal",
})
const menuItemStyle = css({
    display: "block",
    width: "100%",
    padding: "6px 8px",
    border: 0,
    borderRadius: "3px",
    textAlign: "left",
    color: "var(--text)",
    background: "transparent",
    fontSize: "12px",
    cursor: "pointer",
    "&:hover:not(:disabled), &:focus-visible:not(:disabled)": { background: "var(--hover)" },
    "&:disabled": { opacity: 0.5, cursor: "default" },
})
const menuPathStyle = css({ display: "block", overflowWrap: "anywhere", color: "var(--muted)", fontSize: "10px" })
const dialogStyle = css({
    width: "460px",
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
    "& h2": { margin: "0 0 16px", fontSize: "17px", fontWeight: 600 },
    "& p, & li": { overflowWrap: "anywhere", fontSize: "13px", lineHeight: 1.5 },
    "& label": { display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "13px", lineHeight: 1.5, marginBlock: "12px" },
    "& [role='alert']": { color: "var(--danger)", background: "var(--danger-wash)", padding: "10px", borderRadius: "4px" },
})
const affectedPathsStyle = css({ display: "grid", gap: "8px", marginBottom: "16px" })
const workingChangesStyle = css({
    marginTop: "14px",
    padding: "10px 12px",
    border: "1px solid var(--warning-edge)",
    borderRadius: "5px",
    background: "var(--warning-wash)",
    color: "var(--text)",
    "& > strong": { fontSize: "13px", fontWeight: 600 },
    "& p": { margin: "4px 0 0", color: "var(--muted)" },
    "& label": { margin: "10px 0 0" },
})
const affectedPathStyle = css({
    display: "grid",
    gap: "4px",
    padding: "10px 12px",
    border: "1px solid var(--line)",
    borderRadius: "5px",
    background: "var(--canvas)",
    "& strong": { fontSize: "13px", fontWeight: 600, overflowWrap: "anywhere" },
    "& span": { fontFamily: "var(--mono)", fontSize: "11px", lineHeight: 1.5, color: "var(--muted)", overflowWrap: "anywhere" },
})
const dialogFooterStyle = css({
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    margin: "20px -20px -20px",
    padding: "12px 20px",
    borderTop: "1px solid var(--line)",
    background: "var(--canvas)",
})
const dialogButtonStyle = css({
    minHeight: "32px",
    padding: "0 14px",
    borderRadius: "4px",
    fontFamily: "inherit",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    "&:disabled": { opacity: 0.5, cursor: "default" },
})
const removeButtonStyle = css({
    color: "var(--danger)",
    background: "var(--danger-wash)",
    border: "1px solid var(--danger-edge)",
    "&:hover:not(:disabled)": { background: "var(--danger)", color: "var(--panel)" },
})
