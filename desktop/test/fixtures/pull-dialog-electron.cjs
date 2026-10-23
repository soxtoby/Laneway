let { app, BrowserWindow } = require("electron")
let { writeFileSync } = require("node:fs")
let { join } = require("node:path")
let directory = process.argv[2]
app.setPath("userData", join(directory, "profile"))
app.whenReady().then(async () => {
    let window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    let problems = []
    window.webContents.on("console-message", event => {
        if (event.level == "warning" || event.level == "error")
            problems.push(event.message)
    })
    try {
        await window.loadFile(join(directory, "index.html"))
        let desktop = await window.webContents.executeJavaScript("window.pullDialogChecks()")
        window.setContentSize(480, 640)
        await window.webContents.executeJavaScript("window.manyPullStacks()")
        let small = await window.webContents.executeJavaScript("window.pullDialogChecks()")
        writeFileSync(join(directory, "result.json"), JSON.stringify({ desktop, small, problems }))
        app.quit()
    } catch (error) {
        writeFileSync(join(directory, "result.json"), JSON.stringify({ error: String(error) }))
        app.exit(1)
    }
})
