import type { RemoteImageResult } from "@laneway/shared"
import { ipcMain, net, shell } from "electron"
import { readRemoteImage } from "../remote-images"

/** What rendered Markdown needs from main: pictures from the web, and links opened in the browser. */
export function registerMarkdownHandlers() {
    ipcMain.handle(
        "markdown:image",
        (_event, url: unknown): Promise<RemoteImageResult> | RemoteImageResult =>
            typeof url == "string" ? readRemoteImage(url, (address, init) => net.fetch(address, init)) : { ok: false, reason: "Invalid picture address." },
    )

    ipcMain.handle("markdown:open-link", async (_event, url: unknown) => {
        if (typeof url == "string" && isExternalLink(url))
            await shell.openExternal(url)
    })
}

/** Links that open outside Laneway: web pages and email addresses. */
export function isExternalLink(url: string) {
    let protocol = URL.parse(url)?.protocol
    return protocol == "http:" || protocol == "https:" || protocol == "mailto:"
}
