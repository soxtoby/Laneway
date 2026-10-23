import type { RepositoryGit } from "@laneway/git"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Change, Registration } from "./operation-record"

export type Trees = { index: string; files: string }

/**
 * Collects what a mutation changes. Refs it reports here are informational; the operation runtime finds ref, HEAD,
 * registration, stash, configuration and metadata changes by comparing snapshots, and only content changes to a
 * worktree's index and files need reporting, as the trees they replaced and the trees they left.
 */
export class ChangeRecorder extends Map<string, string | null> {
    readonly trees: Extract<Change, { type: "tree" }>[] = []
    /** Registrations removed with their Working Changes retained, by worktree id. */
    readonly removing = new Map<string, Registration>()

    constructor(private readonly repo: RepositoryGit) {
        super()
    }

    /** Records a worktree's index and files moving between known trees; a change that leaves both as they were is dropped. */
    tree(path: string, before: Trees, after: Trees) {
        if (before.index == after.index && before.files == after.files)
            return
        let existing = this.trees.find(change => change.path == path)
        if (existing)
            existing.after = after
        else
            this.trees.push({ type: "tree", path, before, after })
    }

    /** Runs work that may change a worktree's index or files, recording the trees it found and left. */
    async worktree<T>(path: string, work: () => Promise<T>): Promise<T> {
        let before = await worktreeTrees(this.repo, path)
        let after: Trees | undefined
        try {
            return await work()
        } finally {
            // A failed mutation is rolled back from what it left, so its trees are read even then.
            after = await worktreeTrees(this.repo, path).catch(() => undefined)
            if (after)
                this.tree(path, before, after)
        }
    }
}

/** The worktree's index as a tree, and its files including non-ignored untracked ones as another. */
export async function worktreeTrees(repo: RepositoryGit, path: string): Promise<Trees> {
    let index = (await repo.command(path, ["write-tree"])).toString().trim()
    let scratch = join(repo.descriptor.commonDirectory, "laneway", `trees-index-${crypto.randomUUID()}`)
    let env = { GIT_INDEX_FILE: scratch }
    await mkdir(dirname(scratch), { recursive: true })
    try {
        await repo.command(path, ["read-tree", index], undefined, env)
        await repo.command(path, ["add", "-A"], undefined, env)
        let files = (await repo.command(path, ["write-tree"], undefined, env)).toString().trim()
        return { index, files }
    } finally {
        await rm(scratch, { force: true })
    }
}
