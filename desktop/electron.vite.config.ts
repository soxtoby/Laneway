import { defineConfig } from "electron-vite"

export default defineConfig({
    main: {
        build: {
            externalizeDeps: { exclude: ["@git-workbench/git", "@git-workbench/settings", "@git-workbench/shared"] },
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
    renderer: {},
})
