import { defineConfig } from "electron-vite"

export default defineConfig({
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
    renderer: {},
})
