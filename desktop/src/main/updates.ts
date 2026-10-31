import { app, BrowserWindow, ipcMain } from "electron"
import { autoUpdater } from "electron-updater"

// An installed Laneway looks for a newer release on GitHub when it starts and every hour after, and downloads it in the
// background. The update installs when Laneway next quits, or at once, restarting Laneway, from the header's button.
let interval = 60 * 60_000

let downloaded: string | undefined

/** The version downloaded and waiting to install, if any. */
export function readyUpdate() {
    return downloaded
}

export function registerUpdates() {
    ipcMain.handle("update:install", () => {
        if (downloaded)
            autoUpdater.quitAndInstall(true, true)
    })

    // Development runs from source, which has no release to update.
    if (!app.isPackaged)
        return

    // Releases carry the whole installer, rather than a web installer that downloads the app, and updates download all of
    // it, rather than looking for a block map of only what changed.
    autoUpdater.disableWebInstaller = true
    autoUpdater.disableDifferentialDownload = true

    // The updater logs its failures, such as being offline, and the next check tries again.
    let check = () => void autoUpdater.checkForUpdates().catch(() => undefined)
    let checks = setInterval(check, interval)

    autoUpdater.on("update-downloaded", ({ version }) => {
        downloaded = version
        clearInterval(checks)
        for (let window of BrowserWindow.getAllWindows()) {
            if (!window.webContents.isDestroyed())
                window.webContents.send("update:ready", { version })
        }
    })

    check()
}
