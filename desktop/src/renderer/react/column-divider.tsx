import clsx from "clsx"
import { type KeyboardEvent, type PointerEvent, useRef } from "react"

/** Resizes the element before it by dragging or the keyboard, and back to its default width on a double-click. */
export function ColumnDivider({ label, width, minimum, maximum, defaultWidth, attached, className, onResize }: {
    label: string
    width: number
    minimum: number
    /** The widest it may be in its row, which End sizes it to; without one it grows freely, and End fills the row. */
    maximum?(row: HTMLElement): number
    defaultWidth: number
    /** Whether it is the seam between a column and an auxiliary column joined onto its card. */
    attached?: boolean
    className?: string
    onResize(width: number): void
}) {
    let divider = useRef<HTMLDivElement>(null)
    let widest = () => {
        let row = divider.current?.parentElement
        return row && maximum ? Math.floor(maximum(row)) : Infinity
    }
    // A width beyond the maximum shows at the maximum, so it resizes from there.
    let current = () => Math.min(width, widest())
    // A drag sizes the element directly as it goes; the width saves once it ends.
    let size = (next: number) => {
        let clamped = Math.max(minimum, Math.min(widest(), Math.round(next)))
        let element = divider.current?.previousElementSibling
        if (element instanceof HTMLElement)
            element.style.width = `${clamped}px`
        return clamped
    }
    let keyDown = (event: KeyboardEvent) => {
        let step = event.shiftKey ? 50 : 10
        let next = event.key == "ArrowLeft" || event.key == "ArrowRight"
            ? current() + (event.key == "ArrowLeft" ? -step : step)
            : event.key == "Home"
            ? minimum
            : event.key == "End"
            ? maximum ? widest() : divider.current?.parentElement?.clientWidth ?? defaultWidth
            : undefined
        if (next != undefined) {
            event.preventDefault()
            onResize(size(next))
        }
    }
    let pointerDown = (event: PointerEvent) => {
        event.preventDefault()
        let startX = event.clientX
        let start = current()
        let move = (next: globalThis.PointerEvent) => size(start + next.clientX - startX)
        let end = (next: globalThis.PointerEvent) => {
            window.removeEventListener("pointermove", move)
            onResize(size(start + next.clientX - startX))
        }
        window.addEventListener("pointermove", move)
        window.addEventListener("pointerup", end, { once: true })
    }
    return (
        <div
            ref={divider}
            className={clsx("column-divider", attached && "attached", className)}
            role="separator"
            tabIndex={0}
            aria-label={label}
            aria-orientation="vertical"
            aria-valuemin={minimum}
            aria-valuemax={2000}
            aria-valuenow={width}
            onKeyDown={keyDown}
            onPointerDown={pointerDown}
            onDoubleClick={() => onResize(size(defaultWidth))}
        />
    )
}
