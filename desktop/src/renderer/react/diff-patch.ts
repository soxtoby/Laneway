import type { DiffLine, FileDiffPage } from "@laneway/shared"
import { processFile } from "@pierre/diffs"

// Rebuild only the loaded patch, retaining Git's line numbers and hunk boundaries.
// In particular, a page may stop in the middle of a hunk.
export function pierrePatch(page: FileDiffPage) {
    let groups = new Map<number, DiffLine[]>()
    for (let line of page.lines) {
        let group = groups.get(line.hunk) ?? []
        group.push(line)
        groups.set(line.hunk, group)
    }

    let patch = "--- a/file\n+++ b/file\n"
    for (let lines of groups.values())
        patch += hunkPatch(lines)

    let diff = processFile(patch, { throwOnError: true })
    if (diff) {
        diff.name = page.file.path
        diff.prevName = page.file.oldPath
    }

    return diff
}

function hunkPatch(lines: DiffLine[]) {
    let content = lines.filter(line => ["addition", "deletion", "context"].includes(line.kind))
    if (!content.length)
        return ""

    let old = content.filter(line => line.kind != "addition")
    let next = content.filter(line => line.kind != "deletion")
    let header = lines.find(line => line.kind == "hunk")?.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
    let patch = `@@ -${old[0]?.oldLine ?? header?.[1] ?? next[0]?.newLine ?? 0},${old.length} +${next[0]?.newLine ?? header?.[2] ?? 0},${next.length} @@${
        header?.[3] ?? ""
    }\n`

    patch += lines.filter(line => line.kind != "hunk").map(line =>
        line.kind == "notice"
            ? line.text.startsWith("\\ No newline") ? `${line.text}\n` : ""
            : `${line.kind == "addition" ? "+" : line.kind == "deletion" ? "-" : " "}${line.text}\n`
    ).join("")

    return patch
}
