import type { OpenRepository, RepositoryIcon } from "@laneway/shared"

/** The name shown for a repository everywhere in Laneway: its label when set, otherwise its folder name. */
export function repositoryName(repository: OpenRepository) {
    return repository.label ?? repositoryFolderName(repository)
}

/** The folder name of a repository's Main Worktree, which labels it until the user chooses otherwise. */
export function repositoryFolderName(repository: OpenRepository) {
    return repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name
}

/** What a repository shows without an override: the favicon found in it, or nothing for its initials. */
export function automaticIcon(repository: OpenRepository): Extract<RepositoryIcon, { kind: "image" }> | undefined {
    return repository.status == "available" && repository.favicon ? { kind: "image", path: repository.favicon } : undefined
}

export function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}
