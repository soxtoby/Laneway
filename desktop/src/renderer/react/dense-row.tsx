/** @jsxImportSource react */
import clsx from "clsx"
import { type MouseEvent, type ReactNode, useRef } from "react"
import { GridListItem, type GridListItemProps, type GridListItemRenderProps } from "react-aria-components"
import { useContextMenu } from "./context-menu"
import { MoreMenu } from "./controls"

interface DenseRowProps extends Omit<GridListItemProps, "children" | "className" | "onContextMenu"> {
    textValue: string
    className?: string
    /** The row's actions: its context menu and its hover menu button show the same items. */
    menu?: { label: string; items(): ReactNode }
    /** Draws the row; `actions` is its hover menu button, placed where the row wants it. */
    children(state: GridListItemRenderProps & { actions: ReactNode }): ReactNode
}

/**
 * A row of one of Laneway's dense lists, which are React Aria GridLists. Right-click opens the row's
 * menu at the pointer; Shift+F10 or the context menu key opens it under the row.
 */
export function DenseRow({ className, menu, children, ...props }: DenseRowProps) {
    let row = useRef<HTMLDivElement>(null)
    let openContextMenu = useContextMenu()

    let openMenu = (event: MouseEvent<HTMLDivElement>) => {
        // Right-clicks inside the row's hover menu reach here through React's portal bubbling.
        if (!menu || !row.current?.contains(event.target as Node))
            return
        event.preventDefault()
        let keyboard = event.button != 2
        // A right-click doesn't focus the row, and the menu returns focus to wherever it was.
        if (!row.current.contains(document.activeElement))
            row.current.focus({ preventScroll: true })
        let rect = row.current.getBoundingClientRect()
        let point = keyboard ? new DOMRect(rect.left, rect.bottom, 0, 0) : new DOMRect(event.clientX, event.clientY, 0, 0)
        openContextMenu({ target: row, point, keyboard, ...menu })
    }

    return (
        <GridListItem {...props} ref={row} className={clsx("dense-row", className)} onContextMenu={menu && openMenu}>
            {state =>
                children({
                    ...state,
                    actions: menu && (
                        <span className="row-actions" data-visible={state.isHovered || state.isFocusVisibleWithin || undefined}>
                            <MoreMenu label={menu.label}>{menu.items()}</MoreMenu>
                        </span>
                    ),
                })}
        </GridListItem>
    )
}
