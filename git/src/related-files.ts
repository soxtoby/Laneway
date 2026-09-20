import type { RelatedFile } from "@laneway/shared"

export interface FileChange {
    status: string
    path: string
    previousPath?: string
}
export function parseFileChanges(raw: string): FileChange[] {
    const fields = raw.split("\0")
    const changes: FileChange[] = []
    for (let index = 0; index < fields.length - 1;) {
        const status = fields[index++]
        const before = fields[index++]
        changes.push(/^[RC]/.test(status) ? { status, path: fields[index++], previousPath: before } : { status, path: before })
    }
    return changes
}
/** Evidence only: shared text and co-change never assert a unique origin. */
export function rankRelatedFiles(
    anchor: string,
    objectId: string,
    parentId: string | undefined,
    changes: FileChange[],
    contents: Map<string, string>,
): RelatedFile[] {
    const anchorLines = new Set((contents.get(anchor) ?? "").split("\n").map(line => line.trim()).filter(line => line.length >= 12))
    const previousPath = changes.find(change => change.path == anchor)?.previousPath
    const predecessor: RelatedFile[] = previousPath && parentId ? [{ path: previousPath, objectId: parentId, evidence: "rename/copy", score: 100 }] : []
    return [
        ...predecessor,
        ...changes.filter(change => change.path != anchor && change.path != previousPath).map(change => {
            const origin = change.status == "D" && parentId ? parentId : objectId
            if (change.previousPath == anchor || changes.some(other => other.path == anchor && other.previousPath == change.path))
                return { path: change.path, objectId: origin, evidence: "rename/copy" as const, score: 100 }
            const text = contents.get(change.path) ?? ""
            const shared = new Set(text.split("\n").map(line => line.trim()).filter(line => anchorLines.has(line))).size
            return {
                path: change.path,
                objectId: origin,
                evidence: shared ? "shared lines" as const : "changed together" as const,
                score: shared ? Math.min(99, shared) : 0,
            }
        }),
    ].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
}
