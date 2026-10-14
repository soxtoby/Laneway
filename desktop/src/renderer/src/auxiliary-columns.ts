export interface AuxiliaryColumn<T> {
    readonly id: string
    readonly sourceId: string
    readonly identity: string
    readonly value: T
    width: number
    dispose(): void
}

export let defaultAuxiliaryColumnWidth = 620

/** Session-only source tree. Root order belongs to Workspace State. */
export class AuxiliaryColumns<T> {
    private readonly roots = new Set<string>()
    private readonly columns = new Map<string, AuxiliaryColumn<T>>()
    private readonly children = new Map<string, string[]>()
    private nextId = 0
    focusedId?: string

    addRoot(id: string) {
        this.roots.add(id)
    }

    open(sourceId: string, identity: string, create: () => { value: T; dispose(): void }, width = defaultAuxiliaryColumnWidth) {
        if (!this.roots.has(sourceId) && !this.columns.has(sourceId))
            throw new Error("The auxiliary column source is unavailable.")

        let siblings = this.children.get(sourceId) ?? []
        let existing = siblings.map(id => this.columns.get(id)!).find(column => column.identity == identity)
        if (existing) {
            this.focusedId = existing.id
            return existing
        }
        let column = { ...create(), id: `auxiliary:${++this.nextId}`, sourceId, identity, width }
        this.columns.set(column.id, column)
        this.children.set(sourceId, [column.id, ...siblings])
        this.focusedId = column.id

        return column
    }

    descendants(sourceId: string): AuxiliaryColumn<T>[] {
        return (this.children.get(sourceId) ?? []).flatMap(id => [this.columns.get(id)!, ...this.descendants(id)])
    }

    close(id: string) {
        let column = this.columns.get(id)
        let focused = this.focusedId == id || this.descendants(id).some(child => child.id == this.focusedId)
        // Detach before disposal so cleanup may safely close related resources.
        let descendants = this.descendants(id).reverse()
        let removed = column ? [...descendants, column] : descendants
        for (let child of removed) {
            this.columns.delete(child.id)
            this.children.delete(child.id)
        }
        this.children.delete(id)
        this.roots.delete(id)
        if (column)
            this.children.set(column.sourceId, (this.children.get(column.sourceId) ?? []).filter(child => child != id))
        if (focused)
            this.focusedId = column?.sourceId
        for (let child of removed)
            child.dispose()
    }
}

/**
 * Auxiliary columns extend their source column's card: square where they join it, rounded at the card's far end.
 * Each keeps its own resizable width, set inline, except the last beside a maximized column, which takes the space
 * the others leave.
 */
export let auxiliaryColumnFrame = {
    flex: "0 0 auto",
    width: `${defaultAuxiliaryColumnWidth}px`,
    overflow: "auto",
    background: "var(--panel)",
    borderRadius: "0 var(--radius-card) var(--radius-card) 0",
    boxShadow: "0 0 0 1px var(--line-strong), var(--card-shadow)",
    "&:focus-visible": { outline: "2px solid var(--ring)", outlineOffset: "-2px" },
    // Auxiliary columns opened from one another sit flush, split by the divider they share.
    "&:has(+ .column-divider + [data-auxiliary-id])": { borderRadius: "0" },
    // Without its source column, it starts the row itself.
    ".branch-columns > &:first-child": { borderTopLeftRadius: "var(--radius-card)", borderBottomLeftRadius: "var(--radius-card)" },
    ".branch-columns.maximized > &:not(:has(+ .column-divider))": { flex: "1 1 0", minWidth: "310px" },
}

/** Matches the branch column header, so the header band runs on across the join. */
export let auxiliaryColumnHeader = {
    height: "46px",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "0 var(--scrollbar-clearance) 0 10px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel)",
}

/** Matches the branch column header's buttons. */
export let auxiliaryCloseButton = {
    flex: "0 0 auto",
    width: "28px",
    height: "28px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--muted)",
    border: "1px solid transparent",
    borderRadius: "var(--radius)",
    background: "transparent",
    "&:hover": { color: "var(--text)", borderColor: "var(--line)", background: "var(--control-hover)" },
}
