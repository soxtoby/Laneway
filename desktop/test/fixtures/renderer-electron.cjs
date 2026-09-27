const { app, BrowserWindow } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

const directory = process.argv[2]
app.setPath("userData", path.join(directory, "profile"))
// Match the app's scrollbars.
app.commandLine.appendSwitch("enable-features", "OverlayScrollbar:mode/overlay")
app.commandLine.appendSwitch("disable-features", "ScrollbarAnimations")
app.whenReady().then(async () => {
    const window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    window.webContents.on("console-message", (_event, level, message) => {
        if (level >= 2) console.error(message)
    })
    await window.loadFile(path.join(directory, "index.html"))
    window.webContents.executeJavaScript("window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack || String(event.reason)))")
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
    const menuPoint = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const timer = setInterval(() => {
            const item = document.querySelector('[data-column-id="virtual:inspection"] [role="menuitem"]');
            if (!item) return;
            clearInterval(timer);
            const rect = item.getBoundingClientRect();
            resolve({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
        }, 20);
    })`)
    window.webContents.sendInputEvent({ type: "mouseMove", ...menuPoint })
    const result = await window.webContents.executeJavaScript("window.rendererChecks")
    if (process.env.LANEWAY_TEST_SCREENSHOT)
        fs.writeFileSync(process.env.LANEWAY_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result))
    app.quit()
}).catch(error => {
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ error: String(error) }))
    app.exit(1)
})
