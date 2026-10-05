import type { RegisteredWorktree, WorktreePreview, WorktreeRequest } from "@laneway/shared"
import { createHash } from "node:crypto"
import { lstat, readdir, readFile, readlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { readConflictState } from "./conflicts"
import { GitError, type RepositoryGit } from "./index"

export async function previewWorktree(repository: RepositoryGit, request: WorktreeRequest): Promise<WorktreePreview> {
    if ((request.action == "create" || request.action == "switch") && request.branch) {
        let ref = request.branch.startsWith("refs/heads/") ? request.branch : `refs/heads/${request.branch}`
        let state = await readConflictState(repository).catch(() => undefined)
        let stack = state?.stacks.find(s => s.branches.some(b => b.ref == ref))
        if (stack) {
            if (!await repository.resolveRef(stack.temporaryRef))
                throw new GitError("git.command-failed", "Restore the missing unresolved stack before checking it out.")
            request = { ...request, branch: stack.temporaryRef.slice(11) }
        }
    }

    let worktrees = await readRegisteredWorktrees(repository)
    let current = "path" in request ? worktrees.find(item => normalize(item.path) == normalize(request.path)) : undefined
    if ("path" in request && !current)
        throw new GitError("git.invalid-root", "The worktree is no longer registered. Refresh and try again.")
    if (current?.main && ["remove", "rename", "repair"].includes(request.action))
        throw new GitError("git.command-failed", "The Main Worktree cannot be renamed or removed. Locate a missing repository from the repository rail.")
    if (current?.locked && ["remove", "rename"].includes(request.action))
        throw new GitError("git.command-failed", `Unlock this worktree first.${current.lockReason ? ` ${current.lockReason}` : ""}`)
    if (current?.missing && !["remove", "repair", "unlock"].includes(request.action))
        throw new GitError("git.invalid-root", "Locate and repair this missing worktree first.")

    let destination: string | undefined
    let holder: RegisteredWorktree | undefined
    if (request.action == "create" || request.action == "switch") {
        if (request.action == "create" && Boolean(request.branch) == Boolean(request.commit))
            throw new GitError("git.command-failed", "Choose one local branch or one commit.")
        if (request.action == "create" && request.commit)
            await repository.command(repository.descriptor.mainWorktree, ["rev-parse", "--verify", `${request.commit}^{commit}`])

        if (request.branch) {
            if (request.branch.replace(/^refs\/heads\//, "").startsWith("-"))
                throw new GitError("git.command-failed", "Invalid local branch name.")
            let ref = request.branch.startsWith("refs/heads/") ? request.branch : `refs/heads/${request.branch}`
            await repository.command(repository.descriptor.mainWorktree, ["show-ref", "--verify", ref])
            if (current?.branchRef == ref)
                throw new GitError("git.command-failed", "This branch is already checked out in this worktree.")
            holder = worktrees.find(item => item.branchRef == ref && item.id != current?.id)
            if (holder?.missing)
                throw new GitError("git.invalid-root", "Locate or remove the missing worktree holding this branch first.")
        }

        if (request.action == "create") {
            let home = `${repository.descriptor.mainWorktree}.worktrees`
            let slug = branchSlug(request.branch ?? `detached-${request.commit!.slice(0, 8)}`)
            destination = join(home, slug)
            for (let suffix = 2; await pathExists(destination) || worktrees.some(item => normalize(item.path) == normalize(destination!)); suffix++)
                destination = join(home, `${slug}-${suffix}`)
        }
    } else if (request.action == "rename") {
        destination = join(dirname(current!.path), worktreeBasename(request.basename))
        if (normalize(destination) == normalize(current!.path) || await pathExists(destination))
            throw new GitError("git.destination-conflict", "That worktree path is already occupied.")
    } else if (request.action == "repair") {
        destination = resolve(request.destination)
        if (!current!.missing)
            throw new GitError("git.command-failed", "This worktree is available at its registered path.")
        let link = await readFile(join(destination, ".git"), "utf8")
        if (!link.startsWith("gitdir: ") || normalize(resolve(destination, link.slice(8).trim())) != normalize(current!.gitDirectory))
            throw new GitError("git.invalid-root", "The selected directory belongs to a different worktree.")
    }

    let affectedWorktrees = [current, holder].filter((item): item is RegisteredWorktree => Boolean(item))
    let affected = affectedWorktrees.map(item => item.path)
    if (destination)
        affected.push(destination)

    let dirty = false, uniqueCommits = false, hasSubmodules = false
    let ignored: string[] = []
    let hash = createHash("sha256").update(JSON.stringify({ request, worktrees, destination }))
    hash.update(
        await repository.command(repository.descriptor.mainWorktree, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
            "refs/tags",
            "refs/stash",
        ]),
    )

    for (let worktree of affectedWorktrees) {
        uniqueCommits ||= await hasUniqueCommits(repository, worktree)
        if (worktree.missing) {
            for (let file of ["HEAD", "index"]) {
                if (await pathExists(join(worktree.gitDirectory, file)))
                    hash.update(await readFile(join(worktree.gitDirectory, file)))
            }
        } else {
            let modules = await populatedSubmodules(repository, worktree.path)
            hasSubmodules ||= modules.length > 0
            for (let path of [worktree.path, ...modules]) {
                let state = await repository.readWorktreeState(path)
                dirty ||= state.status.length > 0
                hash.update(state.index).update(state.status).update(state.diff)
                hash.update(await repository.command(path, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]))

                for (let file of state.untracked) {
                    let target = resolve(path, file)
                    hash.update(file)
                    hash.update((await lstat(target)).isSymbolicLink() ? await readlink(target) : await readFile(target))
                }

                let ignoredFiles = (await repository.command(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0")
                    .filter(Boolean)
                ignored.push(...ignoredFiles.map(file => join(path, file)))
            }
        }
    }

    if (request.action == "rename" && hasSubmodules)
        throw new GitError("git.command-failed", "Rename is unavailable for worktrees containing populated submodules.")

    hash.update(JSON.stringify(ignored))
    return { request, worktrees, destination, affected, ignored, dirty, uniqueCommits, populatedSubmodules: hasSubmodules, token: hash.digest("hex") }
}

export async function readRegisteredWorktrees(repository: RepositoryGit): Promise<RegisteredWorktree[]> {
    let common = repository.descriptor.commonDirectory
    let adminPaths = new Map<string, string>()
    if (await pathExists(join(common, "worktrees"))) {
        for (let entry of await readdir(join(common, "worktrees"))) {
            let admin = join(common, "worktrees", entry)
            let link = await readFile(join(admin, "gitdir"), "utf8")
            adminPaths.set(normalize(dirname(resolve(admin, link.trim()))), admin)
        }
    }

    let output = await repository.command(repository.descriptor.mainWorktree, ["worktree", "list", "--porcelain", "-z"])
    return Promise.all(
        output.toString().split("\0\0").filter(Boolean).map(async (record, index) => {
            let values = new Map(
                record.split("\0").filter(Boolean).map(field => {
                    let space = field.indexOf(" ")
                    return space < 0 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)]
                }),
            )

            let path = resolve(values.get("worktree")!)
            let gitDirectory = index == 0 ? common : adminPaths.get(normalize(path))
            if (!gitDirectory)
                throw new GitError("git.command-failed", `Cannot identify the registration for ${path}.`)

            return {
                id: index == 0 ? "main" : basename(gitDirectory),
                path,
                name: basename(path),
                head: values.get("HEAD") ?? "",
                branchRef: values.get("branch") || undefined,
                main: index == 0,
                gitDirectory,
                missing: !await pathExists(path),
                locked: values.has("locked"),
                lockReason: values.get("locked") || undefined,
            }
        }),
    )
}

export function normalize(path: string) {
    let absolute = resolve(path)
    return process.platform == "win32" ? absolute.toLowerCase() : absolute
}

export function branchSlug(value: string) {
    let slug = value.replace(/^refs\/heads\//, "").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/[. ]+$/g, "") || "detached"
    try {
        return worktreeBasename(slug)
    } catch {
        return `worktree-${slug}`
    }
}

export function worktreeBasename(value: string) {
    if (
        value == "." || value == ".." || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)
        || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) || isAbsolute(value)
    ) {
        throw new GitError("git.destination-conflict", "Use a valid directory basename, without a parent path.")
    }
    return value
}

export async function populatedSubmodules(repository: RepositoryGit, path: string): Promise<string[]> {
    let entries = (await repository.command(path, ["ls-files", "--stage", "-z"])).toString().split("\0")
    let result: string[] = []

    for (let entry of entries.filter(entry => entry.startsWith("160000 "))) {
        let child = resolve(path, entry.slice(entry.indexOf("\t") + 1))
        if (await pathExists(join(child, ".git")))
            result.push(child, ...await populatedSubmodules(repository, child))
    }

    return result
}

export async function pathExists(path: string) {
    try {
        await lstat(path)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT")
            return false
        throw error
    }
}

export async function hasUniqueCommits(repository: RepositoryGit, worktree: RegisteredWorktree) {
    if (worktree.branchRef || /^0+$/.test(worktree.head))
        return false

    let output = await repository.command(repository.descriptor.mainWorktree, ["rev-list", "--max-count=1", worktree.head, "--not", "--branches", "--tags"])
    return output.length > 0
}
