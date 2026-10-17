import { defineConfig } from "electron-vite"
import { resolve } from "node:path"
import type { Plugin } from "vite"

// Vite injects CSS imported from modules as <style> tags during development. The fixed nonce is
// added to the page CSP only for the dev server; production CSS is extracted to files, so the
// shipped CSP keeps `style-src 'self'`.
let devNonce = "laneway-dev"

let devStyleNonce: Plugin = {
    name: "laneway-dev-style-nonce",
    apply: "serve",
    transformIndexHtml: html => html.replace("style-src 'self'", `style-src 'self' 'nonce-${devNonce}'`),
}

export default defineConfig(({ command }) => ({
    main: {
        build: {
            externalizeDeps: { exclude: ["@laneway/git", "@laneway/settings", "@laneway/shared"] },
        },
    },
    preload: {
        build: {
            rollupOptions: {
                output: {
                    entryFileNames: "[name].cjs",
                    format: "cjs",
                },
            },
        },
    },
    renderer: {
        plugins: [devStyleNonce],
        html: command == "serve" ? { cspNonce: devNonce } : {},
        build: {
            rollupOptions: {
                input: {
                    index: resolve(import.meta.dirname, "src/renderer/index.html"),
                    spike: resolve(import.meta.dirname, "src/renderer/spike.html"),
                },
            },
        },
    },
}))
