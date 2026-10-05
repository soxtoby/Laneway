import { normalize, pathExists, populatedSubmodules, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import type { RegisteredWorktree } from "@laneway/shared"
import { chmod, lstat, mkdir, readdir, readlink, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"

let FileSchema = z.object({ name: z.string(), object: z.string(), mode: z.number(), link: z.boolean(), identity: z.string().optional() })
let RootSchema = z.object({
    path: z.string(),
    kind: z.enum(["working", "admin", "main", "stash"]),
    present: z.boolean(),
    files: z.array(FileSchema),
    scope: z.array(z.string()).optional(),
})
export let WorktreeStateSchema = z.object({ roots: z.array(RootSchema), refs: z.record(z.string(), z.string()) })
export type WorktreeState = z.infer<typeof WorktreeStateSchema>
type Root = z.infer<typeof RootSchema>

export async function relocateRemovedState(repository: RepositoryGit, state: WorktreeState, oldPath: string, newPath: string) {
    let result = structuredClone(state)
    for (let root of result.roots) {
        if (normalize(root.path) == normalize(oldPath))
            root.path = newPath
        let link = root.kind == "admin" ? root.files.find(file => file.name == "gitdir") : undefined
        if (link) {
            let value = (await repository.command(repository.descriptor.mainWorktree, ["cat-file", "blob", link.object])).toString()
            if (normalize(dirname(value.trim())) == normalize(oldPath)) {
                link.object = (await repository.command(
                    repository.descriptor.mainWorktree,
                    ["hash-object", "-w", "--stdin"],
                    `${join(newPath, ".git").replaceAll("\\", "/")}\n`,
                ))
                    .toString().trim()
            }
        }
    }

    result.roots.sort((a, b) => a.path.localeCompare(b.path))

    return result
}

export async function worktreeStateMatches(repository: RepositoryGit, expected: WorktreeState) {
    let actual = await captureWorktreeState(repository, expected.roots.filter(root => root.kind == "working").map(root => root.path), expected)
    return stateIdentity(actual) == stateIdentity(expected)
}

/**
 * Snapshots the given worktrees plus their Git administrative state. Every Git process costs tens of
 * milliseconds on Windows, so callers that already listed the registered worktrees pass them in, and
 * each working root's populated submodules are scanned once and shared with its file listing.
 */
export async function captureWorktreeState(
    repository: RepositoryGit,
    paths: string[],
    template?: WorktreeState,
    registered?: RegisteredWorktree[],
    scopes?: Map<string, string[]>,
): Promise<WorktreeState> {
    let worktrees = registered ?? await readRegisteredWorktrees(repository)
    let roots = new Map<string, Root>()
    let submodules = new Map<string, string[]>()
    let ordinaryFiles: Array<{ path: string; file: z.infer<typeof FileSchema> }> = []
    let add = (path: string, kind: Root["kind"], scope = scopes?.get(normalize(path)) ?? roots.get(normalize(path))?.scope) =>
        roots.set(normalize(path), { path, kind, present: false, files: [], ...(scope ? { scope } : {}) })

    for (let root of template?.roots ?? [])
        add(root.path, root.kind, root.scope)

    for (let path of paths) {
        add(path, "working")
        let worktree = worktrees.find(item => normalize(item.path) == normalize(path))
        if (worktree)
            add(worktree.gitDirectory, worktree.main ? "main" : "admin")
        if (worktree && !worktree.missing && !roots.get(normalize(path))?.scope) {
            let children = await populatedSubmodules(repository, path)
            submodules.set(normalize(path), children)
            for (let child of children) {
                let admin = (await repository.command(child, ["rev-parse", "--absolute-git-dir"])).toString().trim()
                if (worktree.main || !normalize(admin).startsWith(normalize(worktree.gitDirectory) + sep))
                    add(admin, "admin")
            }
        }
    }

    add(join(repository.descriptor.commonDirectory, "logs", "refs"), "stash")

    for (let root of roots.values()) {
        root.present = await pathExists(root.path)
        if (!root.present)
            continue
        if ((await lstat(root.path)).isSymbolicLink())
            throw new Error(`Cannot snapshot a symbolic-link worktree root: ${root.path}`)

        let names: string[]
        if (root.kind == "working") {
            if (!await pathExists(join(root.path, ".git"))) {
                if ((await readdir(root.path)).length)
                    throw new Error(`The destination is occupied: ${root.path}`)
                names = []
            } else {
                names = root.scope ? [...root.scope] : await workingFiles(repository, root.path, submodules.get(normalize(root.path)))
                if ((await lstat(join(root.path, ".git"))).isFile())
                    names.push(".git")
            }
        } else if (root.kind == "main")
            names = ["HEAD", "index", "logs/HEAD", "config", "laneway-local.json"]
        else if (root.kind == "stash")
            names = ["stash"]
        else
            names = await filesUnder(root.path)

        let sorted = [...new Set(names)].sort()
        for (let offset = 0; offset < sorted.length; offset += 64) {
            let files = await Promise.all(
                sorted.slice(offset, offset + 64).map(async name => {
                    let path = safeChild(root.path, name)
                    let stat = await lstat(path).catch(error => {
                        if ((error as NodeJS.ErrnoException).code != "ENOENT")
                            throw error
                        return undefined
                    })
                    if (!stat || stat.isDirectory())
                        return undefined
                    let link = stat.isSymbolicLink()
                    let object = link
                        ? (await repository.command(repository.descriptor.mainWorktree, ["hash-object", "-w", "--stdin"], await readlink(path))).toString()
                            .trim()
                        : ""
                    let identity: string | undefined
                    if ((root.kind == "main" || root.kind == "admin") && (name == "index" || name.endsWith("/index"))) {
                        identity =
                            (await repository.command(repository.descriptor.mainWorktree, ["--git-dir", dirname(path), "ls-files", "--stage", "-v", "-z"]))
                                .toString()
                    }
                    return { path, file: { name, object, mode: stat.mode & 0o777, link, identity } }
                }),
            )
            for (let item of files.filter(item => item != undefined)) {
                root.files.push(item.file)
                if (!item.file.link)
                    ordinaryFiles.push(item)
            }
        }
    }

    if (ordinaryFiles.length) {
        let output = await repository.command(
            repository.descriptor.mainWorktree,
            ["hash-object", "-w", "--no-filters", "--stdin-paths"],
            ordinaryFiles.map(item => JSON.stringify(item.path.replaceAll("\\", "/"))).join("\n") + "\n",
        )
        let objects = output.toString().trim().split("\n")
        if (objects.length != ordinaryFiles.length)
            throw new Error("Git did not capture every worktree file.")
        ordinaryFiles.forEach((item, index) => item.file.object = objects[index]!)
    }

    let refs: Record<string, string> = {}
    let output =
        (await repository.command(repository.descriptor.mainWorktree, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
            "refs/tags",
            "refs/stash",
            "refs/laneway/conflicts/current",
            "refs/laneway/conflict-candidates",
        ])).toString()
    for (let line of output.trim().split("\n").filter(Boolean)) {
        let [ref, oid] = line.split(" ")
        refs[ref!] = oid!
    }

    return { roots: [...roots.values()].sort((a, b) => a.path.localeCompare(b.path)), refs }
}

async function workingFiles(repository: RepositoryGit, path: string, submodules?: string[], prefix = ""): Promise<string[]> {
    let names = (await repository.command(path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean)
    let result = names.map(name => prefix + name)
    for (let child of submodules ?? await populatedSubmodules(repository, path)) {
        // The recursive submodule listing already includes descendants.
        let childPrefix = prefix + relative(path, child).replaceAll("\\", "/") + "/"
        let files = (await repository.command(child, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean)
        result.push(childPrefix + ".git", ...files.map(name => childPrefix + name))
    }

    return result
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
    let result: string[] = []
    for (let entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        let name = prefix + entry.name
        if (entry.isDirectory())
            result.push(...await filesUnder(root, name + "/"))
        else
            result.push(name)
    }

    return result
}

export function stateIdentity(state: WorktreeState) {
    return JSON.stringify({
        refs: Object.entries(state.refs).sort(),
        roots: state.roots.filter(root => root.present && (root.kind != "stash" || root.files.length)).map(root => ({
            path: normalize(root.path),
            kind: root.kind,
            ...(root.scope ? { scope: root.scope } : {}),
            files: root.files.map(file => ({
                name: file.name,
                object: file.identity ?? file.object,
                link: file.link,
                mode: process.platform == "win32" ? 0 : file.mode,
            })),
        })).sort((a, b) => a.path.localeCompare(b.path)),
    })
}

export async function worktreeStateObjects(repository: RepositoryGit, state: WorktreeState, heads = new Map<string, string>()) {
    let objects = new Set(Object.values(state.refs))
    let files = [...new Set(state.roots.flatMap(root => root.files.map(file => file.object)))]
    for (let file of files)
        objects.add(file)

    // Retain HEAD commits as well as raw snapshots; a raw HEAD file alone does not keep its commit reachable.
    for (
        let root of state.roots.filter(root =>
            root.kind == "main"
            || (root.kind == "admin" && normalize(dirname(root.path)) == normalize(join(repository.descriptor.commonDirectory, "worktrees")))
        )
    ) {
        let head = root.files.find(file => file.name == "HEAD")
        if (head) {
            let value = heads.get(head.object)
            if (value == undefined) {
                value = (await repository.command(repository.descriptor.mainWorktree, ["cat-file", "blob", head.object])).toString().trim()
                heads.set(head.object, value)
            }
            if (/^[a-f0-9]{40,64}$/.test(value) && !/^0+$/.test(value))
                objects.add(value)
        }
    }

    return [...objects]
}

export async function restoreWorktreeState(repository: RepositoryGit, source: WorktreeState, target: WorktreeState) {
    let objects = [...new Set(target.roots.flatMap(root => root.files.map(file => file.object)))]
    let content = new Map<string, Buffer>()
    if (objects.length) {
        let output = await repository.command(repository.descriptor.mainWorktree, ["cat-file", "--batch"], objects.join("\n") + "\n")
        let offset = 0
        for (let object of objects) {
            let newline = output.indexOf(10, offset)
            let header = output.subarray(offset, newline).toString().split(" ")
            if (header[0] != object || header[1] != "blob")
                throw new Error(`Missing retained worktree object ${object}.`)
            let size = Number(header[2])
            if (!Number.isSafeInteger(size) || size < 0 || newline + size + 1 >= output.length)
                throw new Error("Invalid retained object size.")
            content.set(object, output.subarray(newline + 1, newline + 1 + size))
            offset = newline + size + 2
        }
    }

    // Every source root was verified before starting. A crash during filesystem restoration
    // leaves the journal pending and requires recovery inspection rather than an unsafe reset.
    let moved = new Map<string, string>()
    for (let root of source.roots.filter(root => root.kind == "working" && root.present)) {
        if (target.roots.some(item => normalize(item.path) == normalize(root.path) && item.present))
            continue
        let link = root.files.find(file => file.name == ".git")
        let next = link
            && target.roots.find(item => item.kind == "working" && item.present && item.files.some(file => file.name == ".git" && file.object == link.object))
        if (next)
            moved.set(root.path, next.path)
        else {
            let ignored = await repository.command(root.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
            if (ignored.length)
                throw new Error(`Move ignored files out of ${root.path} before undo/redo deletes this directory. Ignored files are outside recovery.`)
        }
    }

    // Rename the directory itself so ignored files survive rename undo/redo too.
    for (let [from, to] of moved)
        await rename(from, to)

    let sourceRoots = source.roots.map(root => moved.has(root.path) ? { ...root, path: moved.get(root.path)! } : root)
    await repository.updateRefs(
        [...new Set([...Object.keys(source.refs), ...Object.keys(target.refs)])].filter(ref => source.refs[ref] != target.refs[ref]).map(ref => ({
            ref,
            before: source.refs[ref] ?? null,
            after: target.refs[ref] ?? null,
        })),
    )

    for (let root of sourceRoots) {
        let next = target.roots.find(item => normalize(item.path) == normalize(root.path))
        if (!root.present)
            continue
        if (!next?.present && root.kind != "stash") {
            if (root.kind == "main" || normalize(root.path) == normalize(repository.descriptor.mainWorktree))
                throw new Error("The Main Worktree cannot be removed.")
            await rm(root.path, { recursive: true, force: true })
            continue
        }
        for (let file of root.files) {
            if (!next?.files.some(item => item.name == file.name)) {
                let path = safeChild(root.path, file.name)
                if (await pathExists(path))
                    await unlink(path)
            }
        }
    }

    for (let root of target.roots.filter(root => root.present)) {
        await mkdir(root.path, { recursive: true })
        for (let file of root.files) {
            let path = safeChild(root.path, file.name)
            let bytes = content.get(file.object)!
            await mkdir(dirname(path), { recursive: true })
            if (await pathExists(path)) {
                let stat = await lstat(path)
                if (stat.isDirectory()) {
                    if ((await readdir(path)).length)
                        throw new Error(`Cannot replace a non-empty directory: ${path}`)
                    await rmdir(path)
                } else {
                    await unlink(path)
                }
            }
            if (file.link)
                await symlink(bytes.toString(), path)
            else {
                await writeFile(path, bytes)
                if (process.platform != "win32")
                    await chmod(path, file.mode)
            }
        }
    }
}

function safeChild(root: string, name: string) {
    let path = resolve(root, name)
    if (isAbsolute(name) || !path.startsWith(resolve(root) + sep))
        throw new Error("Invalid snapshot path.")
    return path
}
