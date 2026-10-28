import { blob, gitText, isText, replaceTreeFiles, type RepositoryGit, treeEntries, workingFilesTree } from "@laneway/git"
import type { CompositionRequest, DiffLine } from "@laneway/shared"

export async function selectionTrees(repo: RepositoryGit, request: CompositionRequest) {
    let source = request.source
    if (source.kind == "branch")
        throw new Error("A branch rebase has no file selection.")

    let inventory = await repo.startReadChanges({ source }).result
    if (request.inventoryVersion && inventory.version != request.inventoryVersion)
        throw new Error("Source files changed. Select the changes again.")

    let base: string, after: string
    if (source.kind == "working") {
        let head = await repo.run(source.worktreePath, ["rev-parse", "HEAD^{tree}"])
        let index = (await repo.command(source.worktreePath, ["write-tree"])).toString().trim()
        base = request.view == "unstaged" ? index : head.exitCode ? await gitText(repo, ["mktree"], "") : head.stdout.toString().trim()
        after = request.view == "staged" ? index : await workingTree(repo, source.worktreePath)
    } else {
        if (inventory.parents.length > 1 && !source.parentId)
            throw new Error("Choose an explicit parent before copying changes from a merge commit.")
        base = source.parentId ?? inventory.parents[0] ?? await gitText(repo, ["mktree"], "")
        after = source.objectId
    }

    let [beforeFiles, afterFiles] = await Promise.all([treeEntries(repo, base), treeEntries(repo, after)])
    let chosen: NonNullable<CompositionRequest["files"]> = request.files ?? inventory.files.filter(f => !f.ignored).map(f => ({ path: f.path }))
    if (!chosen.length || new Set(chosen.map(f => f.path)).size != chosen.length)
        throw new Error("Choose one or more distinct changed files.")
    if (chosen.some(f => "lineIds" in f && f.lineIds) && chosen.length != 1)
        throw new Error("Line selection belongs to one file.")

    let entries: Parameters<typeof replaceTreeFiles>[2] = {}
    for (let selected of chosen) {
        let file = inventory.files.find(f => f.path == selected.path && !f.ignored)
        if (!file)
            throw new Error("A selected file is no longer in the source diff.")

        if ("lineIds" in selected && selected.lineIds) {
            if (file.oldPath)
                throw new Error("Transfer renamed files as a complete change.")
            if (!selected.version)
                throw new Error("Line transfers require the displayed diff version.")

            let lines = await readSelectedLines(repo, {
                source,
                path: selected.path,
                view: request.view,
                entireFile: selected.entireFile,
                expectedVersion: selected.version,
            })

            let original = beforeFiles.get(file.path) ?? null, next = afterFiles.get(file.path) ?? null
            if ([original?.mode, next?.mode].some(mode => mode == "120000" || mode == "160000"))
                throw new Error("Transfer symlinks and submodules as whole-file changes.")
            let bytes = await blob(repo, original)
            if (bytes && !isText(bytes))
                throw new Error("Select the entire binary file.")

            let text = selectedText(bytes?.toString() ?? "", lines, selected.lineIds)
            entries[file.path] = !next && text == "" ? null : {
                mode: original?.mode ?? next?.mode ?? "100644",
                object: await gitText(repo, ["hash-object", "-w", "--stdin"], text),
            }
        } else {
            entries[file.path] = afterFiles.get(file.path) ?? null
            if (file.oldPath)
                entries[file.oldPath] = null
        }
    }

    return { base, after, selected: await replaceTreeFiles(repo, base, entries), paths: Object.keys(entries) }
}

export async function workingTree(repo: RepositoryGit, path: string) {
    let [index, status] = await Promise.all([
        repo.command(path, ["write-tree"]),
        repo.command(path, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ])

    let records = status.toString().split("\0").filter(Boolean)
    let dirty = false
    for (let i = 0; i < records.length; i++) {
        let code = records[i].slice(0, 2)
        dirty ||= code[1] != " "
        if (code.includes("R") || code.includes("C"))
            i++
    }
    if (!dirty)
        return index.toString().trim()

    return workingFilesTree(repo, path, index.toString().trim())
}

// Apply only the explicitly selected +/- records; never infer their paired line.
export function selectedText(before: string, lines: DiffLine[], ids: number[]) {
    let selected = new Set(ids)
    if (selected.size != ids.length || ids.some(id => !lines.some(l => l.id == id && (l.kind == "addition" || l.kind == "deletion"))))
        throw new Error("The selected diff lines changed.")

    let original = before.match(/[^\n]*\n|[^\n]+$/g) ?? []
    let deleted = new Set<number>(), additions = new Map<number, string[]>()
    let cursor = 0

    for (let [index, line] of lines.entries()) {
        if (line.kind == "hunk") {
            let match = /^@@ -(\d+)(?:,(\d+))?/.exec(line.text)
            if (!match)
                throw new Error("Invalid diff hunk.")
            cursor = Number(match[1]) - (match[2] == "0" ? 0 : 1)
        } else if (line.kind == "deletion") {
            if (selected.has(line.id))
                deleted.add(cursor)
            cursor++
        } else if (line.kind == "context")
            cursor++
        else if (line.kind == "addition" && selected.has(line.id)) {
            let values = additions.get(cursor) ?? []
            values.push(line.text + (lines[index + 1]?.kind == "notice" ? "" : "\n"))
            additions.set(cursor, values)
        }
    }

    let result = ""
    for (let i = 0; i <= original.length; i++) {
        result += (additions.get(i) ?? []).join("")
        if (i < original.length && !deleted.has(i))
            result += original[i]
    }

    return result
}

async function readSelectedLines(repo: RepositoryGit, request: Parameters<RepositoryGit["startReadFileDiff"]>[0]) {
    let page = await repo.startReadFileDiff(request).result
    let lines = [...page.lines]
    while (page.nextOffset !== undefined) {
        page = await repo.startReadFileDiff({ ...request, offset: page.nextOffset }).result
        lines.push(...page.lines)
    }

    if (!page.selectable)
        throw new Error("This file supports whole-file transfers only.")

    return lines
}
