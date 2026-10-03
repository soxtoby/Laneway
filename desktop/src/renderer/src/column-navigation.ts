/**
 * Arrow-key movement through a Workspace Column's navigable rows: branch headings, commit headings, and files,
 * in the order they appear. Hidden rows, such as a collapsed commit's files, are skipped.
 */
// The row's disclosure button, not its drag handle or checkbox.
const itemSelector = ".stack-heading, .commit-heading, .change-file > button[aria-expanded]"

export function columnItems(column: Element): HTMLElement[] {
    return [...column.querySelectorAll<HTMLElement>(itemSelector)].filter(item => !item.hasAttribute("disabled") && visible(item))
}

/** The navigable row containing `element`, if any. */
export function columnItem(element: Element): HTMLElement | null {
    return element.closest<HTMLElement>(itemSelector)
}

export function isFileItem(item: Element) {
    return item.parentElement?.classList.contains("change-file") ?? false
}

/** The row that discloses `item`: a file's commit heading, or a commit's branch heading. */
export function parentItem(item: HTMLElement): HTMLElement | null {
    const owner = isFileItem(item) ? item.closest(".inspect-commit") : item.classList.contains("commit-heading") ? item.closest(".stack-branch") : null
    const parent = owner?.querySelector<HTMLElement>(isFileItem(item) ? ".commit-heading" : ".stack-heading") ?? null
    return parent && visible(parent) ? parent : null
}

/**
 * The row `delta` steps from `target`. From anywhere else in the column, the nearest row in that direction;
 * from the column itself, its first or last row.
 */
export function stepItem(column: HTMLElement, target: HTMLElement, delta: 1 | -1): HTMLElement | undefined {
    const items = columnItems(column)
    const current = columnItem(target)
    const index = current ? items.indexOf(current) : -1
    if (index >= 0)
        return items[index + delta]
    if (target == column)
        return delta > 0 ? items[0] : items.at(-1)
    const preceding = items.filter(item => target.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING).length
    return items[delta > 0 ? preceding : preceding - 1]
}

/** Focuses a row and brings it out from under the column's sticky headings. */
export function focusItem(item: HTMLElement) {
    item.focus({ preventScroll: true })
    item.scrollIntoView({ block: "nearest", behavior: scrollBehavior() })
}

/** Smooth, unless the user asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
}

// Collapsed commits and branches hide their rows with `hidden`, and file trees fold directories with `details`.
// Walking those attributes is enough, and avoids checkVisibility's full style computation in tests.
function visible(element: HTMLElement) {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        if (node.hidden)
            return false
        const parent = node.parentElement
        if (parent?.tagName == "DETAILS" && !parent.hasAttribute("open") && node.tagName != "SUMMARY")
            return false
    }
    return true
}
