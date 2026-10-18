/** Joins a repository-relative path onto a worktree root using the root's own separator. */
export function fullPath(root: string, path: string) {
    let separator = root.includes("\\") || /^[A-Za-z]:$/.test(root) ? "\\" : "/"
    let base = root.replace(/[\\/]+$/, "")
    return `${base}${separator}${path.replaceAll("/", separator)}`
}

export function fileName(path: string) {
    return path.slice(path.lastIndexOf("/") + 1)
}

export function copyText(text: string) {
    return navigator.clipboard.writeText(text).catch((error: unknown) => console.warn("Could not copy to the clipboard", error))
}
