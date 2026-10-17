// Icon images arrive as bytes over IPC and become blob URLs, which the strict CSP allows in <img>.
// Each path loads once; a failed or unreadable image is remembered as missing so tiles fall back.

type ImageEntry = { url?: string; failed: boolean; waiting: Set<() => void> }

let images = new Map<string, ImageEntry>()

export interface IconImageApi {
    readIconImage: Window["laneway"]["readIconImage"]
}

/**
 * The blob URL for an icon image path, or nothing while it loads or when it cannot be shown. `loaded`
 * fires once when a pending image resolves either way, so callers re-render and take the final answer.
 */
export function iconImageUrl(api: IconImageApi, path: string, loaded: () => void): string | undefined {
    let entry = images.get(path)
    if (entry) {
        if (!entry.url && !entry.failed)
            entry.waiting.add(loaded)
        return entry.url
    }

    let pending: ImageEntry = { failed: false, waiting: new Set([loaded]) }
    images.set(path, pending)
    void api.readIconImage(path).then(image => {
        if (image)
            pending.url = URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.mime }))
        else
            pending.failed = true
    }, () => pending.failed = true).then(() => {
        let waiting = [...pending.waiting]
        pending.waiting.clear()
        for (let notify of waiting)
            notify()
    })
    return undefined
}

/** Forgets a path so its next use reads the file again, such as after choosing a replacement image. */
export function forgetIconImage(path: string) {
    let entry = images.get(path)
    if (entry?.url)
        URL.revokeObjectURL(entry.url)
    images.delete(path)
}
