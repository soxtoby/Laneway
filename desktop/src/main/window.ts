import { BrowserWindow, nativeTheme } from "electron"
import { fileURLToPath } from "node:url"
import windowsIcon from "../../resources/icon.ico?asset"
import icon from "../../resources/icon.png?asset"
import { reactRenderer, titleBarOverlay, windowBackground } from "./window-colors"

export function createWindow(appearance: string) {
    applyNativeTheme(appearance)
    let window = new BrowserWindow({
        width: 1180,
        height: 760,
        minWidth: 820,
        minHeight: 620,
        backgroundColor: windowBackground(appearance),
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

    let page = reactRenderer ? "react.html" : "index.html"
    if (process.env.ELECTRON_RENDERER_URL)
        void window.loadURL(new URL(page, process.env.ELECTRON_RENDERER_URL.replace(/\/?$/, "/")).href)
    else
        void window.loadFile(fileURLToPath(new URL(`../renderer/${page}`, import.meta.url)))
}

// The React renderer's styles switch with prefers-color-scheme, which follows this rather than the OS.
export function applyNativeTheme(appearance: string) {
    nativeTheme.themeSource = appearance == "dark" ? "dark" : "light"
}
