import { normalize, pathExists, populatedSubmodules, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import type { RegisteredWorktree } from "@laneway/shared"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { retainRecoveryObjects } from "./recovery-objects"

let identity = {
    GIT_AUTHOR_NAME: "Laneway",
    GIT_AUTHOR_EMAIL: "checkpoint@laneway.invalid",
    GIT_COMMITTER_NAME: "Laneway",
    GIT_COMMITTER_EMAIL: "checkpoint@laneway.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
}
let WorktreeSchema = z.object({
    id: z.string(),
    path: z.string(),
    main: z.boolean(),
    head: z.string(),
    branchRef: z.string().optional(),
    present: z.boolean(),
    registered: z.boolean(),
    locked: z.boolean(),
    lockReason: z.string().optional(),
    scope: z.array(z.string()).optional(),
    fingerprint: z.string(),
    stash: z.string().optional(),
    submodules: z.array(z.object({
        path: z.string(),
        head: z.string(),
        branchRef: z.string().optional(),
        stash: z.string().optional(),
        fingerprint: z.string(),
        remotes: z.array(z.tuple([z.string(), z.string()])),
    })).default([]),
})
export let GitCheckpointSchema = z.object({
    version: z.literal(1),
    refs: z.record(z.string(), z.string()),
    worktrees: z.array(WorktreeSchema),
    metadata: z.string().nullable(),
    branchConfig: z.array(z.tuple([z.string(), z.string()])),
    stashes: z.array(z.object({ object: z.string(), message: z.string() })),
})
export type GitCheckpoint = z.infer<typeof GitCheckpointSchema>
type Worktree = z.infer<typeof WorktreeSchema>

export async function retainCheckpoint(repo: RepositoryGit, operation: string, ...checkpoints: GitCheckpoint[]) {
    await retainRecoveryObjects(
        repo,
        operation,
        checkpoints.flatMap(
            c => [
                ...Object.values(c.refs),
                ...c.worktrees.flatMap(w => [w.head, w.stash, ...w.submodules.flatMap(s => [s.head, s.stash])].filter((id): id is string => Boolean(id))),
                ...c.stashes.map(s => s.object),
            ],
        ),
    )
}

export async function restoreGitCheckpoint(repo: RepositoryGit, source: GitCheckpoint, target: GitCheckpoint) {
    let main = repo.descriptor.mainWorktree
    let current = await readRegisteredWorktrees(repo)
    if (!await checkpointMatches(repo, source))
        throw new Error("Repository state changed outside Laneway. The checkpoint was left intact.")

    for (let to of target.worktrees.filter(w => w.registered)) {
        if (await pathExists(to.path) && !current.some(w => normalize(w.path) == normalize(to.path)))
            throw new Error(`The worktree destination is occupied: ${to.path}`)
    }

    // Move existing registrations first: Git preserves their identity and ignored files.
    for (let to of target.worktrees.filter(w => w.registered)) {
        let from = current.find(w => w.id == to.id)
        if (from && normalize(from.path) != normalize(to.path)) {
            if (await pathExists(to.path))
                throw new Error(`The worktree destination is occupied: ${to.path}`)
            await repo.command(main, ["worktree", "move", "--", from.path, to.path])
        }
    }

    for (let from of source.worktrees.filter(w => w.registered)) {
        let to = target.worktrees.find(w => w.id == from.id) ?? target.worktrees.find(w => normalize(w.path) == normalize(from.path))
        if (!to?.registered) {
            if (from.main)
                throw new Error("The Main Worktree cannot be removed.")
            if (from.present) {
                let ignored = await repo.command(from.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
                if (ignored.length)
                    throw new Error(`Move ignored files out of ${from.path} before restoring this checkpoint.`)
            }
            await repo.command(main, ["worktree", "remove", "--force", "--", from.path])
        } else if (to.present && !to.scope && await pathExists(to.path)) {
            if (from.head)
                await repo.command(to.path, ["checkout", "--detach", "--force", "--no-overwrite-ignore", from.head])
            await repo.command(to.path, ["clean", "-fd"])
        }
    }

    await repo.updateRefs(
        [...new Set([...Object.keys(source.refs), ...Object.keys(target.refs)])]
            .filter(ref => ref != "refs/stash" && source.refs[ref] != target.refs[ref])
            .map(ref => ({ ref, before: source.refs[ref] ?? null, after: target.refs[ref] ?? null })),
    )

    for (let to of target.worktrees.filter(w => w.registered)) {
        let exists = await pathExists(to.path)
        if (!exists) {
            await mkdir(dirname(to.path), { recursive: true })
            await repo.command(main, ["worktree", "add", "--detach", "--", to.path, to.head])
        }
        if (to.scope)
            await repo.command(to.path, ["--literal-pathspecs", "restore", "--staged", `--source=${to.head}`, "--", ...to.scope])
        else {
            let base = to.head || (to.stash ? (await repo.command(main, ["rev-parse", `${to.stash}^1`])).toString().trim() : "")
            if (base)
                await repo.command(to.path, ["checkout", "--detach", "--force", "--no-overwrite-ignore", base])
            if (to.stash)
                await repo.command(to.path, ["stash", "apply", "--index", to.stash])
            if (to.branchRef)
                await repo.command(to.path, ["symbolic-ref", "HEAD", to.branchRef])
            for (let module of to.submodules) {
                let path = safePath(to.path, module.path)
                if (!await pathExists(join(path, ".git"))) {
                    await mkdir(path, { recursive: true })
                    await repo.command(path, ["init", "-q", `--object-format=${repo.descriptor.objectFormat}`])
                    let parent = to.submodules.filter(s => module.path.startsWith(s.path + sep)).sort((a, b) => b.path.length - a.path.length)[0]
                    let root = parent ? safePath(to.path, parent.path) : to.path
                    await repo.command(root, ["submodule", "absorbgitdirs", "--", relative(root, path)])
                }
                await copyObjects(repo, main, path, [module.head, ...(module.stash ? [module.stash] : [])])
                for (let [key, value] of module.remotes)
                    await repo.command(path, ["config", key, value])
                await repo.command(path, ["checkout", "--detach", "--force", "--no-overwrite-ignore", module.head])
                await repo.command(path, ["clean", "-fd"])
                if (module.stash)
                    await repo.command(path, ["stash", "apply", "--index", module.stash])
                if (module.branchRef) {
                    await repo.command(path, ["update-ref", module.branchRef, module.head])
                    await repo.command(path, ["symbolic-ref", "HEAD", module.branchRef])
                }
            }
        }
        if (to.locked && !source.worktrees.find(w => w.id == to.id)?.locked)
            await repo.command(main, ["worktree", "lock", "--reason", to.lockReason ?? "Laneway checkpoint", "--", to.path])
        else if (!to.locked && source.worktrees.find(w => w.id == to.id)?.locked)
            await repo.command(main, ["worktree", "unlock", "--", to.path])
        if (!to.present && !to.main) {
            let absolute = resolve(to.path)
            if (normalize(absolute) == normalize(main) || !absolute.includes(sep))
                throw new Error("Invalid missing-worktree path.")
            await rm(absolute, { recursive: true, force: true })
        }
    }

    if (JSON.stringify(source.stashes) != JSON.stringify(target.stashes)) {
        await repo.command(main, ["update-ref", "-d", "refs/stash"])
        for (let stash of [...target.stashes].reverse())
            await repo.command(main, ["stash", "store", "-m", stash.message, stash.object])
    }

    let configKeys = new Set([...source.branchConfig, ...target.branchConfig].map(([key]) => key))
    for (let key of configKeys) {
        let old = source.branchConfig.filter(([k]) => k == key), next = target.branchConfig.filter(([k]) => k == key)
        if (JSON.stringify(old) != JSON.stringify(next)) {
            await repo.run(main, ["config", "--unset-all", key])
            for (let [, value] of next)
                await repo.command(main, ["config", "--add", key, value])
        }
    }

    if (source.metadata != target.metadata) {
        let path = join(repo.descriptor.commonDirectory, "laneway-local.json")
        if (target.metadata == null)
            await rm(path, { force: true })
        else
            await writeFile(path, target.metadata)
    }
}

export async function checkpointMatches(repo: RepositoryGit, checkpoint: GitCheckpoint) {
    return checkpointIdentity(await captureGitCheckpoint(repo, checkpoint.worktrees.map(w => w.path), checkpoint, undefined, undefined, false))
        == checkpointIdentity(checkpoint)
}

export async function captureGitCheckpoint(
    repo: RepositoryGit,
    paths: string[],
    template?: GitCheckpoint,
    registered?: RegisteredWorktree[],
    scopes?: Map<string, string[]>,
    retain = true,
): Promise<GitCheckpoint> {
    let scoped = Boolean(scopes?.size || template?.worktrees.length && template.worktrees.every(w => w.scope))
    let [worktrees, refs, configuration, metadata, stashOutput] = await Promise.all([
        registered ?? readRegisteredWorktrees(repo),
        readCheckpointRefs(repo),
        scoped ? { stdout: Buffer.alloc(0) } : repo.run(repo.descriptor.mainWorktree, ["config", "--null", "--get-regexp", "^branch\\."]),
        scoped ? null : readFile(join(repo.descriptor.commonDirectory, "laneway-local.json"), "utf8").catch(error => {
            if (error.code != "ENOENT")
                throw error
            return null
        }),
        scoped ? Buffer.alloc(0) : repo.command(repo.descriptor.mainWorktree, ["stash", "list", "--format=%H%x00%gs"]),
    ])

    let selected = worktrees.filter(w => paths.some(path => normalize(path) == normalize(w.path)) || template?.worktrees.some(old => old.id == w.id))
    let captured = await Promise.all(selected.map(async w => {
        let scope = scopes?.get(normalize(w.path)) ?? template?.worktrees.find(old => old.id == w.id)?.scope
        let state: Worktree = {
            id: w.id,
            path: w.path,
            main: w.main,
            head: /^0+$/.test(w.head) ? "" : w.head,
            branchRef: w.branchRef,
            present: !w.missing,
            registered: true,
            locked: w.locked,
            lockReason: w.lockReason,
            scope,
            fingerprint: "",
            submodules: [],
        }
        if (state.present) {
            state.fingerprint = await workingFingerprint(repo, state)
            if (retain && !scope)
                state.stash = await saveWorkingChanges(repo, state)
            if (!scope) {
                for (let path of await populatedSubmodules(repo, w.path)) {
                    let head = (await repo.command(path, ["rev-parse", "HEAD"])).toString().trim()
                    let branchRef = (await repo.run(path, ["symbolic-ref", "-q", "HEAD"])).stdout.toString().trim() || undefined
                    let format = (await repo.command(path, ["rev-parse", "--show-object-format"])).toString().trim()
                    if (format != repo.descriptor.objectFormat)
                        throw new Error("Submodules with a different Git object format require manual recovery.")
                    let child = { ...state, path, head, scope: undefined }
                    let stash = retain ? await saveWorkingChanges(repo, child) : undefined
                    let remotes = (await repo.run(path, ["config", "--null", "--get-regexp", "^remote\\."])).stdout.toString()
                        .split("\0").filter(Boolean).map(record => {
                            let split = record.indexOf("\n")
                            return [record.slice(0, split), record.slice(split + 1)] as [string, string]
                        })
                    state.submodules.push({ path: relative(w.path, path), head, branchRef, stash, fingerprint: await workingFingerprint(repo, child), remotes })
                    if (retain)
                        await copyObjects(repo, path, repo.descriptor.mainWorktree, [head, ...(stash ? [stash] : [])])
                }
            }
        }
        return state
    }))

    for (let old of template?.worktrees ?? []) {
        if (!captured.some(w => w.id == old.id || normalize(w.path) == normalize(old.path)))
            captured.push({ ...old, present: false, registered: false, fingerprint: "", stash: undefined, submodules: [] })
    }

    for (let path of paths) {
        if (!captured.some(w => normalize(w.path) == normalize(path)) && !template?.worktrees.some(w => normalize(w.path) == normalize(path))) {
            captured.push({
                id: `absent:${normalize(path)}`,
                path,
                main: false,
                head: "",
                present: false,
                registered: false,
                locked: false,
                fingerprint: "",
                submodules: [],
            })
        }
    }

    return {
        version: 1,
        refs,
        worktrees: captured.sort((a, b) => a.id.localeCompare(b.id)),
        metadata,
        branchConfig: configuration.stdout.toString().split("\0").filter(Boolean).map(record => {
            let split = record.indexOf("\n")
            return [record.slice(0, split), record.slice(split + 1)]
        }),
        stashes: stashOutput.toString().trim().split("\n").filter(Boolean).map(record => {
            let split = record.indexOf("\0")
            return { object: record.slice(0, split), message: record.slice(split + 1) }
        }),
    }
}

export async function readCheckpointRefs(repo: RepositoryGit) {
    let output = await repo.command(repo.descriptor.mainWorktree, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/tags",
        "refs/stash",
        "refs/laneway/conflicts/current",
        "refs/laneway/conflict-candidates",
    ])
    return Object.fromEntries(output.toString().trim().split("\n").filter(Boolean).map(line => line.split(" ")))
}

export function checkpointIdentity(checkpoint: GitCheckpoint) {
    return JSON.stringify({
        ...checkpoint,
        refs: Object.entries(checkpoint.refs).sort(),
        branchConfig: checkpoint.branchConfig.toSorted(([a], [b]) => a.localeCompare(b)),
        worktrees: checkpoint.worktrees.map(w => ({ ...w, stash: undefined, submodules: w.submodules.map(s => ({ ...s, stash: undefined })) })),
    })
}

export async function workingFingerprint(repo: RepositoryGit, w: Pick<Worktree, "path" | "scope">) {
    let paths = w.scope ? ["--", ...w.scope] : []
    let [index, work, untracked] = await Promise.all([
        w.scope
            ? repo.command(w.path, ["--literal-pathspecs", "ls-files", "--stage", "-v", "-z", ...paths])
            : repo.command(w.path, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]),
        w.scope ? Buffer.alloc(0) : repo.command(w.path, ["diff", "--binary", "--no-ext-diff", "--no-textconv"]),
        w.scope ? Buffer.from(w.scope.join("\0")) : repo.command(w.path, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ])

    let hash = createHash("sha256").update(index).update("\0").update(work)
    for (let name of untracked.toString().split("\0").filter(Boolean)) {
        let path = safePath(w.path, name),
            stat = await lstat(path).catch(error => {
                if (error.code != "ENOENT")
                    throw error
                return undefined
            })
        hash.update("\0" + name + "\0")
        if (stat?.isSymbolicLink())
            hash.update(await readlink(path))
        else if (stat?.isFile())
            hash.update(await readFile(path))
    }

    return hash.digest("hex")
}

async function saveWorkingChanges(repo: RepositoryGit, w: Worktree) {
    let status = await repo.command(w.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    if (!status.length)
        return undefined

    // Git creates the tracked/index stash without clearing the user's working files.
    let head = w.head || await commit(repo, w.path, (await repo.command(w.path, ["mktree"], "")).toString().trim(), [])
    let tracked = w.head ? (await repo.command(w.path, ["stash", "create"], undefined, identity)).toString().trim() : ""
    let untracked = (await repo.command(w.path, ["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean)
    if (!untracked.length && tracked)
        return tracked
    if (!untracked.length && !tracked && w.head)
        return undefined

    let indexTree = tracked
        ? (await repo.command(w.path, ["rev-parse", `${tracked}^2^{tree}`])).toString().trim()
        : (await repo.command(w.path, ["write-tree"])).toString().trim()
    let indexCommit = tracked
        ? (await repo.command(w.path, ["rev-parse", `${tracked}^2`])).toString().trim()
        : await commit(repo, w.path, indexTree, [head])

    let index = join(repo.descriptor.commonDirectory, "laneway", `stash-index-${crypto.randomUUID()}`), env = { GIT_INDEX_FILE: index }
    await mkdir(dirname(index), { recursive: true })
    try {
        let working: string
        if (tracked)
            working = (await repo.command(w.path, ["rev-parse", `${tracked}^{tree}`])).toString().trim()
        else {
            await repo.command(w.path, ["read-tree", indexTree], undefined, env)
            await repo.command(w.path, ["add", "-u"], undefined, env)
            working = (await repo.command(w.path, ["write-tree"], undefined, env)).toString().trim()
        }
        if (!untracked.length)
            return commit(repo, w.path, working, [head, indexCommit])
        await repo.command(w.path, ["read-tree", "--empty"], undefined, env)
        await repo.command(w.path, ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], untracked.join("\0") + "\0", env)
        let tree = (await repo.command(w.path, ["write-tree"], undefined, env)).toString().trim()
        let extra = await commit(repo, w.path, tree, [])
        return commit(repo, w.path, working, [head, indexCommit, extra])
    } finally {
        await rm(index, { force: true })
    }
}

async function commit(repo: RepositoryGit, path: string, tree: string, parents: string[]) {
    return (await repo.command(path, ["commit-tree", tree, ...parents.flatMap(p => ["-p", p])], "Laneway checkpoint\n", identity)).toString().trim()
}

async function copyObjects(repo: RepositoryGit, from: string, to: string, roots: string[]) {
    let pack = await repo.command(from, ["pack-objects", "--stdout", "--revs"], roots.join("\n") + "\n")
    await repo.command(to, ["index-pack", "--stdin"], pack)
}

function safePath(root: string, name: string) {
    let path = resolve(root, name)
    if (!path.startsWith(resolve(root) + sep) || relative(root, path).startsWith(".."))
        throw new Error("Invalid checkpoint path.")
    return path
}
