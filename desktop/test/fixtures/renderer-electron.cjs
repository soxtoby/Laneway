const { app, BrowserWindow } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

const directory = process.argv[2]
app.setPath("userData", path.join(directory, "profile"))
app.whenReady().then(async () => {
    const window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await window.loadFile(path.join(directory, "index.html"))
    const point = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const timer = setInterval(() => {
            const button = document.querySelector('[aria-label="Filter files"]');
            if (!button) return;
            clearInterval(timer);
            const rect = button.getBoundingClientRect();
            resolve({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
        }, 50);
    })`)
    window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 })
    window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 })
    const result = await window.webContents.executeJavaScript("window.rendererChecks")
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result))
    app.quit()
}).catch(error => {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ error: String(error) }))
    app.exit(1)
})
