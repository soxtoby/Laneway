import { useSyncExternalStore } from "react"

/** A framework-free controller as React views read it. */
export interface Store<T> {
    subscribe(listener: () => void): () => void
    snapshot(): T
}

export function useSnapshot<T>(store: Store<T>) {
    return useSyncExternalStore(store.subscribe, store.snapshot)
}
