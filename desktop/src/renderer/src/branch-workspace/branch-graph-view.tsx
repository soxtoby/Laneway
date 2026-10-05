import type { BranchGraph, BranchGraphBranchNode, BranchGraphMarker } from "@laneway/shared"
import { css, type Handle, on, ref, type RemixNode } from "remix/ui"
import { Icon } from "../icons"
import { graphLineColor, type GraphRowLayout } from "./branch-graph-layout"

export let branchDragType = "application/x-laneway-branch"

let graphSummary = css({
    minHeight: "28px",
    padding: "0 14px",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    overflow: "hidden",
    color: "var(--muted)",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
    fontSize: "11.5px",
    whiteSpace: "nowrap",
})

let graphSummarySpan = css({
    "& + span::before": {
        marginRight: "12px",
        content: '"·"',
    },
})

let baseUnresolved = css({
    padding: "7px 10px",
    color: "var(--warning)",
    borderBottom: "1px solid var(--line)",
    background: "var(--warning-wash)",
    fontSize: "12px",
    lineHeight: "1.45",
})

let baseUnresolvedSummary = css({
    cursor: "default",
})

let baseUnresolvedDiv = css({
    marginTop: "6px",
    display: "grid",
    gridTemplateColumns: "minmax(80px, 1fr) 2fr",
    alignItems: "center",
    gap: "8px",
})

let baseUnresolvedSpan = css({
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
})

let baseUnresolvedButton = css({
    minHeight: "24px",
    padding: "0 7px",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "var(--control)",
    fontSize: "12px",
    "&.active": {
        color: "var(--warning)",
        borderColor: "var(--warning-edge)",
        background: "var(--warning-wash)",
    },
})

let graphRow = css({
    position: "relative",
    width: "100%",
    height: "40px",
    minHeight: "40px",
    padding: "3px 8px 3px 0",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    color: "var(--text)",
    textAlign: "left",
    border: "0",
    borderRadius: "0",
    background: "transparent",
    // Row separators are shadows so the 40px rail geometry stays exact.
    boxShadow: "inset 0 -1px var(--line)",
    "&.selected": {
        background: "var(--focus-wash)",
        boxShadow: "inset 3px 0 var(--focus), inset 0 -1px var(--line)",
    },
    "&.simple": {
        paddingLeft: "0",
    },
    "&:hover": {
        background: "var(--hover)",
    },
    "&.rebase-target": {
        outline: "2px solid var(--focus)",
        outlineOffset: "-2px",
        background: "var(--focus-wash)",
    },
    "&.rebase-source": {
        opacity: "0.6",
    },
})

let graphRailLines = css({
    flexShrink: "0",
    overflow: "hidden",
    alignSelf: "center",
})

let branchCopy = css({
    minWidth: "0",
    flex: "1 1 auto",
    display: "grid",
    gap: "1px",
})

