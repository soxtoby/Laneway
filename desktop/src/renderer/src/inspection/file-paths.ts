import type { FileAction } from "./file-menu"

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

/** Context menu entries copying a file's location; the full path needs the worktree `root` it lives in. */
export function copyPathActions(path: string, root?: string): FileAction[] {
    let actions: FileAction[] = []
    if (root)
        actions.push({ label: "Copy full path", run: () => void copyText(fullPath(root, path)) })
    actions.push(
        { label: "Copy relative path", run: () => void copyText(path) },
        { label: "Copy file name", run: () => void copyText(fileName(path)) },
    )
    actions[0].separator = true
    return actions
}
