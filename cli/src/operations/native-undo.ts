import type { RepositoryGit } from "@laneway/git"
import type { GitResult } from "@laneway/shared"
import { chmod, lstat, mkdir, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { runNativeGit } from "../native-git"
import { nativeIndexEntries, withNativeIndex } from "./native-index"
import { captureNativeState, nativeStateChanges, readBranchConfig, readHead, readNativeRef, readRefLog, readStashes, readWorkingFile, readWorktreeHead, refLogPath } from "./native-state"
import type { NativeUndo } from "./native-undo-record"
import { type CancellationSignal, OperationRuntimeError } from "./operation-contracts"
import { sealOperation, type StoredOperation } from "./operation-record"
import type { OperationStore } from "./operation-store"
import { releaseRecoveryObjects, retainRecoveryObjects } from "./recovery-objects"

export async function executeNativeGit(
    repo: RepositoryGit,
    store: OperationStore,
    args: string[],
    cwd: string,
    json: boolean,
    noWait: boolean,
    cancellation: CancellationSignal,
): Promise<GitResult> {
    let before = await captureNativeState(repo, cwd, args)
    let result = await runNativeGit(repo, args, cwd, json)
    try {
        let after = await captureNativeState(repo, cwd, args, before)
        let nativeUndo = await nativeStateChanges(repo, before, after)
        if (nativeUndo) {
            // Git owns execution. Only recording its completed result uses the history lock.
            await store.withLock(noWait, cancellation, async () => {
                let projection = await store.readHistory()
                let operation = sealOperation({
                    id: crypto.randomUUID(),
                    timestamp: new Date().toISOString(),
                    kind: `git.${args[0]}`,
                    summary: `git ${args[0]}`,
                    affectedRefs: [...nativeUndo.refs.map(ref => ref.name), ...(nativeUndo.stashes ? ["refs/stash"] : [])],
                    affectedWorktrees: nativeUndo.index || nativeUndo.files.length || nativeUndo.head
                        ? [nativeUndo.cwd]
                        : nativeUndo.heads.map(head => head.path),
                    gitCommonDirectory: repo.descriptor.commonDirectory,
                    expectedGitLockfiles: [],
                    refChanges: [],
                    worktreeChanges: [],
                    nativeUndo,
                })
                await retainRecoveryObjects(repo, operation.id, nativeObjects(nativeUndo))
                await store.appendHistory({ schemaVersion: 1, type: "operation", executionId: crypto.randomUUID(), operation })
                for (let abandoned of projection.operations.slice(projection.position))
                    await releaseRecoveryObjects(repo, abandoned.id)
            })
        }
    } catch (error) {
        process.stderr.write(
            `Git finished with exit code ${result.exitCode}; Laneway could not record undo: ${error instanceof Error ? error.message : error}\n`,
        )
    }
    return result
}

export async function validateNativeUndo(repo: RepositoryGit, undo: NativeUndo, action: "undo" | "redo") {
    let side: "before" | "after" = action == "undo" ? "after" : "before"
    if (undo.head && await readHead(repo, undo.cwd) != undo.head)
        throw changed("ref-changed", "The worktree now has a different HEAD.")
    for (let ref of undo.refs) {
        if (!same(await readNativeRef(repo, undo.cwd, ref.name), ref[side]))
            throw changed("ref-changed", `${ref.name} changed outside Laneway.`)
    }
    for (let head of undo.heads) {
        if (await readWorktreeHead(repo, head.path) != head[side])
            throw changed("ref-changed", `HEAD at ${head.path} changed outside Laneway.`)
    }
    if (undo.index && await nativeIndexEntries(repo, undo.cwd) != undo.index[side].entries)
        throw changed("index-changed", "The index changed outside Laneway.")
    if (undo.config.length) {
        let config = await readBranchConfig(repo, undo.cwd)
        for (let entry of undo.config) {
            if (!same(config[entry.key] ?? [], entry[side]))
                throw changed("ref-changed", `${entry.key} changed outside Laneway.`)
        }
    }
    if (undo.stashes && !same(await readStashes(repo, undo.cwd), undo.stashes[side]))
        throw changed("ref-changed", "The stash list changed outside Laneway.")
    for (let log of undo.logs) {
        if (await readRefLog(repo, undo.cwd, log.ref) != log[side])
            throw changed("ref-changed", `The reflog for ${log.ref} changed outside Laneway.`)
    }
    for (let file of undo.files) {
        let current = await readWorkingFile(undo.cwd, file.path)
        let expected = file[side]
        let matches = !current && !expected
        if (current && expected) {
            let content = await repo.command(undo.cwd, ["cat-file", "blob", expected.object])
            matches = current.link == expected.link && current.mode == expected.mode && current.content.equals(content)
        }
        if (!matches)
            throw changed("worktree-changed", `${file.path} changed outside Laneway.`)
    }
    let target: "before" | "after" = action == "undo" ? "before" : "after"
    let removed = new Set(undo.files.map(file => safePath(undo.cwd, file.path)))
    for (let file of undo.files.filter(file => file[target]))
        await validateReplacement(safePath(undo.cwd, file.path), removed)
}

export async function replayNativeUndo(repo: RepositoryGit, store: OperationStore, operation: StoredOperation, action: "undo" | "redo") {
    let undo = operation.nativeUndo!
    let target: "before" | "after" = action == "undo" ? "before" : "after"
    if (undo.index || undo.files.length)
        await withNativeIndex(repo, undo.cwd, undo.index?.[target], () => applyNativeUndo(repo, undo, action))
    else
        await applyNativeUndo(repo, undo, action)
    await store.appendHistory({
        schemaVersion: 1,
        type: "transition",
        executionId: crypto.randomUUID(),
        action,
        operationId: operation.id,
        timestamp: new Date().toISOString(),
    })
}

async function applyNativeUndo(repo: RepositoryGit, undo: NativeUndo, action: "undo" | "redo") {
    await validateNativeUndo(repo, undo, action)
    let source: "before" | "after" = action == "undo" ? "after" : "before"
    let target: "before" | "after" = action == "undo" ? "before" : "after"
    for (let ref of undo.refs) {
        let old = ref[source], next = ref[target]
        if (next?.symbolic)
            await repo.command(undo.cwd, ["symbolic-ref", ref.name, next.symbolic])
        else if (next)
            await repo.command(undo.cwd, ["update-ref", "--no-deref", "-m", `Laneway ${action}`, ref.name, next.object, old?.object ?? zero(repo)])
        else
            await repo.command(undo.cwd, ["update-ref", "--no-deref", "-d", ref.name, old!.object])
    }
    for (let head of undo.heads) {
        if (head[target].startsWith("refs/"))
            await repo.command(head.path, ["symbolic-ref", "HEAD", head[target]])
        else
            await repo.command(head.path, ["update-ref", "--no-deref", "HEAD", head[target]])
    }
    for (let entry of undo.config) {
        await repo.run(undo.cwd, ["config", "--local", "--unset-all", entry.key])
        for (let value of entry[target])
            await repo.command(undo.cwd, ["config", "--local", "--add", entry.key, value])
    }
    for (let log of undo.logs) {
        let path = await refLogPath(repo, undo.cwd, log.ref)
        if (log[target] == null)
            await rm(path, { force: true })
        else {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, log[target]!)
        }
    }
    if (undo.stashes) {
        await repo.command(undo.cwd, ["update-ref", "-d", "refs/stash"])
        for (let stash of [...undo.stashes[target]].reverse())
            await repo.command(undo.cwd, ["stash", "store", "-m", stash.message, stash.object])
    }
    await restoreFiles(repo, undo, target)
}

