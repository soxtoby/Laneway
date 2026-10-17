import { normalize, type RepositoryGit } from "@laneway/git"
import type { DiffLine, DiscardRequest, DiscardResult, DiscardUndoResult } from "@laneway/shared"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

interface HeldEntry {
    /** Worktree-relative path. */
    path: string
    /** Where the original waits during the undo window, when it existed and could be moved aside. */
    held?: string
}
interface PendingDiscard {
    id: string
    repositoryId: string
    worktreePath: string
    /** Absent when the originals could not be set aside, so there is nothing to release. */
    holding?: string
    entries: HeldEntry[]
    /** Paths a staged discard returned to HEAD, which undo stages again from the restored files. */
    restage: string[]
    completedAt: number
    timer: ReturnType<typeof setTimeout>
}
/** Tracks where the originals are set aside and whether moving them is possible on this worktree. */
interface Holding {
    directory: string
    /** Clears when the git directory sits on another volume, where moving would mean copying. */
    possible: boolean
}

let staleAfterMs = 5 * 60_000

/**
 * Working Changes Discards: the originals move into the worktree's git directory with renames, Git
 * or a direct write replaces them, and undo renames them back. Nothing is read or copied, so a
 * discard costs the same for a large binary as for a one-line file. Pending discards release on
 * request or after the window; directories left by an interrupted session go with the next sweep.
 */
export class WorkingDiscards {
    private readonly pending = new Map<string, PendingDiscard>()

    constructor(private readonly repository: (repositoryId: string) => RepositoryGit, private readonly windowMs = 60_000) {}

    async apply(repositoryId: string, request: DiscardRequest): Promise<DiscardResult> {
        try {
            let repository = this.repository(repositoryId)
            let { root, gitDirectory } = await worktreeGitDirectory(repository, request.worktreePath)
            let id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
            let discards = join(gitDirectory, "laneway", "discard")
            let holding: Holding = {
                directory: join(discards, id),
                possible: await mkdir(join(discards, id), { recursive: true }).then(() => true, () => false),
            }
            let entries: HeldEntry[] = [], restage: string[] = []

            try {
                if (request.kind == "lines")
                    entries.push(await discardLinesOnDisk(root, holding, request))
                else {
                    let restore: string[] = []
                    for (let file of request.files) {
                        let absolute = worktreeFile(root, file.path)
                        if (file.oldPath)
                            worktreeFile(root, file.oldPath)

                        let entry = await hold(holding, absolute, file.path)
                        entries.push(entry)
                        if (request.view == "unstaged" && file.untracked) {
                            if (!entry.held && !holding.possible)
                                await rm(absolute, { recursive: true, force: true })
                        } else {
                            restore.push(file.path)
                            // Restoring HEAD recreates the old side of a rename, which undo removes again.
                            if (request.view == "staged" && file.oldPath) {
                                restore.push(file.oldPath)
                                entries.push({ path: file.oldPath })
                            }
                        }
                    }
                    if (restore.length) {
                        let staged = request.view == "staged"
                        let result = await repository.run(root, [
                            "--literal-pathspecs",
                            "restore",
                            ...(staged ? ["--source=HEAD", "--staged"] : []),
                            "--worktree",
                            "--",
                            ...restore,
                        ])
                        // An unborn branch has no HEAD to restore from; its staged files are all additions.
                        if (result.exitCode && staged && /HEAD/.test(result.stderr.toString()))
                            result = await repository.run(root, ["--literal-pathspecs", "rm", "-q", "-r", "--cached", "--", ...restore])
                        if (result.exitCode)
                            throw new Error(result.stderr.toString().trim() || "Git could not discard the changes.")
                        if (staged)
                            restage.push(...restore)
                    }
                }
            } catch (error) {
                await putBack(root, entries)
                await rm(holding.directory, { recursive: true, force: true })
                throw error
            }

            let held = entries.some(entry => entry.held)
            let pending: PendingDiscard = {
                id,
                repositoryId,
                worktreePath: root,
                holding: held ? holding.directory : undefined,
                entries,
                restage,
                completedAt: Date.now(),
                timer: setTimeout(() => void this.settle(repositoryId, id), this.windowMs),
            }
            pending.timer.unref?.()
            this.pending.set(id, pending)
            if (!held)
                await rm(holding.directory, { recursive: true, force: true })
            void this.sweep(discards)

            // Holding that switched off part-way left some originals unrecoverable, so the discard is final.
            return { ok: true, id, undoable: holding.possible }
        } catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        }
    }

    async undo(repositoryId: string, id: string): Promise<DiscardUndoResult> {
        let pending = this.pending.get(id)
        if (!pending || pending.repositoryId != repositoryId)
            return { ok: false, error: { message: "The discard can no longer be undone." } }

        this.pending.delete(id)
        clearTimeout(pending.timer)
        try {
            let kept: string[] = []
            for (let entry of [...pending.entries].reverse()) {
                let absolute = join(pending.worktreePath, entry.path)
                let current = await stat(absolute).catch(() => undefined)
                // A file edited after the discard keeps the new edits rather than losing them to undo.
                if (current && current.mtimeMs > pending.completedAt + 1000) {
                    kept.push(entry.path)
                    continue
                }
                if (current)
                    await rm(absolute, { recursive: true, force: true })
                if (entry.held) {
                    await mkdir(dirname(absolute), { recursive: true })
                    await rename(entry.held, absolute)
                }
            }

            let restage = pending.restage.filter(path => !kept.includes(path))
            if (restage.length)
                await this.repository(repositoryId).command(pending.worktreePath, ["--literal-pathspecs", "add", "-A", "--", ...restage])
            // Kept files leave their originals in place for the sweep, in case the edits were a mistake too.
            if (pending.holding && !kept.length)
                await rm(pending.holding, { recursive: true, force: true })

            return { ok: true, kept }
        } catch (error) {
            return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
        }
    }

    /** Releases a discard's originals, making it final. */
    async settle(repositoryId: string, id: string) {
        let pending = this.pending.get(id)
        if (!pending || pending.repositoryId != repositoryId)
            return

        this.pending.delete(id)
        clearTimeout(pending.timer)
        if (pending.holding)
            await rm(pending.holding, { recursive: true, force: true })
    }

    private async sweep(discards: string) {
        try {
            for (let name of await readdir(discards)) {
                let started = parseInt(name.split("-")[0], 36)
                if (!this.pending.has(name) && Number.isFinite(started) && Date.now() - started > staleAfterMs)
                    await rm(join(discards, name), { recursive: true, force: true })
            }
        } catch {
            // The directory appears with the first discard that can be held.
        }
    }
}

