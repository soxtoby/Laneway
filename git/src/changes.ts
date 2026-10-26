import type { ChangedFile, ChangesInventory, ChangesRequest, ComparisonRef, DiffSource, DiffView, FileContent, FileDiffPage, FileDiffRequest, FileImagePage, FileImageRequest, FileVersion, FileVersionRequest } from "@laneway/shared"
import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { GitError, type GitTask, redactGitText, type RepositoryDescriptor } from "./index"
import { patchCollector } from "./patch-collector"

interface Command {
    result: Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>
    cancel(): void
    wasCancelled(): boolean
}
type StartCommand = (cwd: string, args: string[], onOutput?: (chunk: Buffer) => void, input?: string) => Command

interface ChangesSnapshot {
    inventory: ChangesInventory
    cwd: string
    headId: string
    indexPath?: string
    indexEntries?: string
    attributes: Map<string, string>
}

export type ChangesReadCache = Map<string, ChangesSnapshot>
type Reader = ReturnType<typeof operation>

export function startChangesRead(
    descriptor: RepositoryDescriptor,
    start: StartCommand,
    request: ChangesRequest,
    cache?: ChangesReadCache,
): GitTask<ChangesInventory> {
    let reader = operation(start)
    let result = readSnapshot(descriptor, reader, request).then(snapshot => {
        reader.check()
        if (cache) {
            let key = snapshotKey(snapshot.inventory.source, snapshot.inventory.version)
            cache.delete(key)
            cache.set(key, snapshot)
            if (cache.size > 16)
                cache.delete(cache.keys().next().value!)
        }
        if (snapshot.inventory.source.kind != "comparison")
            return snapshot.inventory

        let offset = request.offset ?? 0
        if (!Number.isSafeInteger(offset) || offset < 0)
            throw new GitError("git.command-failed", "Invalid comparison page.")

        return {
            ...snapshot.inventory,
            files: snapshot.inventory.files.slice(offset, offset + 200),
            ...(offset + 200 < snapshot.inventory.files.length ? { nextOffset: offset + 200 } : {}),
        }
    })
    return { cancel: reader.cancel, result }
}

export function startFileDiffRead(
    descriptor: RepositoryDescriptor,
    start: StartCommand,
    request: FileDiffRequest,
    cache?: ChangesReadCache,
): GitTask<FileDiffPage> {
    let reader = operation(start)
    return { cancel: reader.cancel, result: fileDiff(descriptor, reader, request, cache) }
}

/** Images above this size are reported as unavailable rather than sent to the renderer. */
export let imageSizeLimit = 20 * 1024 * 1024

export function startFileImageRead(
    descriptor: RepositoryDescriptor,
    start: StartCommand,
    request: FileImageRequest,
    cache?: ChangesReadCache,
    limit = imageSizeLimit,
): GitTask<FileImagePage> {
    let reader = operation(start)
    return { cancel: reader.cancel, result: fileImage(descriptor, reader, request, cache, limit) }
}

/** Reads one version of any file, changed or not, as one side of a comparison has it. */
export function startFileVersionRead(
    descriptor: RepositoryDescriptor,
    start: StartCommand,
    request: FileVersionRequest,
    limit = imageSizeLimit,
): GitTask<FileVersion> {
    let reader = operation(start)
    return { cancel: reader.cancel, result: fileVersion(descriptor, reader, request, limit) }
}

function operation(start: StartCommand) {
    let active = new Set<Command>()
    let cancelled = false
    let check = () => {
        if (cancelled)
            throw new GitError("git.cancelled", "Diff inspection cancelled.")
    }
    return {
        check,
        cancel() {
            cancelled = true
            for (let command of active)
                command.cancel()
        },
        async run(cwd: string, args: string[], onOutput?: (chunk: Buffer) => void, accepted = [0], input?: string) {
            check()
            let command = start(cwd, args, onOutput, input)
            active.add(command)
            let result = await command.result.finally(() => active.delete(command))
            check()
            if (command.wasCancelled())
                throw new GitError("git.cancelled", "Diff inspection cancelled.")
            if (!accepted.includes(result.exitCode))
                throw new GitError("git.command-failed", redactGitText(result.stderr.toString()) || "Git could not inspect these changes.")
            return result.stdout.toString("utf8")
        },
    }
}

