import { BrowserWindow, nativeTheme } from "electron"
import { fileURLToPath } from "node:url"
import { titleBarOverlay, windowBackground } from "./window-colors"

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
        icon: resource(process.platform == "win32" ? "icon.ico" : "icon.png"),
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

/** A file in `desktop/resources`, which is two folders up from both the main process's source and its bundle. */
export function resource(name: string) {
    return fileURLToPath(new URL(`../../resources/${name}`, import.meta.url))
}

// The renderer's styles switch with prefers-color-scheme, which follows this rather than the OS.
export function applyNativeTheme(appearance: string) {
    nativeTheme.themeSource = appearance == "dark" ? "dark" : "light"
}
