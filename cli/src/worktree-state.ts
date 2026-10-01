import { normalize, pathExists, populatedSubmodules, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import type { RegisteredWorktree } from "@laneway/shared"
import { chmod, lstat, mkdir, readdir, readlink, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"

const FileSchema = z.object({ name: z.string(), object: z.string(), mode: z.number(), link: z.boolean(), identity: z.string().optional() })
const RootSchema = z.object({ path: z.string(), kind: z.enum(["working", "admin", "main", "stash"]), present: z.boolean(), files: z.array(FileSchema) })
export const WorktreeStateSchema = z.object({ roots: z.array(RootSchema), refs: z.record(z.string(), z.string()) })
export type WorktreeState = z.infer<typeof WorktreeStateSchema>
type Root = z.infer<typeof RootSchema>

export async function relocateRemovedState(repository: RepositoryGit, state: WorktreeState, oldPath: string, newPath: string) {
    const result = structuredClone(state)
    for (const root of result.roots) {
        if (normalize(root.path) == normalize(oldPath))
            root.path = newPath
        if (root.kind != "admin")
            continue
        const link = root.files.find(file => file.name == "gitdir")
        if (!link)
            continue
        const value = (await repository.command(repository.descriptor.mainWorktree, ["cat-file", "blob", link.object])).toString()
        if (normalize(dirname(value.trim())) != normalize(oldPath))
            continue
        link.object =
            (await repository.command(repository.descriptor.mainWorktree, ["hash-object", "-w", "--stdin"], `${join(newPath, ".git").replaceAll("\\", "/")}\n`))
                .toString().trim()
    }
    result.roots.sort((a, b) => a.path.localeCompare(b.path))
    return result
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
): Promise<WorktreeState> {
    const worktrees = registered ?? await readRegisteredWorktrees(repository)
    const roots = new Map<string, Root>()
    const submodules = new Map<string, string[]>()
    const ordinaryFiles: Array<{ path: string; file: z.infer<typeof FileSchema> }> = []
    const add = (path: string, kind: Root["kind"]) => roots.set(normalize(path), { path, kind, present: false, files: [] })
    for (const root of template?.roots ?? [])
        add(root.path, root.kind)
    for (const path of paths) {
        add(path, "working")
        const worktree = worktrees.find(item => normalize(item.path) == normalize(path))
        if (worktree)
            add(worktree.gitDirectory, worktree.main ? "main" : "admin")
        if (worktree && !worktree.missing) {
            const children = await populatedSubmodules(repository, path)
            submodules.set(normalize(path), children)
            for (const child of children) {
                const admin = (await repository.command(child, ["rev-parse", "--absolute-git-dir"])).toString().trim()
                if (worktree.main || !normalize(admin).startsWith(normalize(worktree.gitDirectory) + sep))
                    add(admin, "admin")
            }
        }
    }
    add(join(repository.descriptor.commonDirectory, "logs", "refs"), "stash")
    for (const root of roots.values()) {
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
                names = await workingFiles(repository, root.path, submodules.get(normalize(root.path)))
                if ((await lstat(join(root.path, ".git"))).isFile())
                    names.push(".git")
            }
        } else if (root.kind == "main")
            names = ["HEAD", "index", "logs/HEAD", "config", "laneway-local.json"]
        else if (root.kind == "stash")
            names = ["stash"]
        else
            names = await filesUnder(root.path)
        for (const name of [...new Set(names)].sort()) {
            const path = safeChild(root.path, name)
            if (!await pathExists(path))
                continue
            const stat = await lstat(path)
            if (stat.isDirectory())
                continue
            const link = stat.isSymbolicLink()
            const object = link
                ? (await repository.command(repository.descriptor.mainWorktree, ["hash-object", "-w", "--stdin"], await readlink(path))).toString().trim()
                : ""
            let identity: string | undefined
            if ((root.kind == "main" || root.kind == "admin") && (name == "index" || name.endsWith("/index"))) {
                identity = (await repository.command(repository.descriptor.mainWorktree, ["--git-dir", dirname(path), "ls-files", "--stage", "-v", "-z"]))
                    .toString()
            }
            const file = { name, object, mode: stat.mode & 0o777, link, identity }
            root.files.push(file)
            if (!link)
                ordinaryFiles.push({ path, file })
        }
    }
    if (ordinaryFiles.length) {
        const output = await repository.command(
            repository.descriptor.mainWorktree,
            ["hash-object", "-w", "--no-filters", "--stdin-paths"],
            ordinaryFiles.map(item => JSON.stringify(item.path.replaceAll("\\", "/"))).join("\n") + "\n",
        )
        const objects = output.toString().trim().split("\n")
        if (objects.length != ordinaryFiles.length)
            throw new Error("Git did not capture every worktree file.")
        ordinaryFiles.forEach((item, index) => item.file.object = objects[index]!)
    }
    const refs: Record<string, string> = {}
    const output =
        (await repository.command(repository.descriptor.mainWorktree, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
            "refs/tags",
            "refs/stash",
            "refs/laneway/conflicts/current",
            "refs/laneway/conflict-candidates",
        ])).toString()
    for (const line of output.trim().split("\n").filter(Boolean)) {
        const [ref, oid] = line.split(" ")
        refs[ref!] = oid!
    }
    return { roots: [...roots.values()].sort((a, b) => a.path.localeCompare(b.path)), refs }
}

