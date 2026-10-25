import { useSyncExternalStore } from "react"
import type { Store } from "./store"

export function useSnapshot<T>(store: Store<T>) {
    return useSyncExternalStore(store.subscribe, store.snapshot)
}

/** One value from a store's snapshot, such as a flag, re-rendering only when that value changes. */
export function useSnapshotValue<T, V>(store: Store<T>, select: (snapshot: T) => V) {
    return useSyncExternalStore(store.subscribe, () => select(store.snapshot()))
}
