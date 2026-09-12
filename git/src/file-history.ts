import { type FileHistoryEntry, type FileHistoryPage, type FileHistoryRequest, FileHistoryRequestSchema } from "@git-workbench/shared"
import { realpath } from "node:fs/promises"
import { GitError, type GitTask, type RepositoryDescriptor } from "./index"
import { parseFileChanges, rankRelatedFiles } from "./related-files"

type Command = { result: Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>; cancel(): void }
type Start = (cwd: string, args: string[]) => Command

/** Bounded first-parent walk: preserve the actual parent and path at every transition. */
export function startFileHistoryRead(descriptor: RepositoryDescriptor, start: Start, input: FileHistoryRequest): GitTask<FileHistoryPage> {
    let active: Command | undefined
    let cancelled = false
    async function run(cwd: string, args: string[], optional = false) {
        if (cancelled)
            throw new GitError("git.cancelled", "History read cancelled.")
        active = start(cwd, ["-c", "core.quotepath=false", ...args])
        const result = await active.result
        if (cancelled)
            throw new GitError("git.cancelled", "History read cancelled.")
        if (result.exitCode && !optional)
            throw new GitError("git.command-failed", "File history source is unavailable.")
        return result.exitCode ? "" : result.stdout.toString("utf8")
    }
    const result = (async () => {
        const request = FileHistoryRequestSchema.parse(input)
        let cwd = descriptor.selectedWorktree
        let tip = ""
        if (request.source.kind == "worktree") {
            cwd = await realpath(request.source.worktreePath)
            const common = (await run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
            if (await realpath(common) != await realpath(descriptor.commonDirectory))
                throw new GitError("git.command-failed", "Worktree does not belong to this repository.")
            tip = (await run(cwd, ["rev-parse", "--verify", "HEAD"], true)).trim()
        } else if (request.source.kind == "branch") {
            const refs = (await run(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", request.source.ref])).trim().split("\n")
            tip = refs.map(line => line.split("\0")).find(([ref]) => ref == (request.source as { ref: string }).ref)?.[1] ?? ""
            if (!tip)
                throw new GitError("git.command-failed", "History branch is unavailable. Close or choose another source.")
        } else {
            tip = request.source.objectId
        }
        if (request.related) {
            const { objectId, path, offset = 0 } = request.related
            const parents = (await run(cwd, ["show", "-s", "--format=%P", objectId])).trim().split(" ").filter(Boolean)
            const parentId = request.related.parentId ?? parents[0]
            if (parentId && !parents.includes(parentId))
                throw new GitError("git.command-failed", "Selected parent does not belong to this commit.")
            const changes = parseFileChanges(
                await run(cwd, [
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "-r",
                    "-z",
                    "--name-status",
                    "-M",
                    "-C",
                    "--find-copies-harder",
                    ...(parentId ? [parentId, objectId] : [objectId]),
                    "--",
                ]),
            )
            const contents = new Map<string, string>()
            for (const change of [{ path, status: "" }, ...changes.slice(0, 100)]) {
                const oid = change.status == "D" ? parentId : objectId
                if (!oid)
                    continue
                const size = Number((await run(cwd, ["cat-file", "-s", `${oid}:${change.path}`], true)).trim())
                if (!size || size > 128_000)
                    continue
                const text = await run(cwd, ["show", `${oid}:${change.path}`], true)
                if (!text.includes("\0"))
                    contents.set(change.path, text)
            }
            const related = rankRelatedFiles(path, objectId, parentId, changes, contents)
            return {
                tip,
                entries: [],
                related: related.slice(offset, offset + 50),
                ...(offset + 50 < related.length ? { nextRelatedOffset: offset + 50 } : {}),
                ...(changes.length > 100
                    ? { notice: "Content evidence is limited to the first 100 changed files; remaining files use co-change evidence." }
                    : {}),
            }
        }
        if (request.blame) {
            const { objectId, path, offset = 0 } = request.blame
            const content = await run(cwd, ["show", `${objectId}:${path}`], true)
            if (content.includes("\0") || content.length > 2_000_000)
                return { tip, entries: [], notice: "Blame is unavailable for binary or oversized files." }
            const count = content.split("\n").length - (content.endsWith("\n") ? 1 : 0)
            if (!content || offset >= count)
                return { tip, entries: [], blame: [] }
            const end = Math.min(count, offset + 200)
            const raw = await run(cwd, ["blame", "--line-porcelain", "-M", "-C", "-L", `${offset + 1},${end}`, objectId, "--", path])
            const blame: NonNullable<FileHistoryPage["blame"]> = []
            let current = { objectId: "", originalLine: 0, line: 0, path, author: "" }
            for (const line of raw.split("\n")) {
                const header = /^([a-f0-9]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line)
                if (header)
                    current = { ...current, objectId: header[1], originalLine: Number(header[2]), line: Number(header[3]) }
                else if (line.startsWith("author "))
                    current.author = line.slice(7)
                else if (line.startsWith("filename "))
                    current.path = line.slice(9)
                else if (line.startsWith("\t"))
                    blame.push({ ...current, text: line.slice(1) })
            }
            return { tip, entries: [], blame, ...(end < count ? { nextBlameOffset: end } : {}) }
        }
        const entries: FileHistoryEntry[] = []
        const eligible = new Set(
            request.composition
                ? (await run(cwd, ["rev-list", "--max-count=10000", request.composition.tip, "--not", request.composition.primaryTip])).trim().split("\n")
                : [],
        )
        let objectId = request.cursor?.objectId ?? tip
        let path = request.cursor?.path ?? request.path
        if (!request.cursor && request.source.kind == "worktree" && tip) {
            const working = parseFileChanges(await run(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", tip, "--"]))
            path = working.find(change => change.path == path)?.previousPath ?? path
        }
        for (let scanned = 0; objectId && scanned < 200 && entries.length < 40; scanned++) {
            const metadata = (await run(cwd, ["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s", objectId])).trimEnd().split("\0")
            const [oid, parents, authorName, authorEmail, authoredAt, subject] = metadata
            const parentIds = parents ? parents.split(" ") : []
            const fields =
                (await run(cwd, [
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "-r",
                    "-z",
                    "--name-status",
                    "-M",
                    "-C",
                    "--find-copies-harder",
                    ...(parentIds[0] ? [parentIds[0], oid] : [oid]),
                    "--",
                ])).split("\0")
            const match = parseFileChanges(fields.join("\0")).find(change => change.path == path)
            if (match) {
                let candidates: string[] | undefined
                if (match.previousPath && parentIds[0]) {
                    const blob = (await run(cwd, ["rev-parse", "--verify", `${oid}:${path}`])).trim()
                    const tree = (await run(cwd, ["ls-tree", "-r", "-z", parentIds[0]])).split("\0")
                    const exact = tree.flatMap(record => {
                        const tab = record.indexOf("\t")
                        return record.slice(0, tab).split(" ")[2] == blob ? [record.slice(tab + 1)] : []
                    })
                    if (exact.length > 1 || !match.status.endsWith("100")) {
                        candidates = exact.length ? exact : [match.previousPath]
                        const choice = request.choices?.find(choice =>
                            choice.objectId == oid && choice.path == path && candidates!.includes(choice.previousPath)
                        )
                        if (choice)
                            match.previousPath = choice.previousPath
                        else
                            match.previousPath = undefined
                    }
                }
                entries.push({
                    objectId: oid,
                    parentIds,
                    authorName,
                    authorEmail,
                    authoredAt: Number(authoredAt),
                    subject,
                    followedParent: parentIds[0],
                    ...match,
                    candidates,
                    composable: eligible.has(oid),
                })
                if (candidates && !match.previousPath) {
                    objectId = ""
                    break
                }
                if (match.previousPath)
                    path = match.previousPath
                else if (match.status == "A") {
                    objectId = ""
                    break
                }
            }
            objectId = parentIds[0] ?? ""
        }
        return { tip: tip || undefined, entries, ...(objectId ? { cursor: { objectId, path } } : {}) }
    })()
    return {
        result,
        cancel() {
            cancelled = true
            active?.cancel()
        },
    }
}
