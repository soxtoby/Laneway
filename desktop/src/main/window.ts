import { BrowserWindow } from "electron"
import { fileURLToPath } from "node:url"
import windowsIcon from "../../resources/icon.ico?asset"
import icon from "../../resources/icon.png?asset"

export function createWindow(appearance: string) {
    let window = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 820,
        minHeight: 620,
        backgroundColor: appearance == "dark" ? "#1a1e1b" : "#f4f5f4",
        show: true,
        title: "Laneway",
        icon: process.platform == "win32" ? windowsIcon : icon,
        titleBarStyle: "hidden",
        titleBarOverlay: process.platform == "darwin" ? undefined : titleBarOverlay(appearance),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
            sandbox: true,
        },
    })

    if (process.env.ELECTRON_RENDERER_URL)
        void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else
        void window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)))
}

// Window controls share the header colors and stop 1px short to leave its bottom border visible.
export function titleBarOverlay(appearance: string) {
    return appearance == "dark"
        ? { color: "#1c222d", symbolColor: "#e9edf3", height: 47 }
        : { color: "#ffffff", symbolColor: "#141a24", height: 47 }
}
