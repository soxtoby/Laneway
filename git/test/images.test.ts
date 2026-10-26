import type { FileVersionRequest } from "@laneway/shared"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { startFileImageRead } from "../src/changes"
import { startGitProcess } from "../src/git-process"
import { openRepository } from "../src/index"

let roots: string[] = []
afterEach(async () => {
    for (let root of roots.splice(0))
        await rm(root, { recursive: true, force: true })
})

// Large enough for Git to recognize a redrawn image as a rename of the original.
let first = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1020, 1)])
let second = Buffer.concat([first.subarray(0, 1000), Buffer.alloc(24, 2)])
let third = Buffer.from([0x89, 0x50, 0x4e, 0x47, 3])
let ready = (bytes: Buffer) => ({ state: "ready" as const, bytes: new Uint8Array(bytes), size: bytes.length })

test("reads both versions of committed, renamed, and Working Changes images", async () => {
    let { path, api, source } = await repository()
    await writeFile(resolve(path, "icon.png"), first)
    git(path, "add", ".")
    git(path, "commit", "-qm", "add icon")
    let added = { kind: "commit" as const, objectId: git(path, "rev-parse", "HEAD") }
    expect(await api.startReadFileImage({ source: added, path: "icon.png" }).result).toMatchObject({ old: undefined, new: ready(first) })

    await rename(resolve(path, "icon.png"), resolve(path, "logo.png"))
    await writeFile(resolve(path, "logo.png"), second)
    git(path, "add", "-A")
    git(path, "commit", "-qm", "rename and redraw")
    let renamed = { kind: "commit" as const, objectId: git(path, "rev-parse", "HEAD") }
    let page = await api.startReadFileImage({ source: renamed, path: "logo.png" }).result
    expect(page.file.oldPath).toBe("icon.png")
    expect(page).toMatchObject({ old: ready(first), new: ready(second) })

    await writeFile(resolve(path, "logo.png"), third)
    git(path, "add", "logo.png")
    await writeFile(resolve(path, "logo.png"), first)
    expect(await api.startReadFileImage({ source, path: "logo.png" }).result).toMatchObject({ old: ready(second), new: ready(first) })
    expect(await api.startReadFileImage({ source, path: "logo.png", view: "staged" }).result).toMatchObject({ old: ready(second), new: ready(third) })
    expect(await api.startReadFileImage({ source, path: "logo.png", view: "unstaged" }).result).toMatchObject({ old: ready(third), new: ready(first) })

    await writeFile(resolve(path, "new.png"), third)
    expect(await api.startReadFileImage({ source, path: "new.png" }).result).toMatchObject({ old: undefined, new: ready(third) })
    git(path, "checkout", "logo.png")
    git(path, "reset", "-q", "logo.png")
    await unlink(resolve(path, "logo.png"))
    expect(await api.startReadFileImage({ source, path: "logo.png" }).result).toMatchObject({ old: ready(second), new: undefined })
})

test("shows Git LFS objects from the local store and reports ones that were never downloaded", async () => {
    let { path, api, source } = await repository()
    let oid = createHash("sha256").update(first).digest("hex")
    let objects = resolve(path, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4))
    await mkdir(objects, { recursive: true })
    await writeFile(resolve(objects, oid), first)
    await writeFile(resolve(path, "fetched.png"), pointer(oid, first.length))
    await writeFile(resolve(path, "missing.png"), pointer("f".repeat(64), 1234))

    let fetched = await api.startReadFileImage({ source, path: "fetched.png" }).result
    expect(fetched.new).toEqual(ready(first))
    let missing = await api.startReadFileImage({ source, path: "missing.png" }).result
    expect(missing.new).toEqual({ state: "lfs", size: 1234 })
})

