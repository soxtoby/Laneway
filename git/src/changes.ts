import type { ChangedFile, ChangesInventory, ChangesRequest, DiffLine, DiffSource, FileDiffPage, FileDiffRequest } from "@git-workbench/shared"
import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { GitError, type GitTask, redactGitText, type RepositoryDescriptor } from "./index"

interface Command {
    result: Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>
    cancel(): void
    wasCancelled(): boolean
}
type StartCommand = (cwd: string, args: string[], onOutput?: (chunk: Buffer) => void) => Command

function operation(start: StartCommand) {
    const active = new Set<Command>()
    let cancelled = false
    const check = () => {
        if (cancelled)
            throw new GitError("git.cancelled", "Diff inspection cancelled.")
    }
    return {
        check,
        cancel() {
            cancelled = true
            for (const command of active)
                command.cancel()
        },
        async run(cwd: string, args: string[], onOutput?: (chunk: Buffer) => void, accepted = [0]) {
            check()
            const command = start(cwd, args, onOutput)
            active.add(command)
            const result = await command.result.finally(() => active.delete(command))
            check()
            if (command.wasCancelled())
                throw new GitError("git.cancelled", "Diff inspection cancelled.")
            if (!accepted.includes(result.exitCode))
                throw new GitError("git.command-failed", redactGitText(result.stderr.toString()) || "Git could not inspect these changes.")
            return result.stdout.toString("utf8")
        },
    }
}
type Reader = ReturnType<typeof operation>

export function startChangesRead(descriptor: RepositoryDescriptor, start: StartCommand, request: ChangesRequest): GitTask<ChangesInventory> {
    const reader = operation(start)
    return { cancel: reader.cancel, result: inventory(descriptor, reader, request) }
}

export function startFileDiffRead(descriptor: RepositoryDescriptor, start: StartCommand, request: FileDiffRequest): GitTask<FileDiffPage> {
    const reader = operation(start)
    return { cancel: reader.cancel, result: fileDiff(descriptor, reader, request) }
}

async function directory(descriptor: RepositoryDescriptor, reader: Reader, source: DiffSource) {
    if (source.kind == "commit") {
        oid(descriptor, source.objectId)
        if (source.parentId)
            oid(descriptor, source.parentId)
        return descriptor.selectedWorktree
    }
    if (!isAbsolute(source.worktreePath))
        throw new GitError("git.invalid-root", "Choose a Registered Worktree.")
    const path = await realpath(source.worktreePath)
    const registrations = await reader.run(descriptor.selectedWorktree, ["worktree", "list", "--porcelain", "-z"])
    const paths = registrations.split("\0").filter(value => value.startsWith("worktree ")).map(value => resolve(value.slice(9)))
    if (!paths.some(candidate => equalPath(candidate, path)))
        throw new GitError("git.invalid-root", "The worktree is no longer registered in this repository.")
    return path
}

