import type { BranchGraph, BranchGraphBranchNode, BranchGraphVirtualBranch, WorktreeRequest } from "@laneway/shared"
import { css, type Handle, on, ref } from "remix/ui"
import { CommandLens } from "../command-lens"
import { Icon } from "../icons"

export type Column = BranchGraphBranchNode | BranchGraphVirtualBranch

// Lives inside the column header: `display: contents` lets the name sit beside the kind icon
// while the overflow button lands at the far right of the header's action group.
let controlStyle = css({
    display: "contents",
    color: "var(--text)",
    "& > [aria-haspopup='menu']": { order: "2" },
})

// The worktree's name sits over its path so the column says both what it is and where it lives.
let titleStyle = css({
    flex: "1 1 auto",
    minWidth: 0,
    display: "grid",
    alignContent: "center",
})

let titleRowStyle = css({
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "6px",
})

// Too truncated to select usefully; left unselectable, a double-click on it maximizes the column like the rest of the header.
let pathStyle = css({
    userSelect: "none",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--muted)",
    fontSize: "11px",
    lineHeight: "14px",
})

// The name and its rename input size to their text, leaving the rest of the header free to drag and click.
let nameStyle = css({
    flex: "0 1 auto",
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

let nameInputStyle = css({
    flex: "0 1 auto",
    minWidth: "4ch",
    width: "auto",
    fieldSizing: "content",
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

let stateChip = css({
    flex: "0 0 auto",
    padding: "1px 6px",
    color: "var(--warning)",
    border: "1px solid var(--warning-edge)",
    borderRadius: "4px",
    background: "var(--warning-wash)",
    fontSize: "10.5px",
    fontWeight: 600,
})

let iconStyle = css({
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

let menuStyle = css({
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

let menuItemStyle = css({
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

let menuPathStyle = css({ display: "block", overflowWrap: "anywhere", color: "var(--muted)", fontSize: "10px" })

export function WorktreeControls(
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
    let menuId = `${handle.id}-worktree-menu`
    return () => {
        let props = handle.props
        let worktrees = [...props.graph.branches.flatMap(branch => branch.checkedOut), ...props.graph.virtualBranches.map(branch => branch.worktree)]
            .filter((item, index, items) => items.findIndex(other => other.path == item.path) == index)
        let worktree = worktrees.find(item => item.path == props.path)
        let rename = async () => {
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
                                                // Re-rendering keeps the controlled value in step; otherwise Remix restores the stale one after each keystroke.
                                                on("input", event => {
                                                    name = event.currentTarget.value
                                                    void handle.update()
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
                                    let items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]
                                    let index = items.indexOf(document.activeElement as HTMLButtonElement)
                                    let next = event.key == "Home" ? 0 : event.key == "End"
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
                                                let destination = await props.chooseDirectory(worktree.path)
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
                            let branch = props.graph.branches.find(item => item.id == result.nodeId)?.localRefs[0]
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

    async function prepare(request: WorktreeRequest) {
        closeMenu(true)
        await handle.update()
        await handle.props.prepare(request)
    }

    function closeMenu(focus = false) {
        menuOpen = false
        void handle.update().then(() => {
            if (focus)
                menuButton.focus()
        })
    }

    function closeBranches() {
        choosingBranch = false
        void handle.update().then(() => menuButton.focus())
    }
}
