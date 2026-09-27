import type { Workspace } from "@laneway/shared"
import { css, type Handle, on, type RemixNode } from "remix/ui"
import { Icon } from "./icons"

// The ink-coloured repository rail on the left edge. Collapsed it is an icon strip of initials
// tiles; expanded it adds names and worktree paths. Both views share one markup so the
// branch workspace and the missing-repository view stay identical.
export function RepositoryRail(
    handle: Handle<{
        railCollapsed: boolean
        toggleRail(): void
        activeId: string
        workspace: Workspace
        busy?: boolean
        selectRepository(id: string): void
        // Set when choosing the active repository toggles a panel; reports whether it is shown.
        activeExpanded?: boolean
        closeRepository?(id: string): void
        moveRepository(id: string, targetId: string): void
        previewRepositoryMove(id: string, targetId: string): void
        commitRepositoryOrder(): void
        cancelRepositoryMove(): void
        addRepository(): void
        heading?: RemixNode
    }>,
) {
    let draggingId: string | undefined
    return () => {
        const props = handle.props
        return (
            <aside class="repository-rail" mix={repositoryRail}>
                <div class="rail-heading" mix={railHeading}>
                    {props.heading}
                    <p class="eyebrow" mix={railEyebrow}>
                        Open repositories
                    </p>
                </div>
                <nav aria-label="Open repositories" mix={openRepositoriesNav}>
                    {props.workspace.repositories.map((repository, index) => {
                        const name = repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name
                        return (
                            <div
                                class="repository-row"
                                draggable={!props.busy}
                                title="Drag to reorder · Ctrl+< / Ctrl+>"
                                mix={[
                                    repositoryRow,
                                    on("keydown", event => {
                                        if (event.ctrlKey && event.shiftKey && (event.key == "<" || event.key == ">")) {
                                            event.preventDefault()
                                            const target = props.workspace.repositories[index + (event.key == "<" ? -1 : 1)]
                                            if (target)
                                                props.moveRepository(repository.id, target.id)
                                        }
                                    }),
                                    on("dragstart", event => {
                                        draggingId = repository.id
                                        event.dataTransfer?.setData("text/plain", repository.id)
                                    }),
                                    on("dragover", event => {
                                        event.preventDefault()
                                        if (draggingId)
                                            props.previewRepositoryMove(draggingId, repository.id)
                                    }),
                                    on("drop", event => {
                                        event.preventDefault()
                                        props.commitRepositoryOrder()
                                        draggingId = undefined
                                    }),
                                    on("dragend", () => {
                                        if (draggingId)
                                            props.cancelRepositoryMove()
                                        draggingId = undefined
                                    }),
                                ]}
                            >
                                <button
                                    class={`repository-item ${props.railCollapsed ? "collapsed" : ""} ${
                                        repository.id == props.activeId ? "active" : ""
                                    } ${repository.status}`}
                                    type="button"
                                    disabled={props.busy}
                                    title={repository.status == "available" ? repository.info.selectedWorktree : repository.path}
                                    aria-label={name}
                                    aria-expanded={repository.id == props.activeId ? props.activeExpanded : undefined}
                                    data-mousedown-activate
                                    mix={[repositoryItem, on("click", () => props.selectRepository(repository.id))]}
                                >
                                    <span mix={repositoryInitials}>
                                        {initials(repository.path)}
                                    </span>
                                    {!props.railCollapsed && (
                                        <span mix={repositoryCopy}>
                                            <strong mix={repositoryName}>{name}</strong>
                                            <small mix={repositoryPath}>
                                                {repository.status == "available" ? repository.info.selectedWorktree : "Unavailable"}
                                            </small>
                                        </span>
                                    )}
                                </button>
                                {!props.railCollapsed && props.closeRepository && (
                                    <button
                                        class="repository-close"
                                        type="button"
                                        aria-label={`Close ${name}`}
                                        title="Close repository"
                                        mix={[repositoryClose, on("click", () => props.closeRepository?.(repository.id))]}
                                    >
                                        <Icon name="close" size={12} />
                                    </button>
                                )}
                            </div>
                        )
                    })}
                    <button
                        class={`rail-add ${props.railCollapsed ? "collapsed" : ""}`}
                        type="button"
                        aria-label="Add repository"
                        title="Add repository"
                        disabled={props.busy}
                        mix={[railAdd, on("click", props.addRepository)]}
                    >
                        <span aria-hidden="true" mix={railAddIcon}>
                            <Icon name="plus" size={14} />
                        </span>
                        {!props.railCollapsed && <span class="rail-add-label">Add repository</span>}
                    </button>
                </nav>
                <div class="rail-footer" mix={railFooter}>
                    <RepositoryRailToggle collapsed={props.railCollapsed} toggle={props.toggleRail} />
                </div>
            </aside>
        )
    }
}

