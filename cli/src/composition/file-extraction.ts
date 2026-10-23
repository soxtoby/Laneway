import { normalize, pathExists, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import { type CompositionRequest, CompositionRequestSchema, type LocalPreview, type LocalResult } from "@laneway/shared"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { type ChangeRecorder, worktreeTrees } from "../operations/change-recorder"
import { readRecordedRefs } from "../operations/repository-snapshot"
import type { RefsBefore } from "./composition-plan"

interface Change {
    path: string
    mode: string
    before: string
    after: string
}
interface Commit {
    oid: string
    tree: string
    parent: string
    author: string
    message: Buffer
}
interface Extraction {
    before: RefsBefore
    path: string
    ref: string
    head: string
    commits: Commit[]
    changes: Change[]
}
let extractions = new WeakMap<LocalPreview, Extraction>()

/** A file untouched by descendants can leave a linear commit chain without merging or checking out any files. */
export async function prepareFileExtraction(repo: RepositoryGit, request: CompositionRequest) {
    if (
        request.mode != "move" || request.source.kind != "commit" || request.target.kind != "working"
        || !request.files?.length || request.files.some(file => file.lineIds) || request.source.parentId
    ) {
        return undefined
    }

    let paths = request.files.map(file => file.path)
    if (
        new Set(paths).size != paths.length
        || paths.some(path => path.split("/").some(part => !part || part == "." || part == "..") || /[\x00\n\r\\]/.test(path))
    ) {
        return undefined
    }

    let worktrees = await readRegisteredWorktrees(repo)
    let target = worktrees.find(worktree =>
        !worktree.missing && normalize(worktree.path) == normalize(request.target.kind == "working" ? request.target.worktreePath : "")
    )
    if (!target?.branchRef || request.source.branch && target.branchRef != `refs/heads/${request.source.branch.replace(/^refs\/heads\//, "")}`)
        return undefined

    let run = (args: string[], input?: string) => repo.command(target.path, args, input)
    let [configuration, refOutput, hooks, blocked, inventory] = await Promise.all([
        run(["config", "--null", "--list", "--includes"]),
        run([
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
            "refs/tags",
            "refs/stash",
            "refs/remotes",
            "refs/laneway/conflicts/current",
            "refs/laneway/conflict-candidates",
            // A Historical Edit worktree must follow the rewrite, which only the general planner does.
            "refs/laneway/historical-edits",
            "refs/replace",
        ]),
        Promise.all(["pre-commit", "prepare-commit-msg", "commit-msg", "reference-transaction", "post-index-change"].map(async name => {
            try {
                await access(join(repo.descriptor.commonDirectory, "hooks", name), process.platform == "win32" ? constants.F_OK : constants.X_OK)
                return true
            } catch (error) {
                if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
                    throw error
                return false
            }
        })),
        Promise.all(
            ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].map(marker => pathExists(join(target.gitDirectory, marker)))
                .concat(pathExists(join(repo.descriptor.commonDirectory, "info", "grafts"))),
        ),
        request.inventoryVersion ? repo.startReadChanges({ source: request.source }).result : undefined,
    ])
    if (inventory && inventory.version != request.inventoryVersion)
        throw new Error("Source files changed. Select the changes again.")

    let config = new Map(
        configuration.toString().split("\0").filter(Boolean).map(record => {
            let split = record.indexOf("\n")
            return [record.slice(0, split), record.slice(split + 1)]
        }),
    )
    let refs = Object.fromEntries(refOutput.toString().trim().split("\n").filter(Boolean).map(line => line.split(" ")))
    if (
        hooks.some(Boolean) || blocked.some(Boolean) || [...config.keys()].some(key => key.startsWith("hook.") || key == "core.hookspath")
        || ![undefined, "false", "no", "off", "0"].includes(config.get("commit.gpgsign")) || config.has("i18n.commitencoding")
        || Object.keys(refs).some(ref => ref.startsWith("refs/laneway/") || ref.startsWith("refs/heads/laneway/unresolved/") || ref.startsWith("refs/replace/"))
    ) {
        return undefined
    }

    let source = request.source.objectId
    let [related, topology, delta, touched] = await Promise.all([
        run(["for-each-ref", `--contains=${source}`, "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"]),
        repo.run(target.path, ["rev-list", "--reverse", "--max-count=65", "--format=%H %T %P", "--no-commit-header", `${source}^..${target.head}`]),
        run(["diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "-r", "-z", source]),
        run(["--literal-pathspecs", "log", "--format=%H", `${source}..${target.head}`, "--", ...paths]),
    ])
    if (related.toString().trim() != `${target.branchRef} ${target.head}` || topology.exitCode || touched.length)
        return undefined
    let rows = topology.stdout.toString().trim().split("\n").map(line => line.split(" "))
    if (
        rows.length > 64 || rows[0]?.[0] != source || rows.at(-1)?.[0] != target.head
        || rows.some((row, i) => row.length != 3 || i > 0 && (row[2] != rows[i - 1][0] || row[1] == rows[i - 1][1]))
        || worktrees.some(worktree => worktree != target && rows.some(row => row[0] == worktree.head))
    ) {
        return undefined
    }

    let records = delta.toString().split("\0").filter(Boolean), changes: Change[] = []
    for (let i = 0; i < records.length; i += 2) {
        let [beforeMode, mode, before, after, status] = records[i].slice(1).split(" ")
        if (paths.includes(records[i + 1])) {
            if (status != "M" || beforeMode != mode || !["100644", "100755"].includes(mode))
                return undefined
            changes.push({ path: records[i + 1], mode, before, after })
        }
    }

    // Emptying a commit, renames, additions, and shared/published stacks use the general planner.
    if (changes.length != paths.length || changes.length == records.length / 2)
        return undefined

    let [objects, recorded] = await Promise.all([run(["cat-file", "--batch"], rows.map(row => row[0]).join("\n") + "\n"), readRecordedRefs(repo)])
    let before: RefsBefore = { refs: recorded }
    let expectedRefs = Object.fromEntries(Object.entries(refs).filter(([ref]) => !ref.startsWith("refs/remotes/")))
    if (JSON.stringify(expectedRefs) != JSON.stringify(before.refs) || before.refs[target.branchRef] != target.head)
        throw new Error("Repository refs changed while preparing the transfer. Review it again.")

    let index = (await run(["--literal-pathspecs", "ls-files", "--stage", "-v", "-z", "--", ...paths])).toString()
    let entries = index?.split("\0").filter(Boolean) ?? []
    if (
        !index || entries.some(entry => !/^[A-Za-z] \d{6} [a-f0-9]+ 0\t/.test(entry))
        || changes.some(change => !entries.includes(`H ${change.mode} ${change.after} 0\t${change.path}`))
    ) {
        return undefined
    }

    let commits: Commit[] = []
    let offset = 0
    for (let [oid, tree, parent] of rows) {
        let newline = objects.indexOf(10, offset), [actual, type, size] = objects.subarray(offset, newline).toString().split(" ")
        if (actual != oid || type != "commit")
            throw new Error("Cannot read the selected commit chain.")
        let raw = objects.subarray(newline + 1, newline + 1 + Number(size)), split = raw.indexOf("\n\n")
        let headers = raw.subarray(0, split).toString(), author = /^author (.+)$/m.exec(headers)?.[1]
        if (!author || /^encoding /m.test(headers))
            return undefined
        commits.push({ oid, tree, parent, author, message: raw.subarray(split + 2) })
        offset = newline + 2 + Number(size)
    }

    let preview: LocalPreview = {
        token: createHash("sha256").update(
            "file-extraction-v1\0" + JSON.stringify([before.refs, await worktreeTrees(repo, target.path)]) + refOutput + configuration
                + JSON.stringify(CompositionRequestSchema.parse({ ...request, allowConflicts: false })),
        ).digest("hex"),
        affected: [target.path],
        composition: { branches: [target.branchRef.slice(11)], removed: [], conflicts: [], published: [], skipped: [], noop: false },
        uniqueCommits: false,
        unborn: false,
        suggestedBranch: "",
        staged: false,
        files: [],
        stashes: [],
        worktrees: [],
    }

    extractions.set(preview, { before, path: target.path, ref: target.branchRef, head: target.head, commits, changes })
    return { before, preview }
}

export function isFileExtraction(preview: LocalPreview) {
    return extractions.has(preview)
}

export async function extractFiles(
    repo: RepositoryGit,
    preview: LocalPreview,
    refs: ChangeRecorder,
    cancelled: () => boolean,
): Promise<LocalResult> {
    let plan = extractions.get(preview)!
    let identity = (await repo.command(plan.path, ["var", "GIT_COMMITTER_IDENT"])).toString().trim()
    let temporary = `refs/laneway/extraction/${randomUUID()}`, chunks: Buffer[] = []
    for (let [i, commit] of plan.commits.entries()) {
        chunks.push(
            Buffer.from(`commit ${temporary}\nmark :${i + 1}\nauthor ${commit.author}\ncommitter ${identity}\ndata ${commit.message.length}\n`),
            commit.message,
            Buffer.from(
                `\nfrom ${i ? `:${i}` : commit.parent}\nM 040000 ${commit.tree} ""\n`
                    + plan.changes.map(change => `M ${change.mode} ${change.before} ${JSON.stringify(change.path)}\n`).join("") + "\n",
            ),
        )
    }

    chunks.push(Buffer.from(`get-mark :${plan.commits.length}\nreset ${temporary}\n\ndone\n`))
    if (cancelled())
        throw new Error("Transfer cancelled. No transfer was applied.")

    let head = (await repo.command(plan.path, ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fast-import", "--quiet", "--done"], Buffer.concat(chunks)))
        .toString().trim()
    if (cancelled())
        throw new Error("Transfer cancelled before changing files or refs.")

    await repo.updateRefs([{ ref: plan.ref, before: plan.head, after: head }])
    refs.set(plan.ref, head)
    await refs.worktree(plan.path, () =>
        repo.command(
            plan.path,
            ["update-index", "-z", "--index-info"],
            plan.changes.map(change => `${change.mode} ${change.before}\t${change.path}\0`).join(""),
        ))

    return { type: "result", command: "local", status: "performed", message: "Changes transferred." }
}