test("downloads missing Git LFS objects through git-lfs only when asked", async () => {
    let { path, api, source } = await repository()
    let oid = createHash("sha256").update(first).digest("hex")
    await writeFile(resolve(path, "remote.png"), pointer(oid, first.length))
    let smudged: string[] = []
    let lfs = (installed: boolean): Parameters<typeof startFileImageRead>[1] => (cwd, args, onOutput, input) => {
        if (args[0] != "lfs")
            return startGitProcess({ installation: api.descriptor.git, cwd, args, readOnly: true, onOutput, input })

        smudged.push(input ?? "")
        if (installed)
            onOutput?.(first)
        let stderr = Buffer.from(installed ? "" : "git: 'lfs' is not a git command. See 'git --help'.")
        return { result: Promise.resolve({ exitCode: installed ? 0 : 1, stdout: Buffer.alloc(0), stderr }), cancel() {}, wasCancelled: () => false }
    }

    let quick = await startFileImageRead(api.descriptor, lfs(true), { source, path: "remote.png" }).result
    expect(quick.new).toEqual({ state: "lfs", size: first.length })
    expect(smudged).toEqual([])
    let fetched = await startFileImageRead(api.descriptor, lfs(true), { source, path: "remote.png", fetchLfs: true }).result
    expect(fetched.new).toEqual(ready(first))
    expect(smudged).toEqual([pointer(oid, first.length)])

    let missing = await startFileImageRead(api.descriptor, lfs(false), { source, path: "remote.png", fetchLfs: true }).result
    expect(missing.new).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Install Git LFS") })
})

test("reports images above the size limit instead of sending them", async () => {
    let { path, api, source } = await repository()
    await writeFile(resolve(path, "large.png"), Buffer.alloc(64, 1))
    git(path, "add", ".")
    git(path, "commit", "-qm", "large")
    await writeFile(resolve(path, "large.png"), Buffer.alloc(16, 2))
    let start = (cwd: string, args: string[], onOutput?: (chunk: Buffer) => void) =>
        startGitProcess({ installation: api.descriptor.git, cwd, args, readOnly: true, onOutput })

    let page = await startFileImageRead(api.descriptor, start, { source, path: "large.png" }, undefined, 32).result
    expect(page.old).toMatchObject({ state: "unavailable", reason: expect.stringContaining("larger") })
    expect(page.new).toEqual(ready(Buffer.alloc(16, 2)))
})

test("reads any file as either side of a comparison has it, whether or not it changed", async () => {
    let { path, api, source } = await repository()
    let read = (request: FileVersionRequest) => api.startReadFileVersion(request).result
    await mkdir(resolve(path, "docs"))
    await writeFile(resolve(path, "docs", "logo.png"), first)
    git(path, "add", ".")
    git(path, "commit", "-qm", "add logo")
    let commit = { kind: "commit" as const, objectId: git(path, "rev-parse", "HEAD"), parentId: git(path, "rev-parse", "HEAD~1") }

    expect(await read({ source: commit, path: "docs/logo.png", side: "new" })).toEqual(ready(first))
    expect(await read({ source: commit, path: "docs/logo.png", side: "old" })).toEqual({ state: "missing" })
    expect(await read({ source: commit, path: "file.txt", side: "old" })).toEqual(ready(Buffer.from("text\n")))

    await writeFile(resolve(path, "docs", "logo.png"), second)
    git(path, "add", ".")
    await writeFile(resolve(path, "docs", "logo.png"), third)
    expect(await read({ source, path: "docs/logo.png", side: "old" })).toEqual(ready(first))
    expect(await read({ source, path: "docs/logo.png", side: "new" })).toEqual(ready(third))
    expect(await read({ source, path: "docs/logo.png", view: "staged", side: "new" })).toEqual(ready(second))
    expect(await read({ source, path: "docs/logo.png", view: "unstaged", side: "old" })).toEqual(ready(second))
    expect(await read({ source, path: "docs/missing.png", side: "new" })).toEqual({ state: "missing" })
    expect(read({ source, path: "../outside.png", side: "new" })).rejects.toThrow("Invalid repository file path.")
})

function pointer(oid: string, size: number) {
    return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`
}

async function repository() {
    let path = await mkdtemp(resolve(tmpdir(), "laneway-image-"))
    roots.push(path)
    git(path, "init", "-q", "--initial-branch=main")
    git(path, "config", "user.name", "Image Test")
    git(path, "config", "user.email", "image@example.invalid")
    await writeFile(resolve(path, "file.txt"), "text\n")
    git(path, "add", ".")
    git(path, "commit", "-qm", "initial")
    let api = await openRepository(path)
    return { path, api, source: { kind: "working" as const, worktreePath: path } }
}

function git(cwd: string, ...args: string[]) {
    let result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode)
        throw new Error(`${args.join(" ")}: ${result.stderr}`)
    return result.stdout.toString().trim()
}
