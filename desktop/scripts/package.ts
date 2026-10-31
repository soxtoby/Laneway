// Packages the built desktop app and the Engine as Laneway's Windows installer in `dist/`. With `--publish`, it also
// uploads the installer to the GitHub release for its version, where installed copies find their updates.
import { build } from "electron-builder"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { desktop, out } from "./bundles"

let engine = resolve(desktop, "../cli/bin/lane.exe")

for (let built of [out, engine]) {
    if (!existsSync(built))
        throw new Error(`${built} is missing; run \`bun run build\` first.`)
}

await build({
    projectDir: desktop,
    publish: process.argv.includes("--publish") ? "always" : "never",
    config: {
        // The installer keys its registration on the app id, so changing it would install a second Laneway.
        appId: "com.soxtoby.laneway",
        productName: "Laneway",
        // Only the installed app takes Laneway's name, which names its user data folder, so it runs beside `bun dev`.
        extraMetadata: { name: "laneway", productName: "Laneway" },
        directories: { output: "dist" },
        // The bundles import nothing from node_modules but Electron, so the app is only them and its icons.
        files: ["out/**/*", "resources/**/*"],
        // Returning false leaves out node_modules, which electron-builder would otherwise install and collect.
        beforeBuild: async () => false,
        // The desktop app finds the Engine beside its executable.
        extraFiles: [{ from: engine, to: "lane.exe" }],
        win: {
            target: [{ target: "nsis", arch: "x64" }],
            icon: "resources/icon.ico",
        },
        // One click installs for the current user, without administrator rights, and starts Laneway. Updates download the
        // whole installer, so it has no block map for downloading only what changed.
        nsis: {
            oneClick: true,
            perMachine: false,
            differentialPackage: false,
            artifactName: "Laneway-Setup-${version}.${ext}",
        },
        // These settings also make electron-builder write `latest.yml` beside the installer, naming this version and the
        // installer's checksum, and `resources/app-update.yml` into the app, telling installed copies which releases to
        // check. Both happen whether or not it publishes.
        publish: { provider: "github", owner: "soxtoby", repo: "Laneway", releaseType: "release" },
    },
})
