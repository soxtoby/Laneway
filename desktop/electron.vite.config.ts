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

// The Repository Icon catalogue reads Tabler's node data and tags, which `@tabler/icons` leaves out of
// its exports; `tsconfig.json` maps the same names for Bun.
let tablerCatalogFiles = Object.fromEntries(
    ["tabler-nodes-outline.json", "icons.json"].map(file => [`@tabler/icons/${file}`, resolve(import.meta.dirname, "node_modules/@tabler/icons", file)]),
)

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
        plugins: [react(), devNonceCsp],
        html: command == "serve" ? { cspNonce: devNonce } : {},
        resolve: { alias: tablerCatalogFiles },
        build: {
            rollupOptions: {
                input: { index: resolve(import.meta.dirname, "src/renderer/index.html") },
            },
        },
    },
}))
