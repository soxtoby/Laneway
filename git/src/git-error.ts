export type GitErrorCode =
    | "git.unavailable"
    | "git.too-old"
    | "git.invalid-root"
    | "git.bare-repository"
    | "git.missing-main-worktree"
    | "git.unsupported-format"
    | "git.authentication-required"
    | "git.destination-conflict"
    | "git.cancelled"
    | "git.command-failed"

export class GitError extends Error {
    constructor(
        readonly code: GitErrorCode,
        message: string,
        readonly details?: Record<string, unknown>,
    ) {
        super(message)
    }
}