async function workingFiles(repository: RepositoryGit, path: string, submodules?: string[], prefix = ""): Promise<string[]> {
    const names = (await repository.command(path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean)
    const result = names.map(name => prefix + name)
    for (const child of submodules ?? await populatedSubmodules(repository, path)) {
        // The recursive submodule listing already includes descendants.
        const childPrefix = prefix + relative(path, child).replaceAll("\\", "/") + "/"
        const files = (await repository.command(child, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean)
        result.push(childPrefix + ".git", ...files.map(name => childPrefix + name))
    }
    return result
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
    const result: string[] = []
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        const name = prefix + entry.name
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
            files: root.files.map(file => ({
                name: file.name,
                object: file.identity ?? file.object,
                link: file.link,
                mode: process.platform == "win32" ? 0 : file.mode,
            })),
        })).sort((a, b) => a.path.localeCompare(b.path)),
    })
}

export async function worktreeStateMatches(repository: RepositoryGit, expected: WorktreeState) {
    const actual = await captureWorktreeState(repository, expected.roots.filter(root => root.kind == "working").map(root => root.path), expected)
    return stateIdentity(actual) == stateIdentity(expected)
}

export async function retainWorktreeState(repository: RepositoryGit, id: string, side: string, state: WorktreeState) {
    const objects = new Set(Object.values(state.refs))
    const files = [...new Set(state.roots.flatMap(root => root.files.map(file => file.object)))]
    if (files.length) {
        const tree = (await repository.command(
            repository.descriptor.mainWorktree,
            ["mktree", "-z"],
            files.map((object, index) => `100644 blob ${object}\t${index}\0`).join(""),
        )).toString().trim()
        objects.add(tree)
    }
    // Retain HEAD commits as well as raw snapshots; a raw HEAD file alone does not keep its commit reachable.
    for (
        const root of state.roots.filter(root =>
            root.kind == "main"
            || (root.kind == "admin" && normalize(dirname(root.path)) == normalize(join(repository.descriptor.commonDirectory, "worktrees")))
        )
    ) {
        const head = root.files.find(file => file.name == "HEAD")
        if (head) {
            const value = (await repository.command(repository.descriptor.mainWorktree, ["cat-file", "blob", head.object])).toString().trim()
            if (/^[a-f0-9]{40,64}$/.test(value) && !/^0+$/.test(value))
                objects.add(value)
        }
    }
    if (objects.size) {
        await repository.command(
            repository.descriptor.mainWorktree,
            ["update-ref", "--stdin"],
            [...objects].map((object, index) => `update refs/laneway/recovery/${id}/${side}/state-${index} ${object}\n`).join(""),
        )
    }
}

export async function restoreWorktreeState(repository: RepositoryGit, source: WorktreeState, target: WorktreeState) {
    const objects = [...new Set(target.roots.flatMap(root => root.files.map(file => file.object)))]
    const content = new Map<string, Buffer>()
    if (objects.length) {
        const output = await repository.command(repository.descriptor.mainWorktree, ["cat-file", "--batch"], objects.join("\n") + "\n")
        let offset = 0
        for (const object of objects) {
            const newline = output.indexOf(10, offset)
            const header = output.subarray(offset, newline).toString().split(" ")
            if (header[0] != object || header[1] != "blob")
                throw new Error(`Missing retained worktree object ${object}.`)
            const size = Number(header[2])
            if (!Number.isSafeInteger(size) || size < 0 || newline + size + 1 >= output.length)
                throw new Error("Invalid retained object size.")
            content.set(object, output.subarray(newline + 1, newline + 1 + size))
            offset = newline + size + 2
        }
    }
    // Every source root was verified before starting. A crash during filesystem restoration
    // leaves the journal pending and requires recovery inspection rather than an unsafe reset.
    const moved = new Map<string, string>()
    for (const root of source.roots.filter(root => root.kind == "working" && root.present)) {
        if (target.roots.some(item => normalize(item.path) == normalize(root.path) && item.present))
            continue
        const link = root.files.find(file => file.name == ".git")
        const next = link
            && target.roots.find(item => item.kind == "working" && item.present && item.files.some(file => file.name == ".git" && file.object == link.object))
        if (next)
            moved.set(root.path, next.path)
        else {
            const ignored = await repository.command(root.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
            if (ignored.length)
                throw new Error(`Move ignored files out of ${root.path} before undo/redo deletes this directory. Ignored files are outside recovery.`)
        }
    }
    // Rename the directory itself so ignored files survive rename undo/redo too.
    for (const [from, to] of moved)
        await rename(from, to)
    const sourceRoots = source.roots.map(root => moved.has(root.path) ? { ...root, path: moved.get(root.path)! } : root)
    await repository.updateRefs(
        [...new Set([...Object.keys(source.refs), ...Object.keys(target.refs)])].filter(ref => source.refs[ref] != target.refs[ref]).map(ref => ({
            ref,
            before: source.refs[ref] ?? null,
            after: target.refs[ref] ?? null,
        })),
    )
    for (const root of sourceRoots) {
        const next = target.roots.find(item => normalize(item.path) == normalize(root.path))
        if (!root.present)
            continue
        if (!next?.present && root.kind != "stash") {
            if (root.kind == "main" || normalize(root.path) == normalize(repository.descriptor.mainWorktree))
                throw new Error("The Main Worktree cannot be removed.")
            await rm(root.path, { recursive: true, force: true })
            continue
        }
        for (const file of root.files) {
            if (!next?.files.some(item => item.name == file.name)) {
                const path = safeChild(root.path, file.name)
                if (await pathExists(path))
                    await unlink(path)
            }
        }
    }
    for (const root of target.roots.filter(root => root.present)) {
        await mkdir(root.path, { recursive: true })
        for (const file of root.files) {
            const path = safeChild(root.path, file.name)
            const bytes = content.get(file.object)!
            await mkdir(dirname(path), { recursive: true })
            if (await pathExists(path)) {
                const stat = await lstat(path)
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
    const path = resolve(root, name)
    if (isAbsolute(name) || !path.startsWith(resolve(root) + sep))
        throw new Error("Invalid snapshot path.")
    return path
}
