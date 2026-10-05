import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import tseslint from "typescript-eslint"

export default defineConfig(
    globalIgnores(["**/node_modules/**", "cli/bin/**", "desktop/out/**", "desktop/dist/**", ".tmp/**", "tmp/**", "prototype/**"]),
    {
        files: ["**/*.js"],
        extends: [js.configs.recommended],
    },
    {
        files: ["**/*.ts"],
        extends: [tseslint.configs.recommended],
        rules: {
            "prefer-const": "off",
            "@typescript-eslint/consistent-type-imports": "error",
        },
    },
)
