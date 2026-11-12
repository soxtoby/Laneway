import { createContext, useContext, useSyncExternalStore } from "react"
import type { RepositoryStore, Store } from "./store"

export function useSnapshot<T>(store: Store<T>) {
    return useSyncExternalStore(store.subscribe, store.snapshot)
}

/** One value from a store's snapshot, such as a flag, re-rendering only when that value changes. */
export function useSnapshotValue<T, V>(store: Store<T>, select: (snapshot: T) => V) {
    return useSyncExternalStore(store.subscribe, () => select(store.snapshot()))
}

/**
 * The repository whose work the views inside show. Every open repository keeps its views, hidden while another
 * shows, so they read their own repository's snapshots rather than the active repository's.
 */
export let RepositoryScope = createContext<string | undefined>(undefined)

/** A repository's snapshot, which stays the same object, rendering nothing again, while another repository is active. */
export function useRepositorySnapshot<T>(store: RepositoryStore<T>, repositoryId: string) {
    return useSyncExternalStore(store.subscribe, () => store.snapshotFor(repositoryId))
}

/** One value from the snapshot of the repository in scope, or of the active repository outside any. */
export function useScopedSnapshotValue<T, V>(store: RepositoryStore<T>, select: (snapshot: T) => V) {
    let repositoryId = useContext(RepositoryScope)
    return useSyncExternalStore(store.subscribe, () => select((repositoryId ? store.snapshotFor(repositoryId) : undefined) ?? store.snapshot()))
}
