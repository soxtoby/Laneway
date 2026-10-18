import type { OpenRepository } from "@laneway/shared"
import clsx from "clsx"
import { type KeyboardEvent, useRef, useState } from "react"
import { Button as AriaButton, DropIndicator, GridList, useDragAndDrop } from "react-aria-components"
import { IconButton } from "./controls"
import { DenseRow } from "./dense-row"
import { AddIcon, CollapsePanelIcon, ExpandPanelIcon } from "./icons"
import { automaticIcon, repositoryName } from "./repositories"
import type { IconImageApi } from "./repository-icon-images"
import { RepositoryTile } from "./repository-tile"
import { Button } from "./ui/Button"
import { GripVertical } from "./ui/icons"
import { MenuItem } from "./ui/Menu"

interface RepositoryPanelProps {
    repositories: OpenRepository[]
    activeId?: string
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
    return (
        <aside className={collapsed ? "repository-panel collapsed" : "repository-panel"} aria-label="Open repositories">
            {!collapsed && <div className="panel-heading">Repositories</div>}
            <RepositoryList {...props} collapsed={collapsed} />
            <div className="panel-footer">
                {collapsed
                    ? (
                        <IconButton label="Add repository" isDisabled={props.busy} onPress={props.onAdd}>
                            <AddIcon />
                        </IconButton>
                    )
                    : (
                        <Button variant="quiet" isDisabled={props.busy} onPress={props.onAdd}>
                            <AddIcon />
                            Add repository
                        </Button>
                    )}
                <IconButton
                    label={collapsed ? "Expand repository sidebar" : "Collapse repository sidebar"}
                    aria-expanded={!collapsed}
                    onPress={() => setCollapsed(!collapsed)}
                >
                    {collapsed ? <ExpandPanelIcon /> : <CollapsePanelIcon />}
                </IconButton>
            </div>
        </aside>
    )
}

function RepositoryList(
    { repositories, activeId, api, busy, onSelect, onReorder, onCustomize, onClose, collapsed }: RepositoryPanelProps & { collapsed: boolean },
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
                                <div className="repository-content" title={collapsed ? `${name}\n${path}` : path}>
                                    <AriaButton slot="drag" className="drag-handle" data-visible={isFocusVisibleWithin || undefined}>
                                        <GripVertical />
                                    </AriaButton>
                                    <RepositoryTile
                                        icon={repository.icon ?? automaticIcon(repository)}
                                        name={name}
                                        api={api}
                                        isActive={isActive}
                                        isMissing={repository.status != "available"}
                                    />
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
                            )}
                        </DenseRow>
                    )
                })}
            </GridList>
        </div>
    )
}

function RepositoryMenuItems({ onCustomize, onClose }: { onCustomize(): void; onClose(): void }) {
    return (
        <>
            <MenuItem onAction={onCustomize}>Customize…</MenuItem>
            <MenuItem onAction={onClose}>Close repository</MenuItem>
        </>
    )
}
