import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
    globalIgnores([
        "**/node_modules/**",
        "cli/bin/**",
        "desktop/out/**",
        "prototype/**",
    ]),
    {
        files: ["**/*.js"],
        extends: [js.configs.recommended],
    },
    {
        files: ["**/*.ts"],
        extends: [tseslint.configs.recommended],
        rules: {
            "@typescript-eslint/consistent-type-imports": "error",
        },
    },
);
