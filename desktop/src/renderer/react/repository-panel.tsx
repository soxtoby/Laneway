import type { OpenRepository } from "@laneway/shared"
import clsx from "clsx"
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react"
import { Button as AriaButton, type ButtonProps, DropIndicator, GridList, useDragAndDrop } from "react-aria-components"
import { Hint } from "./controls"
import { DenseRow } from "./dense-row"
import { AddIcon, CollapsePanelIcon, ExpandPanelIcon } from "./icons"
import { automaticIcon, repositoryName } from "./repositories"
import type { RepositoryChangesSnapshot, RepositoryChangesState } from "./repository-changes"
import type { IconImageApi } from "./repository-icon-images"
import { RepositoryTile } from "./repository-tile"
import { GripVertical } from "./ui/icons"
import { MenuItem } from "./ui/Menu"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"

interface RepositoryPanelProps {
    repositories: OpenRepository[]
    activeId?: string
    /** Each repository's Working Changes; a repository not yet checked is absent. */
    changes: RepositoryChangesSnapshot
    api: IconImageApi
    /** Opening or adding a repository is under way, so choosing another waits. */
    busy: boolean
    onSelect(id: string): void
    /** Receives every open repository's id in the new order. */
    onReorder(ids: string[]): void
    onCustomize(id: string): void
    onClose(id: string): void
    onAdd(): void
}

/**
 * Open repositories in a side panel that stays dark in both appearances, reordered by drag, keyboard
 * drag, or Ctrl+Shift+< and >. It starts collapsed to its tiles.
 */
export function RepositoryPanel(props: RepositoryPanelProps) {
    let [collapsed, setCollapsed] = useState(true)
    // Rows keep one height either way, so each tile stays where it was as the panel's width animates.
    return (
        <aside className={collapsed ? "repository-panel collapsed" : "repository-panel"} aria-label="Open repositories">
            <RepositoryList {...props} collapsed={collapsed} />
            <div className="panel-footer">
                <PanelAction label="Add repository" isDisabled={props.busy} onPress={props.onAdd} labelled={!collapsed}>
                    <AddIcon />
                </PanelAction>
                <PanelAction
                    label={collapsed ? "Expand repository sidebar" : "Collapse repository sidebar"}
                    aria-expanded={!collapsed}
                    onPress={() => setCollapsed(!collapsed)}
                >
                    {collapsed ? <ExpandPanelIcon /> : <CollapsePanelIcon />}
                </PanelAction>
            </div>
        </aside>
    )
}

/**
 * A footer action whose icon sits where a collapsed panel centres it, with its label beside it once the panel
 * opens; an unlabelled one has a tooltip instead.
 */
function PanelAction({ label, labelled, children, ...props }: Pick<ButtonProps, "onPress" | "isDisabled" | "aria-expanded"> & {
    label: string
    labelled?: boolean
    children: ReactNode
}) {
    let button = (
        <AriaButton {...props} className="panel-action" aria-label={labelled ? undefined : label}>
            {children}
            {labelled && <span className="panel-action-label">{label}</span>}
        </AriaButton>
    )
    return labelled ? button : (
        <TooltipTrigger>
            {button}
            <Tooltip placement="end">{label}</Tooltip>
        </TooltipTrigger>
    )
}