async function fileDiff(descriptor: RepositoryDescriptor, reader: Reader, request: FileDiffRequest, cache?: ChangesReadCache): Promise<FileDiffPage> {
    validatePath(request.path)
    if (request.offset != undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0))
        throw new GitError("git.command-failed", "Invalid diff page.")

    let cached = request.expectedVersion == undefined && request.inventoryVersion
        ? cache?.get(snapshotKey(request.source, request.inventoryVersion))
        : undefined
    let snapshot = cached ?? await readSnapshot(descriptor, reader, { source: request.source })
    let { cwd, headId } = snapshot
    let source = snapshot.inventory.source
    if (request.expectedVersion != undefined && !snapshot.inventory.files.some(file => file.path == request.path && !file.ignored))
        throw stale()

    let file = changedFile(snapshot.inventory.files, request.path)
    let attributes = snapshot.attributes.get(file.path) ?? ""
    let view = request.view ?? "combined"
    let stage = { base: 1, ours: 2, theirs: 3 }[view as "base" | "ours" | "theirs"]
    if (source.kind != "working" && view != "combined" || stage && !file.conflicted)
        throw new GitError("git.command-failed", "This comparison is unavailable for the selected file.")

    let before = request.expectedVersion != undefined && source.kind == "working" ? await workingIdentity(reader, cwd, file) : undefined
    if (before && (before.headId != headId || before.attributes != attributes))
        throw stale()
    let evidence = source.kind == "working"
        ? await Promise.all([snapshot.indexEntries, ...[file.path, ...(file.oldPath ? [file.oldPath] : [])].map(path => stamp(resolve(cwd, path)))])
        : undefined
    let collector = patchCollector(request.offset ?? 0, Boolean(stage))
    let summary = collector.summary

    let values = attributes.split("\0")
    let attrs = new Map<string, string>()
    for (let i = 0; i + 2 < values.length; i += 3)
        attrs.set(values[i + 1], values[i + 2])

    let custom = attrs.get("diff") && !["unspecified", "set"].includes(attrs.get("diff")!)
    let transformed = ["filter", "working-tree-encoding"].some(name => attrs.has(name) && !["unspecified", "unset"].includes(attrs.get(name)!))
    let selectable = source.kind != "comparison" && source.kind != "refs" && ["combined", "staged", "unstaged"].includes(view) && !file.conflicted
        && !file.oldPath
        && ![file.oldMode, file.newMode].some(mode => mode == "120000" || mode == "160000")

    if (file.oldMode != file.newMode && file.oldMode && file.newMode)
        summary.push(describeModeChange(file.oldMode, file.newMode))
    if (file.oldPath)
        summary.push(`Renamed ${file.oldPath} → ${file.path}`)

    if (custom || file.untracked && transformed) {
        summary.push("Binary or custom-filter file. Text conversion and external diff programs are disabled.")
        selectable = false
    } else if (stage) {
        let stages = await reader.run(cwd, ["ls-files", "--stage", "-z", "--", file.path])
        if (stages.split("\0").some(record => record.split("\t")[0].endsWith(` ${stage}`)))
            await reader.run(cwd, ["show", `:${stage}:${file.path}`], collector.write)
        else
            summary.push(`This file is absent from ${view}.`)
        summary.push(`${view[0].toUpperCase()}${view.slice(1)} version, read-only`)
    } else {
        let flags = [
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-relative",
            "--no-prefix",
            request.entireFile ? "--unified=2147483647" : "--unified=3",
            "--submodule=short",
            "--ignore-submodules=none",
        ]
        let paths = [...new Set([file.oldPath, file.path].filter((path): path is string => Boolean(path)))]
        if (source.kind == "comparison") {
            await reader.run(
                cwd,
                ["diff-tree", "--no-commit-id", "-r", "-p", "-M", ...flags, source.fromObjectId, source.toObjectId, "--", ...paths],
                collector.write,
            )
        } else if (source.kind == "commit") {
            await reader.run(cwd, [
                "diff-tree",
                "--no-commit-id",
                "--root",
                "-r",
                "-p",
                "-M",
                ...flags,
                ...(source.parentId ? [source.parentId, source.objectId] : [source.objectId]),
                "--",
                ...paths,
            ], collector.write)
        } else if (file.untracked && view == "staged")
            summary.push("This file has no staged content.")
        else if (file.untracked) {
            await safeFile(cwd, file.path)
            await reader.run(cwd, ["diff", "--no-index", ...flags, "--", process.platform == "win32" ? "NUL" : "/dev/null", file.path], collector.write, [0, 1])
        } else {
            let revisions = view == "staged" ? ["--cached", ...(headId ? [headId] : [])] : view == "unstaged" ? [] : headId ? [headId] : ["--cached"]
            // An unborn HEAD has no tree. For its combined diff read the worktree against an empty file.
            if (!headId && view == "combined") {
                if (file.newMode != "000000") {
                    await safeFile(cwd, file.path)
                    await reader.run(
                        cwd,
                        ["diff", "--no-index", ...flags, "--", process.platform == "win32" ? "NUL" : "/dev/null", file.path],
                        collector.write,
                        [0, 1],
                    )
                }
            } else {
                await reader.run(cwd, ["diff", "-M", ...flags, ...revisions, "--", ...paths], collector.write)
            }
        }
    }

    let collected = collector.finish()
    if (before && before.identity != (await workingIdentity(reader, cwd, file)).identity)
        throw stale()
    reader.check()
    let version = hash(JSON.stringify(source) + JSON.stringify(file) + headId + view + attributes + JSON.stringify(evidence) + collected.digest)
    if (request.expectedVersion != undefined && version != request.expectedVersion)
        throw stale()

    if (file.submodule) {
        summary.push(`Submodule ${file.submodule}. Inspect its repository for internal changes.`)
        selectable = false
    }
    if (transformed) {
        summary.push("Git filters or encoding conversion apply. Line composition is unavailable.")
        selectable = false
    }

    return {
        source,
        file,
        view,
        ...(request.entireFile ? { entireFile: true } : {}),
        version,
        lines: collected.lines,
        ...(collected.more ? { nextOffset: (request.offset ?? 0) + collected.lines.length } : {}),
        summary,
        selectable: selectable && !collected.binary && !collected.oversized,
    }
}

