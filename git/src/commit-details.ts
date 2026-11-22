import type { BranchHistoryCommit, CommitDetails } from "@laneway/shared"

type ReadGit = (args: string[], input: string) => Promise<string | Buffer>

/** Read immutable commit labels together. A saved comparison or a shallow parent can outlive the object. */
export async function readCommitDetails(objectIds: string[], run: ReadGit): Promise<Record<string, CommitDetails>> {
    let ids = [...new Set(objectIds)].filter(id => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id) && !/^0+$/.test(id))
    if (!ids.length)
        return {}
    let output = await run(["log", "--no-walk", "--ignore-missing", "--stdin", "-z", "--format=%H%x00%s%x00%aN%x00%at"], ids.join("\n") + "\n")
    let fields = output.toString().split("\0")
    let details: Record<string, CommitDetails> = {}
    for (let i = 0; i + 3 < fields.length; i += 4)
        details[fields[i]!] = { subject: fields[i + 1] || "Untitled commit", authorName: fields[i + 2]!, authoredAt: Number(fields[i + 3]) }
    return details
}

export async function labelMergeParents(commits: BranchHistoryCommit[], run: ReadGit) {
    let merges = commits.filter(commit => commit.parentIds.length > 1)
    let details = await readCommitDetails(merges.flatMap(commit => commit.parentIds), run)
    for (let merge of merges)
        merge.parentSubjects = Object.fromEntries(merge.parentIds.filter(id => details[id]).map(id => [id, details[id]!.subject]))
}
