import type { BranchGraph, BranchGraphBranchNode, BranchGraphMarker } from "@laneway/shared"
import { type KeyboardEvent, useEffect, useEffectEvent, useMemo, useRef } from "react"
import { Button as AriaButton, GridList, GridListItem, ListLayout, useDragAndDrop, Virtualizer } from "react-aria-components"
import type { AppController } from "./app-controller"
import { graphRowHeight, type GraphRowLayout, layoutBranchGraph } from "./branch-graph-layout"
import { canRebaseOnto, rebaseable } from "./branch-rebase"
import type { GraphView } from "./branch-workspace"
import { Hint, IconButton } from "./controls"
import { useRowMenu } from "./dense-row"
import { copyText } from "./file-paths"
import { GraphSettings } from "./graph-settings"
import { ArchiveIcon, CloseIcon, FolderIcon, TagIcon } from "./icons"
import { Button } from "./ui/Button"
import { GripVertical } from "./ui/icons"
import { MenuItem, Separator } from "./ui/Menu"
import { ToggleButton } from "./ui/ToggleButton"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot } from "./use-snapshot"
import { branchNodeFor, localIdentities, workspaceGraph } from "./worktree-columns"

/** What a Branch Graph row carries when dragged: the branch's ref. */
export let branchDragType = "application/x-laneway-branch"

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
                                    <Hint text={marker.tooltip}>
                                        <span>{marker.label}</span>
                                    </Hint>
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
    let { columns, branches, rebase } = controller
    let identities = useMemo(() => workspaceGraph(graph), [graph])
    let items = useMemo(() => rows.map(row => ({ id: row.node.id, row })), [rows])
    let selected = identities.branches.find(branch => branch.id == view.selectedId)
    let rebasing = useSnapshot(rebase)
    let choosing = rebasing.choosing?.repositoryId == repositoryId ? identities.branches.find(branch => branch.id == rebasing.choosing?.sourceId) : undefined
    // While a rebase chooses its destination, a row chosen with the pointer is the destination; arrows only select.
    let pointer = useRef(false)
    let list = useRef<HTMLDivElement>(null)
    // A revealed node scrolls to the top of the rows when it is out of view, and its row takes focus once it shows.
    let rowIndex = useEffectEvent((id: string) => rows.findIndex(row => row.node.id == id))
    useEffect(() => {
        let element = list.current
        let index = view.revealed ? rowIndex(view.revealed.id) : -1
        if (!view.revealed || !element || index < 0)
            return
        let top = index * graphRowHeight
        if (top < element.scrollTop || top + graphRowHeight > element.scrollTop + element.clientHeight)
            element.scrollTop = top
        let id = view.revealed.id
        // The virtualizer draws the row once it has seen the scroll, which can take a frame or two.
        let frame = 0
        let focus = (attempts: number) => {
            let row = [...element.querySelectorAll<HTMLElement>("[data-node-id]")].find(candidate => candidate.dataset.nodeId == id)
            if (row || attempts == 0)
                (row ?? element).focus({ preventScroll: true })
            else
                frame = requestAnimationFrame(() => focus(attempts - 1))
        }
        frame = requestAnimationFrame(() => focus(3))
        return () => cancelAnimationFrame(frame)
    }, [view.revealed])
    let dragged = useRef<string>(undefined)
    useEffect(() => {
        if (!choosing)
            return
        let escape = (event: globalThis.KeyboardEvent) => {
            if (event.key == "Escape") {
                event.preventDefault()
                rebase.stopChoosing()
            }
        }
        window.addEventListener("keydown", escape)
        return () => window.removeEventListener("keydown", escape)
    }, [choosing, rebase])
    // A branch dropped on another row rebases onto it; dropped on a worktree column's header, it switches that worktree.
    let { dragAndDropHooks } = useDragAndDrop({
        getItems: keys =>
            [...keys].map(key => {
                let branch = identities.branches.find(candidate => candidate.id == key)
                return branch && !branch.remoteOnly ? { [branchDragType]: branch.preferredRef, "text/plain": branch.name } : { "text/plain": String(key) }
            }),
        onDragStart: event => {
            dragged.current = String([...event.keys][0])
        },
        onDragEnd: () => {
            dragged.current = undefined
        },
        acceptedDragTypes: [branchDragType],
        getDropOperation: target => {
            let source = identities.branches.find(branch => branch.id == dragged.current)
            let destination = target.type == "item" && target.dropPosition == "on" ? identities.branches.find(branch => branch.id == target.key) : undefined
            return source && destination && canRebaseOnto(identities, source, destination) ? "move" : "cancel"
        },
        onItemDrop: event => {
            if (dragged.current && event.target.dropPosition == "on")
                void rebase.start(repositoryId, identities, dragged.current, String(event.target.key))
        },
    })
    // Left folds the selected branch's stack and Right unfolds it; F2 renames, Delete deletes, and M rebases it.
    let keyDown = (event: KeyboardEvent) => {
        pointer.current = false
        if (!selected || event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLElement && event.target.closest("button"))
            return
        if (event.key.toLowerCase() == "m" && !event.shiftKey) {
            if (rebaseable(selected)) {
                event.preventDefault()
                event.stopPropagation()
                rebase.choose(repositoryId, selected)
            }
        } else if (event.key == "ArrowLeft" || event.key == "ArrowRight") {
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
                void branches.delete(repositoryId, selected)
        }
    }
    return (
        <div
            className="graph-rows-area"
            onKeyDownCapture={keyDown}
            onPointerDownCapture={() => {
                pointer.current = true
            }}
        >
            <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: graphRowHeight }}>
                <GridList
                    ref={list}
                    aria-label="Branches and graph nodes"
                    className="graph-rows"
                    items={items}
                    selectionMode="single"
                    selectionBehavior="replace"
                    // Choosing the selected row again keeps it selected, as Graph Selection only moves.
                    disallowEmptySelection
                    keyboardNavigationBehavior="tab"
                    dragAndDropHooks={dragAndDropHooks}
                    selectedKeys={view.selectedId ? [view.selectedId] : []}
                    onSelectionChange={keys => {
                        if (keys == "all")
                            return
                        let key = keys.size ? String([...keys][0]) : undefined
                        columns.select(key)
                        if (choosing && pointer.current && key && key != choosing.id)
                            rebase.chooseDestination(repositoryId, identities, key)
                        pointer.current = false
                    }}
                    // Enter opens the selected branch, or rebases onto it while a rebase chooses its destination.
                    onAction={key => {
                        if (choosing)
                            rebase.chooseDestination(repositoryId, identities, String(key))
                        else if (identities.branches.some(branch => branch.id == key))
                            columns.open(String(key))
                    }}
                    dependencies={[identities, choosing, view.selectedId]}
                >
                    {({ row }) => {
                        let branch = row.node.kind == "branch" ? identities.branches.find(candidate => candidate.id == row.node.id) : undefined
                        return branch
                            ? (
                                <BranchRow
                                    row={row}
                                    branch={branch}
                                    rebase={choosing?.id == branch.id
                                        ? "source"
                                        : choosing && view.selectedId == branch.id && canRebaseOnto(identities, choosing, branch)
                                        ? "target"
                                        : undefined}
                                    onOpen={() => columns.open(branch.id)}
                                    onMarker={marker => {
                                        columns.showMarker(marker, branch.id)
                                        void controller.stashes.open(repositoryId, mainWorktree, marker.objectId)
                                    }}
                                    menu={() => (
                                        <>
                                            {rebaseable(branch) && (
                                                <MenuItem
                                                    onAction={() => {
                                                        columns.select(branch.id)
                                                        rebase.choose(repositoryId, branch)
                                                    }}
                                                >
                                                    Rebase onto…
                                                </MenuItem>
                                            )}
                                            <MenuItem onAction={() => branches.createAt(repositoryId, branch.tip)}>Create branch here…</MenuItem>
                                            {branch.localRefs.length > 0 && (
                                                <MenuItem onAction={() => branches.rename(repositoryId, branch)}>Rename branch…</MenuItem>
                                            )}
                                            {branch.localRefs.length > 0 && (
                                                <MenuItem onAction={() => void branches.delete(repositoryId, branch)}>Delete branch</MenuItem>
                                            )}
                                            <Separator />
                                            <MenuItem onAction={() => void copyText(branch.name)}>Copy branch name</MenuItem>
                                            {branch.tags.map(tag => (
                                                <MenuItem
                                                    key={tag}
                                                    onAction={() => void copyText(tag)}
                                                >
                                                    {`Copy tag ${tag}`}
                                                </MenuItem>
                                            ))}
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

function BranchRow({ row, branch, rebase, onOpen, onMarker, menu }: {
    row: GraphRowLayout
    branch: BranchGraphBranchNode
    /** Its part in a rebase whose destination is being chosen. */
    rebase?: "source" | "target"
    onOpen(): void
    onMarker(marker: BranchGraphMarker): void
    menu(): React.ReactNode
}) {
    let { row: rowRef, openMenu } = useRowMenu({ label: `Actions for ${branch.name}`, items: menu })
    return (
        <GridListItem
            ref={rowRef}
            id={branch.id}
            textValue={branch.name}
            className="graph-row"
            data-node-id={branch.id}
            data-rebase={rebase}
            onContextMenu={openMenu}
        >
            {({ isFocusVisibleWithin }) => (
                <>
                    <GraphRail row={row} />
                    <span className="graph-copy">
                        <Hint text={branch.name}>
                            <strong className="graph-name">{branch.name}</strong>
                        </Hint>
                        <span className="graph-details">
                            <small className="graph-kind">{branchKind(branch)}</small>
                            {branch.checkedOut.map(worktree => (
                                <Hint key={worktree.path} text={worktree.path}>
                                    <span className="graph-chip worktree">
                                        <FolderIcon />
                                        {worktree.name}
                                    </span>
                                </Hint>
                            ))}
                            {branch.tags.map(tag => (
                                <span key={tag} className="graph-chip tag">
                                    <TagIcon />
                                    {tag}
                                </span>
                            ))}
                            {branch.unresolved && (
                                <Hint text={branch.unresolved.recovery ?? "This stack contains deferred conflicts"}>
                                    <span className="graph-chip unresolved">Unresolved</span>
                                </Hint>
                            )}
                            {branch.markers.map(marker => (
                                <TooltipTrigger key={marker.id}>
                                    <AriaButton className="graph-marker" aria-label={`Stash ${marker.label}`} onPress={() => onMarker(marker)}>
                                        <ArchiveIcon />
                                    </AriaButton>
                                    <Tooltip>{`Stash ${marker.label}`}</Tooltip>
                                </TooltipTrigger>
                            ))}
                            {(branch.ahead > 0 || branch.behind > 0) && <span className="graph-chip divergence">↑{branch.ahead} ↓{branch.behind}</span>}
                        </span>
                    </span>
                    {/* Drags the branch by keyboard too: onto another row to rebase, or a worktree column's header to switch it. */}
                    <AriaButton slot="drag" className="drag-handle" aria-label={`Drag ${branch.name}`} data-visible={isFocusVisibleWithin || undefined}>
                        <GripVertical />
                    </AriaButton>
                    <AriaButton className="graph-open" onPress={onOpen}>Open</AriaButton>
                </>
            )}
        </GridListItem>
    )
}

/** A tag or a detached worktree: it only selects, and a tag's menu copies its name. */
function SimpleRow({ row }: { row: GraphRowLayout }) {
    let node = row.node as Extract<GraphRowLayout["node"], { kind: "tag" | "worktree" }>
    let { row: rowRef, openMenu } = useRowMenu({
        label: `Actions for ${node.name}`,
        items: () => <MenuItem onAction={() => void copyText(node.name)}>Copy tag name</MenuItem>,
    })
    return (
        <GridListItem
            ref={rowRef}
            id={node.id}
            textValue={node.name}
            className="graph-row simple"
            data-node-id={node.id}
            onContextMenu={node.kind == "tag" ? openMenu : undefined}
        >
            {({ isFocusVisibleWithin }) => (
                <>
                    <GraphRail row={row} />
                    <Hint text={node.title}>
                        <span className="graph-copy">
                            <strong className="graph-name">{node.name}</strong>
                            <small className="graph-kind">{node.kind == "tag" ? "Tag" : "Detached worktree"}</small>
                        </span>
                    </Hint>
                    {/* Every row drags in a draggable list, but only a branch's drag lands anywhere. */}
                    <AriaButton slot="drag" className="drag-handle" aria-label={`Drag ${node.name}`} data-visible={isFocusVisibleWithin || undefined}>
                        <GripVertical />
                    </AriaButton>
                </>
            )}
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