async function fileImage(
    descriptor: RepositoryDescriptor,
    reader: Reader,
    request: FileImageRequest,
    cache: ChangesReadCache | undefined,
    limit: number,
): Promise<FileImagePage> {
    validatePath(request.path)
    let cached = request.inventoryVersion ? cache?.get(snapshotKey(request.source, request.inventoryVersion)) : undefined
    let snapshot = cached ?? await readSnapshot(descriptor, reader, { source: request.source })
    let { cwd, headId } = snapshot
    let source = snapshot.inventory.source
    let file = changedFile(snapshot.inventory.files, request.path)
    let view = request.view ?? "combined"
    let stage = { base: 1, ours: 2, theirs: 3 }[view as "base" | "ours" | "theirs"]
    if (source.kind != "working" && view != "combined" || stage && !file.conflicted)
        throw new GitError("git.command-failed", "This comparison is unavailable for the selected file.")

    let oldPath = file.oldPath ?? file.path
    let store: BlobStore = { reader, cwd, commonDirectory: descriptor.commonDirectory, limit, fetchLfs: request.fetchLfs == true, noun: "image" }
    let blob = (object: string, path: string) => readBlob(store, object, path)
    let worktree = () => readWorktreeFile(store, file.path)
    let sides: { old?: FileContent; new?: FileContent } = {}

    if (source.kind == "comparison") {
        sides.old = file.oldMode != "000000" ? await blob(`${source.fromObjectId}:${oldPath}`, oldPath) : undefined
        sides.new = file.newMode != "000000" ? await blob(`${source.toObjectId}:${file.path}`, file.path) : undefined
    } else if (source.kind == "commit") {
        sides.old = source.parentId && file.oldMode != "000000" ? await blob(`${source.parentId}:${oldPath}`, oldPath) : undefined
        sides.new = file.newMode != "000000" ? await blob(`${source.objectId}:${file.path}`, file.path) : undefined
    } else {
        let inHead = Boolean(headId) && !file.untracked && file.oldMode != "000000"
        let inWorktree = file.untracked || file.newMode != "000000"
        let indexStages = view == "combined" ? [] : await stagesOf(reader, cwd, file.path)
        if (stage)
            sides.new = indexStages.includes(stage) ? await blob(`:${stage}:${file.path}`, file.path) : undefined
        else if (view == "staged") {
            sides.old = inHead ? await blob(`${headId}:${oldPath}`, oldPath) : undefined
            sides.new = indexStages.includes(0) ? await blob(`:0:${file.path}`, file.path) : undefined
        } else if (view == "unstaged") {
            sides.old = indexStages.includes(0) ? await blob(`:0:${file.path}`, file.path) : undefined
            sides.new = inWorktree ? await worktree() : undefined
        } else {
            sides.old = inHead ? await blob(`${headId}:${oldPath}`, oldPath) : undefined
            sides.new = inWorktree ? await worktree() : undefined
        }
    }
    reader.check()

    let identity = [sides.old, sides.new].map(side => side?.state == "ready" ? hash(Buffer.from(side.bytes).toString("base64")) : JSON.stringify(side))
    return {
        source,
        file,
        view,
        version: hash(JSON.stringify(source) + JSON.stringify(file) + headId + view + identity.join()),
        ...sides,
    }
}

