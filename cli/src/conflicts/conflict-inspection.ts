import { blob, candidateReady, conflictHunks, gitText, hasConflictMarkers, isText, readConflictState, replaceTreeFiles, type RepositoryGit, temporaryBranchPrefix, treeEntries } from "@laneway/git"
import { type ConflictFile, type ConflictResult, type ConflictState } from "@laneway/shared"
import { readCandidate } from "./conflict-candidates"

export async function conflictResult(repo: RepositoryGit, subjectId?: string, requestedFiles?: string[]): Promise<ConflictResult> {
    let result: ConflictResult = { type: "result", command: "conflict", conflicts: [], recovery: [] }
    let state = await readConflictState(repo).catch(() => undefined)
    if (!state) {
        result.recovery.push({
            stack: "untracked",
            branch: "",
            message: "Conflict metadata is damaged. Use Operation History to restore the last recorded state. Existing branches remain available to Git.",
            candidates: [],
        })
        result.publishable = false
        return result
    }

    let inspectedCandidate = subjectId && requestedFiles ? readCandidate(repo, findSubject(state, subjectId).subject) : undefined
    for (let stack of state.stacks) {
        if (subjectId && requestedFiles && !stack.steps.some(step => step.conflict?.id == subjectId))
            continue
        let tip = subjectId && requestedFiles ? stack.temporaryRef : await repo.resolveRef(stack.temporaryRef)
        let branch = stack.branches.at(-1)!.ref.slice(11)
        if (!tip) {
            let refs = await repo.listRefs("refs/heads/")
            let candidates: string[] = []
            for (let ref of refs) {
                if (await repo.resolveRef(ref) == (stack.steps.at(-1)?.current ?? stack.base))
                    candidates.push(ref.slice(11))
            }
            result.recovery.push({ stack: stack.id, branch, message: "The unresolved branch is missing.", candidates })
        }
        for (let step of stack.steps) {
            if (step.conflict && (!subjectId || !requestedFiles || step.conflict.id == subjectId)) {
                result.conflicts.push({
                    id: step.conflict.id,
                    stackId: stack.id,
                    kind: "commit",
                    branch,
                    commit: step.current,
                    title: await gitText(repo, ["log", "-1", "--format=%s", step.source]),
                    files: step.conflict.files.length,
                })
            }
        }
    }

    for (let working of state.working) {
        result.conflicts.push({
            id: working.conflict.id,
            kind: "working",
            branch: working.branch?.slice(11) ?? "Detached worktree",
            title: "Working Changes Conflict",
            files: working.conflict.files.length,
            suspended: Boolean(working.suspended),
        })
    }

    for (let ref of requestedFiles ? [] : await repo.listRefs(temporaryBranchPrefix)) {
        if (!state.stacks.some(stack => stack.temporaryRef == ref)) {
            result.recovery.push({
                stack: "untracked",
                branch: ref.slice(11),
                message: "Conflict metadata is unavailable. Keep this branch until recovery is restored.",
                candidates: [],
            })
        }
    }

    if (subjectId) {
        let { subject, step, working } = findSubject(state, subjectId)
        let candidate = await (inspectedCandidate ?? readCandidate(repo, subject))
        let suggestion = subject.suggestion && requestedFiles?.length != 0 ? await treeEntries(repo, subject.suggestion) : undefined
        let needsReview = requestedFiles == undefined || requestedFiles.some(path => path in candidate.files)
        let [candidateTree, reviewTree] = needsReview
            ? await Promise.all([
                replaceTreeFiles(repo, subject.tree, candidate.files),
                replaceTreeFiles(repo, subject.tree, Object.fromEntries(subject.files.map(file => [file.path, file.left]))),
            ])
            : [subject.tree, subject.tree]

        let blobs = new Map<string, Promise<Buffer | null>>()
        let readBlob = (entry: ConflictFile["base"]) => {
            if (!entry || entry.mode == "160000")
                return Promise.resolve(null)
            let pending = blobs.get(entry.object)
            if (!pending) {
                pending = blob(repo, entry)
                blobs.set(entry.object, pending)
            }
            return pending
        }

        let files: NonNullable<ConflictResult["view"]>["files"] = []
        for (let file of subject.files) {
            if (requestedFiles && !requestedFiles.includes(file.path)) {
                let bytes = file.path in candidate.files ? await readBlob(candidate.files[file.path]) : null
                files.push({
                    ...file,
                    loaded: false,
                    baseText: null,
                    leftText: null,
                    rightText: null,
                    resultText: null,
                    suggestionText: null,
                    diff: "",
                    hunks: [],
                    resolved: file.path in candidate.files && !hasConflictMarkers(bytes?.toString() ?? "", subject),
                })
                continue
            }
            let entries = [
                file.base,
                file.left,
                file.right,
                file.path in candidate.files ? candidate.files[file.path] : file.provisional,
                suggestion?.get(file.path) ?? null,
            ]
            let texts = await Promise.all(entries.map(async entry => {
                let bytes = await readBlob(entry)
                return isText(bytes) && bytes!.length <= 2_000_000 ? bytes!.toString() : null
            }))
            let diff = !needsReview
                ? ""
                : (await repo.command(repo.descriptor.mainWorktree, ["diff", "--no-ext-diff", "--no-textconv", reviewTree, candidateTree, "--", file.path]))
                    .toString()
            files.push({
                ...file,
                baseText: texts[0],
                leftText: texts[1],
                rightText: texts[2],
                resultText: texts[3],
                suggestionText: texts[4],
                diff: diff.slice(0, 2_000_000),
                resolved: file.path in candidate.files && !hasConflictMarkers(texts[3] ?? "", subject),
                hunks: conflictHunks(texts[3] ?? "", subject),
            })
        }

        result.view = {
            subject,
            sourceCommit: step?.source ?? working!.stash,
            candidate,
            files,
            reviewTree,
            resultTree: candidateTree,
            ready: await candidateReady(repo, subject, candidate),
        }
    }

    return result
}

export function findSubject(state: ConflictState, id: string) {
    let found = state.stacks.map(stack => ({ stack, step: stack.steps.find(step => step.conflict?.id == id) })).find(item => item.step?.conflict)
    let working = state.working.find(w => w.conflict.id == id)

    if (found?.step?.conflict)
        return { subject: found.step.conflict, stack: found.stack, step: found.step }
    else if (working)
        return { subject: working.conflict, working }
    else
        throw new Error("This conflict no longer exists. Refresh the branch.")
}
