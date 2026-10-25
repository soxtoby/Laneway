let { app, BrowserWindow } = require("electron")
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let directory = process.argv[2]
app.setPath("userData", join(directory, "profile"))
// The list learns where the column has scrolled, and how tall its rows are, on animation frames, which a hidden or
// covered window would hold.
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows")
app.commandLine.appendSwitch("disable-renderer-backgrounding")
app.whenReady().then(async () => {
    let window = new BrowserWindow({
        width: 900,
        height: 600,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    })
    window.webContents.setBackgroundThrottling(false)
    let messages = []
    window.webContents.on("console-message", (_event, _level, message) => messages.push(message))
    try {
        await window.loadFile(join(directory, "index.html"))
        await window.webContents.executeJavaScript("window.mountFileTree()")
        let result = await window.webContents.executeJavaScript(
            "(async () => { try { return await window.fileTreeChecks() } catch (error) { return { error: error.stack, text: document.body.innerText } } })()",
        )
        writeFileSync(join(directory, "result.json"), JSON.stringify({ ...result, messages }))
        app.quit()
    } catch (error) {
        writeFileSync(join(directory, "result.json"), JSON.stringify({ error: String(error), messages }))
        app.exit(1)
    }
})