async function fileVersion(descriptor: RepositoryDescriptor, reader: Reader, request: FileVersionRequest, limit: number): Promise<FileVersion> {
    validatePath(request.path)
    let revision = sideRevision(request.source, request.view ?? "combined", request.side)
    if (revision == undefined)
        return { state: "missing" }

    let cwd = await directory(descriptor, reader, request.source)
    let store: BlobStore = { reader, cwd, commonDirectory: descriptor.commonDirectory, limit, fetchLfs: request.fetchLfs == true, noun: "file" }
    let read = (revision: string) =>
        revision == "worktree" ? readWorktreeFile(store, request.path) : readBlob(store, `${revision}:${request.path}`, request.path)
    // A conflict stage holds only the conflicted files, so the others come from the index; a conflicted file has no
    // stage 0, so one missing from its stage stays missing.
    let content = await unlessMissing(read(revision)) ?? (/^:[1-3]$/.test(revision) ? await unlessMissing(read(":0")) : undefined)
    return content ?? { state: "missing" }
}

/** The revision a side of a comparison reads from: an object, `HEAD`, an index stage such as `:0`, or the worktree. */
function sideRevision(source: DiffSource, view: DiffView, side: "old" | "new") {
    let stage = { base: 1, ours: 2, theirs: 3 }[view as "base" | "ours" | "theirs"]
    if (source.kind == "comparison")
        return side == "old" ? source.fromObjectId : source.toObjectId
    if (source.kind == "commit")
        return side == "old" ? source.parentId : source.objectId
    if (source.kind == "refs")
        return undefined
    if (stage)
        return side == "new" ? `:${stage}` : undefined
    if (view == "staged")
        return side == "old" ? "HEAD" : ":0"
    if (view == "unstaged")
        return side == "old" ? ":0" : "worktree"
    return side == "old" ? "HEAD" : "worktree"
}

async function unlessMissing(read: Promise<FileContent>) {
    try {
        return await read
    } catch (error) {
        let missing = error instanceof GitError ? error.code == "git.command-failed" : (error as NodeJS.ErrnoException).code == "ENOENT"
        if (!missing)
            throw error
        return undefined
    }
}

