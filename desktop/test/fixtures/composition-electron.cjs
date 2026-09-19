const { app, BrowserWindow } = require("electron")
const { writeFileSync } = require("node:fs")
const { join } = require("node:path")
const directory = process.argv[2]
app.setPath("userData", join(directory, "profile"))
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    window.webContents.on("console-message", (_event, _level, message) => console.error(message))
    try {
        await window.loadFile(join(directory, "index.html"))
        const result = await window.webContents.executeJavaScript("(async () => { try { return await window.compositionChecks() } catch (error) { return { error: error.stack, requests: window.compositionRequests, text: document.body.innerText } } })()")
        writeFileSync(join(directory, "result.json"), JSON.stringify(result))
        app.quit()
    } catch (error) {
        writeFileSync(join(directory, "result.json"), JSON.stringify({ error: String(error) }))
        app.exit(1)
    }
})