function nativeObjects(undo: NativeUndo) {
    return [
        ...new Set(
            [
                ...undo.refs.flatMap(ref => [ref.before?.object, ref.after?.object]),
                ...undo.files.flatMap(file => [file.before?.object, file.after?.object]),
                ...undo.heads.flatMap(head => [head.before, head.after]).filter(head => !head.startsWith("refs/")),
                ...undo.logs.flatMap(log => [log.before, log.after]).flatMap(log => (log ?? "").split("\n"))
                    .flatMap(line => line.split(" ").slice(0, 2)).filter(object => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object) && !/^0+$/.test(object)),
                ...(undo.index ? [undo.index.before, undo.index.after].flatMap(index => [index.object, ...index.objects]) : []),
                ...(undo.stashes
                    ? [...undo.stashes.before, ...undo.stashes.after].map(stash => stash.object)
                    : []),
            ].filter((object): object is string => Boolean(object)),
        ),
    ]
}

async function restoreFiles(repo: RepositoryGit, undo: NativeUndo, side: "before" | "after") {
    let paths = undo.files.map(file => ({ file, absolute: safePath(undo.cwd, file.path) }))
    for (let { absolute } of paths.toSorted((a, b) => b.absolute.length - a.absolute.length)) {
        let stat = await fileStat(absolute)
        if (stat && !stat.isDirectory()) {
            await rm(absolute)
            await removeEmptyParents(dirname(absolute), resolve(undo.cwd))
        }
    }
    for (let { file, absolute } of paths.filter(item => item.file[side])) {
        // Removing empty directories permits file/directory replacements without deleting other files.
        await rmdir(absolute).catch(error => {
            if (!["ENOENT", "ENOTDIR"].includes(error.code))
                throw error
        })
        await mkdir(dirname(absolute), { recursive: true })
        let value = file[side]!
        let content = await repo.command(undo.cwd, ["cat-file", "blob", value.object])
        if (value.link)
            await symlink(content.toString(), absolute)
        else {
            await writeFile(absolute, content)
            await chmod(absolute, value.mode)
        }
    }
}

async function validateReplacement(path: string, removed: Set<string>) {
    let stat = await fileStat(path)
    if (!stat?.isDirectory())
        return

    for (let entry of await readdir(path, { withFileTypes: true })) {
        let child = resolve(path, entry.name)
        if (entry.isDirectory())
            await validateReplacement(child, removed)
        else if (!removed.has(child))
            throw changed("worktree-changed", `${child} would be overwritten by undo.`)
    }
}

async function fileStat(path: string) {
    return lstat(path).catch(error => {
        if (!["ENOENT", "ENOTDIR"].includes(error.code))
            throw error
        return undefined
    })
}

async function removeEmptyParents(path: string, root: string) {
    let empty = true
    while (empty && path.startsWith(root + sep)) {
        empty = await rmdir(path).then(() => true, error => {
            if (!["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(error.code))
                throw error
            return false
        })
        path = dirname(path)
    }
}

function safePath(cwd: string, path: string) {
    let absolute = resolve(cwd, path)
    if (!absolute.startsWith(resolve(cwd) + sep))
        throw new Error("Invalid undo path.")
    return absolute
}

function changed(reason: string, message: string) {
    return new OperationRuntimeError("operation.precondition-failed", message, { reason })
}

function same(left: unknown, right: unknown) {
    return JSON.stringify(left) == JSON.stringify(right)
}

function zero(repo: RepositoryGit) {
    return "0".repeat(repo.descriptor.objectFormat == "sha256" ? 64 : 40)
}