async function inventory(descriptor: RepositoryDescriptor, reader: Reader, request: ChangesRequest): Promise<ChangesInventory> {
    const cwd = await directory(descriptor, reader, request.source)
    if (request.source.kind == "working") {
        const headBefore = await head(reader, cwd)
        const args = [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
            ...(request.includeIgnored ? ["--ignored=matching"] : []),
        ]
        const status = await reader.run(cwd, args)
        const headAfter = await head(reader, cwd)
        if (headBefore != headAfter)
            throw stale()
        const files = parseStatus(status)
        const stamps = await Promise.all(files.filter(file => !file.ignored).map(file => stamp(resolve(cwd, file.path))))
        return { source: request.source, version: hash(headBefore + status + JSON.stringify(stamps)), parents: [], files }
    }
    const commit = request.source.objectId
    const parents = (await reader.run(cwd, ["show", "-s", "--format=%P", commit, "--"])).trim().split(" ").filter(Boolean)
    const parentId = request.source.parentId ?? parents[0]
    if (parentId && !parents.includes(parentId))
        throw new GitError("git.command-failed", "The selected comparison is not a parent of this commit.")
    const source: DiffSource = { kind: "commit", objectId: commit, ...(parentId ? { parentId } : {}) }
    const output = await reader.run(cwd, [
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
    return { source, version: hash(JSON.stringify(source) + output), parents, files: parseRaw(output) }
}

function parseStatus(output: string): ChangedFile[] {
    const fields = output.split("\0")
    const files: ChangedFile[] = []
    for (let index = 0; index < fields.length; index++) {
        const record = fields[index]
        if (!record)
            continue
        const type = record[0]
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
        const count = type == "1" ? 8 : type == "2" ? 9 : type == "u" ? 10 : 0
        if (!count)
            continue
        const parts = record.split(" ")
        const xy = parts[1]
        const code = xy.replaceAll(".", "")[0] ?? "M"
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
    const fields = output.split("\0")
    const files: ChangedFile[] = []
    for (let i = 0; i < fields.length; i++) {
        if (!fields[i].startsWith(":"))
            continue
        const [oldMode, newMode, , , status] = fields[i].slice(1).split(" ")
        const first = fields[++i]
        const renamed = status.startsWith("R") || status.startsWith("C")
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

async function fileDiff(descriptor: RepositoryDescriptor, reader: Reader, request: FileDiffRequest): Promise<FileDiffPage> {
    validatePath(request.path)
    if (request.offset != undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0))
        throw new GitError("git.command-failed", "Invalid diff page.")
    const current = await inventory(descriptor, reader, { source: request.source, includeIgnored: true })
    const file = current.files.find(file => file.path == request.path)
    if (!file || file.ignored)
        throw new GitError("git.command-failed", "This file no longer has inspectable changes. Refresh the file list.")
    const source = current.source
    const cwd = source.kind == "working" ? source.worktreePath : descriptor.selectedWorktree
    const view = request.view ?? "combined"
    const stage = { base: 1, ours: 2, theirs: 3 }[view as "base" | "ours" | "theirs"]
    if (source.kind == "commit" && view != "combined" || stage && !file.conflicted)
        throw new GitError("git.command-failed", "This comparison is unavailable for the selected file.")
    const before = source.kind == "working" ? await workingIdentity(reader, cwd, file) : current.version
    const collector = patchCollector(request.offset ?? 0, Boolean(stage))
    const summary = collector.summary
    const attributes = await reader.run(cwd, [
        "check-attr",
        "-z",
        ...(source.kind == "commit" ? [`--source=${source.objectId}`] : []),
        "diff",
        "filter",
        "working-tree-encoding",
        "--",
        file.path,
    ])
    const values = attributes.split("\0")
    const attrs = new Map<string, string>()
    for (let i = 0; i + 2 < values.length; i += 3)
        attrs.set(values[i + 1], values[i + 2])
    const custom = attrs.get("diff") && !["unspecified", "set"].includes(attrs.get("diff")!)
    const transformed = ["filter", "working-tree-encoding"].some(name => attrs.has(name) && !["unspecified", "unset"].includes(attrs.get(name)!))
    let selectable = view == "combined" && !file.conflicted
    if (file.oldMode != file.newMode && file.oldMode && file.newMode)
        summary.push(`File mode ${file.oldMode} → ${file.newMode}`)
    if (file.oldPath)
        summary.push(`Renamed ${file.oldPath} → ${file.path}`)
    if (custom || file.untracked && transformed) {
        summary.push("Binary or custom-filter file. Text conversion and external diff programs are disabled.")
        selectable = false
    } else if (stage) {
        const stages = await reader.run(cwd, ["ls-files", "--stage", "-z", "--", file.path])
        if (stages.split("\0").some(record => record.split("\t")[0].endsWith(` ${stage}`)))
            await reader.run(cwd, ["show", `:${stage}:${file.path}`], collector.write)
        else
            summary.push(`This file is absent from ${view}.`)
        summary.push(`${view[0].toUpperCase()}${view.slice(1)} version, read-only`)
    } else {
        const flags = [
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-relative",
            "--no-prefix",
            "--unified=3",
            "--submodule=short",
            "--ignore-submodules=none",
        ]
        const paths = [...new Set([file.oldPath, file.path].filter((path): path is string => Boolean(path)))]
        if (source.kind == "commit") {
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
            const headId = await head(reader, cwd)
            const revisions = view == "staged" ? ["--cached", ...(headId ? [headId] : [])] : view == "unstaged" ? [] : headId ? [headId] : ["--cached"]
            // An unborn HEAD has no tree. For its combined diff read the worktree against an empty file.
            if (!headId && view == "combined") {
                if (file.newMode != "000000") {
                    await safeFile(cwd, file.path)
                    await reader.run(
                        cwd,
                        ["diff", "--no-index", ...flags, "--", process.platform == "win32" ? "NUL" : "/dev/null", file.path],
                        collector.write,
                        [
                            0,
                            1,
                        ],
                    )
                }
            } else {
                await reader.run(cwd, ["diff", "-M", ...flags, ...revisions, "--", ...paths], collector.write)
            }
        }
    }
    const collected = collector.finish()
    if (source.kind == "working" && before != await workingIdentity(reader, cwd, file))
        throw stale()
    reader.check()
    const version = hash(JSON.stringify(source) + before + view + attributes + collected.digest)
    if (request.expectedVersion && version != request.expectedVersion)
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
        version,
        lines: collected.lines,
        ...(collected.more ? { nextOffset: (request.offset ?? 0) + collected.lines.length } : {}),
        summary,
        selectable: selectable && !collected.binary && !collected.oversized,
    }
}

// Retain one page, even when Git produces a multi-gigabyte patch or one huge line.
function patchCollector(offset: number, plain: boolean) {
    const digest = createHash("sha256")
    const decoder = new StringDecoder("utf8")
    const validator = new TextDecoder("utf-8", { fatal: true })
    const lines: DiffLine[] = []
    const summary: string[] = []
    let pending = "", skipping = false, oversized = false, binary = false, invalidEncoding = false, inHunk = false
    let oldLine = 0, newLine = 0, hunk = -1, count = 0
    const accept = (kind: DiffLine["kind"], text: string, old?: number, next?: number) => {
        const id = count++
        if (id >= offset && lines.length < 400)
            lines.push({ id, kind, text, hunk, ...(old != undefined ? { oldLine: old } : {}), ...(next != undefined ? { newLine: next } : {}) })
    }
    const line = (text: string) => {
        if (plain) {
            if (text.includes("\0"))
                binary = true
            accept("context", text, undefined, ++newLine)
            return
        }
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
        if (match) {
            oldLine = Number(match[1])
            newLine = Number(match[2])
            hunk++
            inHunk = true
            accept("hunk", text)
        } else if (text.startsWith("diff --git "))
            inHunk = false
        else if (inHunk && text[0] == "+")
            accept("addition", text.slice(1), undefined, newLine++)
        else if (inHunk && text[0] == "-")
            accept("deletion", text.slice(1), oldLine++)
        else if (inHunk && text[0] == " ")
            accept("context", text.slice(1), oldLine++, newLine++)
        else if (text.startsWith("\\ No newline"))
            accept("notice", text)
        else if (text.startsWith("Binary files ") || text == "GIT binary patch") {
            binary = true
            summary.push("Binary content changed.")
        } else if (/^(old mode|new mode|new file mode|deleted file mode|similarity index)/.test(text) && summary.length < 20) {
            summary.push(text)
        }
    }
    const consume = (text: string) => {
        for (const part of text.split(/(?<=\n)/)) {
            if (!skipping)
                pending += part
            if (pending.length > 16384) {
                oversized = true
                pending = pending.slice(0, 16384)
                skipping = true
            }
            if (part.endsWith("\n")) {
                line(skipping ? `${pending} [line truncated]` : pending.slice(0, -1))
                pending = ""
                skipping = false
            }
        }
    }
    return {
        summary,
        write(chunk: Buffer) {
            digest.update(chunk)
            if (!invalidEncoding) {
                try {
                    validator.decode(chunk, { stream: true })
                } catch {
                    invalidEncoding = true
                }
            }
            consume(decoder.write(chunk))
        },
        finish() {
            if (!invalidEncoding) {
                try {
                    validator.decode()
                } catch {
                    invalidEncoding = true
                }
            }
            consume(decoder.end())
            if (pending)
                line(pending)
            if (oversized)
                summary.push("Very long lines are abbreviated. Line selection is unavailable.")
            if (invalidEncoding)
                summary.push("Content is not UTF-8. Line selection is unavailable.")
            return {
                lines: binary && plain ? [] : lines,
                more: !(binary && plain) && count > offset + lines.length,
                digest: digest.digest("hex"),
                binary,
                oversized: oversized || invalidEncoding,
            }
        },
    }
}

async function workingIdentity(reader: Reader, cwd: string, file: ChangedFile) {
    const [headId, indexPath, attributes, status] = await Promise.all([
        head(reader, cwd),
        reader.run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
        reader.run(cwd, ["check-attr", "-z", "--all", "--", file.path]),
        reader.run(cwd, [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
            "--",
            ...[file.oldPath, file.path].filter((path): path is string => Boolean(path)),
        ]),
    ])
    return JSON.stringify([headId, await stamp(indexPath.trim()), await stamp(resolve(cwd, file.path)), attributes, status])
}
async function stamp(path: string) {
    try {
        const stat = await lstat(path, { bigint: true })
        return [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.mode].map(String)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT")
            return null
        throw error
    }
}
async function safeFile(cwd: string, path: string) {
    const absolute = resolve(cwd, path)
    const stat = await lstat(absolute)
    if (stat.isSymbolicLink())
        return
    const actual = await realpath(absolute)
    const rel = relative(await realpath(cwd), actual)
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
