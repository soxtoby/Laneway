export interface AuxiliaryColumn<T> {
    readonly id: string
    readonly sourceId: string
    readonly identity: string
    readonly value: T
    width: number
    dispose(): void
}

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

    open(sourceId: string, identity: string, create: () => { value: T; dispose(): void }, width = 620) {
        if (!this.roots.has(sourceId) && !this.columns.has(sourceId))
            throw new Error("The auxiliary column source is unavailable.")
        const siblings = this.children.get(sourceId) ?? []
        const existing = siblings.map(id => this.columns.get(id)!).find(column => column.identity == identity)
        if (existing) {
            this.focusedId = existing.id
            return existing
        }
        const column = { ...create(), id: `auxiliary:${++this.nextId}`, sourceId, identity, width }
        this.columns.set(column.id, column)
        this.children.set(sourceId, [column.id, ...siblings])
        this.focusedId = column.id
        return column
    }

    descendants(sourceId: string): AuxiliaryColumn<T>[] {
        return (this.children.get(sourceId) ?? []).flatMap(id => [this.columns.get(id)!, ...this.descendants(id)])
    }

    close(id: string) {
        const column = this.columns.get(id)
        const focused = this.focusedId == id || this.descendants(id).some(child => child.id == this.focusedId)
        // Detach before disposal so cleanup may safely close related resources.
        const descendants = this.descendants(id).reverse()
        const removed = column ? [...descendants, column] : descendants
        for (const child of removed) {
            this.columns.delete(child.id)
            this.children.delete(child.id)
        }
        this.children.delete(id)
        this.roots.delete(id)
        if (column)
            this.children.set(column.sourceId, (this.children.get(column.sourceId) ?? []).filter(child => child != id))
        if (focused)
            this.focusedId = column?.sourceId
        for (const child of removed)
            child.dispose()
    }
}
