// Colours are written only in the React renderer's theme files; Laneway's own stylesheets use the
// theme's variables (ADR 0021). The kit's stylesheets in ui/ are upstream code and are not linted.
let colorFunctions = ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark"]

export default {
    rules: {
        "color-no-hex": true,
        "color-named": "never",
        "function-disallowed-list": colorFunctions,
    },
    overrides: [{
        files: ["**/theme.css"],
        rules: { "color-no-hex": null, "color-named": null, "function-disallowed-list": null },
    }],
}
