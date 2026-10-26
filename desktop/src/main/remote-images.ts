import type { RemoteImageResult } from "@laneway/shared"

/** Pictures larger than this aren't shown, as with pictures in the repository. */
export let remoteImageLimit = 20 * 1024 * 1024

let timeout = 20_000

/**
 * Downloads a picture a Markdown document shows from the web. Main downloads it so the renderer's CSP never allows
 * remote content: only http and https addresses, only image responses, and nothing past the size limit.
 */
export async function readRemoteImage(
    url: string,
    fetch: (url: string, init: RequestInit) => Promise<Response>,
    limit = remoteImageLimit,
): Promise<RemoteImageResult> {
    let address = URL.parse(url)
    if (address?.protocol != "http:" && address?.protocol != "https:")
        return { ok: false, reason: "Only pictures from the web can be downloaded." }

    try {
        let response = await fetch(address.href, { signal: AbortSignal.timeout(timeout), credentials: "omit" })
        let mimeType = response.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() ?? ""
        if (!response.ok) {
            await response.body?.cancel()
            return { ok: false, reason: `The server answered ${response.status}.` }
        } else if (!mimeType.startsWith("image/")) {
            await response.body?.cancel()
            return { ok: false, reason: "This address isn't a picture." }
        } else {
            let bytes = await readLimited(response, limit)
            return bytes ? { ok: true, bytes, mimeType } : { ok: false, reason: `This picture is larger than ${Math.round(limit / 1024 / 1024)} MB.` }
        }
    } catch (error) {
        return { ok: false, reason: (error as Error).name == "TimeoutError" ? "The picture took too long to download." : "The picture couldn't be downloaded." }
    }
}

/** A response's body, or nothing once it passes the limit. */
async function readLimited(response: Response, limit: number) {
    if (Number(response.headers.get("content-length")) > limit) {
        await response.body?.cancel()
        return undefined
    }

    let reader = response.body!.getReader()
    let chunks: Uint8Array[] = []
    let length = 0
    let done = false
    while (!done && length <= limit) {
        let next = await reader.read()
        done = next.done
        if (next.value) {
            chunks.push(next.value)
            length += next.value.length
        }
    }
    if (!done)
        await reader.cancel()
    return length > limit ? undefined : new Uint8Array(Buffer.concat(chunks))
}
