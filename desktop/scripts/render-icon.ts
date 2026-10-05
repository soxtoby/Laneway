// Rasterizes the brand icon with Electron's own Chromium, since window and dock icons cannot be SVG.
// Run with `bun run --cwd desktop icons`; it writes desktop/resources/icon.ico and icon.png.
import { app, BrowserWindow } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

let desktop = resolve(fileURLToPath(import.meta.url), "../..")
let source = join(desktop, "../assets/brand/laneway-icon.svg")
let output = join(desktop, "resources")
let icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
let pngSize = 512

app.disableHardwareAcceleration()
app.commandLine.appendSwitch("force-device-scale-factor", "1")

let canvas = 512

void app.whenReady().then(async () => {
    let svg = await readFile(source, "utf8")
    await mkdir(output, { recursive: true })

    let render = await openRenderer(svg)
    let images: Buffer[] = []
    for (let size of icoSizes)
        images.push(await render(size))

    await writeFile(join(output, "icon.ico"), ico(images))
    await writeFile(join(output, "icon.png"), await render(pngSize))
    console.log(`Wrote ${join(output, "icon.ico")} (${icoSizes.join(", ")}) and icon.png (${pngSize})`)
}).catch(error => {
    console.error(error)
    process.exitCode = 1
}).finally(() => app.quit())

// One offscreen window renders every size; capturing a sub-rectangle sidesteps the platform's minimum window size.
async function openRenderer(svg: string) {
    let window = new BrowserWindow({
        width: canvas,
        height: canvas,
        show: false,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true, sandbox: true },
    })
    let image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    let page =
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block}</style></head><body><img src="${image}"></body></html>`

    await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString("base64")}`)
    await window.webContents.executeJavaScript("document.querySelector('img').decode()")

    return async function render(size: number) {
        await window.webContents.executeJavaScript(
            `(() => { let img = document.querySelector('img'); img.style.width = img.style.height = '${size}px'; return new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))) })()`,
        )
        let capture = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
        let { width, height } = capture.getSize()
        if (width != size || height != size)
            throw new Error(`Rendered ${width}x${height} instead of ${size}x${size}`)
        return capture.toPNG()
    }
}

// ICO files are a directory of images; PNG-compressed entries are supported from Windows Vista onwards.
function ico(images: Buffer[]) {
    let header = Buffer.alloc(6)
    header.writeUInt16LE(0, 0)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(images.length, 4)

    let entries: Buffer[] = []
    let offset = 6 + 16 * images.length
    for (let [index, image] of images.entries()) {
        let size = icoSizes[index]!
        let entry = Buffer.alloc(16)
        entry.writeUInt8(size == 256 ? 0 : size, 0)
        entry.writeUInt8(size == 256 ? 0 : size, 1)
        entry.writeUInt8(0, 2)
        entry.writeUInt8(0, 3)
        entry.writeUInt16LE(1, 4)
        entry.writeUInt16LE(32, 6)
        entry.writeUInt32LE(image.length, 8)
        entry.writeUInt32LE(offset, 12)

        entries.push(entry)
        offset += image.length
    }

    return Buffer.concat([header, ...entries, ...images])
}
