import react from "@vitejs/plugin-react"
import { defineConfig } from "electron-vite"
import { resolve } from "node:path"
import type { Plugin } from "vite"

// During development Vite injects CSS imported from modules as <style> tags, and React Fast Refresh
// adds an inline preamble script. The fixed nonce is added to the page CSP only for the dev server;
// production CSS is extracted to files and has no preamble, so the shipped CSP keeps `style-src 'self'`
// and `script-src 'self'`.
let devNonce = "laneway-dev"

let devNonceCsp: Plugin = {
    name: "laneway-dev-nonce-csp",
    apply: "serve",
    transformIndexHtml: html =>
        html
            .replace("style-src 'self'", `style-src 'self' 'nonce-${devNonce}'`)
            .replace("script-src 'self'", `script-src 'self' 'nonce-${devNonce}'`),
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
        // Fast Refresh covers only the React renderer; Remix modules keep the project's JSX source.
        plugins: [react({ include: /\/src\/renderer\/react\/.*\.tsx?$/ }), devNonceCsp],
        html: command == "serve" ? { cspNonce: devNonce } : {},
        build: {
            rollupOptions: {
                input: {
                    index: resolve(import.meta.dirname, "src/renderer/index.html"),
                    react: resolve(import.meta.dirname, "src/renderer/react.html"),
                },
            },
        },
    },
}))
