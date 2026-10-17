/** @jsxImportSource react */
import type { ComponentProps } from "react"
import { Pressable, type PressEvent } from "react-aria-components"

/**
 * Receives a MenuTrigger's right-click handling inside a collection row. A bare Pressable would
 * stop every press from reaching the row, so ordinary clicks continue on and still select.
 */
export function ContextMenuArea({ children }: { children: ComponentProps<typeof Pressable>["children"] }) {
    let pass = (event: PressEvent) => event.continuePropagation()
    return <Pressable onPressStart={pass} onPressEnd={pass} onPressUp={pass} onPress={pass}>{children}</Pressable>
}
