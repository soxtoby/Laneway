let { app, BrowserWindow, nativeImage } = require("electron")
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let directory = process.argv[2]
let screenshots = process.env.IMAGE_DIFF_SCREENSHOTS
app.setPath("userData", join(directory, "profile"))
app.whenReady().then(async () => {
    let window = new BrowserWindow({
        show: Boolean(screenshots),
        width: 900,
        height: 600,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    })
    let messages = []
    window.webContents.on("console-message", (_event, _level, message) => messages.push(message))
    try {
        await window.loadFile(join(directory, "index.html"))
        let images = { old: picture(120, 80, 40).toString("base64"), new: picture(160, 100, 60).toString("base64") }
        await window.webContents.executeJavaScript(`window.mountImageDiff(${JSON.stringify(images)})`)
        if (screenshots) {
            for (let mode of ["side-by-side", "swipe", "onion", "difference"]) {
                await window.webContents.executeJavaScript(`window.imageDiffMode(${JSON.stringify(mode)})`)
                writeFileSync(join(screenshots, `${mode}.png`), (await window.webContents.capturePage()).toPNG())
            }
            await window.webContents.executeJavaScript(`window.imageDiffMode("side-by-side")`)
        }
        let result = await window.webContents.executeJavaScript(
            "(async () => { try { return await window.imageDiffChecks() } catch (error) { return { error: error.stack, text: document.body.innerText } } })()",
        )
        writeFileSync(join(directory, "result.json"), JSON.stringify({ ...result, messages }))
        app.quit()
    } catch (error) {
        writeFileSync(join(directory, "result.json"), JSON.stringify({ error: String(error), messages }))
        app.exit(1)
    }
})

// A red card with a blue disc, so the modes have something recognizable to compare.
function picture(width, height, radius) {
    let bitmap = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 <= radius ** 2
            bitmap.set(inside ? [220, 90, 30, 255] : [40, 50, 200, 255], (y * width + x) * 4)
        }
    }
    return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
}
