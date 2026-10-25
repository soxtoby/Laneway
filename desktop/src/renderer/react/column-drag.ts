/** A Workspace Column's extent across the row: its card, then its divider and auxiliary columns. */
export interface ColumnSpan {
    id: string
    left: number
    right: number
}

/** The spans of a row's columns: each group, holding a card that carries `data-column-id` and what belongs to it. */
export function columnSpans(row: Element): ColumnSpan[] {
    return [...row.children].flatMap(group => {
        let id = group.querySelector<HTMLElement>("[data-column-id]")?.dataset.columnId
        let rect = group.getBoundingClientRect()
        return id ? [{ id, left: rect.left, right: rect.right }] : []
    })
}

/**
 * The column a dragged column should take the place of: the one under the pointer, or the first or last past
 * either end. It moves only once the pointer is where the dragged column would then sit, so a column narrower
 * than the one it passes doesn't swap back and forth under a still pointer.
 */
export function columnDropTarget(spans: ColumnSpan[], draggedId: string, x: number) {
    let from = spans.findIndex(span => span.id == draggedId)
    if (from < 0 || spans.length < 2)
        return undefined
    let to = x < spans[0].left
        ? 0
        : x >= spans.at(-1)!.right
        ? spans.length - 1
        : spans.findIndex(span => x >= span.left && x < span.right)
    if (to < 0 || to == from)
        return undefined
    let width = spans[from].right - spans[from].left
    let reached = to > from ? x >= spans[to].right - width : x < spans[to].left + width
    return reached ? spans[to].id : undefined
}