let branchCopyStrong = css({
    overflow: "hidden",
    fontSize: "13px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let branchCopySmall = css({
    color: "var(--muted)",
    fontFamily: "var(--mono)",
    fontSize: "10.5px",
    letterSpacing: "0",
    textTransform: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

let branchDetails = css({
    minWidth: "0",
    height: "18px",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    overflow: "hidden",
    "& button": { minHeight: "16px", padding: "0 3px" },
})

let worktreeChip = css({
    maxWidth: "110px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 6px",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    fontFamily: "var(--mono)",
    fontSize: "10.5px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "& svg": { flex: "0 0 auto" },
    color: "var(--ok-ink)",
    borderColor: "var(--ok-edge)",
    background: "var(--ok-wash)",
})

let tagChip = css({
    maxWidth: "110px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 6px",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    fontFamily: "var(--mono)",
    fontSize: "10.5px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "& svg": { flex: "0 0 auto" },
    color: "var(--warning)",
    borderColor: "var(--accent-edge)",
    background: "var(--accent-wash)",
})

let markerButton = css({
    width: "20px",
    height: "18px",
    padding: "0",
    display: "inline-grid",
    placeItems: "center",
    color: "var(--stash-ink)",
    border: "1px solid var(--stash-edge)",
    borderRadius: "4px",
    background: "var(--stash-wash)",
    "&:hover": { background: "var(--stash-edge)", color: "var(--panel)" },
})

let divergence = css({
    maxWidth: "110px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "1px 6px",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    fontFamily: "var(--mono)",
    fontSize: "10.5px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "& svg": { flex: "0 0 auto" },
    color: "var(--muted)",
    background: "var(--panel-deep)",
})

let openBranch = css({
    height: "24px",
    padding: "0 10px",
    color: "var(--focus)",
    border: "1px solid var(--focus-edge)",
    borderRadius: "var(--radius)",
    background: "var(--panel)",
    fontSize: "12px",
    fontWeight: "600",
    "&:hover": {
        color: "#fff",
        borderColor: "var(--focus)",
        background: "var(--focus)",
    },
})

let graphLoading = css({
    minWidth: "240px",
    margin: "auto",
    padding: "20px",
    textAlign: "center",
})

let graphLoadingSpan = css({
    width: "22px",
    height: "22px",
    margin: "0 auto 12px",
    display: "block",
    border: "2px solid var(--line-strong)",
    borderTopColor: "var(--accent)",
    borderRadius: "50%",
    animation: "graph-spin 800ms linear infinite",
})

let graphLoadingP = css({
    marginBottom: "6px",
    fontSize: "13px",
})

let graphLoadingSmall = css({
    color: "var(--faint)",
    fontSize: "11px",
    lineHeight: "1.45",
    textTransform: "none",
})

let graphError = css({
    minWidth: "240px",
    margin: "auto",
    padding: "20px",
    textAlign: "center",
})

let graphErrorSpan = css({
    color: "var(--faint)",
    fontSize: "11px",
    lineHeight: "1.45",
    textTransform: "none",
})

let graphErrorP = css({
    marginBottom: "6px",
    fontSize: "13px",
})

let primaryButton = css({
    minHeight: "28px",
    marginTop: "12px",
    padding: "0 12px",
    borderRadius: "4px",
})

export function GraphSummary(handle: Handle<{ graph: BranchGraph; visibleCount: number }>) {
    return () => (
        <div class="graph-summary" mix={graphSummary}>
            <span mix={graphSummarySpan}>
                {handle.props.visibleCount} branches
            </span>
            <span mix={graphSummarySpan}>
                {handle.props.graph.primaryBranch.status == "known" ? `Primary · ${shortRef(handle.props.graph.primaryBranch.ref!)}` : "Primary unresolved"}
            </span>
            <span mix={graphSummarySpan}>
                {handle.props.graph.selectedRemote ? `Remote · ${handle.props.graph.selectedRemote}` : "Remote unresolved"}
            </span>
        </div>
    )
}

export function BaseUnresolved(
    handle: Handle<{ branches: BranchGraphBranchNode[]; selections: Record<string, string>; choose(branchId: string, candidateId: string): void }>,
) {
    return () => {
        let unresolved = handle.props.branches.filter(branch => branch.base.status == "ambiguous")
        if (unresolved.length == 0)
            return null
        return (
            <details class="base-unresolved" mix={baseUnresolved}>
                <summary mix={baseUnresolvedSummary}>
                    Base unresolved · {unresolved.length}
                </summary>
                {unresolved.map(branch => (
                    <div mix={baseUnresolvedDiv}>
                        <strong>{branch.name}</strong>
                        <span mix={baseUnresolvedSpan}>
                            {branch.base.status == "ambiguous"
                                && branch.base.candidates.map(candidate => (
                                    <button
                                        type="button"
                                        class={handle.props.selections[branch.id] == candidate.branchId ? "active" : ""}
                                        title="Use for inspection only"
                                        mix={[baseUnresolvedButton, on("click", () => handle.props.choose(branch.id, candidate.branchId))]}
                                    >
                                        {candidate.name}
                                    </button>
                                ))}
                        </span>
                    </div>
                ))}
            </details>
        )
    }
}

export function BranchRow(
    handle: Handle<
        {
            branch: BranchGraphBranchNode
            rail: RemixNode
            selected: boolean
            /** Its part in a rebase whose destination is being chosen by keyboard. */
            rebase?: "source" | "target"
            select(): void
            open(): void
            selectMarker(marker: BranchGraphMarker): void
            contextMenu(event: MouseEvent): void
            dragStart(): void
            dragEnd(): void
            /** Whether the branch being dragged can rebase onto this one. */
            accepts(): boolean
            drop(): void
        }
    >,
) {
    return () => {
        let props = handle.props
        let branch = props.branch
        return (
            <div
                class={`graph-row ${props.selected ? "selected" : ""} ${props.rebase ? `rebase-${props.rebase}` : ""}`}
                role="option"
                aria-selected={props.selected}
                data-node-id={branch.id}
                draggable={!branch.remoteOnly}
                mix={[
                    graphRow,
                    // Dropped on a column header the branch switches that worktree; dropped on another row it rebases.
                    on("dragstart", event => {
                        event.dataTransfer?.setData(branchDragType, branch.preferredRef)
                        props.dragStart()
                    }),
                    on("dragend", props.dragEnd),
                    on("dragover", event => {
                        if (!event.dataTransfer?.types.includes(branchDragType) || !props.accepts())
                            return

                        event.preventDefault()
                        event.dataTransfer.dropEffect = "move"
                        event.currentTarget.classList.add("rebase-target")
                    }),
                    on("dragleave", event => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && props.rebase != "target")
                            event.currentTarget.classList.remove("rebase-target")
                    }),
                    on("drop", event => {
                        if (props.rebase != "target")
                            event.currentTarget.classList.remove("rebase-target")
                        if (!event.dataTransfer?.types.includes(branchDragType) || !props.accepts())
                            return
                        event.preventDefault()
                        props.drop()
                    }),
                    on("click", props.select),
                    ref((element, signal) => {
                        element.addEventListener("contextmenu", event => handle.props.contextMenu(event), { signal })
                    }),
                ]}
            >
                {props.rail}
                <span class="branch-copy" mix={branchCopy}>
                    <strong title={branch.name} mix={branchCopyStrong}>
                        {branch.name}
                    </strong>
                    <span class="branch-details" mix={branchDetails}>
                        <small mix={branchCopySmall}>
                            {branch.primary
                                ? "Primary"
                                : branch.merged
                                ? "Merged"
                                : branch.remoteOnly
                                ? "Remote only"
                                : branch.involvement == "involved"
                                ? "Involved"
                                : branch.involvement == "unknown"
                                ? "Involvement unknown"
                                : "Other branch"}
                        </small>
                        {branch.checkedOut.map(worktree => (
                            <span class="worktree-chip" title={worktree.path} mix={worktreeChip}>
                                <Icon name="folder" size={11} />
                                {worktree.name}
                            </span>
                        ))}
                        {branch.tags.map(tag => (
                            <span class="tag-chip" mix={tagChip}>
                                <Icon name="tag" size={11} />
                                {tag}
                            </span>
                        ))}
                        {branch.unresolved && (
                            <span class="conflict-marker" title={branch.unresolved.recovery ?? "This stack contains deferred conflicts"}>Unresolved</span>
                        )}
                        {branch.markers.map(marker => (
                            <button
                                class="marker-button"
                                data-mousedown-activate
                                type="button"
                                title={marker.tooltip}
                                mix={[
                                    markerButton,
                                    on("click", event => {
                                        event.stopPropagation()
                                        props.selectMarker(marker)
                                    }),
                                ]}
                            >
                                <Icon name="stash" size={12} />
                            </button>
                        ))}
                        {(branch.ahead > 0 || branch.behind > 0) && (
                            <span class="divergence" mix={divergence}>
                                ↑{branch.ahead} ↓{branch.behind}
                            </span>
                        )}
                    </span>
                </span>
                <button
                    class="open-branch"
                    data-mousedown-activate
                    type="button"
                    mix={[
                        openBranch,
                        on("click", event => {
                            event.stopPropagation()
                            props.open()
                        }),
                    ]}
                >
                    Open
                </button>
            </div>
        )
    }
}

