import type { DiffLine, FileDiffPage } from "@git-workbench/shared"
import { processFile } from "@pierre/diffs"

// Rebuild only the loaded patch, retaining Git's line numbers and hunk boundaries.
// In particular, a page may stop in the middle of a hunk.
export function pierrePatch(page: FileDiffPage) {
    const groups = new Map<number, DiffLine[]>()
    for (const line of page.lines) {
        const group = groups.get(line.hunk) ?? []
        group.push(line)
        groups.set(line.hunk, group)
    }
    let patch = "--- a/file\n+++ b/file\n"
    for (const lines of groups.values()) {
        const content = lines.filter(line => ["addition", "deletion", "context"].includes(line.kind))
        if (!content.length)
            continue
        const old = content.filter(line => line.kind != "addition")
        const next = content.filter(line => line.kind != "deletion")
        const header = lines.find(line => line.kind == "hunk")?.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
        patch += `@@ -${old[0]?.oldLine ?? header?.[1] ?? next[0]?.newLine ?? 0},${old.length} +${next[0]?.newLine ?? header?.[2] ?? 0},${next.length} @@${
            header?.[3] ?? ""
        }\n`
        for (const line of lines) {
            if (line.kind == "hunk")
                continue
            if (line.kind == "notice") {
                if (line.text.startsWith("\\ No newline"))
                    patch += `${line.text}\n`
            } else {
                patch += `${line.kind == "addition" ? "+" : line.kind == "deletion" ? "-" : " "}${line.text}\n`
            }
        }
    }
    const diff = processFile(patch, { throwOnError: true })
    if (diff) {
        diff.name = page.file.path
        diff.prevName = page.file.oldPath
    }
    return diff
}
