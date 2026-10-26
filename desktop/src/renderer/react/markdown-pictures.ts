import { useSyncExternalStore } from "react"

// Pictures that rendered Markdown shows. Each arrives as bytes over IPC, from the repository or downloaded by main
// from the web, and becomes a blob URL, which the strict CSP allows in <img>. Each loads once, when a view first
// shows it, and the least recently loaded go once there are many that nothing shows. A picture that failed is
// forgotten once nothing shows it, so it's tried again next time, such as once it's been added or the network's back.

/** Where a picture comes from: the web, or one version of the repository the document is in. */
export type PictureSource = { kind: "web"; url: string } | { kind: "repository"; side: "old" | "new"; path: string }

export type PictureState = { state: "loading" } | { state: "ready"; url: string } | { state: "failed"; reason: string }

/** Reads a picture's bytes and type, or throws why it can't be shown. */
export type PictureLoad = () => Promise<{ bytes: Uint8Array; mimeType: string }>

let pictures = new Map<string, PictureState>()
let watchers = new Map<string, Set<() => void>>()
let retained = 200

let loading: PictureState = { state: "loading" }

/**
 * Where a picture in a Markdown document comes from, by its `src`: web addresses as they are, and other paths
 * relative to the document, or to the repository's root when they start with a slash. Nothing for other schemes or
 * for paths that leave the repository.
 */
export function pictureSource(src: string, side: "old" | "new", documentPath: string): PictureSource | undefined {
    let address = URL.parse(src.startsWith("//") ? `https:${src}` : src)
    if (address)
        return address.protocol == "http:" || address.protocol == "https:" ? { kind: "web", url: address.href } : undefined

    let path = decodePath(src.split(/[?#]/)[0]!)
    let directory = documentPath.split("/").slice(0, -1)
    let resolved = path == undefined ? undefined : normalize(path.startsWith("/") ? path.split("/") : [...directory, ...path.split("/")])
    return resolved ? { kind: "repository", side, path: resolved } : undefined
}

/** A picture's state, loading it the first time a view shows it; views showing it render again as it loads. */
export function usePicture(key: string | undefined, load: PictureLoad): PictureState | undefined {
    return useSyncExternalStore(
        changed => key == undefined ? () => {} : watch(key, load, changed),
        () => key == undefined ? undefined : pictures.get(key) ?? loading,
    )
}

function watch(key: string, load: PictureLoad, changed: () => void) {
    let watching = watchers.get(key) ?? new Set()
    watchers.set(key, watching)
    watching.add(changed)
    if (!pictures.has(key))
        start(key, load)
    return () => {
        watching.delete(changed)
        if (watching.size == 0) {
            watchers.delete(key)
            // A view resubscribes as it renders again, so a failure is only forgotten once nothing came back for it.
            setTimeout(() => {
                if (!watchers.has(key) && pictures.get(key)?.state == "failed")
                    pictures.delete(key)
            })
        }
    }
}

function start(key: string, load: PictureLoad) {
    pictures.set(key, loading)
    load().then(
        ({ bytes, mimeType }) => settle(key, { state: "ready", url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType })) }),
        failure => settle(key, { state: "failed", reason: failure instanceof Error ? failure.message : String(failure) }),
    )
}

function settle(key: string, state: PictureState) {
    pictures.delete(key)
    pictures.set(key, state)
    forgetUnwatched()
    for (let changed of watchers.get(key) ?? [])
        changed()
}

// Maps keep insertion order, and a settled picture moves to the end, so the first unwatched ones loaded longest ago.
function forgetUnwatched() {
    let excess = pictures.size - retained
    let forgotten = [...pictures].filter(([key, state]) => !watchers.has(key) && state.state != "loading").slice(0, Math.max(excess, 0))
    for (let [key, state] of forgotten) {
        pictures.delete(key)
        if (state.state == "ready")
            URL.revokeObjectURL(state.url)
    }
}

function decodePath(path: string) {
    try {
        return decodeURIComponent(path)
    } catch {
        return undefined
    }
}

function normalize(parts: string[]) {
    let kept: string[] = []
    let escaped = false
    for (let part of parts) {
        if (part == "..")
            escaped ||= kept.pop() == undefined
        else if (part != "." && part != "")
            kept.push(part)
    }
    return escaped || kept.length == 0 ? undefined : kept.join("/")
}
