/** @jsxImportSource react */
import { createContext, type ReactNode, type RefObject, useContext, useState } from "react"
import { Menu } from "./ui/Menu"
import { Popover } from "./ui/Popover"

export interface ContextMenuRequest {
    /** Where the menu opens: the pointer, or under the target for the keyboard. Focus returns to the target. */
    target: RefObject<HTMLElement | null>
    point: DOMRect
    keyboard: boolean
    label: string
    items(): ReactNode
}

let OpenContextMenu = createContext<(request: ContextMenuRequest) => void>(() => {})

/**
 * Hosts the app's one context menu. It renders outside every collection: a menu inside a row would
 * pass its focus events to the row's list through React's portal bubbling, and the list would then
 * keep focus from returning to the row when the menu closes.
 */
export function ContextMenuHost({ children }: { children: ReactNode }) {
    let [opened, setOpened] = useState<ContextMenuRequest & { id: number }>()
    let close = () => setOpened(undefined)
    let open = (request: ContextMenuRequest) => setOpened(current => ({ ...request, id: (current?.id ?? 0) + 1 }))
    return (
        <OpenContextMenu value={open}>
            {children}
            {opened && (
                <Popover
                    key={opened.id}
                    trigger="MenuTrigger"
                    triggerRef={opened.target}
                    getTargetRect={() => opened.point}
                    placement="bottom start"
                    offset={0}
                    isOpen
                    onOpenChange={isOpen => isOpen || close()}
                >
                    <Menu aria-label={opened.label} autoFocus={opened.keyboard ? "first" : true} onClose={close}>
                        {opened.items()}
                    </Menu>
                </Popover>
            )}
        </OpenContextMenu>
    )
}

export function useContextMenu() {
    return useContext(OpenContextMenu)
}
