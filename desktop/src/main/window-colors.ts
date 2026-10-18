// The window shows these before the page paints and behind its controls, so they match the renderer's
// header. The controls stop 1px short of the header to leave its bottom border visible. The renderer
// styles test checks them against the stylesheets.

export function windowBackground(appearance: string) {
    return appearance == "dark" ? "#1b1b1b" : "#f8f8f8"
}

export function titleBarOverlay(appearance: string) {
    return appearance == "dark"
        ? { color: "#1b1b1b", symbolColor: "#e8e8e8", height: 47 }
        : { color: "#ffffff", symbolColor: "#1f1f1f", height: 47 }
}
