import { useSyncExternalStore } from "react"
import type { Store } from "./store"

export function useSnapshot<T>(store: Store<T>) {
    return useSyncExternalStore(store.subscribe, store.snapshot)
}
