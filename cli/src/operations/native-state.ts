import { readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import { lstat, readFile, readlink } from "node:fs/promises"
import { resolve } from "node:path"
import { nativeIndexEntries, readNativeIndex } from "./native-index"
import type { NativeFile, NativeIndex, NativeRef, NativeUndo } from "./native-undo-record"

type FileContent = { content: Buffer; mode: number; link: boolean }
type State = {
    cwd: string
    head?: string
    refs: Record<string, NativeRef>
    heads: Record<string, string>
    config: Record<string, string[]>
    logs: Record<string, string | null>
    files: Map<string, FileContent>
    paths?: string[]
    index?: NativeIndex
    stashes?: { object: string; message: string }[]
}

export async function captureNativeState(repo: RepositoryGit, cwd: string, args: string[], before?: State): Promise<State> {
    let command = args[0]
    let root = before?.cwd ?? (await repo.command(cwd, ["rev-parse", "--show-toplevel"])).toString().trim()
    let state: State = { cwd: root, refs: {}, heads: {}, config: {}, logs: {}, files: new Map() }
    if (command == "commit") {
        state.head = await readHead(repo, root)
        let ref = before?.head ?? state.head
        let value = await readNativeRef(repo, root, ref)
        if (value)
            state.refs[ref] = value
    }
    if (command == "branch" || command == "stash" && args[1] == "branch") {
        state.refs = await readBranchRefs(repo, root)
        state.config = await readBranchConfig(repo, root)
        for (let worktree of await readRegisteredWorktrees(repo)) {
            if (!worktree.missing)
                state.heads[worktree.path] = await readWorktreeHead(repo, worktree.path)
        }
        for (let ref of Object.keys({ ...before?.refs, ...state.refs }))
            state.logs[ref] = await readRefLog(repo, root, ref)
    }
    let stashFiles = command == "stash" && (!args[1] || args[1].startsWith("-") || ["push", "save", "apply", "pop", "branch"].includes(args[1]))
    let restoreFiles = command == "restore" && args.some(arg => arg == "--worktree" || /^-[^-]*W/.test(arg))
    if (command == "add" || command == "restore" || stashFiles) {
        let entries = before?.index ? await nativeIndexEntries(repo, root) : undefined
        state.index = entries == before?.index?.entries && before?.index ? before.index : await readNativeIndex(repo, root)
    }
    if (command == "stash")
        state.stashes = await readStashes(repo, root)
    if (stashFiles || restoreFiles) {
        let push = command == "stash" && (!args[1] || args[1].startsWith("-") || ["push", "save"].includes(args[1]))
        let extra = before?.paths ?? (stashFiles && !push ? await stashUntrackedPaths(repo, root, args) : [])
        state.paths = await workingPaths(repo, root, push, args.includes("--all") || args.includes("-a"), extra)
        state.files = await readWorkingFiles(root, state.paths)
    }
    return state
}

export async function nativeStateChanges(repo: RepositoryGit, before: State, after: State): Promise<NativeUndo | undefined> {
    let refs = changedKeys(before.refs, after.refs).map(name => ({ name, before: before.refs[name] ?? null, after: after.refs[name] ?? null }))
    let heads = changedKeys(before.heads, after.heads).filter(path => before.heads[path] && after.heads[path])
        .map(path => ({ path, before: before.heads[path]!, after: after.heads[path]! }))
    let config = changedKeys(before.config, after.config).map(key => ({ key, before: before.config[key] ?? [], after: after.config[key] ?? [] }))
    let logs = refs.map(ref => ({ ref: ref.name, before: before.logs[ref.name] ?? null, after: after.logs[ref.name] ?? null }))
        .filter(log => log.before != log.after)
    let index = before.index && after.index && before.index.entries != after.index.entries ? { before: before.index, after: after.index } : undefined
    let stashes = JSON.stringify(before.stashes) != JSON.stringify(after.stashes) ? { before: before.stashes!, after: after.stashes! } : undefined
    let files: NativeUndo["files"] = []
    for (let path of new Set([...before.files.keys(), ...after.files.keys()])) {
        let old = before.files.get(path), next = after.files.get(path)
        if (!sameFile(old, next))
            files.push({ path, before: await storeFile(repo, before.cwd, old), after: await storeFile(repo, before.cwd, next) })
    }
    if (!refs.length && !heads.length && !config.length && !files.length && !index && !stashes)
        return undefined

    return { cwd: before.cwd, head: before.head, refs, heads, config, logs, files, index, stashes }
}

export async function readHead(repo: RepositoryGit, cwd: string) {
    return (await repo.run(cwd, ["symbolic-ref", "-q", "HEAD"])).stdout.toString().trim() || "HEAD"
}

export async function readWorktreeHead(repo: RepositoryGit, cwd: string) {
    let head = await readHead(repo, cwd)
    return head == "HEAD" ? (await repo.command(cwd, ["rev-parse", "HEAD"])).toString().trim() : head
}

export async function readNativeRef(repo: RepositoryGit, cwd: string, name: string): Promise<NativeRef | null> {
    let object = (await repo.run(cwd, ["rev-parse", "--verify", name])).stdout.toString().trim()
    if (!object)
        return null

    let symbolic = name == "HEAD" ? "" : (await repo.run(cwd, ["symbolic-ref", "-q", name])).stdout.toString().trim()
    return { object, ...(symbolic ? { symbolic } : {}) }
}

export async function readBranchConfig(repo: RepositoryGit, cwd: string) {
    let output = (await repo.run(cwd, ["config", "--local", "--null", "--get-regexp", "^branch\\."])).stdout.toString()
    let config: Record<string, string[]> = {}
    for (let entry of output.split("\0").filter(Boolean)) {
        let split = entry.indexOf("\n")
        let key = entry.slice(0, split)
        ;(config[key] ??= []).push(entry.slice(split + 1))
    }
    return config
}

export async function readStashes(repo: RepositoryGit, cwd: string) {
    let output = await repo.command(cwd, ["stash", "list", "--format=%H%x00%gs"])
    return output.toString().trimEnd().split("\n").filter(Boolean).map(line => {
        let split = line.indexOf("\0")
        return { object: line.slice(0, split), message: line.slice(split + 1) }
    })
}

export async function refLogPath(repo: RepositoryGit, cwd: string, ref: string) {
    return resolve(cwd, (await repo.command(cwd, ["rev-parse", "--git-path", `logs/${ref}`])).toString().trim())
}

export async function readRefLog(repo: RepositoryGit, cwd: string, ref: string) {
    return readFile(await refLogPath(repo, cwd, ref), "utf8").catch(error => {
        if (error.code != "ENOENT")
            throw error
        return null
    })
}

export async function readWorkingFile(cwd: string, path: string): Promise<FileContent | undefined> {
    let absolute = resolve(cwd, path)
    let stat = await lstat(absolute).catch(error => {
        if (error.code != "ENOENT" && error.code != "ENOTDIR")
            throw error
        return undefined
    })
    if (!stat || stat.isDirectory())
        return undefined

    let link = stat.isSymbolicLink()
    return { content: link ? Buffer.from(await readlink(absolute)) : await readFile(absolute), mode: stat.mode & 0o777, link }
}

async function readBranchRefs(repo: RepositoryGit, cwd: string) {
    let output = await repo.command(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/heads", "refs/remotes"])
    return Object.fromEntries(
        output.toString().trimEnd().split("\n").filter(Boolean).map(line => {
            let [name, object, symbolic] = line.split("\0")
            return [name!, { object: object!, ...(symbolic ? { symbolic } : {}) }]
        }),
    )
}

async function workingPaths(repo: RepositoryGit, cwd: string, dirtyOnly: boolean, ignored: boolean, extra: string[]) {
    let output = await repo.command(cwd, ["ls-files", ...(dirtyOnly ? [] : ["--cached"]), "--others", ...(ignored ? [] : ["--exclude-standard"]), "-z"])
    let paths = [...extra, ...output.toString().split("\0").filter(Boolean)]
    if (dirtyOnly) {
        for (let view of [[], ["--cached"]]) {
            let diff = await repo.command(cwd, ["diff", ...view, "--name-only", "--no-renames", "-z"])
            paths.push(...diff.toString().split("\0").filter(Boolean))
        }
    }
    return [...new Set(paths)]
}

async function stashUntrackedPaths(repo: RepositoryGit, cwd: string, args: string[]) {
    let selector = args.slice(args[1] == "branch" ? 3 : 2).find(arg => !arg.startsWith("-")) ?? "stash@{0}"
    let tree = (await repo.run(cwd, ["rev-parse", "--verify", `${selector}^3^{tree}`])).stdout.toString().trim()
    if (!tree)
        return []

    return (await repo.command(cwd, ["ls-tree", "-r", "--name-only", "-z", tree])).toString().split("\0").filter(Boolean)
}

async function readWorkingFiles(cwd: string, paths: string[]) {
    let files = new Map<string, FileContent>()
    for (let path of paths) {
        let file = await readWorkingFile(cwd, path)
        if (file)
            files.set(path, file)
    }
    return files
}

function changedKeys<T>(before: Record<string, T>, after: Record<string, T>) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) != JSON.stringify(after[key]))
}

function sameFile(before: FileContent | undefined, after: FileContent | undefined) {
    return before == after || Boolean(before && after && before.link == after.link && before.mode == after.mode && before.content.equals(after.content))
}

async function storeFile(repo: RepositoryGit, cwd: string, file: FileContent | undefined): Promise<NativeFile | null> {
    if (!file)
        return null

    let object = (await repo.command(cwd, ["hash-object", "-w", "--stdin"], file.content)).toString().trim()
    return { object, mode: file.mode, link: file.link }
}
