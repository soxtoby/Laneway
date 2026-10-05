import { type RepositoryGit, retainedDocument } from "@laneway/git"
import { type ConflictSubject, type ResolutionCandidate, ResolutionCandidateSchema } from "@laneway/shared"

export async function saveCandidate(repo: RepositoryGit, subject: ConflictSubject, candidate: ResolutionCandidate) {
    let objects = new Map<string, string>()
    for (let entry of Object.values(candidate.files)) {
        if (entry && entry.mode != "160000")
            objects.set(entry.object, "blob")
    }

    let after = await retainedDocument(repo, candidate, objects)
    await repo.updateRefs([{ ref: candidateRef(subject), before: candidate.revision || null, after }])
}

export async function checkedCandidate(repo: RepositoryGit, subject: ConflictSubject, request: { input: string; revision: string }) {
    if (subject.input != request.input)
        throw new Error("Conflict inputs changed. The previous result remains a suggestion; refresh before accepting.")
    let candidate = await readCandidate(repo, subject)
    if (candidate.revision != request.revision)
        throw new Error("Resolution progress changed. Reload the candidate before continuing.")
    return candidate
}

export async function readCandidate(repo: RepositoryGit, subject: ConflictSubject): Promise<ResolutionCandidate> {
    let ref = await repo.resolveRef(candidateRef(subject))
    if (!ref)
        return { subject: subject.id, input: subject.input, revision: "", files: {} }
    let candidate = ResolutionCandidateSchema.parse(JSON.parse((await repo.command(repo.descriptor.mainWorktree, ["show", `${ref}:state.json`])).toString()))
    return { ...candidate, revision: ref }
}

export function candidateRef(subject: ConflictSubject) {
    return `refs/laneway/conflict-candidates/${subject.id}/${subject.input}`
}
