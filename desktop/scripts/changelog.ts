import { resolve } from "node:path"
import { desktop } from "./bundles"

// CHANGELOG.md, at the repository root, holds each release's notes under a `## v<version>` heading, newest first, below the
// changes not yet released under `## Unreleased`.

export let changelogPath = resolve(desktop, "../CHANGELOG.md")

/** The notes under a `## ` heading, up to the next one, or undefined without that heading. */
export function sectionNotes(changelog: string, heading: string) {
    let lines = changelog.split(/\r?\n/)
    let start = lines.indexOf(`## ${heading}`)
    if (start < 0)
        return undefined
    let end = lines.findIndex((line, index) => index > start && line.startsWith("## "))
    return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim()
}
