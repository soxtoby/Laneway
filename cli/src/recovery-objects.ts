import { pathExists, type RepositoryGit } from "@laneway/git"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const StoreSchema = z.object({
    version: z.literal(1),
    operations: z.record(z.string(), z.array(oid)),
    packs: z.array(oid),
    basePacks: z.array(oid).default([]),
})
type Store = z.infer<typeof StoreSchema>
const keepMessage = "Laneway Operation History\n"
const stores = new WeakMap<RepositoryGit, Store>()

/** Called under the repository mutation lock. Packs retain objects without decorating Git history. */
export async function retainRecoveryObjects(repository: RepositoryGit, operation: string, objects: string[]) {
    const store = await retentionStore(repository)
    const retained = [...new Set(Object.values(store.operations).flat())]
    const roots = [...new Set(objects)]
    const known = new Set(retained)
    const added = roots.filter(object => !known.has(object))
    const pack = added.length ? await keepPack(repository, added, retained, store.packs) : undefined
    const next: Store = {
        ...store,
        operations: { ...store.operations, [operation]: roots },
        packs: [...new Set([...store.packs, ...(pack ? [pack] : [])])],
    }
    if (JSON.stringify(next) != JSON.stringify(store)) {
        await writeStore(repository, next)
        if (next.packs.length - next.basePacks.length > 32)
            await compactStore(repository, next, next.operations)
    }
}

export async function releaseRecoveryObjects(repository: RepositoryGit, operation: string) {
    const store = await readStore(repository)
    if (!Object.hasOwn(store.operations, operation))
        return
    const operations = { ...store.operations }
    delete operations[operation]
    if (Object.keys(operations).length)
        await writeStore(repository, { ...store, operations })
    else
        await compactStore(repository, store, operations)
}