async function stagesOf(reader: Reader, cwd: string, path: string) {
    let output = await reader.run(cwd, ["ls-files", "--stage", "-z", "--", path])
    return output.split("\0").filter(Boolean).map(record => Number(record.split("\t")[0].split(" ")[2]))
}

interface BlobStore {
    reader: Reader
    cwd: string
    commonDirectory: string
    limit: number
    fetchLfs: boolean
    /** What the reasons a version is unavailable call it. */
    noun: "image" | "file"
}

async function readBlob(store: BlobStore, object: string, path: string): Promise<FileContent> {
    let bytes = await collectOutput(store, ["cat-file", "blob", object])
    return bytes ? blobContent(store, bytes, path) : oversized(store)
}

async function readWorktreeFile(store: BlobStore, path: string): Promise<FileContent> {
    await safeFile(store.cwd, path)
    let absolute = resolve(store.cwd, path)
    let stat = await lstat(absolute)
    return stat.size > store.limit ? oversized(store) : blobContent(store, await readFile(absolute), path)
}

// A Git LFS pointer stands in for the file. Its object comes from the local LFS store when present; downloading
// it is a separate, explicitly requested read so the first read stays quick and offline.
async function blobContent(store: BlobStore, bytes: Buffer, path: string): Promise<FileContent> {
    let pointer = lfsPointer(bytes)
    if (!pointer)
        return ready(bytes)
    if (pointer.size > store.limit)
        return oversized(store)

    let stored = await readLfsObject(store.commonDirectory, pointer.oid)
    if (stored)
        return ready(stored)
    else if (store.fetchLfs)
        return fetchLfsObject(store, bytes, path)
    else
        return { state: "lfs", size: pointer.size }
}

async function readLfsObject(commonDirectory: string, oid: string) {
    try {
        return await readFile(resolve(commonDirectory, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code != "ENOENT")
            throw error
        return undefined
    }
}

// Smudging through git-lfs downloads the object into the local store, so later reads find it there.
async function fetchLfsObject(store: BlobStore, pointer: Buffer, path: string): Promise<FileContent> {
    try {
        let bytes = await collectOutput(store, ["lfs", "smudge", "--", path], pointer.toString("utf8"))
        if (!bytes)
            return oversized(store)
        else if (lfsPointer(bytes))
            return { state: "unavailable", reason: `Git LFS could not download this ${store.noun}.` }
        else
            return ready(bytes)
    } catch (error) {
        if (!(error instanceof GitError) || error.code != "git.command-failed")
            throw error
        return { state: "unavailable", reason: /not a git command/i.test(error.message) ? `Install Git LFS to show this ${store.noun}.` : error.message }
    }
}

/** Streams a command's output up to the size limit; `undefined` means the limit was exceeded. */
async function collectOutput(store: BlobStore, args: string[], input?: string) {
    let chunks: Buffer[] = []
    let length = 0
    await store.reader.run(
        store.cwd,
        args,
        chunk => {
            length += chunk.length
            if (length <= store.limit)
                chunks.push(chunk)
        },
        [0],
        input,
    )
    return length > store.limit ? undefined : Buffer.concat(chunks)
}

function ready(bytes: Buffer): FileContent {
    return { state: "ready", bytes: new Uint8Array(bytes), size: bytes.length }
}

function lfsPointer(bytes: Buffer) {
    if (bytes.length > 1024 || !bytes.subarray(0, 8).equals(Buffer.from("version ")))
        return undefined

    let text = bytes.toString("utf8")
    let oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)
    let size = /^size (\d+)$/m.exec(text)
    return text.startsWith("version https://git-lfs.github.com/spec/v1\n") && oid && size ? { oid: oid[1], size: Number(size[1]) } : undefined
}

function oversized(store: BlobStore): FileContent {
    return { state: "unavailable", reason: `This ${store.noun} is larger than ${Math.round(store.limit / 1024 / 1024)} MB.` }
}

function snapshotKey(source: DiffSource, version: string) {
    return JSON.stringify([source, version])
}

