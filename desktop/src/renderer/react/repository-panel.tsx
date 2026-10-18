/** @jsxImportSource react */
import type { OpenRepository } from "@laneway/shared"
import { repositoryInitials } from "@laneway/shared"
import clsx from "clsx"
import { createElement, type KeyboardEvent, type ReactNode, useReducer, useRef, useState } from "react"
import { Button as AriaButton, DropIndicator, GridList, useDragAndDrop } from "react-aria-components"
import { lucideNode } from "../src/lucide-catalog"
import { type IconImageApi, iconImageUrl } from "../src/repository-icon-images"
import { IconButton } from "./controls"
import { DenseRow } from "./dense-row"
import { AddIcon, CollapsePanelIcon, ExpandPanelIcon } from "./icons"
import { repositoryName } from "./repositories"
import { Button } from "./ui/Button"
import { GripVertical } from "./ui/icons"
import { MenuItem } from "./ui/Menu"

interface RepositoryPanelProps {
    repositories: OpenRepository[]
    activeId?: string
    api: IconImageApi
    onSelect(id: string): void
    /** Receives every open repository's id in the new order. */
    onReorder(ids: string[]): void
    onClose(id: string): void
    onAdd(): void
}

/** Open repositories in a collapsible side panel, reordered by drag, keyboard drag, or Ctrl+Shift+< and >. */
export function RepositoryPanel(props: RepositoryPanelProps) {
    let [collapsed, setCollapsed] = useState(false)
    return (
        <aside className={collapsed ? "repository-panel collapsed" : "repository-panel"} aria-label="Open repositories">
            {!collapsed && <div className="panel-heading">Repositories</div>}
            <RepositoryList {...props} collapsed={collapsed} />
            <div className="panel-footer">
                {collapsed
                    ? (
                        <IconButton label="Add repository" onPress={props.onAdd}>
                            <AddIcon />
                        </IconButton>
                    )
                    : (
                        <Button variant="quiet" onPress={props.onAdd}>
                            <AddIcon />
                            Add repository
                        </Button>
                    )}
                <IconButton label={collapsed ? "Expand repository panel" : "Collapse repository panel"} onPress={() => setCollapsed(!collapsed)}>
                    {collapsed ? <ExpandPanelIcon /> : <CollapsePanelIcon />}
                </IconButton>
            </div>
        </aside>
    )
}

function RepositoryList({ repositories, activeId, api, onSelect, onReorder, onClose, collapsed }: RepositoryPanelProps & { collapsed: boolean }) {
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
                onAction={key => onSelect(String(key))}
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
                            menu={{ label: `Actions for ${name}`, items: () => <RepositoryMenuItems onClose={() => onClose(repository.id)} /> }}
                        >
                            {({ isFocusVisibleWithin, actions }) => (
                                <div className="repository-content" title={collapsed ? `${name}\n${path}` : path}>
                                    <AriaButton slot="drag" className="drag-handle" data-visible={isFocusVisibleWithin || undefined}>
                                        <GripVertical />
                                    </AriaButton>
                                    <RepositoryTile repository={repository} name={name} api={api} isActive={isActive} />
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

function RepositoryMenuItems({ onClose }: { onClose(): void }) {
    return (
        <>
            <MenuItem>Customize…</MenuItem>
            <MenuItem onAction={onClose}>Close repository</MenuItem>
        </>
    )
}

/**
 * A Repository Icon on a 20-unit tile drawn at 28px. Initials, monograms, emoji, Lucide icons, and
 * images all fit the same tile; images and the Lucide catalog show initials until they load.
 */
function RepositoryTile({ repository, name, api, isActive }: { repository: OpenRepository; name: string; api: IconImageApi; isActive: boolean }) {
    let [, loaded] = useReducer((count: number) => count + 1, 0)
    let icon = repository.icon ?? (repository.status == "available" && repository.favicon ? { kind: "image" as const, path: repository.favicon } : undefined)
    let content: ReactNode
    if (icon?.kind == "image") {
        let url = iconImageUrl(api, icon.path, loaded)
        if (url)
            content = <image href={url} x={2} y={2} width={16} height={16} preserveAspectRatio="xMidYMid meet" />
    } else if (icon?.kind == "emoji")
        content = <text {...centredText} y={14.6} fontSize={12}>{icon.emoji}</text>
    else if (icon?.kind == "monogram")
        content = <text {...centredText} className="tile-text" data-tone={icon.color}>{icon.text}</text>
    else if (icon?.kind == "icon") {
        let node = lucideNode(icon.name, loaded)
        if (node) {
            content = (
                <g
                    data-tone={icon.color}
                    transform="translate(4 4) scale(0.5)"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    {node.map(([tag, attributes], index) => createElement(tag, { key: index, ...attributes }))}
                </g>
            )
        }
    }
    // Initials fill with the accent when active, as they do in the current rail.
    let isInitials = content == undefined
    return (
        <svg viewBox="0 0 20 20" className="tile" aria-hidden>
            <rect
                x={0.5}
                y={0.5}
                width={19}
                height={19}
                rx={4.5}
                className="tile-frame"
                data-filled={(isActive && isInitials) || undefined}
                data-missing={repository.status != "available" || undefined}
            />
            {isInitials
                ? <text {...centredText} className="tile-text" data-inverse={isActive || undefined}>{repositoryInitials(name)}</text>
                : content}
        </svg>
    )
}

let centredText = { x: 10, y: 13.4, textAnchor: "middle", fontSize: 8, fontWeight: 700 } as const
