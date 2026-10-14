import { css, type Handle, on } from "remix/ui"

export let minimumColumnWidth = 310

// The divider sits in the gap after its column, clear of the column's scrollbar; its negative margins cancel
// the extra flex gap it would otherwise add.
let columnDivider = css({
    position: "relative",
    zIndex: "2",
    flex: "0 0 var(--gutter)",
    alignSelf: "stretch",
    margin: "0 calc(-1 * var(--gutter))",
    cursor: "col-resize",
    "&:focus-visible": {
        outline: "2px solid var(--ring)",
        outlineOffset: "0",
    },
    // Between a column and its auxiliary columns, the divider is the seam of their shared card: it carries the card's
    // outline across the gap and still resizes the column.
    "&.attached": {
        borderInline: "1px solid var(--line)",
        background: "var(--panel-deep)",
        boxShadow: "0 -1px 0 var(--line-strong), 0 1px 0 var(--line-strong)",
    },
    "&.attached:hover, &.attached:focus-visible": { background: "var(--accent-wash-strong)" },
})

/** Resizes the column immediately before it: by dragging, by keyboard, or back to its default width on a double-click. */
export function ColumnDivider(
    handle: Handle<{
        id: string
        label: string
        width: number
        defaultWidth: number
        minWidth?: number
        attached: boolean
        resize(id: string, width: number): void
    }>,
) {
    // Sizes the column ahead of the resize and returns its new width. A split column is capped to keep its auxiliary
    // columns in view, so its width is read back rather than assumed.
    let applyWidth = (divider: HTMLElement, width: number) => {
        let column = divider.previousElementSibling as HTMLElement | null
        width = Math.max(handle.props.minWidth ?? minimumColumnWidth, width)
        if (column)
            column.style.width = `${width}px`

        return column?.classList.contains("split") ? column.getBoundingClientRect().width : width
    }
    return () => (
        <div
            class={`column-divider ${handle.props.attached ? "attached" : ""}`}
            role="separator"
            tabIndex={0}
            aria-label={handle.props.label}
            aria-orientation="vertical"
            aria-valuemin={handle.props.minWidth ?? minimumColumnWidth}
            aria-valuemax={2000}
            aria-valuenow={Math.round(handle.props.width)}
            mix={[
                columnDivider,
                on("keydown", event => {
                    let step = event.shiftKey ? 50 : 10
                    let width = event.key == "ArrowLeft" || event.key == "ArrowRight"
                        ? handle.props.width + (event.key == "ArrowLeft" ? -step : step)
                        : event.key == "Home"
                        ? handle.props.minWidth ?? minimumColumnWidth
                        : event.key == "End"
                        ? document.querySelector<HTMLElement>(".graph-layout")?.clientWidth ?? 1180
                        : undefined
                    if (width != undefined) {
                        event.preventDefault()
                        handle.props.resize(handle.props.id, applyWidth(event.currentTarget, width))
                    }
                }),
                on("pointerdown", event => {
                    event.preventDefault()
                    let startX = event.clientX
                    let startWidth = handle.props.width
                    let divider = event.currentTarget
                    let move = (next: PointerEvent) => applyWidth(divider, startWidth + next.clientX - startX)
                    let end = (next: PointerEvent) => {
                        window.removeEventListener("pointermove", move)
                        window.removeEventListener("pointerup", end)
                        handle.props.resize(handle.props.id, applyWidth(divider, startWidth + next.clientX - startX))
                    }
                    window.addEventListener("pointermove", move)
                    window.addEventListener("pointerup", end, { once: true })
                }),
                on("dblclick", event => handle.props.resize(handle.props.id, applyWidth(event.currentTarget, handle.props.defaultWidth))),
            ]}
        >
        </div>
    )
}
