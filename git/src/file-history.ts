import { type FileHistoryEntry, type FileHistoryPage, type FileHistoryRequest, FileHistoryRequestSchema } from "@laneway/shared"
import { realpath } from "node:fs/promises"
import { GitError, type GitTask, type RepositoryDescriptor } from "./index"
import { type FileChange, parseFileChanges, rankRelatedFiles } from "./related-files"

type Command = { result: Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>; cancel(): void }
type Start = (cwd: string, args: string[]) => Command

/** Bounded first-parent walk: preserve the actual parent and path at every transition. */
export function startFileHistoryRead(descriptor: RepositoryDescriptor, start: Start, input: FileHistoryRequest): GitTask<FileHistoryPage> {
    let active: Command | undefined
    let cancelled = false
    let result = (async () => {
        let request = FileHistoryRequestSchema.parse(input)
        let cwd = descriptor.selectedWorktree
        let tip = ""
        if (request.source.kind == "worktree") {
            cwd = await realpath(request.source.worktreePath)
            let common = (await run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()
            if (await realpath(common) != await realpath(descriptor.commonDirectory))
                throw new GitError("git.command-failed", "Worktree does not belong to this repository.")
            tip = (await run(cwd, ["rev-parse", "--verify", "HEAD"], true)).trim()
        } else if (request.source.kind == "branch") {
            let refs = (await run(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", request.source.ref])).trim().split("\n")
            tip = refs.map(line => line.split("\0")).find(([ref]) => ref == (request.source as { ref: string }).ref)?.[1] ?? ""
            if (!tip)
                throw new GitError("git.command-failed", "History branch is unavailable. Close or choose another source.")
        } else {
            tip = request.source.objectId
        }

        if (request.related) {
            let { objectId, path, offset = 0 } = request.related
            let parents = (await run(cwd, ["show", "-s", "--format=%P", objectId])).trim().split(" ").filter(Boolean)
            let parentId = request.related.parentId ?? parents[0]
            if (parentId && !parents.includes(parentId))
                throw new GitError("git.command-failed", "Selected parent does not belong to this commit.")

            let changes = parseFileChanges(
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

            let contents = new Map<string, string>()
            for (let change of [{ path, status: "" }, ...changes.slice(0, 100)]) {
                let oid = change.status == "D" ? parentId : objectId
                if (!oid)
                    continue
                let size = Number((await run(cwd, ["cat-file", "-s", `${oid}:${change.path}`], true)).trim())
                if (!size || size > 128_000)
                    continue
                let text = await run(cwd, ["show", `${oid}:${change.path}`], true)
                if (!text.includes("\0"))
                    contents.set(change.path, text)
            }

            let related = rankRelatedFiles(path, objectId, parentId, changes, contents)
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
            let { objectId, path, offset = 0 } = request.blame
            let content = await run(cwd, ["show", `${objectId}:${path}`], true)
            if (content.includes("\0") || content.length > 2_000_000)
                return { tip, entries: [], notice: "Blame is unavailable for binary or oversized files." }
            let count = content.split("\n").length - (content.endsWith("\n") ? 1 : 0)
            if (!content || offset >= count)
                return { tip, entries: [], blame: [] }

            let end = Math.min(count, offset + 200)
            let raw = await run(cwd, ["blame", "--line-porcelain", "-M", "-C", "-L", `${offset + 1},${end}`, objectId, "--", path])
            let blame: NonNullable<FileHistoryPage["blame"]> = []
            let current = { objectId: "", originalLine: 0, line: 0, path, author: "" }
            for (let line of raw.split("\n")) {
                let header = /^([a-f0-9]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line)
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

        let entries: FileHistoryEntry[] = []
        let eligible = new Set(
            request.composition
                ? (await run(cwd, ["rev-list", "--max-count=10000", request.composition.tip, "--not", request.composition.primaryTip])).trim().split("\n")
                : [],
        )
        let objectId = request.cursor?.objectId ?? tip
        let path = request.cursor?.path ?? request.path
        if (!request.cursor && request.source.kind == "worktree" && tip) {
            let working = parseFileChanges(await run(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", tip, "--"]))
            path = working.find(change => change.path == path)?.previousPath ?? path
        }

        // Bound the revision walk before filtering by path: log -n with a path alone
        // can scan the entire repository history to find enough matching commits.
        // Keep the first response small; amortize process startup across larger
        // continuation windows once the column can already show results.
        let scanLimit = request.cursor ? 2000 : 200
        let metadata = objectId
            ? (await run(cwd, [
                "log",
                "--no-patch",
                "--first-parent",
                `--max-count=${scanLimit}`,
                // Bodies span lines, so records end in NUL as well and the fields are read in groups of seven.
                "-z",
                "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b",
                objectId,
                "--",
            ]))
                .split("\0")
            : []
        let commits: Array<Omit<FileHistoryEntry, "path" | "status">> = []
        for (let index = 0; index + 6 < metadata.length; index += 7) {
            let [oid, parents, authorName, authorEmail, authoredAt, subject, body] = metadata.slice(index, index + 7)
            let parentIds = parents ? parents.split(" ") : []
            commits.push({
                objectId: oid,
                parentIds,
                authorName,
                authorEmail,
                authoredAt: Number(authoredAt),
                subject,
                body: body.trimEnd(),
                followedParent: parentIds[0],
            })
        }

        let boundary = commits.at(-1)?.followedParent
        let commitIds = new Set(commits.map(commit => commit.objectId))
        let changes = new Map<string, FileChange>()
        let scannedPath: string | undefined
        for (let commit of commits) {
            let { objectId: oid, parentIds } = commit
            if (entries.length == (request.limit ?? 40))
                break

            if (scannedPath != path) {
                // Tree metadata only, restricted to this literal file. Never compute
                // whole-repository copy similarity for ordinary edits/unrelated commits.
                let fields =
                    (await run(cwd, [
                        "log",
                        "--first-parent",
                        "--full-history",
                        "--diff-merges=first-parent",
                        "--format=%H",
                        "-z",
                        "--name-status",
                        "--root",
                        "--no-renames",
                        "--no-ext-diff",
                        "--no-textconv",
                        oid,
                        ...(boundary ? [`^${boundary}`] : []),
                        "--",
                        path,
                    ])).split("\0")
                changes = new Map()
                let current = ""
                for (let index = 0; index < fields.length; index++) {
                    let field = fields[index].trim()
                    if (commitIds.has(field))
                        current = field
                    else if (/^[ADMT]$/.test(field)) {
                        let changedPath = fields[++index]
                        if (changedPath == path)
                            changes.set(current, { status: field, path: changedPath })
                    }
                }
                scannedPath = path
            }

            let match = changes.get(oid)
            // Only an addition can introduce a different predecessor path. Keep the
            // existing explicit ambiguity rules, but pay for evidence at that boundary only.
            if (match?.status == "A" && parentIds[0]) {
                match = parseFileChanges(
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
                        parentIds[0],
                        oid,
                        "--",
                    ]),
                ).find(change => change.path == path) ?? match
            }

            if (match) {
                let candidates: string[] | undefined
                if (match.previousPath && parentIds[0]) {
                    let blob = (await run(cwd, ["rev-parse", "--verify", `${oid}:${path}`])).trim()
                    let tree = (await run(cwd, ["ls-tree", "-r", "-z", parentIds[0]])).split("\0")
                    let exact = tree.flatMap(record => {
                        let tab = record.indexOf("\t")
                        return record.slice(0, tab).split(" ")[2] == blob ? [record.slice(tab + 1)] : []
                    })
                    if (exact.length > 1 || !match.status.endsWith("100")) {
                        candidates = exact.length ? exact : [match.previousPath]
                        let choice = request.choices?.find(choice => choice.objectId == oid && choice.path == path && candidates!.includes(choice.previousPath))
                        if (choice)
                            match.previousPath = choice.previousPath
                        else
                            match.previousPath = undefined
                    }
                }

                entries.push({
                    ...commit,
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

    async function run(cwd: string, args: string[], optional = false) {
        if (cancelled)
            throw new GitError("git.cancelled", "History read cancelled.")

        active = start(cwd, ["-c", "core.quotepath=false", "--literal-pathspecs", ...args])
        let result = await active.result
        if (cancelled)
            throw new GitError("git.cancelled", "History read cancelled.")
        if (result.exitCode && !optional)
            throw new GitError("git.command-failed", "File history source is unavailable.")

        return result.exitCode ? "" : result.stdout.toString("utf8")
    }
}
