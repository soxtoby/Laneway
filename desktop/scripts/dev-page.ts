// Runs in the development server's copy of the page, ahead of Bun's development client: dev.ts inlines it, and the
// copy's CSP allows its hash. It has no imports, so it stays a script, and declares nothing at its top level, so it adds
// no globals.

// Bun's overlay shows any error the window reports as fatal, and then reloads the page for every edit rather than
// refreshing it in place. A ResizeObserver loop is reported, not thrown: the browser delivers what's left on the next
// frame. So the page only warns of one, from a listener ahead of Bun's, because the window calls its listeners in the
// order they were added, capturing or not. The built app, which the Electron tests drive, still reports it.
window.addEventListener("error", event => {
    if (event.message.startsWith("ResizeObserver loop")) {
        event.stopImmediatePropagation()
        event.preventDefault()
        console.warn(event.message)
    }
})

// The overlay's icons, on its previous, next, and dismiss buttons, are data: URLs, which the page's `img-src` refuses,
// leaving the buttons blank; as blob: URLs, which it allows, they show. Bun adds the overlay to the body for its first
// error.
window.addEventListener("DOMContentLoaded", () => {
    let observer = new MutationObserver(showIcons)
    observer.observe(document.body, { childList: true })
    showIcons()

    function showIcons() {
        let overlay = document.querySelector("bun-hmr")?.shadowRoot
        if (!overlay)
            return
        observer.disconnect()
        for (let sheet of overlay.adoptedStyleSheets) {
            for (let rule of sheet.cssRules) {
                if (!(rule instanceof CSSStyleRule))
                    continue
                let [, type, data] = rule.style.backgroundImage.match(/^url\("data:([^;,]+);base64,(.+)"\)$/) ?? []
                if (type && data) {
                    let icon = new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], { type })
                    rule.style.backgroundImage = `url("${URL.createObjectURL(icon)}")`
                }
            }
        }
    }
})
