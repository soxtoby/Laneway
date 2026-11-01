// Prepares the next release from CHANGELOG.md: it chooses the version from the kinds of change under Unreleased, sets it as
// the desktop app's version, and moves those notes under the version's heading. `bun run prepare-release <version>` sets
// that version instead, such as `0.1.0` to end the alpha.
import { $ } from "bun"
import { resolve } from "node:path"
import { desktop } from "./bundles"
import { changelogPath, sectionNotes } from "./changelog"

/** The version part each kind of change bumps: 0 for major, 1 for minor, 2 for patch. */
let bumpedPart: Record<string, number> = { Breaking: 0, Added: 1, Changed: 1, Fixed: 2 }

let changelog = await Bun.file(changelogPath).text()
let unreleased = sectionNotes(changelog, "Unreleased")
if (unreleased == undefined)
    throw new Error("CHANGELOG.md has no Unreleased heading.")
let headings = [...unreleased.matchAll(/^### (.*)$/gm)].map(match => match[1]!)
if (!headings.length)
    throw new Error("CHANGELOG.md has no changes under Unreleased.")
let unknown = headings.filter(heading => !Object.hasOwn(bumpedPart, heading))
if (unknown.length)
    throw new Error(`Unknown change headings under Unreleased: ${unknown.join(", ")}.`)

let { version } = await Bun.file(resolve(desktop, "package.json")).json()
let next = process.argv[2] ?? nextVersion(version, Math.min(...headings.map(heading => bumpedPart[heading]!)))
if (!/^\d+\.\d+\.\d+(-alpha\.\d+)?$/.test(next))
    throw new Error(`${next} isn't a version like 0.1.0 or 0.1.0-alpha.2.`)
if (Bun.semver.order(next, version) <= 0)
    throw new Error(`${next} isn't newer than ${version}.`)

await $`bun pm version ${next} --no-git-tag-version`.cwd(desktop).quiet()
await $`bun install --lockfile-only`.cwd(resolve(desktop, "..")).quiet() // bun.lock records workspace versions
// The Unreleased notes become the new version's notes
await Bun.write(changelogPath, changelog.replace(/^## Unreleased(\r?\n)/m, `$&$1## v${next}$1`))

console.log(`Prepared v${next}. Commit it, then tag the commit v${next} and push the tag to publish it.`)

function nextVersion(version: string, part: number) {
    let [release, prerelease] = version.split("-")
    // An alpha leads up to its release version, so the next alpha only counts up, whatever changed
    if (prerelease) {
        let [label, number] = prerelease.split(".")
        return `${release}-${label}.${Number(number) + 1}`
    }
    let parts = release!.split(".").map(Number)
    if (parts[0] == 0) // Below 1.0, a new minor version is the breaking one, so each bump moves down a part
        part = Math.min(part + 1, 2)
    parts[part]!++
    return parts.fill(0, part + 1).join(".")
}