export function RepositoryRailToggle(handle: Handle<{ collapsed: boolean; toggle(): void }>) {
    return () => (
        <button
            class={`repository-rail-toggle ${handle.props.collapsed ? "collapsed" : ""}`}
            type="button"
            aria-label={handle.props.collapsed ? "Expand repository sidebar" : "Collapse repository sidebar"}
            title={handle.props.collapsed ? "Expand repository sidebar" : "Collapse repository sidebar"}
            aria-expanded={!handle.props.collapsed}
            mix={[railToggle, on("click", handle.props.toggle)]}
        >
            <Icon name={handle.props.collapsed ? "collapse-right" : "collapse-left"} size={14} />
        </button>
    )
}

export function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}

export function initials(path: string) {
    const words = baseName(path).split(/[-_.\s]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "GW").toUpperCase()
}

const repositoryRail = css({
    minWidth: "0",
    minHeight: "0",
    padding: "6px",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    gap: "6px",
    color: "var(--chrome-text)",
    borderRight: "1px solid var(--chrome-line)",
    background: "var(--chrome)",
    ".rail-collapsed &": { padding: "6px 0" },
})

const railHeading = css({
    padding: "2px 2px 6px 6px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    borderBottom: "1px solid var(--chrome-line)",
    ".rail-collapsed &": { padding: "0 0 6px", justifyContent: "center" },
})

const railEyebrow = css({
    minWidth: "0",
    flex: "1 1 auto",
    margin: "0",
    overflow: "hidden",
    color: "var(--chrome-muted)",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0",
    textOverflow: "ellipsis",
    textTransform: "none",
    whiteSpace: "nowrap",
    ".rail-collapsed &": { display: "none" },
})

const openRepositoriesNav = css({
    minWidth: "0",
    minHeight: "0",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    gap: "4px",
    overflowX: "hidden",
    overflowY: "auto",
    ".rail-collapsed &": { justifyItems: "center" },
})

const repositoryRow = css({
    position: "relative",
    ".rail-collapsed &": { width: "100%", display: "grid", justifyItems: "center" },
})

const repositoryItem = css({
    "&.collapsed": { width: "36px", height: "36px", padding: "0", gridTemplateColumns: "1fr", gap: "0", justifyItems: "center" },
    position: "relative",
    minWidth: "0",
    width: "100%",
    padding: "5px 26px 5px 6px",
    display: "grid",
    gridTemplateColumns: "28px minmax(0, 1fr)",
    alignItems: "center",
    gap: "8px",
    outlineOffset: "-2px",
    textAlign: "left",
    color: "var(--chrome-text)",
    border: "1px solid transparent",
    borderRadius: "7px",
    background: "transparent",
    "&:hover:not(:disabled)": { background: "var(--chrome-2)" },
    "&.active": { background: "var(--chrome-2)", borderColor: "var(--chrome-line)" },
    "&.active > span:first-child": { color: "var(--accent-ink)", borderColor: "var(--chrome-accent)", background: "var(--chrome-accent)" },
    "&.active::before": {
        content: '""',
        position: "absolute",
        left: "-6px",
        top: "6px",
        bottom: "6px",
        width: "3px",
        borderRadius: "0 2px 2px 0",
        background: "var(--chrome-accent)",
    },
    // Collapsed, the tile alone marks the selection: a solid accent tile with a side marker of the same height.
    "&.collapsed, &.collapsed.active, &.collapsed:hover:not(:disabled)": { background: "transparent", borderColor: "transparent" },
    "&.collapsed.active::before": { left: "-8px", top: "4px", bottom: "4px", width: "3px" },
    "&.collapsed:focus-visible": { outline: "none" },
    "&.missing > span:first-child": { color: "var(--warning)" },
})