export async function migrateRecoveryRefs(repository: RepositoryGit) {
    const output =
        (await repository.command(repository.descriptor.mainWorktree, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/laneway/recovery/"]))
            .toString()
    const refs = output.trim().split("\n").filter(Boolean).map(line => line.split(" "))
    if (!refs.length)
        return
    const store = await retentionStore(repository)
    const operations = structuredClone(store.operations)
    for (const [ref, object] of refs) {
        const operation = ref.slice("refs/laneway/recovery/".length).split("/")[0]
        operations[operation] = [...new Set([...(operations[operation] ?? []), object])]
    }
    const retained = [...new Set(Object.values(store.operations).flat())]
    const known = new Set(retained)
    const added = [...new Set(refs.map(([, object]) => object))].filter(object => !known.has(object))
    const pack = added.length ? await keepPack(repository, added, retained, store.packs) : undefined
    await writeStore(repository, { ...store, operations, packs: [...new Set([...store.packs, ...(pack ? [pack] : [])])] })
    await repository.updateRefs(refs.map(([ref, before]) => ({ ref, before, after: null })))
}

async function keepPack(repository: RepositoryGit, roots: string[], exclude: string[] = [], protectedPacks: string[] = []): Promise<string | undefined> {
    for (const object of [...roots, ...exclude])
        oid.parse(object)
    const directory = join(repository.descriptor.commonDirectory, "laneway", `recovery-pack-${randomUUID()}`)
    await mkdir(directory, { recursive: true })
    try {
        const hash =
            (await repository.command(repository.descriptor.mainWorktree, [
                "-c",
                "core.fsync=pack,pack-metadata",
                "pack-objects",
                "--revs",
                "--non-empty",
                "--max-pack-size=0",
                ...protectedPacks.map(hash => `--keep-pack=pack-${hash}.pack`),
                join(directory, "pack"),
            ], [...roots, ...exclude.map(object => `^${object}`), ""].join("\n"))).toString().trim()
        if (!hash)
            return undefined
        oid.parse(hash)
        const destination = join(repository.descriptor.commonDirectory, "objects", "pack")
        await mkdir(destination, { recursive: true })
        // Install protection before either standard pack filename becomes visible
        // to concurrent Git maintenance. Never take ownership of another tool's keep.
        await durableWrite(join(destination, `pack-${hash}.keep`), keepMessage, "wx").catch(error => {
            if ((error as NodeJS.ErrnoException).code != "EEXIST")
                throw error
        })
        if (await readFile(join(destination, `pack-${hash}.keep`), "utf8") != keepMessage) {
            // Another tool can remove its own protection at any time. Give this
            // pack a distinct identity instead of relying on that tool's keep.
            const marker = await repository.hashObject(`Laneway recovery pack ${randomUUID()}`)
            return keepPack(repository, [...roots, marker], exclude, protectedPacks)
        }
        for (const extension of ["pack", "idx"]) {
            const source = join(directory, `pack-${hash}.${extension}`)
            const target = join(destination, `pack-${hash}.${extension}`)
            if (!await pathExists(target))
                await rename(source, target)
        }
        return hash
    } finally {
        // directory is a fresh UUID child of this repository's Laneway data.
        await rm(directory, { recursive: true, force: true })
    }
}

async function compactStore(repository: RepositoryGit, store: Store, operations: Store["operations"]) {
    const roots = [...new Set(Object.values(operations).flat())]
    // Existing repository packs can be large. Consolidate only incremental recovery
    // objects, keeping the shared baseline protected until the pool becomes empty.
    const basePacks = roots.length ? store.basePacks : []
    const pack = roots.length ? await keepPack(repository, roots, [], basePacks) : undefined
    const next: Store = { version: 1, operations, packs: [...basePacks, ...(pack ? [pack] : [])], basePacks }
    // Publish the replacement before releasing any old protection. A crash can
    // retain extra objects, but cannot leave remaining undo entries unprotected.
    await writeStore(repository, next)
    for (const old of store.packs.filter(hash => !next.packs.includes(hash))) {
        const path = join(repository.descriptor.commonDirectory, "objects", "pack", `pack-${old}.keep`)
        if (await readFile(path, "utf8").catch(() => "") == keepMessage)
            await unlink(path)
    }
}

async function readStore(repository: RepositoryGit): Promise<Store> {
    const cached = stores.get(repository)
    if (cached)
        return cached
    let store: Store = { version: 1, operations: {}, packs: [], basePacks: [] }
    try {
        const envelope = JSON.parse(await readFile(join(repository.descriptor.commonDirectory, "laneway", "recovery-objects.json"), "utf8"))
        if (typeof envelope.data != "string" || digest(envelope.data) != envelope.hash)
            throw new Error("Recovery object manifest is damaged; retained packs were left intact.")
        store = StoreSchema.parse(JSON.parse(envelope.data))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code != "ENOENT")
            throw error
    }
    for (const pack of store.packs) {
        for (const extension of ["pack", "idx", "keep"]) {
            if (!await pathExists(join(repository.descriptor.commonDirectory, "objects", "pack", `pack-${pack}.${extension}`)))
                throw new Error("Recovery object storage is incomplete. Restore its retained packs before continuing.")
        }
    }
    stores.set(repository, store)
    return store
}

async function retentionStore(repository: RepositoryGit) {
    const store = await readStore(repository)
    if (store.packs.length || Object.keys(store.operations).length)
        return store
    const basePacks = await protectExistingPacks(repository)
    return { ...store, packs: basePacks, basePacks }
}

async function protectExistingPacks(repository: RepositoryGit) {
    const directory = join(repository.descriptor.commonDirectory, "objects", "pack")
    const files = await readdir(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code != "ENOENT")
            throw error
        return [] as string[]
    })
    const packs: string[] = []
    for (const name of files.filter(name => /^pack-(?:[a-f0-9]{40}|[a-f0-9]{64})\.pack$/.test(name))) {
        const hash = name.slice(5, -5), keep = join(directory, `pack-${hash}.keep`)
        await durableWrite(keep, keepMessage, "wx").catch(error => {
            if ((error as NodeJS.ErrnoException).code != "EEXIST")
                throw error
        })
        if (await readFile(keep, "utf8") == keepMessage && await pathExists(join(directory, name)) && await pathExists(join(directory, `pack-${hash}.idx`)))
            packs.push(hash)
    }
    return packs
}

async function writeStore(repository: RepositoryGit, store: Store) {
    const path = join(repository.descriptor.commonDirectory, "laneway", "recovery-objects.json")
    const data = JSON.stringify(store)
    await durableWrite(`${path}.tmp`, JSON.stringify({ data, hash: digest(data) }))
    await rename(`${path}.tmp`, path)
    stores.set(repository, store)
}

async function durableWrite(path: string, data: string, flags = "w") {
    const file = await open(path, flags)
    try {
        await file.writeFile(data)
        await file.sync()
    } finally {
        await file.close()
    }
}

function digest(data: string) {
    return createHash("sha256").update(data).digest("hex")
}
