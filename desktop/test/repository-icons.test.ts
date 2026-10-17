import { openRepository } from "@laneway/git"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { inferFavicon, listRepositoryImages } from "../src/main/repository-icons"

let temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Repository images", () => {
    test("lists tracked image files likely icons first, leaving untracked and ignored files out", async () => {
        let root = await mkdtemp(resolve(tmpdir(), "laneway-images-"))
        temporaryDirectories.push(root)
        expect(runGit(root, "init", "--quiet").exitCode).toBe(0)
        for (
            let file of [
                ".gitignore",
                "README.md",
                "docs/screenshot.png",
                "src/assets/brand/logo.svg",
                "src/assets/photo.jpeg",
                "public/favicon.ico",
                "public/app-icon.png",
                "dist/bundle.svg",
                "scratch/untracked.png",
            ]
        ) {
            await mkdir(resolve(root, file, ".."), { recursive: true })
            await writeFile(resolve(root, file), file == ".gitignore" ? "dist/\n" : file)
        }
        expect(runGit(root, "add", "--", ".gitignore", "README.md", "docs", "src", "public").exitCode).toBe(0)

        let images = await listRepositoryImages(await openRepository(root), root)

        expect(images.map(image => image.relative)).toEqual([
            "public/favicon.ico",
            "public/app-icon.png",
            "src/assets/brand/logo.svg",
            "docs/screenshot.png",
            "src/assets/photo.jpeg",
        ])
        expect(images[0].path).toBe(resolve(root, "public", "favicon.ico"))
        expect(await inferFavicon(root)).toBe(resolve(root, "public", "favicon.ico"))
    })
})

function runGit(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
}
