import type { KeyboardEvent } from "react"

/**
 * Arrow-key movement through a Workspace Column's rows: base branch headings, commit headings, and file and folder
 * rows, in the order they show. Up and Down move across the column's lists. Right unfolds a commit or opens a file's
 * diff, and Left folds it or moves to the row it belongs to; folders fold as their tree folds them. With the diff
 * column open, moving onto a file shows it there.
 */
export function navigationKeyDown(event: KeyboardEvent<HTMLElement>, diffColumn: boolean) {
    let column = event.currentTarget
    let target = event.target
    if (
        !(target instanceof HTMLElement) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
        || target.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=listbox], [role=dialog], .file-diff")
    ) {
        return
    }
    let item = target.closest<HTMLElement>(itemSelector)
    if (event.key == "ArrowUp" || event.key == "ArrowDown") {
        event.preventDefault()
        event.stopPropagation()
        let next = step(column, item ?? target, event.key == "ArrowDown" ? 1 : -1)
        if (!next)
            return
        next.focus()
        if (diffColumn && isFile(next))
            next.click()
        return
    }
    // A folder row folds and unfolds as its tree does.
    if (!item || item.matches(".folder-row"))
        return
    let expanded = isFile(item) ? item.matches(".inspected, [data-active]") : item.getAttribute("aria-expanded") == "true"
    // A file shown in the diff column has nothing of its own to fold, so Left moves up from it.
    let folds = expanded && !(diffColumn && isFile(item))
    let up = event.key == "ArrowLeft" && !folds ? parent(item) : undefined
    // A long list draws only the rows near the view; when a row's folder isn't drawn, its tree moves to it instead.
    if (event.key == "ArrowLeft" && !folds && !up && Number(item.getAttribute("aria-level") ?? 1) > 1)
        return
    event.preventDefault()
    event.stopPropagation()
    if (event.key == "ArrowRight") {
        if (!expanded)
            item.click()
        return
    }
    if (folds)
        item.click()
    else
        up?.focus()
}

let itemSelector = ".stack-toggle, .commit-toggle, .file-tree [role=row]"

function isFile(item: HTMLElement) {
    return item.matches(".file-row")
}

function step(column: HTMLElement, from: HTMLElement, delta: 1 | -1) {
    let items = [...column.querySelectorAll<HTMLElement>(itemSelector)]
    let index = items.indexOf(from)
    if (index != -1)
        return items[index + delta]
    // From elsewhere in the column, the nearest row that way.
    let following = (item: HTMLElement) => (from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) != 0
    return delta == 1 ? items.find(following) : items.findLast(item => !following(item) && !item.contains(from))
}

/** The row `item` belongs to: a nested row's folder, a list's commit or stash, or a commit's branch. */
function parent(item: HTMLElement) {
    if (item.matches("[role=row]")) {
        let level = Number(item.getAttribute("aria-level") ?? 1)
        if (level > 1) {
            let rows = [...(item.closest(".file-tree")?.querySelectorAll<HTMLElement>("[role=row]") ?? [])]
            return rows.slice(0, rows.indexOf(item)).findLast(row => Number(row.getAttribute("aria-level")) == level - 1)
        }
        return item.closest(".trail-commit")?.querySelector<HTMLElement>(".commit-toggle")
            ?? item.closest(".branch-stash")?.querySelector<HTMLElement>(".branch-stash-toggle")
    }
    if (item.matches(".commit-toggle"))
        return item.closest(".stack-branch")?.querySelector<HTMLElement>(".stack-toggle")
    return undefined
}