async function discardLinesOnDisk(root: string, holding: Holding, request: Extract<DiscardRequest, { kind: "lines" }>): Promise<HeldEntry> {
    let absolute = worktreeFile(root, request.path)
    let [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)])
    let text = bytes.toString("utf8")
    if (!Buffer.from(text, "utf8").equals(bytes))
        throw new Error("The file is not UTF-8 text. Discard the whole file instead.")

    let next = discardLines(text, request.lines, request.lineIds)
    let entry = await hold(holding, absolute, request.path)
    await writeFile(absolute, next, { mode: info.mode })
    return entry
}

/**
 * The worktree text with the selected additions removed and the selected deletions put back. Every
 * displayed line is checked against the file, so a stale diff fails instead of corrupting the file.
 */
export function discardLines(text: string, lines: DiffLine[], ids: number[]) {
    let selected = new Set(ids)
    if (selected.size != ids.length || ids.some(id => !lines.some(line => line.id == id && (line.kind == "addition" || line.kind == "deletion"))))
        throw new Error("The selected diff lines changed.")

    let current = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
    let removed = new Set<number>(), insertions = new Map<number, string[]>()
    let cursor = 0
    let matches = (line: DiffLine) => current[cursor] != undefined && current[cursor].replace(/\n$/, "") == line.text
    let changed = () => new Error("The file changed since this diff was read. Reload the diff and select again.")

    for (let [index, line] of lines.entries()) {
        if (line.kind == "hunk") {
            let match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(line.text)
            if (!match)
                throw new Error("Invalid diff hunk.")
            cursor = Number(match[1]) - (match[2] == "0" ? 0 : 1)
        } else if (line.kind == "addition" || line.kind == "context") {
            if (!matches(line))
                throw changed()
            if (line.kind == "addition" && selected.has(line.id))
                removed.add(cursor)
            cursor++
        } else if (line.kind == "deletion" && selected.has(line.id)) {
            let values = insertions.get(cursor) ?? []
            values.push(line.text + (lines[index + 1]?.kind == "notice" ? "" : "\n"))
            insertions.set(cursor, values)
        }
    }

    let result = ""
    for (let i = 0; i <= current.length; i++) {
        let inserted = insertions.get(i) ?? []
        if (inserted.length && result && !result.endsWith("\n"))
            result += "\n"
        result += inserted.join("")
        if (i < current.length && !removed.has(i))
            result += current[i]
    }

    return result
}

/** Moves a worktree path into holding. A missing path holds nothing; another volume turns holding off. */
async function hold(holding: Holding, absolute: string, path: string): Promise<HeldEntry> {
    if (!holding.possible)
        return { path }

    let destination = join(holding.directory, path)
    await mkdir(dirname(destination), { recursive: true })
    try {
        await rename(absolute, destination)
        return { path, held: destination }
    } catch (error) {
        let code = (error as NodeJS.ErrnoException).code
        if (code == "ENOENT")
            return { path }
        if (code == "EXDEV") {
            holding.possible = false
            return { path }
        }
        throw new Error(`${path} is in use and could not be discarded.`)
    }
}

async function putBack(root: string, entries: HeldEntry[]) {
    for (let entry of entries) {
        if (entry.held)
            await rename(entry.held, join(root, entry.path)).catch(() => undefined)
    }
}

function worktreeFile(root: string, path: string) {
    let absolute = resolve(root, path)
    if (
        isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).some(part => part == ".." || part.toLowerCase() == ".git")
        || relative(root, absolute).startsWith("..") || absolute == root
    ) {
        throw new Error("Choose files inside this worktree.")
    }

    return absolute
}

/** Resolves a worktree's own git directory from its `.git` entry and checks it belongs to the repository. */
async function worktreeGitDirectory(repository: RepositoryGit, worktreePath: string) {
    let root = resolve(worktreePath)
    let dotGit = join(root, ".git")
    let info = await stat(dotGit).catch(() => undefined)
    if (!info)
        throw new Error("Choose an available Registered Worktree.")

    let gitDirectory = dotGit
    if (!info.isDirectory()) {
        let link = (await readFile(dotGit, "utf8")).trim()
        if (!link.startsWith("gitdir: "))
            throw new Error("Choose an available Registered Worktree.")
        gitDirectory = resolve(root, link.slice(8).trim())
    }

    let commonLink = await readFile(join(gitDirectory, "commondir"), "utf8").catch(() => undefined)
    let common = commonLink ? resolve(gitDirectory, commonLink.trim()) : gitDirectory
    if (normalize(common) != normalize(repository.descriptor.commonDirectory))
        throw new Error("Choose a worktree of this repository.")

    return { root, gitDirectory }
}