async function readSnapshot(descriptor: RepositoryDescriptor, reader: Reader, request: ChangesRequest): Promise<ChangesSnapshot> {
    let cwd = await directory(descriptor, reader, request.source)

    if (request.source.kind == "refs" || request.source.kind == "comparison") {
        let source: DiffSource = request.source.kind == "refs"
            ? {
                kind: "comparison",
                fromObjectId: await resolveComparisonRef(descriptor, reader, cwd, request.source.from),
                toObjectId: await resolveComparisonRef(descriptor, reader, cwd, request.source.to),
            }
            : request.source

        let output = await reader.run(cwd, [
            "diff-tree",
            "--no-commit-id",
            "-r",
            "--raw",
            "-z",
            "--no-abbrev",
            "--no-ext-diff",
            "--no-textconv",
            "-M",
            source.fromObjectId,
            source.toObjectId,
            "--",
        ])
        let files = parseRaw(output)
        let attributes = await readAttributes(reader, cwd, source, files)
        return {
            inventory: { source, version: hash(JSON.stringify(source) + output + JSON.stringify([...attributes])), parents: [], files },
            cwd,
            headId: "",
            attributes,
        }
    }
    if (request.source.kind == "working") {
        let headBefore = await head(reader, cwd)
        let status = await workingStatus(reader, cwd, request.includeIgnored)
        let files = parseStatus(status)

        let [headAfter, attributes, stamps, indexPath, indexEntries] = await Promise.all([
            head(reader, cwd),
            readAttributes(reader, cwd, request.source, files),
            Promise.all(files.filter(file => !file.ignored).map(file => stamp(resolve(cwd, file.path)))),
            reader.run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
            reader.run(cwd, ["ls-files", "--stage", "-z"]),
        ])
        if (headBefore != headAfter)
            throw stale()

        return {
            inventory: {
                source: request.source,
                version: hash(headBefore + status + JSON.stringify(stamps) + JSON.stringify([...attributes]) + indexEntries),
                parents: [],
                files,
            },
            cwd,
            headId: headBefore,
            indexPath: indexPath.trim(),
            indexEntries,
            attributes,
        }
    }

    let commit = request.source.objectId
    let parents = (await reader.run(cwd, ["show", "-s", "--format=%P", commit, "--"])).trim().split(" ").filter(Boolean)
    let parentId = request.source.parentId ?? parents[0]
    if (parentId && !parents.includes(parentId))
        throw new GitError("git.command-failed", "The selected comparison is not a parent of this commit.")

    let source: DiffSource = { kind: "commit", objectId: commit, ...(parentId ? { parentId } : {}) }
    let output = await reader.run(cwd, [
        "diff-tree",
        "--no-commit-id",
        "--root",
        "-r",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        ...(parentId ? [parentId, commit] : [commit]),
        "--",
    ])
    let files = parseRaw(output)
    let attributes = await readAttributes(reader, cwd, source, files)
    return {
        inventory: { source, version: hash(JSON.stringify(source) + output + JSON.stringify([...attributes])), parents, files },
        cwd,
        headId: "",
        attributes,
    }
}

async function directory(descriptor: RepositoryDescriptor, reader: Reader, source: DiffSource) {
    if (source.kind == "refs" || source.kind == "comparison") {
        if (source.kind == "comparison") {
            oid(descriptor, source.fromObjectId)
            oid(descriptor, source.toObjectId)
        }
        return descriptor.selectedWorktree
    }
    if (source.kind == "commit") {
        oid(descriptor, source.objectId)
        if (source.parentId)
            oid(descriptor, source.parentId)
        return descriptor.selectedWorktree
    }
    if (!isAbsolute(source.worktreePath))
        throw new GitError("git.invalid-root", "Choose a Registered Worktree.")

    let path = await realpath(source.worktreePath)
    let registrations = await reader.run(descriptor.selectedWorktree, ["worktree", "list", "--porcelain", "-z"])
    let paths = registrations.split("\0").filter(value => value.startsWith("worktree ")).map(value => resolve(value.slice(9)))
    if (!paths.some(candidate => equalPath(candidate, path)))
        throw new GitError("git.invalid-root", "The worktree is no longer registered in this repository.")
    return path
}

