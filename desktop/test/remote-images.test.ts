import { afterAll, expect, test } from "bun:test"
import { readRemoteImage } from "../src/main/remote-images"

let picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
let server = Bun.serve({
    port: 0,
    fetch(request) {
        let path = new URL(request.url).pathname
        if (path == "/logo.png")
            return new Response(picture, { headers: { "content-type": "image/png" } })
        if (path == "/badge.svg")
            return new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", { headers: { "content-type": "image/svg+xml; charset=utf-8" } })
        if (path == "/page")
            return new Response("<html></html>", { headers: { "content-type": "text/html" } })
        if (path == "/large.png")
            return new Response(new Uint8Array(64), { headers: { "content-type": "image/png" } })
        return new Response("missing", { status: 404 })
    },
})
afterAll(() => server.stop(true))

let read = (path: string, limit?: number) => readRemoteImage(`${server.url.origin}${path}`, fetch, limit)

test("readRemoteImage downloads a picture with its type", async () => {
    expect(await read("/logo.png")).toEqual({ ok: true, bytes: picture, mimeType: "image/png" })
    expect(await read("/badge.svg")).toMatchObject({ ok: true, mimeType: "image/svg+xml" })
})

test("readRemoteImage refuses what isn't a picture from the web", async () => {
    expect(await read("/page")).toEqual({ ok: false, reason: "This address isn't a picture." })
    expect(await read("/gone.png")).toEqual({ ok: false, reason: "The server answered 404." })
    expect(await readRemoteImage("file:///C:/Windows/win.ini", fetch)).toEqual({ ok: false, reason: "Only pictures from the web can be downloaded." })
})

test("readRemoteImage refuses a picture past the size limit", async () => {
    expect(await read("/large.png", 32)).toEqual({ ok: false, reason: expect.stringContaining("larger than") })
})
