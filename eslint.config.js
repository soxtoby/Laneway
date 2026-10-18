import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import { defineConfig, globalIgnores } from "eslint/config"
import tseslint from "typescript-eslint"

// The React renderer's .tsx is linted; the Remix renderer's is not, and goes at cutover (ADR 0021).
let reactFiles = ["desktop/src/renderer/react/**/*.{ts,tsx}", "desktop/test/**/react-*.{ts,tsx}"]

export default defineConfig(
    globalIgnores(["**/node_modules/**", "cli/bin/**", "desktop/out/**", "desktop/dist/**", ".tmp/**", "tmp/**", "prototype/**"]),
    {
        files: ["**/*.js"],
        extends: [js.configs.recommended],
    },
    {
        files: ["**/*.ts", ...reactFiles],
        extends: [tseslint.configs.recommended],
        rules: {
            "prefer-const": "off",
            "@typescript-eslint/consistent-type-imports": "error",
        },
    },
    {
        files: reactFiles,
        extends: [reactHooks.configs.flat.recommended],
    },
)
