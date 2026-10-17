import { BrowserWindow, nativeTheme } from "electron"
import { fileURLToPath } from "node:url"
import windowsIcon from "../../resources/icon.ico?asset"
import icon from "../../resources/icon.png?asset"

// Spike: LANEWAY_RENDERER_PAGE=spike loads the React Aria renderer instead.
let spikePage = process.env.LANEWAY_RENDERER_PAGE == "spike"

export function createWindow(appearance: string) {
    applyNativeTheme(appearance)
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

    let page = spikePage ? "spike.html" : "index.html"
    if (process.env.ELECTRON_RENDERER_URL)
        void window.loadURL(new URL(page, process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, "/")).href)
    else
        void window.loadFile(fileURLToPath(new URL(`../renderer/${page}`, import.meta.url)))
}

// The React Aria starter styles switch with prefers-color-scheme, which follows this rather than the OS.
export function applyNativeTheme(appearance: string) {
    nativeTheme.themeSource = appearance == "dark" ? "dark" : "light"
}

// Window controls share the header colors and stop 1px short to leave its bottom border visible.
export function titleBarOverlay(appearance: string) {
    if (spikePage) {
        return appearance == "dark"
            ? { color: "#1b1b1b", symbolColor: "#e8e8e8", height: 47 }
            : { color: "#ffffff", symbolColor: "#1f1f1f", height: 47 }
    }
    return appearance == "dark"
        ? { color: "#1c222d", symbolColor: "#e9edf3", height: 47 }
        : { color: "#ffffff", symbolColor: "#141a24", height: 47 }
}
