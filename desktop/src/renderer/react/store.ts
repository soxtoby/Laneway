/** A framework-free controller's state: a snapshot that is a new object after every change. */
export interface Store<T> {
    subscribe(listener: () => void): () => void
    /** The same object until something changes, as `useSyncExternalStore` requires. */
    snapshot(): T
}

export function createStore<T>(initial: T) {
    let snapshot = initial
    let listeners = new Set<() => void>()
    return {
        subscribe(listener: () => void) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },
        snapshot: () => snapshot,
        publish(next: T) {
            snapshot = next
            for (let listener of listeners)
                listener()
        },
        clear() {
            listeners.clear()
        },
    }
}