async function resolveComparisonRef(descriptor: RepositoryDescriptor, reader: Reader, cwd: string, ref: ComparisonRef): Promise<string> {
    if (ref.kind == "commit") {
        oid(descriptor, ref.objectId)
        return ref.objectId
    } else if (ref.kind == "branch")
        return (await branchTips(reader, cwd, [ref.ref]))[0]
    else {
        let [base, tip] = await branchTips(reader, cwd, [ref.ref, ref.withRef])
        let mergeBase = (await reader.run(cwd, ["merge-base", base, tip], undefined, [0, 1])).trim()
        if (!mergeBase)
            throw new GitError("git.command-failed", "The compared branches share no history.")
        return mergeBase
    }
}

async function branchTips(reader: Reader, cwd: string, refs: string[]) {
    for (let ref of refs) {
        if (!/^refs\/(heads|remotes)\/.+/.test(ref))
            throw new GitError("git.command-failed", "Choose a branch ref.")
        await reader.run(cwd, ["check-ref-format", ref])
    }
    let output = await reader.run(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "--", ...refs])
    let tips = new Map(output.trim().split("\n").map(line => line.trim().split(" ") as [string, string]))
    let objectIds = refs.map(ref => tips.get(ref))
    if (objectIds.some(objectId => !objectId))
        throw new GitError("git.command-failed", "A compared branch is unavailable. Close this comparison.")

    return objectIds as string[]
}

async function readAttributes(reader: Reader, cwd: string, source: DiffSource, files: ChangedFile[]) {
    let paths = files.filter(file => !file.ignored).map(file => file.path)
    let attributes = new Map<string, string>()
    if (!paths.length)
        return attributes

    let output = await reader.run(
        cwd,
        [
            "check-attr",
            "-z",
            ...(source.kind == "commit" ? [`--source=${source.objectId}`] : source.kind == "comparison" ? [`--source=${source.toObjectId}`] : []),
            "--all",
            "--stdin",
        ],
        undefined,
        [0],
        paths.join("\0") + "\0",
    )
    let values = output.split("\0")
    for (let i = 0; i + 2 < values.length; i += 3) {
        let path = values[i]
        attributes.set(path, (attributes.get(path) ?? "") + `${path}\0${values[i + 1]}\0${values[i + 2]}\0`)
    }

    return attributes
}

function parseStatus(output: string): ChangedFile[] {
    let fields = output.split("\0")
    let files: ChangedFile[] = []
    for (let index = 0; index < fields.length; index++) {
        let record = fields[index]
        if (!record)
            continue
        let type = record[0]
        if (type == "?" || type == "!") {
            files.push({
                path: record.slice(2),
                status: type == "?" ? "added" : "ignored",
                staged: false,
                unstaged: true,
                untracked: type == "?",
                ignored: type == "!",
                conflicted: false,
            })
            continue
        }
        let count = type == "1" ? 8 : type == "2" ? 9 : type == "u" ? 10 : 0
        if (!count)
            continue
        let parts = record.split(" ")
        let xy = parts[1]
        let code = xy.replaceAll(".", "")[0] ?? "M"
        files.push({
            path: parts.slice(count).join(" "),
            ...(type == "2" ? { oldPath: fields[++index] } : {}),
            status: type == "u" ? "conflicted" : statusName(code),
            staged: xy[0] != ".",
            unstaged: xy[1] != ".",
            untracked: false,
            ignored: false,
            conflicted: type == "u",
            ...(parts[2].startsWith("S") ? { submodule: parts[2] } : {}),
            oldMode: parts[3],
            newMode: parts[type == "u" ? 6 : 5],
        })
    }
    return files.sort((left, right) => left.path.localeCompare(right.path))
}

