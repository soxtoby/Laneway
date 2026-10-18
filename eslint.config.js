import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import { defineConfig, globalIgnores } from "eslint/config"
import tseslint from "typescript-eslint"

export default defineConfig(
    globalIgnores(["**/node_modules/**", "cli/bin/**", "desktop/out/**", "desktop/dist/**", ".tmp/**", "tmp/**", "prototype/**"]),
    {
        files: ["**/*.js"],
        extends: [js.configs.recommended],
    },
    {
        files: ["**/*.{ts,tsx}"],
        extends: [tseslint.configs.recommended],
        rules: {
            "prefer-const": "off",
            "@typescript-eslint/consistent-type-imports": "error",
        },
    },
    {
        files: ["desktop/src/renderer/**/*.{ts,tsx}", "desktop/test/**/*.{ts,tsx}"],
        extends: [reactHooks.configs.flat.recommended],
    },
)
