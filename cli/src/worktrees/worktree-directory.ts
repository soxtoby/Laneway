import { pathExists } from "@laneway/git"
import type { RegisteredWorktree } from "@laneway/shared"
import { lstat, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"

export function recoveryBackupPath(path: string, operationId: string) {
    return `${path}.laneway-recovery-${operationId}`
}

// Git's own `worktree remove` drops the registration even when deleting the directory fails, which
// strands every file and leaves nothing for Laneway to show. Moving the directory aside is refused
// while any program holds a file open or runs inside it, so the move is probed before any Git state
// changes and a busy worktree stays registered and intact. Preservation then runs in place, because
// submodules locate their working directories relative to the registration. Only once the real
// move succeeds does the registration go, then the moved files.
export async function removeLinkedWorktree(worktree: RegisteredWorktree, staging: string, preserve?: () => Promise<void>) {
    if (worktree.main)
        throw new Error("The Main Worktree cannot be removed.")

    if (!worktree.missing) {
        await moveAside(worktree.path, staging)
        await rename(staging, worktree.path)
    }
    await preserve?.()
    if (!worktree.missing)
        await moveAside(worktree.path, staging)
    // Delete exactly this registration, never prune other worktrees.
    await rm(worktree.gitDirectory, { recursive: true, force: true })
    if (!worktree.missing)
        await deleteTree(staging)
}

// Dependency trees delete about twice as fast when their packages go in parallel. Only real
// directories two levels deep are split out; links and junctions are deleted as entries.
async function deleteTree(root: string) {
    let subtrees: string[] = []
    async function collect(path: string, depth: number) {
        let children = depth < 2 ? await directoriesWithin(path) : []
        if (!children.length) {
            subtrees.push(path)
            return
        }
        for (let child of children)
            await collect(child, depth + 1)
    }
    await collect(root, 0)

    let next = 0
    await Promise.all(Array.from({ length: Math.min(16, subtrees.length) }, async () => {
        while (next < subtrees.length)
            await remove(subtrees[next++]!)
    }))
    await remove(root)
}

async function directoriesWithin(path: string) {
    let directories: string[] = []
    for (let name of await readdir(path).catch(() => [] as string[])) {
        let child = join(path, name)
        if ((await lstat(child).catch(() => undefined))?.isDirectory())
            directories.push(child)
    }
    return directories
}

function remove(path: string) {
    return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function moveAside(path: string, staging: string) {
    if (await pathExists(staging))
        throw new Error(`A leftover directory occupies ${staging}. Move it aside and try again.`)

    for (let attempt = 1;; attempt++) {
        try {
            await rename(path, staging)
            return
        } catch (error) {
            // Windows refuses while another process has a file open or its working directory inside.
            // Short-lived status reads clear within a few retries; editors and terminals do not.
            if (!["EACCES", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
                throw error
            if (attempt == 8)
                throw new Error(`Another program is using files in ${path}. Close editors, terminals, and build tools in this worktree, then try again.`)
            await new Promise(resolve => setTimeout(resolve, 200))
        }
    }
}
