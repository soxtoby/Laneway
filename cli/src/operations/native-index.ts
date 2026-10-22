import type { RepositoryGit } from "@laneway/git"
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { NativeIndex } from "./native-undo-record"

export async function readNativeIndex(repo: RepositoryGit, cwd: string): Promise<NativeIndex> {
    let entries = (await repo.command(cwd, ["ls-files", "--stage", "-v", "-z"])).toString()
    let path = await nativeIndexPath(repo, cwd)
    let content = await readFile(path).catch(error => {
        if (error.code != "ENOENT")
            throw error
        return null
    })
    let object: string | null = null
    if (content) {
        let temporary = join(repo.descriptor.commonDirectory, "laneway", `index-${crypto.randomUUID()}`)
        await mkdir(dirname(temporary), { recursive: true })
        try {
            await writeFile(temporary, content)
            // A saved index must survive Git removing its shared split-index file.
            await repo.command(cwd, ["update-index", "--no-split-index"], undefined, { GIT_INDEX_FILE: temporary })
            object = (await repo.command(cwd, ["hash-object", "-w", "--stdin"], await readFile(temporary))).toString().trim()
        } finally {
            await rm(temporary, { force: true })
        }
    }
    let objects = entries.split("\0").filter(entry => entry && !entry.slice(2).startsWith("160000 "))
        .map(entry => entry.split(" ")[2]!).filter(object => !/^0+$/.test(object))
    return { object, entries, objects: [...new Set(objects)] }
}

export async function nativeIndexEntries(repo: RepositoryGit, cwd: string) {
    return (await repo.command(cwd, ["ls-files", "--stage", "-v", "-z"])).toString()
}

export async function withNativeIndex(repo: RepositoryGit, cwd: string, target: NativeIndex | undefined, work: () => Promise<void>) {
    let path = await nativeIndexPath(repo, cwd)
    let lock = await open(`${path}.lock`, "wx")
    try {
        if (target?.object)
            await lock.writeFile(await repo.command(cwd, ["cat-file", "blob", target.object]))
        await work()
        await lock.close()
        if (target?.object)
            await rename(`${path}.lock`, path)
        else if (target)
            await rm(path, { force: true })
    } finally {
        await lock.close()
        await rm(`${path}.lock`, { force: true })
        repo.forgetReads()
    }
}

async function nativeIndexPath(repo: RepositoryGit, cwd: string) {
    return resolve(cwd, (await repo.command(cwd, ["rev-parse", "--git-path", "index"])).toString().trim())
}
