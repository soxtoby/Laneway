import { createContext, type ReactNode, type RefObject, useCallback, useContext, useState } from "react"
import { RootMenuTriggerStateContext } from "react-aria-components"
import { useMenuTriggerState } from "react-stately"
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
    // Every row reads this, so it stays the same function whenever the app re-renders.
    let open = useCallback((request: ContextMenuRequest) => setOpened(current => ({ ...request, id: (current?.id ?? 0) + 1 })), [])
    return (
        <OpenContextMenu value={open}>
            {children}
            {opened && <ContextMenu key={opened.id} request={opened} onClose={close} />}
        </OpenContextMenu>
    )
}

/**
 * One opening of the context menu. A choice in a submenu closes every menu through the root menu's trigger state,
 * which a menu has only inside a `MenuTrigger`, so the menu gets one of its own.
 */
function ContextMenu({ request, onClose }: { request: ContextMenuRequest; onClose(): void }) {
    let state = useMenuTriggerState({ isOpen: true, onOpenChange: isOpen => isOpen || onClose() })
    return (
        <RootMenuTriggerStateContext value={state}>
            <Popover
                trigger="MenuTrigger"
                triggerRef={request.target}
                getTargetRect={() => request.point}
                placement="bottom start"
                offset={0}
                isOpen
                onOpenChange={isOpen => isOpen || onClose()}
            >
                <Menu aria-label={request.label} autoFocus={request.keyboard ? "first" : true} onClose={onClose}>
                    {request.items()}
                </Menu>
            </Popover>
        </RootMenuTriggerStateContext>
    )
}

export function useContextMenu() {
    return useContext(OpenContextMenu)
}
