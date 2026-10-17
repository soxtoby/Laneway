import type { RepositoryGit } from "@laneway/git"
import { isRepositoryImagePath, repositoryImageExtensions, type RepositoryImageFile } from "@laneway/shared"
import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { extname, join } from "node:path"

// Best format first: the same favicon shipped as several files resolves to one choice.
let faviconFormats = ["svg", "png", "webp", "avif", "ico", "gif", "jpg", "jpeg"]
let faviconPattern = new RegExp(`^favicon\\.(${faviconFormats.join("|")})$`, "i")
let imagePattern = new RegExp(`\\.(${repositoryImageExtensions.join("|")})$`, "i")

// Build output and dependencies never hold a project's own favicon, and they dominate directory counts.
let skippedDirectories = new Set([
    "node_modules",
    "bower_components",
    "vendor",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "target",
    "coverage",
    "tmp",
    "temp",
    "__pycache__",
])

/** Images larger than this are not icons; the limit also bounds what the renderer holds in memory. */
export let iconImageLimit = 4 * 1024 * 1024

export let iconMimeTypes: Record<string, string> = {
    avif: "image/avif",
    gif: "image/gif",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
}

/**
 * Visits files under `root` breadth-first in name order, stopping at `depth` levels or `limit`
 * directories, whichever comes first. Unreadable directories are skipped.
 */
async function walkFiles(root: string, depth: number, limit: number, visit: (directory: string, entry: Dirent<string>) => void) {
    let pending = [{ path: root, depth: 0 }]
    let visited = 0
    while (pending.length && visited < limit) {
        let { path, depth: level } = pending.shift()!
        visited++
        let entries: Dirent<string>[]
        try {
            entries = await readdir(path, { withFileTypes: true })
        } catch {
            continue
        }
        for (let entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (entry.isFile())
                visit(path, entry)
            else if (entry.isDirectory() && level < depth && !entry.name.startsWith(".") && !skippedDirectories.has(entry.name.toLowerCase()))
                pending.push({ path: join(path, entry.name), depth: level + 1 })
        }
    }
}

/**
 * The repository's one favicon, or nothing when it has none or several. Favicons in one directory are
 * one icon in several formats; favicons in different directories count as one only when identical.
 */
export async function inferFavicon(root: string): Promise<string | undefined> {
    let found = new Map<string, string[]>()
    await walkFiles(root, 3, 400, (directory, entry) => {
        if (faviconPattern.test(entry.name))
            found.set(directory, [...found.get(directory) ?? [], entry.name])
    })

    let candidates = [...found].map(([directory, names]) => join(directory, bestFormat(names)))
    if (candidates.length == 0)
        return undefined
    if (candidates.length == 1)
        return candidates[0]

    let digests = new Set<string>()
    for (let candidate of candidates) {
        try {
            digests.add(createHash("sha1").update(await readFile(candidate)).digest("hex"))
        } catch {
            return undefined
        }
    }
    // Several directories with byte-identical copies, such as a root and its public directory, are one favicon.
    return digests.size == 1 ? candidates[0] : undefined
}

let imageListLimit = 2000

/**
 * Every tracked image file in the repository, likely icons first: favicons and files named for
 * icons or logos, then shallower files, then by path. Reading Git's index rather than the directory
 * keeps ignored and build output out, and untracked files are not yet part of the repository.
 */
export async function listRepositoryImages(git: RepositoryGit, root: string): Promise<RepositoryImageFile[]> {
    let tracked = Buffer.from(await git.command(root, ["ls-files", "-z"])).toString("utf8").split("\0").filter(Boolean)
    return tracked
        .filter(relative => imagePattern.test(relative))
        .slice(0, imageListLimit)
        .map(relative => ({ path: join(root, ...relative.split("/")), relative, depth: relative.split("/").length }))
        .sort((left, right) =>
            iconLikeness(right.relative) - iconLikeness(left.relative) || left.depth - right.depth || left.relative.localeCompare(right.relative)
        )
        .map(({ path, relative }) => ({ path, relative }))
}

function iconLikeness(relativePath: string) {
    let name = relativePath.split("/").pop()!.toLowerCase()
    return faviconPattern.test(name) ? 3 : /icon/.test(name) ? 2 : /logo|brand|mark/.test(name) ? 1 : 0
}

function bestFormat(names: string[]) {
    return [...names].sort((left, right) => faviconFormats.indexOf(format(left)) - faviconFormats.indexOf(format(right)))[0]
}

function format(name: string) {
    return extname(name).slice(1).toLowerCase()
}

export interface IconImage {
    bytes: Uint8Array
    mime: string
}

/** The bytes of an icon image, or nothing when the path is not a readable image of icon size. */
export async function readIconImage(path: string): Promise<IconImage | undefined> {
    if (!isRepositoryImagePath(path))
        return undefined
    try {
        let info = await stat(path)
        if (!info.isFile() || info.size > iconImageLimit)
            return undefined
        return { bytes: new Uint8Array(await readFile(path)), mime: iconMimeTypes[format(path)] }
    } catch {
        return undefined
    }
}
