import { gitText, type RepositoryGit } from "@laneway/git"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"

/** Repository facts every composed commit needs, read once per operation rather than once per commit. */
export interface CommitContext {
    repo: RepositoryGit
    signing: boolean
    cleanup: string
}

export async function prepareCommitContext(repo: RepositoryGit): Promise<CommitContext> {
    let cwd = repo.descriptor.mainWorktree
    let [signing, cleanup] = await Promise.all([
        repo.run(cwd, ["config", "--bool", "--get", "commit.gpgsign"]),
        repo.run(cwd, ["config", "--get", "commit.cleanup"]),
    ])

    return {
        repo,
        signing: signing.stdout.toString().trim() == "true",
        cleanup: cleanup.stdout.toString().trim(),
    }
}

// Commit objects are immutable, so one read per commit serves every author and message lookup in a process.
let rawCommits = new Map<string, Promise<string>>()

/** The raw commit object: headers, a blank line, then the message. */
export function rawCommit(repo: RepositoryGit, commit: string) {
    let key = `${repo.descriptor.commonDirectory}\0${commit}`
    let cached = rawCommits.get(key)
    if (!cached) {
        cached = repo.command(repo.descriptor.mainWorktree, ["cat-file", "commit", commit]).then(raw => raw.toString())
        rawCommits.set(key, cached)
        cached.catch(() => rawCommits.delete(key))
    }
    return cached
}

/** A source commit's author identity as commit environment, and its message. */
export async function commitAuthor(repo: RepositoryGit, source: string) {
    let raw = await rawCommit(repo, source)
    let split = raw.indexOf("\n\n")
    let author = /^author (.*) <([^>]*)> (.+)$/m.exec(raw.slice(0, split))!
    return {
        env: { GIT_AUTHOR_NAME: author[1], GIT_AUTHOR_EMAIL: author[2], GIT_AUTHOR_DATE: author[3] },
        message: raw.slice(split + 2),
    }
}

/** A commit to create. A source commit supplies the author and, unless a message is given, the message. */
export interface ComposedCommit {
    parent: string
    tree: string
    source?: string
    message?: string
}

// Composed commits run no commit hooks: running them would need a checkout of each commit, without the
// ignored files, such as installed tools, that hooks rely on. pre-commit checks the result afterwards instead.
export async function compositionCommit(context: CommitContext, commit: ComposedCommit, cancelled = () => false) {
    let { repo } = context
    let { parent, tree, source, message = "" } = commit
    let env: Record<string, string> = {}
    if (source) {
        let author = await commitAuthor(repo, source)
        env = author.env
        message ||= author.message
    } else if (context.cleanup != "verbatim") {
        message = (await repo.command(
            repo.descriptor.mainWorktree,
            ["stripspace", ...(context.cleanup == "strip" ? ["--strip-comments"] : [])],
            message + "\n",
        )).toString()
    } else {
        message += "\n"
    }

    if (!source && !message.trim())
        throw new Error("A commit message is required.")
    if (cancelled())
        throw new Error("Transfer cancelled while preparing commits.")

    return gitText(repo, ["commit-tree", tree, "-p", parent, ...(context.signing ? ["-S"] : [])], message, env)
}

/** Whether a worktree has a pre-commit hook, in its hooks directory or as `hook.*` configuration. */
export async function hasPreCommit(repo: RepositoryGit, path: string) {
    let configured = await repo.run(path, ["config", "--get-regexp", "^hook\\."])
    if (configured.stdout.length)
        return true
    let hooks = (await repo.command(path, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).toString().trim()
    try {
        await access(join(hooks, "pre-commit"), process.platform == "win32" ? constants.F_OK : constants.X_OK)
        return true
    } catch (error) {
        if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
            return false
        throw error
    }
}
