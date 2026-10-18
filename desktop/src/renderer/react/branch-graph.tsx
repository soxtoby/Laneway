/** @jsxImportSource react */
import type { BranchGraph, BranchGraphBranchNode, BranchGraphMarker } from "@laneway/shared"
import { type KeyboardEvent, useMemo } from "react"
import { Button as AriaButton, GridList, GridListItem, ListLayout, Virtualizer } from "react-aria-components"
import { graphRowHeight, type GraphRowLayout, layoutBranchGraph } from "../src/branch-workspace/branch-graph-layout"
import { branchNodeFor, localIdentities, workspaceGraph } from "../src/worktrees/worktree-columns"
import type { AppController } from "./app-controller"
import type { GraphView } from "./branch-workspace"
import { IconButton } from "./controls"
import { useRowMenu } from "./dense-row"
import { GraphSettings } from "./graph-settings"
import { ArchiveIcon, CloseIcon, FolderIcon, TagIcon } from "./icons"
import { Button } from "./ui/Button"
import { MenuItem } from "./ui/Menu"
import { ToggleButton } from "./ui/ToggleButton"
import { useSnapshot } from "./use-snapshot"

interface GraphPanelProps {
    controller: AppController
    repositoryId: string
    /** The repository's main worktree, where its stashes apply from. */
    mainWorktree: string
}

/**
 * The active repository's Branch Graph: its branches, tags, and detached worktrees on the rails of their verified
 * history. Choosing a row only selects it; Open, Enter, or a double-click opens its column.
 */
export function BranchGraphPanel({ controller, repositoryId, mainWorktree }: GraphPanelProps) {
    let { columns } = controller
    let snapshot = useSnapshot(columns)
    let { graph, graphView: view } = snapshot
    let rows = useMemo(() => graph && graphRows(graph, view.foldedIds), [graph, view.foldedIds])
    return (
        <aside className="graph-panel" aria-label="Branch Graph">
            <header className="graph-toolbar">
                {/* The repository is named by the panel and its main worktree column, so the title stays generic. */}
                <h1 className="graph-title">Branch Graph</h1>
                {/* The engine reads the default set or every branch, so the toggle reads again rather than filtering rows. */}
                <span className="graph-actions">
                    <ToggleButton variant="quiet" isSelected={view.showAll} onChange={() => columns.toggleAll()}>
                        {view.showAll ? "Show relevant" : "Show all"}
                    </ToggleButton>
                    {graph && <GraphSettings graph={graph} onApply={columns.applyGraphSettings} />}
                </span>
            </header>
            {graph?.limited.length ? <p className="graph-limit">Limited evidence: {graph.limited.join(", ")}. No implicit fetch performed.</p> : null}
            {!graph && snapshot.loading && (
                <div className="graph-message" role="status">
                    <p>Reading verified Branch Graph…</p>
                    <small>Local refs and worktrees first.</small>
                </div>
            )}
            {!graph && snapshot.error && (
                <div className="graph-message" role="alert">
                    <small>Graph unavailable</small>
                    <p>{snapshot.error}</p>
                    <Button variant="secondary" onPress={() => void columns.refresh(false)}>Retry</Button>
                </div>
            )}
            {graph && rows && (
                <>
                    <p className="graph-summary">
                        <span>{rows.count} branches</span>
                        <span>{graph.primaryBranch.status == "known" ? `Primary · ${shortRef(graph.primaryBranch.ref!)}` : "Primary unresolved"}</span>
                        <span>{graph.selectedRemote ? `Remote · ${graph.selectedRemote}` : "Remote unresolved"}</span>
                    </p>
                    <GraphRows controller={controller} repositoryId={repositoryId} mainWorktree={mainWorktree} graph={graph} rows={rows.rows} view={view} />
                    {graph.unassignedStashes.length > 0 && (
                        <details className="unassigned-stashes">
                            <summary>{graph.unassignedStashes.length} unassigned stashes</summary>
                            {graph.unassignedStashes.map(marker => (
                                <AriaButton
                                    key={marker.id}
                                    className="unassigned-stash"
                                    onPress={() => columns.showMarker(marker)}
                                >
                                    <span title={marker.tooltip}>{marker.label}</span>
                                </AriaButton>
                            ))}
                        </details>
                    )}
                    {view.marker && <MarkerDetails marker={view.marker} onClose={() => columns.showMarker(undefined)} />}
                </>
            )}
        </aside>
    )
}

