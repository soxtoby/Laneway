import { useSyncExternalStore } from "react"

// Icon images arrive as bytes over IPC and become blob URLs, which the strict CSP allows in <img>.
// Each path loads once, when a view first shows it; a failed or unreadable image is remembered as missing so
// tiles fall back.

type ImageEntry = { url?: string }

let images = new Map<string, ImageEntry>()
let watchers = new Map<string, { api: IconImageApi; changed: Set<() => void> }>()

export interface IconImageApi {
    readIconImage: Window["laneway"]["readIconImage"]
}

/**
 * The blob URL for an icon image path, or nothing while it loads, when it cannot be shown, or without a path. Views
 * showing a path render again when it loads or is forgotten.
 */
export function useIconImage(api: IconImageApi, path?: string): string | undefined {
    return useSyncExternalStore(
        changed => path == undefined ? () => {} : watch(api, path, changed),
        () => path == undefined ? undefined : images.get(path)?.url,
    )
}

function watch(api: IconImageApi, path: string, changed: () => void) {
    let watching = watchers.get(path) ?? { api, changed: new Set() }
    watchers.set(path, watching)
    watching.changed.add(changed)
    load(api, path)
    return () => {
        watching.changed.delete(changed)
        if (watching.changed.size == 0)
            watchers.delete(path)
    }
}

function load(api: IconImageApi, path: string) {
    if (images.has(path))
        return
    let entry: ImageEntry = {}
    images.set(path, entry)
    let settle = (url?: string) => {
        // A path forgotten while it loaded is being read again.
        if (images.get(path) != entry) {
            if (url)
                URL.revokeObjectURL(url)
            return
        }
        entry.url = url
        notify(path)
    }
    void api.readIconImage(path).then(image => settle(image && URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.mime }))), () => settle())
}

function notify(path: string) {
    for (let changed of [...watchers.get(path)?.changed ?? []])
        changed()
}

/** Forgets a path so it is read again, such as after choosing a replacement image; views showing it read it at once. */
export function forgetIconImage(path: string) {
    let url = images.get(path)?.url
    if (url)
        URL.revokeObjectURL(url)
    images.delete(path)
    let watching = watchers.get(path)
    if (watching)
        load(watching.api, path)
    notify(path)
}