function parseRaw(output: string): ChangedFile[] {
    let fields = output.split("\0")
    let files: ChangedFile[] = []
    for (let i = 0; i < fields.length; i++) {
        if (!fields[i].startsWith(":"))
            continue
        let [oldMode, newMode, , , status] = fields[i].slice(1).split(" ")
        let first = fields[++i]
        let renamed = status.startsWith("R") || status.startsWith("C")
        files.push({
            path: renamed ? fields[++i] : first,
            ...(renamed ? { oldPath: first } : {}),
            status: statusName(status[0]),
            staged: false,
            unstaged: false,
            untracked: false,
            ignored: false,
            conflicted: false,
            oldMode,
            newMode,
            ...(oldMode == "160000" || newMode == "160000" ? { submodule: "S..." } : {}),
        })
    }
    return files.sort((left, right) => left.path.localeCompare(right.path))
}

function changedFile(files: ChangedFile[], path: string) {
    let file = files.find(file => file.path == path)
    if (!file || file.ignored)
        throw new GitError("git.command-failed", "This file no longer has inspectable changes. Refresh the file list.")
    return file
}

function describeModeChange(before: string, after: string) {
    let type = (mode: string) => {
        switch (mode) {
            case "100644":
                return "File"
            case "100755":
                return "Executable"
            case "120000":
                return "Symlink"
            case "160000":
                return "Submodule"
            case "040000":
                return "Directory"
            default:
                return "Unknown type"
        }
    }
    if (before == "000000")
        return `${type(after)} added`
    if (after == "000000")
        return `${type(before)} deleted`
    if (before == "100644" && after == "100755")
        return "Executable"
    if (before == "100755" && after == "100644")
        return "Not executable"
    return `${type(before)} → ${type(after)}`
}

async function workingIdentity(reader: Reader, cwd: string, file: ChangedFile) {
    let [headId, indexPath, attributes, status] = await Promise.all([
        head(reader, cwd),
        reader.run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
        reader.run(cwd, ["check-attr", "-z", "--all", "--", file.path]),
        workingStatus(reader, cwd, false, [file.oldPath, file.path].filter((path): path is string => Boolean(path))),
    ])
    return {
        headId,
        attributes,
        identity: JSON.stringify([headId, await stamp(indexPath.trim()), await stamp(resolve(cwd, file.path)), attributes, status]),
    }
}

function workingStatus(reader: Reader, cwd: string, includeIgnored = false, paths: string[] = []) {
    return reader.run(cwd, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
        ...(includeIgnored ? ["--ignored=matching"] : []),
        "--",
        ...paths,
    ])
}
async function stamp(path: string) {
    try {
        let stat = await lstat(path, { bigint: true })
        return [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.mode].map(String)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT")
            return null
        throw error
    }
}
async function safeFile(cwd: string, path: string) {
    let absolute = resolve(cwd, path)
    let stat = await lstat(absolute)
    if (stat.isSymbolicLink())
        return
    let actual = await realpath(absolute)
    let rel = relative(await realpath(cwd), actual)
    if (rel == ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !stat.isFile())
        throw new GitError("git.command-failed", "Only files inside this worktree can be inspected.")
}
function validatePath(path: string) {
    if (!path || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).includes(".."))
        throw new GitError("git.command-failed", "Invalid repository file path.")
}
function oid(descriptor: RepositoryDescriptor, value: string) {
    if (!new RegExp(`^[0-9a-f]{${descriptor.objectFormat == "sha1" ? 40 : 64}}$`).test(value))
        throw new GitError("git.command-failed", "Diff inputs must be full commit object IDs.")
}
async function head(reader: Reader, cwd: string) {
    return (await reader.run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], undefined, [0, 1])).trim()
}
function hash(value: string) {
    return createHash("sha256").update(value).digest("hex")
}
function equalPath(left: string, right: string) {
    return process.platform == "win32" ? left.toLowerCase() == right.toLowerCase() : left == right
}
function stale() {
    return new GitError("git.command-failed", "The source changed while reading. Refresh to inspect its current content.")
}
function statusName(code: string) {
    return ({ A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "conflicted" } as Record<string, string>)[code] ?? "modified"
}