const repositoryInitials = css({
    width: "28px",
    height: "28px",
    display: "grid",
    placeItems: "center",
    color: "var(--chrome-text)",
    border: "1px solid var(--chrome-line)",
    borderRadius: "6px",
    background: "var(--chrome-2)",
    fontSize: "11px",
    fontWeight: "700",
    letterSpacing: "0.02em",
    ".collapsed:not(.active) > &": { color: "var(--chrome-muted)", opacity: 0.7 },
    ".collapsed:not(.active):hover > &": { opacity: 1, borderColor: "var(--chrome-accent)" },
    ".collapsed.active > &": { color: "var(--accent-ink)", borderColor: "var(--chrome-accent)", background: "var(--chrome-accent)" },
    ".collapsed:focus-visible > &": { outline: "2px solid var(--ring)", outlineOffset: "2px" },
})

const repositoryCopy = css({
    minWidth: "0",
    display: "grid",
    alignContent: "center",
    gap: "1px",
})

const repositoryName = css({
    overflow: "hidden",
    fontSize: "12.5px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const repositoryPath = css({
    overflow: "hidden",
    color: "var(--chrome-muted)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const repositoryClose = css({
    position: "absolute",
    top: "50%",
    right: "6px",
    width: "22px",
    height: "22px",
    padding: "0",
    display: "grid",
    translate: "0 -50%",
    placeItems: "center",
    color: "var(--chrome-muted)",
    border: "0",
    borderRadius: "5px",
    background: "transparent",
    "&:hover": { color: "var(--chrome-text)", background: "var(--chrome-line)" },
})

const railAdd = css({
    "&.collapsed": { width: "36px", height: "36px", padding: "0", gridTemplateColumns: "1fr", gap: "0", justifyItems: "center" },
    margin: "4px 0 0",
    width: "100%",
    height: "36px",
    padding: "0 6px",
    display: "grid",
    gridTemplateColumns: "28px minmax(0, 1fr)",
    alignItems: "center",
    gap: "8px",
    flex: "0 0 auto",
    outlineOffset: "-2px",
    textAlign: "left",
    color: "var(--chrome-muted)",
    border: "1px dashed var(--chrome-line)",
    borderRadius: "7px",
    background: "transparent",
    fontSize: "12px",
    lineHeight: "1",
    "&:hover:not(:disabled)": { color: "var(--chrome-text)", background: "var(--chrome-2)" },
})

const railAddIcon = css({
    width: "28px",
    height: "28px",
    display: "grid",
    placeItems: "center",
})

const railFooter = css({
    padding: "6px 2px 2px",
    display: "flex",
    justifyContent: "flex-end",
    borderTop: "1px solid var(--chrome-line)",
    ".rail-collapsed &": { justifyContent: "center", padding: "6px 0 2px" },
})

const railToggle = css({
    width: "100%",
    height: "28px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--chrome-muted)",
    border: "1px solid transparent",
    borderRadius: "6px",
    background: "transparent",
    "&.collapsed": { width: "28px" },
    "&:hover:not(:disabled)": { color: "var(--chrome-text)", background: "var(--chrome-2)" },
})
