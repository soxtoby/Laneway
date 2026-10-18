import type { OpenRepository } from "@laneway/shared"

/** The name shown for a repository everywhere in Laneway: its label when set, otherwise its folder name. */
export function repositoryName(repository: OpenRepository) {
    return repository.label ?? repositoryFolderName(repository)
}

/** The folder name of a repository's Main Worktree, which labels it until the user chooses otherwise. */
export function repositoryFolderName(repository: OpenRepository) {
    if (repository.status != "available")
        return repository.name
    let path = repository.info.mainWorktree
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}