function GraphRows(
    { controller, repositoryId, mainWorktree, graph, rows, view }: GraphPanelProps & { graph: BranchGraph; rows: GraphRowLayout[]; view: GraphView },
) {
    let { columns, branches } = controller
    let identities = useMemo(() => workspaceGraph(graph), [graph])
    let items = useMemo(() => rows.map(row => ({ id: row.node.id, row })), [rows])
    let selected = identities.branches.find(branch => branch.id == view.selectedId)
    // Left folds the selected branch's stack and Right unfolds it; F2 renames and Delete deletes it.
    let keyDown = (event: KeyboardEvent) => {
        if (!selected || event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLElement && event.target.closest("button"))
            return
        if (event.key == "ArrowLeft" || event.key == "ArrowRight") {
            event.preventDefault()
            event.stopPropagation()
            // Branches stack on a whole Branch Node, so folding any identity at its tip folds them all.
            columns.fold(branchNodeFor(graph, selected.id)!.id, event.key == "ArrowLeft")
        } else if ((event.key == "F2" || event.key == "Delete") && selected.localRefs.length > 0) {
            event.preventDefault()
            event.stopPropagation()
            if (event.key == "F2")
                branches.rename(repositoryId, selected)
            else
                branches.delete(repositoryId, selected)
        }
    }
    return (
        <div className="graph-rows-area" onKeyDownCapture={keyDown}>
            <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: graphRowHeight }}>
                <GridList
                    aria-label="Branches and graph nodes"
                    className="graph-rows"
                    items={items}
                    selectionMode="single"
                    selectionBehavior="replace"
                    keyboardNavigationBehavior="tab"
                    selectedKeys={view.selectedId ? [view.selectedId] : []}
                    onSelectionChange={keys => keys != "all" && columns.select(keys.size ? String([...keys][0]) : undefined)}
                    onAction={key => identities.branches.some(branch => branch.id == key) && columns.open(String(key))}
                    dependencies={[identities]}
                >
                    {({ row }) => {
                        let branch = row.node.kind == "branch" ? identities.branches.find(candidate => candidate.id == row.node.id) : undefined
                        return branch
                            ? (
                                <BranchRow
                                    row={row}
                                    branch={branch}
                                    onOpen={() => columns.open(branch.id)}
                                    onMarker={marker => {
                                        columns.showMarker(marker, branch.id)
                                        void controller.stashes.open(repositoryId, mainWorktree, marker.objectId)
                                    }}
                                    menu={() => (
                                        <>
                                            <MenuItem onAction={() => branches.createAt(repositoryId, branch.tip)}>Create branch here…</MenuItem>
                                            {branch.localRefs.length > 0 && (
                                                <MenuItem onAction={() => branches.rename(repositoryId, branch)}>Rename branch…</MenuItem>
                                            )}
                                            {branch.localRefs.length > 0 && (
                                                <MenuItem onAction={() => branches.delete(repositoryId, branch)}>Delete branch…</MenuItem>
                                            )}
                                        </>
                                    )}
                                />
                            )
                            : <SimpleRow row={row} />
                    }}
                </GridList>
            </Virtualizer>
        </div>
    )
}

function BranchRow({ row, branch, onOpen, onMarker, menu }: {
    row: GraphRowLayout
    branch: BranchGraphBranchNode
    onOpen(): void
    onMarker(marker: BranchGraphMarker): void
    menu(): React.ReactNode
}) {
    let { row: rowRef, openMenu } = useRowMenu({ label: `Actions for ${branch.name}`, items: menu })
    return (
        <GridListItem ref={rowRef} id={branch.id} textValue={branch.name} className="graph-row" data-node-id={branch.id} onContextMenu={openMenu}>
            <GraphRail row={row} />
            <span className="graph-copy">
                <strong className="graph-name" title={branch.name}>{branch.name}</strong>
                <span className="graph-details">
                    <small className="graph-kind">{branchKind(branch)}</small>
                    {branch.checkedOut.map(worktree => (
                        <span key={worktree.path} className="graph-chip worktree" title={worktree.path}>
                            <FolderIcon />
                            {worktree.name}
                        </span>
                    ))}
                    {branch.tags.map(tag => (
                        <span key={tag} className="graph-chip tag">
                            <TagIcon />
                            {tag}
                        </span>
                    ))}
                    {branch.unresolved && (
                        <span className="graph-chip unresolved" title={branch.unresolved.recovery ?? "This stack contains deferred conflicts"}>Unresolved</span>
                    )}
                    {branch.markers.map(marker => (
                        <AriaButton
                            key={marker.id}
                            className="graph-marker"
                            aria-label={`Stash ${marker.label}`}
                            onPress={() => onMarker(marker)}
                        >
                            <ArchiveIcon />
                        </AriaButton>
                    ))}
                    {(branch.ahead > 0 || branch.behind > 0) && <span className="graph-chip divergence">↑{branch.ahead} ↓{branch.behind}</span>}
                </span>
            </span>
            <AriaButton className="graph-open" onPress={onOpen}>Open</AriaButton>
        </GridListItem>
    )
}

