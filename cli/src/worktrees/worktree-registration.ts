import { normalize, pathExists, populatedSubmodules, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import type { RegisteredWorktree } from "@laneway/shared"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { Registration } from "../operations/operation-record"
import { recoveryBackupPath, removeLinkedWorktree } from "./worktree-directory"

export let retentionIdentity = {
    GIT_AUTHOR_NAME: "Laneway",
    GIT_AUTHOR_EMAIL: "checkpoint@laneway.invalid",
    GIT_COMMITTER_NAME: "Laneway",
    GIT_COMMITTER_EMAIL: "checkpoint@laneway.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
}

/** A worktree's registration as a record entry, retaining its Working Changes and submodule state when asked. */
export async function captureRegistration(repo: RepositoryGit, worktree: RegisteredWorktree, retain: boolean): Promise<Registration> {
    let registration: Registration = {
        id: worktree.id,
        path: worktree.path,
        head: /^0+$/.test(worktree.head) ? "" : worktree.head,
        branchRef: worktree.branchRef,
        locked: worktree.locked,
        lockReason: worktree.lockReason,
        submodules: [],
    }
    if (worktree.missing)
        return registration

    if (retain) {
        let unmerged = await repo.command(worktree.path, ["ls-files", "--unmerged", "-z"])
        if (unmerged.length) {
            // A stash cannot encode unmerged stages. Retain the index alongside the working snapshot.
            let indexPath = (await repo.command(worktree.path, ["rev-parse", "--git-path", "index"])).toString().trim()
            registration.index = (await repo.command(worktree.path, ["hash-object", "-w", "--stdin"], await readFile(resolve(worktree.path, indexPath))))
                .toString()
                .trim()
            registration.indexObjects = (await repo.command(worktree.path, ["ls-files", "--stage", "-z"])).toString().split("\0")
                .filter(entry => entry && !entry.startsWith("160000 "))
                .map(entry => entry.split(" ")[1]!)
        }
        registration.stash = await saveWorkingChanges(repo, worktree.path, registration.head, Boolean(unmerged.length))
    }
    for (let path of await populatedSubmodules(repo, worktree.path)) {
        let head = (await repo.command(path, ["rev-parse", "HEAD"])).toString().trim()
        let branchRef = (await repo.run(path, ["symbolic-ref", "-q", "HEAD"])).stdout.toString().trim() || undefined
        let format = (await repo.command(path, ["rev-parse", "--show-object-format"])).toString().trim()
        if (format != repo.descriptor.objectFormat)
            throw new Error("Submodules with a different Git object format require manual recovery.")
        let stash = retain ? await saveWorkingChanges(repo, path, head) : undefined
        let remotes = (await repo.run(path, ["config", "--null", "--get-regexp", "^remote\\."])).stdout.toString()
            .split("\0").filter(Boolean).map(record => {
                let split = record.indexOf("\n")
                return [record.slice(0, split), record.slice(split + 1)] as [string, string]
            })
        registration.submodules.push({ path: relative(worktree.path, path), head, branchRef, stash, remotes })
        if (retain)
            await copyObjects(repo, path, repo.descriptor.mainWorktree, [head, ...(stash ? [stash] : [])])
    }
    return registration
}

/** Objects a registration's recreation needs, which retention keeps reachable. */
export function registrationObjects(registration: Registration) {
    return [
        registration.head,
        registration.stash,
        registration.index,
        ...(registration.indexObjects ?? []),
        ...registration.submodules.flatMap(s => [s.head, s.stash]),
    ].filter((id): id is string => Boolean(id))
}

/**
 * Registers the worktree again at its recorded path with its retained Working Changes. The branch is checked out only
 * while it still points where the worktree left it and no other worktree holds it; otherwise the worktree is detached.
 */
export async function recreateRegistration(repo: RepositoryGit, registration: Registration) {
    let main = repo.descriptor.mainWorktree
    let current = await readRegisteredWorktrees(repo)
    let existing = current.find(w => w.id == registration.id)
    if (existing) {
        if (normalize(existing.path) != normalize(registration.path))
            await moveRegistration(repo, existing, registration.path)
        return
    }
    if (await pathExists(registration.path))
        throw new Error(`The worktree destination is occupied: ${registration.path}`)

    let base = registration.head || (registration.stash ? (await repo.command(main, ["rev-parse", `${registration.stash}^1`])).toString().trim() : "")
    if (!base)
        throw new Error("The removed worktree has no commit to recreate it from.")
    await mkdir(dirname(registration.path), { recursive: true })
    await repo.command(main, ["worktree", "add", "--detach", "--", registration.path, base])
    try {
        if (registration.stash)
            await repo.command(registration.path, ["stash", "apply", "--index", registration.stash])
        if (registration.index) {
            let indexPath = (await repo.command(registration.path, ["rev-parse", "--git-path", "index"])).toString().trim()
            await writeFile(resolve(registration.path, indexPath), await repo.command(registration.path, ["cat-file", "blob", registration.index]))
        }
        let branch = registration.branchRef
        if (branch && await repo.resolveRef(branch) == registration.head && !current.some(w => w.branchRef == branch))
            await repo.command(registration.path, ["symbolic-ref", "HEAD", branch])
        for (let module of registration.submodules) {
            let path = safePath(registration.path, module.path)
            if (!await pathExists(join(path, ".git"))) {
                await mkdir(path, { recursive: true })
                await repo.command(path, ["init", "-q", `--object-format=${repo.descriptor.objectFormat}`])
                let parent = registration.submodules.filter(s => module.path.startsWith(s.path + sep)).sort((a, b) => b.path.length - a.path.length)[0]
                let root = parent ? safePath(registration.path, parent.path) : registration.path
                await repo.command(root, ["submodule", "absorbgitdirs", "--", relative(root, path)])
            }
            await copyObjects(repo, main, path, [module.head, ...(module.stash ? [module.stash] : [])])
            for (let [key, value] of module.remotes)
                await repo.command(path, ["config", key, value])
            await repo.command(path, ["checkout", "--detach", "--force", module.head])
            await repo.command(path, ["clean", "-fd"])
            if (module.stash)
                await repo.command(path, ["stash", "apply", "--index", module.stash])
            if (module.branchRef) {
                await repo.command(path, ["update-ref", module.branchRef, module.head])
                await repo.command(path, ["symbolic-ref", "HEAD", module.branchRef])
            }
        }
        if (registration.locked)
            await repo.command(main, ["worktree", "lock", "--reason", registration.lockReason ?? "Laneway", "--", registration.path])
    } finally {
        // Index files are written directly, which no Git command reports.
        repo.forgetReads()
    }
}

/** Removes the worktree's registration and directory, returning the registration with its Working Changes retained. */
export async function removeRegistration(repo: RepositoryGit, registration: Registration, operationId: string) {
    let worktree = (await readRegisteredWorktrees(repo)).find(w => w.id == registration.id)
    if (!worktree)
        return undefined
    if (worktree.main)
        throw new Error("The Main Worktree cannot be removed.")
    if (worktree.locked)
        throw new Error(`Unlock ${worktree.path} before removing it.`)
    let retained = await captureRegistration(repo, worktree, true)
    try {
        await removeLinkedWorktree(worktree, recoveryBackupPath(worktree.path, operationId))
    } finally {
        repo.forgetReads()
    }
    return retained
}

/** Moves a registration to another path: the directory when it is there, otherwise the registration's pointer alone. */
export async function moveRegistration(repo: RepositoryGit, worktree: RegisteredWorktree, destination: string) {
    let main = repo.descriptor.mainWorktree
    if (!worktree.missing && await pathExists(worktree.path)) {
        if (await pathExists(destination))
            throw new Error(`The worktree destination is occupied: ${destination}`)
        await repo.command(main, ["worktree", "move", "--", worktree.path, destination])
    } else if (await pathExists(join(destination, ".git")))
        await repo.command(main, ["worktree", "repair", "--", destination])
    else
        await writeFile(join(worktree.gitDirectory, "gitdir"), `${join(destination, ".git").replaceAll("\\", "/")}\n`)
    repo.forgetReads()
}

export async function setRegistrationLock(repo: RepositoryGit, worktree: RegisteredWorktree, locked: boolean, reason?: string) {
    let main = repo.descriptor.mainWorktree
    if (locked)
        await repo.command(main, ["worktree", "lock", "--reason", reason ?? "Laneway", "--", worktree.path])
    else
        await repo.command(main, ["worktree", "unlock", "--", worktree.path])
}

/** Retains staged, unstaged, and non-ignored untracked content as a private stash commit without clearing the worktree. */
export async function saveWorkingChanges(repo: RepositoryGit, path: string, head: string, unmerged = false) {
    let status = await repo.command(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    if (!status.length)
        return undefined

    // Git creates the tracked/index stash without clearing the user's working files.
    let base = head || await commit(repo, path, (await repo.command(path, ["mktree"], "")).toString().trim(), [])
    let tracked = head && !unmerged ? (await repo.command(path, ["stash", "create"], undefined, retentionIdentity)).toString().trim() : ""
    let untracked = (await repo.command(path, ["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean)
    if (!untracked.length && tracked)
        return tracked
    if (!untracked.length && !tracked && head && !unmerged)
        return undefined

    let indexTree = tracked
        ? (await repo.command(path, ["rev-parse", `${tracked}^2^{tree}`])).toString().trim()
        : unmerged
        ? (await repo.command(path, ["rev-parse", `${base}^{tree}`])).toString().trim()
        : (await repo.command(path, ["write-tree"])).toString().trim()
    let indexCommit = tracked
        ? (await repo.command(path, ["rev-parse", `${tracked}^2`])).toString().trim()
        : await commit(repo, path, indexTree, [base])

    let index = join(repo.descriptor.commonDirectory, "laneway", `stash-index-${crypto.randomUUID()}`), env = { GIT_INDEX_FILE: index }
    await mkdir(dirname(index), { recursive: true })
    try {
        let working: string
        if (tracked)
            working = (await repo.command(path, ["rev-parse", `${tracked}^{tree}`])).toString().trim()
        else {
            await repo.command(path, ["read-tree", indexTree], undefined, env)
            await repo.command(path, ["add", unmerged ? "-A" : "-u"], undefined, env)
            working = (await repo.command(path, ["write-tree"], undefined, env)).toString().trim()
        }
        if (!untracked.length || unmerged)
            return commit(repo, path, working, [base, indexCommit])
        await repo.command(path, ["read-tree", "--empty"], undefined, env)
        await repo.command(path, ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], untracked.join("\0") + "\0", env)
        let tree = (await repo.command(path, ["write-tree"], undefined, env)).toString().trim()
        let extra = await commit(repo, path, tree, [])
        return commit(repo, path, working, [base, indexCommit, extra])
    } finally {
        await rm(index, { force: true })
    }
}

async function commit(repo: RepositoryGit, path: string, tree: string, parents: string[]) {
    return (await repo.command(path, ["commit-tree", tree, ...parents.flatMap(p => ["-p", p])], "Laneway checkpoint\n", retentionIdentity)).toString().trim()
}

export async function copyObjects(repo: RepositoryGit, from: string, to: string, roots: string[]) {
    let pack = await repo.command(from, ["pack-objects", "--stdout", "--revs"], roots.join("\n") + "\n")
    await repo.command(to, ["index-pack", "--stdin"], pack)
}

export function safePath(root: string, name: string) {
    let path = resolve(root, name)
    if (!path.startsWith(resolve(root) + sep) || relative(root, path).startsWith(".."))
        throw new Error("Invalid worktree path.")
    return path
}
