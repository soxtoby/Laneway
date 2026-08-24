import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin({ exclude: ["@git-workbench/shared"] })],
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
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
});