export function SimpleNodeRow(
    handle: Handle<{ id: string; kind: "tag" | "worktree"; name: string; title: string; rail: RemixNode; selected: boolean; select(): void }>,
) {
    return () => (
        <button
            class={`graph-row simple ${handle.props.selected ? "selected" : ""}`}
            data-node-id={handle.props.id}
            role="option"
            tabIndex={-1}
            aria-selected={handle.props.selected}
            type="button"
            title={handle.props.title}
            mix={[graphRow, on("click", handle.props.select)]}
        >
            {handle.props.rail}
            <span class="branch-copy" mix={branchCopy}>
                <strong mix={branchCopyStrong}>
                    {handle.props.name}
                </strong>
                <small mix={branchCopySmall}>
                    {handle.props.kind == "tag" ? "Tag" : "Detached worktree"}
                </small>
            </span>
        </button>
    )
}

export function GraphRail(handle: Handle<{ row: GraphRowLayout }>) {
    return () => {
        let { x, color, sameCommit } = handle.props.row
        return (
            <svg
                class="graph-rail-lines"
                aria-hidden="true"
                width={handle.props.row.width}
                height={40}
                viewBox={`0 0 ${handle.props.row.width} 40`}
                mix={graphRailLines}
            >
                {handle.props.row.paths.map(path => <path d={path.d} fill="none" stroke={graphLineColor(path.color)} stroke-width="2" />)}
                {sameCommit.above || sameCommit.below
                    ? (() => {
                        // One commit labelled by several rows stretches its node across them, so branches sharing a tip
                        // don't read as a stack. Each row draws its part; open ends meet the neighbouring row's.
                        let top = sameCommit.above ? 0 : 20, bottom = sameCommit.below ? 40 : 20
                        let outline = (open: "M" | "L") =>
                            `M ${x - 4} ${bottom} V ${top} ${sameCommit.above ? `${open} ${x + 4} ${top}` : `A 4 4 0 0 1 ${x + 4} ${top}`} V ${bottom}${
                                sameCommit.below ? "" : ` A 4 4 0 0 1 ${x - 4} ${bottom}`
                            }`
                        return [
                            <path class="shared-commit" d={`${outline("L")} Z`} fill="var(--panel)" />,
                            <path d={outline("M")} fill="none" stroke={graphLineColor(color)} stroke-width="2" />,
                        ]
                    })()
                    : <circle cx={x} cy={20} r={4} fill="var(--panel)" stroke={graphLineColor(color)} stroke-width="2" />}
            </svg>
        )
    }
}

export function GraphProgress(_handle: Handle<Record<string, never>>) {
    return () => (
        <div class="graph-loading" mix={graphLoading}>
            <span mix={graphLoadingSpan}>
            </span>
            <p mix={graphLoadingP}>
                Reading verified Branch Graph…
            </p>
            <small mix={graphLoadingSmall}>
                Local refs and worktrees first.
            </small>
        </div>
    )
}

export function GraphError(handle: Handle<{ message: string; retry(): void }>) {
    return () => (
        <div class="graph-error" role="alert" mix={graphError}>
            <span mix={graphErrorSpan}>
                Graph unavailable
            </span>
            <p mix={graphErrorP}>
                {handle.props.message}
            </p>
            <button class="primary-button" type="button" mix={[primaryButton, on("click", handle.props.retry)]}>
                Retry
            </button>
        </div>
    )
}

function shortRef(ref: string) {
    return ref.replace(/^refs\/(heads|remotes)\//, "")
}