/** A tag or a detached worktree: it only selects. */
function SimpleRow({ row }: { row: GraphRowLayout }) {
    let node = row.node as Extract<GraphRowLayout["node"], { kind: "tag" | "worktree" }>
    return (
        <GridListItem id={node.id} textValue={node.name} className="graph-row simple" data-node-id={node.id}>
            <GraphRail row={row} />
            <span className="graph-copy" title={node.title}>
                <strong className="graph-name">{node.name}</strong>
                <small className="graph-kind">{node.kind == "tag" ? "Tag" : "Detached worktree"}</small>
            </span>
        </GridListItem>
    )
}

/** The row's part of the history's rails, and its node; one commit labelled by several rows stretches across them. */
function GraphRail({ row }: { row: GraphRowLayout }) {
    let { x, color, sameCommit } = row
    let top = sameCommit.above ? 0 : 20
    let bottom = sameCommit.below ? graphRowHeight : 20
    // Each row draws its part of a shared node; open ends meet the neighbouring row's.
    let outline = (open: "M" | "L") =>
        `M ${x - 4} ${bottom} V ${top} ${sameCommit.above ? `${open} ${x + 4} ${top}` : `A 4 4 0 0 1 ${x + 4} ${top}`} V ${bottom}${
            sameCommit.below ? "" : ` A 4 4 0 0 1 ${x - 4} ${bottom}`
        }`
    return (
        <svg className="graph-rail" aria-hidden="true" width={row.width} height={graphRowHeight} viewBox={`0 0 ${row.width} ${graphRowHeight}`}>
            {row.paths.map((path, index) => <path key={index} className="graph-line" data-lane={lane(path.color)} d={path.d} />)}
            {sameCommit.above || sameCommit.below
                ? (
                    <>
                        <path className="graph-node-fill" d={`${outline("L")} Z`} />
                        <path className="graph-line" data-lane={lane(color)} d={outline("M")} />
                    </>
                )
                : <circle className="graph-node" data-lane={lane(color)} cx={x} cy={20} r={4} />}
        </svg>
    )
}

function MarkerDetails({ marker, onClose }: { marker: BranchGraphMarker; onClose(): void }) {
    return (
        <aside className="marker-details" aria-label={`Stash ${marker.label}`}>
            <span className="marker-kind">Stash</span>
            <strong>{marker.label}</strong>
            <small>{marker.objectId.slice(0, 8)}</small>
            <IconButton label="Close marker details" small onPress={onClose}>
                <CloseIcon />
            </IconButton>
            <p>{marker.tooltip}</p>
        </aside>
    )
}

/** The rows the graph shows: every branch but those stacked on a folded Branch Node, one row per local identity. */
export function graphRows(graph: BranchGraph, foldedIds: string[]) {
    let folded = new Set(foldedIds)
    let visible = graph.branches.filter(branch => {
        let parent = branch.base.status == "known" ? branch.base.branchId : undefined
        let visited = new Set<string>()
        while (parent && !visited.has(parent)) {
            if (folded.has(parent))
                return false
            visited.add(parent)
            let base = graph.branches.find(candidate => candidate.id == parent)
            parent = base?.base.status == "known" ? base.base.branchId : undefined
        }
        return true
    })
    let identities = visible.flatMap(branch => localIdentities(graph, branch))
    return { ...layoutBranchGraph(graph, identities), count: identities.length }
}

function branchKind(branch: BranchGraphBranchNode) {
    return branch.primary
        ? "Primary"
        : branch.base.status == "ambiguous"
        ? "Choose base"
        : branch.merged
        ? "Merged"
        : branch.remoteOnly
        ? "Remote only"
        : branch.involvement == "involved"
        ? "Involved"
        : branch.involvement == "unknown"
        ? "Involvement unknown"
        : "Other branch"
}

// The Primary Branch's line keeps the neutral colour; the others cycle through the theme's lane colours.
function lane(color: number) {
    return color == 0 ? 0 : (color - 1) % 7 + 1
}

function shortRef(ref: string) {
    return ref.replace(/^refs\/(heads|remotes)\//, "")
}