function RepositoryList(
    { repositories, activeId, changes, api, busy, onSelect, onReorder, onCustomize, onClose, collapsed }: RepositoryPanelProps & {
        collapsed: boolean
    },
) {
    let list = useRef<HTMLDivElement>(null)
    let ids = repositories.map(repository => repository.id)
    let { dragAndDropHooks } = useDragAndDrop({
        getItems: keys => [...keys].map(key => ({ "text/plain": repositoryName(repositories.find(repository => repository.id == key)!) })),
        onReorder(event) {
            let moving = ids.filter(id => event.keys.has(id))
            let order = ids.filter(id => !event.keys.has(id))
            order.splice(order.indexOf(String(event.target.key)) + (event.target.dropPosition == "after" ? 1 : 0), 0, ...moving)
            onReorder(order)
        },
        renderDropIndicator: target => (
            <DropIndicator target={target} className="drop-slot">
                {({ isDropTarget }) => <div className="drop-line" data-drop-target={isDropTarget || undefined} />}
            </DropIndicator>
        ),
    })

    // Ctrl+Shift+< and > move the focused repository without dragging, as the current rail does.
    let moveFocused = (event: KeyboardEvent) => {
        if (!event.ctrlKey || !event.shiftKey || (event.key != "<" && event.key != ">"))
            return
        let rows = [...list.current?.querySelectorAll(":scope > [role=row]") ?? []]
        let from = rows.findIndex(row => row.contains(document.activeElement))
        let to = from + (event.key == "<" ? -1 : 1)
        if (from < 0 || to < 0 || to >= ids.length)
            return
        event.preventDefault()
        let order = [...ids]
        order.splice(to, 0, ...order.splice(from, 1))
        onReorder(order)
    }

    return (
        <div className="repository-list-area" onKeyDown={moveFocused}>
            <GridList
                ref={list}
                aria-label="Open repositories"
                className="repository-list"
                dragAndDropHooks={dragAndDropHooks}
                onAction={key => busy || onSelect(String(key))}
            >
                {repositories.map(repository => {
                    let name = repositoryName(repository)
                    let isActive = repository.id == activeId
                    let path = repository.status == "available" ? repository.info.selectedWorktree : "Unavailable"
                    let working = changes[repository.id]
                    let summary = changesSummary(working)
                    return (
                        <DenseRow
                            key={repository.id}
                            id={repository.id}
                            textValue={name}
                            className={clsx("repository-row", isActive && "active", collapsed && "collapsed")}
                            menu={{
                                label: `Actions for ${name}`,
                                items: () => <RepositoryMenuItems onCustomize={() => onCustomize(repository.id)} onClose={() => onClose(repository.id)} />,
                            }}
                        >
                            {({ isFocusVisibleWithin, actions }) => (
                                <Hint text={[collapsed && name, path, summary].filter(Boolean).join("\n")} placement="end">
                                    <div className="repository-content">
                                        <AriaButton slot="drag" className="drag-handle" data-visible={isFocusVisibleWithin || undefined}>
                                            <GripVertical />
                                        </AriaButton>
                                        <span className="repository-tile">
                                            <RepositoryTile
                                                icon={repository.icon ?? automaticIcon(repository)}
                                                name={name}
                                                api={api}
                                                isActive={isActive}
                                                isMissing={repository.status != "available"}
                                            />
                                            {summary && (
                                                <span className="changes-badge" data-unseen={working?.unseen || undefined} role="img" aria-label={summary} />
                                            )}
                                        </span>
                                        {!collapsed && (
                                            <>
                                                <span className="repository-copy">
                                                    <span className="repository-name">{name}</span>
                                                    <span className="repository-path">{path}</span>
                                                </span>
                                                {actions}
                                            </>
                                        )}
                                    </div>
                                </Hint>
                            )}
                        </DenseRow>
                    )
                })}
            </GridList>
        </div>
    )
}

/** What a repository's row says about its Working Changes, when it has any. */
function changesSummary(working?: RepositoryChangesState) {
    if (!working?.count)
        return undefined
    let summary = `Working Changes in ${working.count} ${working.count == 1 ? "worktree" : "worktrees"}`
    return working.unseen ? `${summary}, changed since you last looked` : summary
}

function RepositoryMenuItems({ onCustomize, onClose }: { onCustomize(): void; onClose(): void }) {
    return (
        <>
            <MenuItem onAction={onCustomize}>Customize…</MenuItem>
            <MenuItem onAction={onClose}>Close repository</MenuItem>
        </>
    )
}
