// The window shows these before the page paints and behind its controls, so each renderer's set
// matches its own header. The controls stop 1px short of the header to leave its bottom border
// visible. The renderer style tests check the React set against the stylesheets.

/** Whether this run loads the React renderer, which replaces Remix screen by screen (ADR 0021). */
export let reactRenderer = process.env.LANEWAY_RENDERER == "react"

export function windowBackground(appearance: string, react = reactRenderer) {
    if (react)
        return appearance == "dark" ? "#1b1b1b" : "#f8f8f8"
    return appearance == "dark" ? "#1a1e1b" : "#f4f5f4"
}

export function titleBarOverlay(appearance: string, react = reactRenderer) {
    if (react) {
        return appearance == "dark"
            ? { color: "#1b1b1b", symbolColor: "#e8e8e8", height: 47 }
            : { color: "#ffffff", symbolColor: "#1f1f1f", height: 47 }
    }
    return appearance == "dark"
        ? { color: "#1c222d", symbolColor: "#e9edf3", height: 47 }
        : { color: "#ffffff", symbolColor: "#141a24", height: 47 }
}
