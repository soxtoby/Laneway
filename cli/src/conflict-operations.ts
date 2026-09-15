import { blob, candidateReady, conflictHunks, conflictStateRef, gitText, isText, normalize, readConflictState, readRegisteredWorktrees, replaceTreeFiles, replayTree, type RepositoryGit, retainedDocument, rewriteCommit, storeConflictState, temporaryBranchPrefix, treeEntries, withConflictScratch } from "@git-workbench/git"
import { type ConflictFile, type ConflictRequest, type ConflictResult, type ConflictState, type ConflictSubject, type ResolutionCandidate, ResolutionCandidateSchema, type UnresolvedStack } from "@git-workbench/shared"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

type Changes = Map<string, string | null>
export const conflictMutation = (request: ConflictRequest) =>
    ["rewrite", "accept", "keep-stashed", "restore", "discard", "resume-working"].includes(request.action)
const candidateRef = (subject: ConflictSubject) => `refs/workbench/conflict-candidates/${subject.id}/${subject.input}`
const commitParent = (repo: RepositoryGit, commit: string) => gitText(repo, ["rev-parse", `${commit}^`])
const branchRef = (name: string) => name.startsWith("refs/heads/") ? name : `refs/heads/${name}`

export async function conflictPaths(repo: RepositoryGit) {
    return (await readRegisteredWorktrees(repo)).filter(w => !w.missing).map(w => w.path)
}
async function requireWorktree(repo: RepositoryGit, path: string, clean = false) {
    const worktree = (await readRegisteredWorktrees(repo)).find(w => normalize(w.path) == normalize(path) && !w.missing)
    if (!worktree)
        throw new Error("Choose a registered, available worktree.")
    if (clean && (await repo.command(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length)
        throw new Error("Commit or stash Working Changes before replacing this worktree's tree.")
    return worktree
}
function findSubject(state: ConflictState, id: string) {
    for (const stack of state.stacks) {
        const step = stack.steps.find(step => step.conflict?.id == id)
        if (step?.conflict)
            return { subject: step.conflict, stack, step }
    }
    const working = state.working.find(w => w.conflict.id == id)
    if (working)
        return { subject: working.conflict, working }
    throw new Error("This conflict no longer exists. Refresh the branch.")
}
async function readCandidate(repo: RepositoryGit, subject: ConflictSubject): Promise<ResolutionCandidate> {
    const ref = await repo.resolveRef(candidateRef(subject))
    if (!ref)
        return { subject: subject.id, input: subject.input, revision: "", files: {} }
    const candidate = ResolutionCandidateSchema.parse(JSON.parse((await repo.command(repo.descriptor.mainWorktree, ["show", `${ref}:state.json`])).toString()))
    return { ...candidate, revision: ref }
}
async function saveCandidate(repo: RepositoryGit, subject: ConflictSubject, candidate: ResolutionCandidate) {
    const objects = new Map<string, string>()
    for (const entry of Object.values(candidate.files)) {
        if (entry && entry.mode != "160000")
            objects.set(entry.object, "blob")
    }
    const after = await retainedDocument(repo, candidate, objects)
    await repo.updateRefs([{ ref: candidateRef(subject), before: candidate.revision || null, after }])
}
async function checkedCandidate(repo: RepositoryGit, subject: ConflictSubject, request: { input: string; revision: string }) {
    if (subject.input != request.input)
        throw new Error("Conflict inputs changed. The previous result remains a suggestion; refresh before accepting.")
    const candidate = await readCandidate(repo, subject)
    if (candidate.revision != request.revision)
        throw new Error("Resolution progress changed. Reload the candidate before continuing.")
    return candidate
}

export async function conflictResult(repo: RepositoryGit, subjectId?: string): Promise<ConflictResult> {
    const result: ConflictResult = { type: "result", command: "conflict", conflicts: [], recovery: [] }
    const state = await readConflictState(repo).catch(() => undefined)
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
    for (const stack of state.stacks) {
        const tip = await repo.resolveRef(stack.temporaryRef)
        const branch = stack.branches.at(-1)!.ref.slice(11)
        if (!tip) {
            const refs = await repo.listRefs("refs/heads/")
            const candidates: string[] = []
            for (const ref of refs) {
                if (await repo.resolveRef(ref) == (stack.steps.at(-1)?.current ?? stack.base))
                    candidates.push(ref.slice(11))
            }
            result.recovery.push({ stack: stack.id, branch, message: "The unresolved branch is missing.", candidates })
        }
        for (const step of stack.steps) {
            if (step.conflict) {
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
    for (const working of state.working) {
        result.conflicts.push({
            id: working.conflict.id,
            kind: "working",
            branch: working.branch?.slice(11) ?? "Detached worktree",
            title: "Working Changes Conflict",
            files: working.conflict.files.length,
            suspended: Boolean(working.suspended),
        })
    }
    for (const ref of await repo.listRefs(temporaryBranchPrefix)) {
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
        const { subject } = findSubject(state, subjectId)
        const candidate = await readCandidate(repo, subject)
        const suggestion = subject.suggestion ? await treeEntries(repo, subject.suggestion) : undefined
        const candidateTree = await replaceTreeFiles(repo, subject.tree, candidate.files)
        const reviewTree = await replaceTreeFiles(repo, subject.tree, Object.fromEntries(subject.files.map(file => [file.path, file.left])))
        const files: NonNullable<ConflictResult["view"]>["files"] = []
        for (const file of subject.files) {
            const entries = [
                file.base,
                file.left,
                file.right,
                file.path in candidate.files ? candidate.files[file.path] : file.provisional,
                suggestion?.get(file.path) ?? null,
            ]
            const texts = await Promise.all(entries.map(async entry => {
                const bytes = await blob(repo, entry)
                return isText(bytes) && bytes!.length <= 2_000_000 ? bytes!.toString() : null
            }))
            const diff =
                (await repo.command(repo.descriptor.mainWorktree, ["diff", "--no-ext-diff", "--no-textconv", reviewTree, candidateTree, "--", file.path]))
                    .toString()
            files.push({
                ...file,
                baseText: texts[0],
                leftText: texts[1],
                rightText: texts[2],
                resultText: texts[3],
                suggestionText: texts[4],
                diff: diff.slice(0, 2_000_000),
                resolved: file.path in candidate.files && !conflictHunks(texts[3] ?? "", subject).length,
                hunks: conflictHunks(texts[3] ?? "", subject),
            })
        }
        result.view = { subject, candidate, files, reviewTree, resultTree: candidateTree, ready: await candidateReady(repo, subject, candidate) }
    }
    return result
}

export async function executeConflict(repo: RepositoryGit, request: ConflictRequest, changes: Changes, cancelled: () => boolean = () => false) {
    if (request.action == "list" || request.action == "inspect")
        return conflictResult(repo, request.action == "inspect" ? request.subject : undefined)
    if (request.action == "publish-check" && !(await readConflictState(repo).catch(() => undefined)))
        return conflictResult(repo)
    const state = await readConflictState(repo)
    for (const step of state.stacks.flatMap(s => s.steps)) {
        if (step.conflict && !state.retainedConflicts.some(c => c.commit == step.current))
            state.retainedConflicts.push({ commit: step.current, source: step.source, conflict: step.conflict })
    }
    const before = await repo.resolveRef(conflictStateRef)
    const observedRefs = new Map<string, string | null>()
    for (const ref of await repo.listRefs("refs/heads/"))
        observedRefs.set(ref, await repo.resolveRef(ref))
    const updateRefs = async (updates: Parameters<RepositoryGit["updateRefs"]>[0]) => {
        for (const update of updates) {
            const expected = changes.has(update.ref) ? changes.get(update.ref) : observedRefs.get(update.ref) ?? null
            if (expected !== update.before)
                throw new Error("A branch changed during replay. Refresh the stack before accepting.")
        }
        await repo.updateRefs(updates)
        for (const update of updates)
            changes.set(update.ref, update.after)
    }
    const persist = async () => {
        changes.set(conflictStateRef, await storeConflictState(repo, state, before))
    }
    if (request.action == "publish-check") {
        const result = await conflictResult(repo)
        const refs = request.branches.map(branchRef)
        const blocked = state.stacks.some(s => refs.includes(s.temporaryRef) || s.branches.some(b => refs.includes(b.ref)))
            || state.working.some(w => w.branch && refs.includes(w.branch))
        let inherited = false
        for (const ref of refs) {
            const tip = await repo.resolveRef(ref)
            if (!tip)
                continue
            for (const retained of state.retainedConflicts) {
                if (!(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", retained.commit, tip])).exitCode)
                    inherited = true
            }
        }
        result.publishable = !blocked && !inherited && !refs.some(ref => ref.startsWith(temporaryBranchPrefix))
        return result
    }
    if (request.action == "rewrite") {
        const refs = request.branches.map(branchRef)
        if (new Set(refs).size != refs.length)
            throw new Error("Choose each affected branch once, in stack order.")
        for (const ref of refs) {
            await gitText(repo, ["check-ref-format", ref])
            if (ref.startsWith(temporaryBranchPrefix))
                throw new Error("Choose the intended branch, not its temporary representation.")
        }
        await gitText(repo, ["cat-file", "-e", `${request.base}^{commit}`])
        let stack = state.stacks.find(s => s.branches.at(-1)!.ref == refs.at(-1))
        if (stack) {
            if (JSON.stringify(stack.branches.map(b => b.ref)) != JSON.stringify(refs))
                throw new Error("Update all branches belonging to this Unresolved Stack together.")
            await followTemporaryBranch(repo, stack)
            stack.base = request.base
        } else {
            if (state.stacks.some(s => s.branches.some(b => refs.includes(b.ref))))
                throw new Error("These branches already belong to an Unresolved Stack. Update that stack first.")
            const branchTips = await Promise.all(refs.map(ref => repo.resolveRef(ref)))
            if (branchTips.some(tip => !tip))
                throw new Error("An affected branch no longer exists.")
            const upstreamBoundary = state.stacks.flatMap(s => s.branches).find(b => b.current == request.base || b.before == request.base)
            const fork = upstreamBoundary?.before ?? await gitText(repo, ["merge-base", branchTips[0]!, request.base])
            const sources = await linearCommits(repo, fork, branchTips.at(-1)!)
            const steps = sources.map(source => ({
                id: crypto.randomUUID(),
                source: state.retainedConflicts.find(c => c.commit == source)?.source ?? source,
                current: source,
            }))
            const branches = refs.map((ref, i) => {
                const step = steps.find(s => s.current == branchTips[i])
                if (!step && branchTips[i] != fork)
                    throw new Error("Each affected branch must be a boundary in the replayed linear stack.")
                return { ref, before: branchTips[i]!, current: branchTips[i]!, step: step?.id ?? "base" }
            })
            const stackId = crypto.randomUUID()
            stack = { id: stackId, temporaryRef: `${temporaryBranchPrefix}${refs.at(-1)!.slice(11)}/${stackId}`, base: request.base, branches, steps }
            state.stacks.push(stack)
        }
        for (const upstream of state.stacks.filter(s => s.id != stack!.id)) {
            const boundary = upstream.branches.find(b => b.current == request.base || b.before == request.base)
            if (boundary) {
                stack.dependency = { stackId: upstream.id, branch: boundary.ref }
                stack.base = boundary.current
            }
        }
        if (request.path) {
            const holder = await requireWorktree(repo, request.path)
            if (holder.branchRef != refs.at(-1) && holder.branchRef != stack.temporaryRef)
                throw new Error("The destination must hold the intended tip branch or its temporary branch.")
        }
        await rebaseStack(repo, stack, cancelled)
        if (cancelled())
            throw new Error("Stack rewrite cancelled before changing refs or files.")
        await publishProvisional(repo, state, stack, updateRefs, changes, request.path)
        await persist()
        return conflictResult(repo)
    }
    if (request.action == "restore" || request.action == "discard") {
        const stack = state.stacks.find(s => s.id == request.stack)
        if (!stack)
            throw new Error("The Unresolved Stack no longer exists.")
        if (request.action == "discard") {
            if (await repo.resolveRef(stack.temporaryRef))
                throw new Error("Use Operation History to undo a live unresolved update.")
            state.stacks = state.stacks.filter(s => s != stack)
        } else {
            if (request.adopt) {
                const adopted = branchRef(request.adopt)
                if (await repo.resolveRef(adopted) != (stack.steps.at(-1)?.current ?? stack.base))
                    throw new Error("The proposed replacement branch changed.")
                stack.temporaryRef = adopted
            } else if (!await repo.resolveRef(stack.temporaryRef)) {
                await updateRefs([{ ref: stack.temporaryRef, before: null, after: stack.steps.at(-1)?.current ?? stack.base }])
            }
            if (request.path) {
                await requireWorktree(repo, request.path, true)
                await repo.command(request.path, ["switch", stack.temporaryRef.slice(11)])
            }
        }
        await persist()
        return conflictResult(repo)
    }
    const found = findSubject(state, request.subject)
    const { subject } = found
    if (request.action == "resume-working") {
        if (!found.working?.suspended)
            throw new Error("This Working Changes Conflict is not suspended.")
        await requireWorktree(repo, request.path, true)
        if (await gitText(repo, ["rev-parse", `${found.working.suspended}^1`]) != await gitHead(repo, request.path))
            throw new Error("The restoration base changed. Apply the suspended stash as a new Working Changes Conflict.")
        await repo.command(request.path, ["stash", "apply", "--index", found.working.suspended])
        await dropStash(repo, found.working.suspended, changes)
        found.working.suspended = undefined
        found.working.path = request.path
        await persist()
        return conflictResult(repo, subject.id)
    }
    const candidate = await checkedCandidate(repo, subject, request)
    if (request.action == "cancel") {
        await repo.updateRefs([{ ref: candidateRef(subject), before: candidate.revision || null, after: null }])
        await cleanupResolutionFiles(repo, subject)
        return conflictResult(repo, subject.id)
    }
    if (request.action == "accept" || request.action == "keep-stashed") {
        if (request.action == "accept" && !await candidateReady(repo, subject, candidate))
            throw new Error("Resolve every recorded conflict before accepting this candidate.")
        if (found.working) {
            const working = found.working
            if (working.suspended)
                throw new Error("Resume these Working Changes before accepting them.")
            await requireWorktree(repo, working.path)
            if (await gitHead(repo, working.path) != working.head)
                throw new Error("The worktree moved. Resume the Working Changes Conflict on its original base.")
            const current = await workingTree(repo, working.path)
            const target = request.action == "accept"
                ? await replaceTreeFiles(repo, subject.tree, candidate.files)
                : await gitText(repo, ["rev-parse", `${working.head}^{tree}`])
            const restored = await replayTree(repo, subject.tree, current, target, crypto.randomUUID())
            if (restored.conflict)
                throw new Error("Later Working Changes overlap this result. Preserve or explicitly include them before accepting or keeping the stash.")
            await repo.command(working.path, ["read-tree", "--reset", "-u", restored.tree])
            await repo.command(working.path, ["read-tree", working.head])
            if (request.action == "accept")
                await dropStash(repo, working.stash, changes)
            state.working = state.working.filter(w => w != working)
        } else {
            if (request.action == "keep-stashed")
                throw new Error("Only Working Changes Conflicts can be kept stashed.")
            const stack = found.stack!
            await followTemporaryBranch(repo, stack)
            if (!stack.steps.includes(found.step!))
                throw new Error("The temporary branch no longer contains this commit. Update the stack to follow its current history.")
            found.step!.accepted = { input: subject.input, tree: await replaceTreeFiles(repo, subject.tree, candidate.files) }
            await rebaseStack(repo, stack, cancelled)
            await carryNewBranchCommits(repo, stack)
            await rebaseDependents(repo, state, stack, cancelled)
            if (cancelled())
                throw new Error("Acceptance cancelled before changing refs or files.")
            const affectedStacks = [...state.stacks].filter(s => s.id == stack.id || dependsOn(state, s, stack.id))
            for (const affected of affectedStacks)
                await publishProvisional(repo, state, affected, updateRefs, changes)
        }
        await persist()
        await cleanupResolutionFiles(repo, subject)
        return conflictResult(repo)
    }
    const file = subject.files.find(file => file.path == request.file)
    if (!file)
        throw new Error("Choose a recorded conflict file.")
    if (request.action == "choose") {
        if (request.hunk !== undefined) {
            if (request.side != "left" && request.side != "right")
                throw new Error("Choose a named side for this hunk.")
            const content = (await blob(repo, file.path in candidate.files ? candidate.files[file.path] : file.provisional))?.toString() ?? ""
            const hunk = conflictHunks(content, subject)[request.hunk]
            if (!hunk)
                throw new Error("The conflict hunk changed. Refresh the candidate.")
            const result = content.slice(0, hunk.start) + hunk[request.side] + content.slice(hunk.end)
            candidate.files[file.path] = { mode: file.provisional!.mode, object: await gitText(repo, ["hash-object", "-w", "--stdin"], result) }
        } else if (request.side == "suggestion") {
            if (!subject.suggestion)
                throw new Error("There is no previous result to use.")
            candidate.files[file.path] = (await treeEntries(repo, subject.suggestion)).get(file.path) ?? null
        } else {
            candidate.files[file.path] = request.side == "delete" ? null : file[request.side]
        }
    } else if (request.action == "use-file") {
        await requireWorktree(repo, request.path)
        const absolute = resolve(request.path, file.path)
        const parent = await realpath(dirname(absolute))
        const root = await realpath(request.path)
        if (isAbsolute(relative(root, parent)) || relative(root, parent).startsWith(".."))
            throw new Error("Resolution files must stay inside the worktree.")
        const stat = await lstat(absolute)
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("Use a named side for symbolic links and structural conflicts.")
        candidate.files[file.path] = {
            mode: file.provisional?.mode ?? "100644",
            object: (await repo.command(request.path, ["hash-object", "-w", `--path=${file.path}`, "--stdin"], await readFile(absolute))).toString().trim(),
        }
    } else if (request.action == "tool") {
        await runMergeTool(repo, subject, file, candidate)
    }
    await saveCandidate(repo, subject, candidate)
    if (request.action != "tool")
        await cleanupResolutionFiles(repo, subject, file.path)
    return conflictResult(repo, subject.id)
}

async function linearCommits(repo: RepositoryGit, base: string, tip: string) {
    const lines = (await gitText(repo, ["rev-list", "--reverse", "--topo-order", "--parents", `${base}..${tip}`])).split("\n").filter(Boolean)
    if (lines.some(line => line.split(" ").length != 2))
        throw new Error("This rewrite requires a linear commit range.")
    return lines.map(line => line.split(" ")[0])
}
async function followTemporaryBranch(repo: RepositoryGit, stack: UnresolvedStack) {
    const actual = await repo.resolveRef(stack.temporaryRef)
    if (!actual)
        throw new Error("The temporary branch is missing. Restore it before continuing.")
    const retained = stack.steps.at(-1)?.current ?? stack.base
    if (actual == retained)
        return
    if (!(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", retained, actual])).exitCode) {
        for (const source of await linearCommits(repo, retained, actual))
            stack.steps.push({ id: crypto.randomUUID(), source, current: source })
    } else {
        let index = -1
        for (let i = stack.steps.length - 1; i >= 0; i--) {
            if (!(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", stack.steps[i].current, actual])).exitCode) {
                index = i
                break
            }
        }
        if (index < 0) {
            throw new Error(
                "The temporary branch was rewritten externally. Its current history is preserved; restore conflict input mappings before accepting.",
            )
        }
        stack.steps.splice(index + 1)
        for (const source of await linearCommits(repo, stack.steps[index].current, actual))
            stack.steps.push({ id: crypto.randomUUID(), source, current: source })
    }
    stack.branches.at(-1)!.step = stack.steps.at(-1)!.id
    stack.branches.at(-1)!.current = actual
}
async function rebaseStack(repo: RepositoryGit, stack: UnresolvedStack, cancelled: () => boolean) {
    let parent = stack.base
    for (const step of stack.steps) {
        if (cancelled())
            throw new Error("Stack replay cancelled.")
        const previous = step.conflict
        const merged = await replayTree(repo, await commitParent(repo, step.source), parent, step.source, step.id)
        if (merged.conflict && previous?.input == merged.conflict.input) {
            merged.tree = await replaceTreeFiles(repo, merged.tree, Object.fromEntries(previous.files.map(file => [file.path, file.provisional])))
            merged.conflict = { ...previous, tree: merged.tree }
        }
        let tree = merged.tree
        if (merged.conflict && step.accepted?.input == merged.conflict.input) {
            const accepted = await treeEntries(repo, step.accepted.tree)
            tree = await replaceTreeFiles(repo, tree, Object.fromEntries(merged.conflict.files.map(f => [f.path, accepted.get(f.path) ?? null])))
            step.conflict = undefined
        } else {
            step.conflict = merged.conflict
            if (step.conflict) {
                if (step.accepted)
                    step.conflict.suggestion = step.accepted.tree
                else if (previous && previous.input != step.conflict.input) {
                    const old = await readCandidate(repo, previous)
                    step.conflict.suggestion = await replaceTreeFiles(repo, previous.tree, old.files)
                } else if (previous?.suggestion) {
                    step.conflict.suggestion = previous.suggestion
                }
            }
        }
        const currentTree = await gitText(repo, ["rev-parse", `${step.current}^{tree}`])
        const currentParent = await commitParent(repo, step.current)
        step.current = currentTree == tree && currentParent == parent ? step.current : await rewriteCommit(repo, step.source, parent, tree)
        parent = step.current
    }
    for (const branch of stack.branches) {
        if (branch.step == "base") {
            branch.current = stack.base
            continue
        }
        const step = stack.steps.find(step => step.id == branch.step)
        if (!step)
            throw new Error("External history removed an intermediate branch boundary. Review the branch mapping before continuing.")
        branch.current = step.current
    }
}
async function carryNewBranchCommits(repo: RepositoryGit, stack: UnresolvedStack) {
    let changed = false
    for (const branch of stack.branches) {
        const actual = await repo.resolveRef(branch.ref)
        if (actual == branch.before)
            continue
        if (!actual || (await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", branch.before, actual])).exitCode)
            throw new Error("An intended branch was replaced externally. Review its new history before final acceptance.")
        const sources = await linearCommits(repo, branch.before, actual)
        const position = stack.steps.findIndex(step => step.id == branch.step) + 1
        const added = sources.map(source => ({ id: crypto.randomUUID(), source, current: source }))
        stack.steps.splice(position, 0, ...added)
        branch.step = added.at(-1)?.id ?? branch.step
        branch.before = actual
        changed = true
    }
    if (changed)
        await rebaseStack(repo, stack, () => false)
}
function dependsOn(state: ConflictState, stack: UnresolvedStack, id: string): boolean {
    const seen = new Set<string>()
    while (stack.dependency) {
        if (stack.dependency.stackId == id)
            return true
        if (seen.has(stack.id))
            throw new Error("Conflict dependencies contain a cycle.")
        seen.add(stack.id)
        const parent = state.stacks.find(s => s.id == stack.dependency!.stackId)
        if (!parent)
            return false
        stack = parent
    }
    return false
}
async function rebaseDependents(repo: RepositoryGit, state: ConflictState, upstream: UnresolvedStack, cancelled: () => boolean) {
    for (const stack of state.stacks.filter(s => s.dependency?.stackId == upstream.id)) {
        await followTemporaryBranch(repo, stack)
        stack.base = upstream.branches.find(b => b.ref == stack.dependency!.branch)!.current
        await rebaseStack(repo, stack, cancelled)
        await rebaseDependents(repo, state, stack, cancelled)
    }
}
async function publishProvisional(
    repo: RepositoryGit,
    state: ConflictState,
    stack: UnresolvedStack,
    updateRefs: (updates: Parameters<RepositoryGit["updateRefs"]>[0]) => Promise<void>,
    changes: Changes,
    path?: string,
) {
    const upstream = stack.dependency && state.stacks.find(s => s.id == stack.dependency!.stackId)
    const unresolved = stack.steps.some(s => s.conflict) || Boolean(upstream)
    const worktrees = await readRegisteredWorktrees(repo)
    const holders = worktrees.filter(w => w.branchRef == stack.temporaryRef || w.path == path || stack.branches.some(b => b.ref == w.branchRef))
    for (const holder of holders) {
        if (holder.missing)
            throw new Error("An affected worktree is unavailable.")
        await requireWorktree(repo, holder.path)
    }
    const tip = stack.steps.at(-1)?.current ?? stack.base
    const working = new Map<string, { tree: string; conflict?: ConflictSubject; index: string; oldHead: string; stash?: string }>()
    const duplicateHolders = holders.filter(w => w.branchRef == stack.branches.at(-1)!.ref && holders.some(other => other.branchRef == stack.temporaryRef))
    for (const holder of holders) {
        if (duplicateHolders.includes(holder))
            continue
        const boundary = stack.branches.find(b => b.ref == holder.branchRef)
        if (unresolved && boundary && boundary != stack.branches.at(-1))
            continue
        const target = unresolved ? tip : (boundary?.current ?? tip)
        const oldHead = await gitHead(repo, holder.path)
        const dirty = Boolean((await repo.command(holder.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length)
        const current = dirty ? await workingTree(repo, holder.path) : await gitText(repo, ["rev-parse", `${oldHead}^{tree}`])
        const merged = dirty
            ? await replayTree(repo, oldHead, target, current, crypto.randomUUID())
            : { tree: await gitText(repo, ["rev-parse", `${target}^{tree}`]) }
        const index = (await repo.command(holder.path, ["write-tree"])).toString().trim()
        const staged = dirty ? await replayTree(repo, oldHead, target, index, crypto.randomUUID()) : merged
        const targetFiles = await treeEntries(repo, merged.tree)
        const ignored = (await repo.command(holder.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0").filter(
            Boolean,
        )
        if (ignored.some(name => [...targetFiles.keys()].some(file => file == name || file.startsWith(name + "/") || name.startsWith(file + "/"))))
            throw new Error("The rewritten tree would replace an ignored file. Move that file before retrying.")
        if (await gitHead(repo, holder.path) != oldHead || await workingTree(repo, holder.path) != current)
            throw new Error("Working Changes moved while preparing resolution. Refresh and retry.")
        working.set(holder.path, { ...merged, oldHead, index: staged.conflict ? await gitText(repo, ["rev-parse", `${target}^{tree}`]) : staged.tree })
    }
    for (const holder of duplicateHolders)
        await repo.command(holder.path, ["checkout", "--detach", holder.head])
    for (const [path, carry] of working) {
        if (carry.conflict) {
            await repo.command(path, ["stash", "push", "--include-untracked", "-m", "Working Changes during conflict resolution"])
            carry.stash = (await repo.resolveRef("refs/stash"))!
            changes.set("refs/stash", carry.stash)
        }
    }
    async function checkout(holder: typeof holders[number], ref: string, target: string) {
        if (duplicateHolders.includes(holder))
            return
        const carry = working.get(holder.path)!
        await repo.command(holder.path, ["read-tree", "--reset", "-u", carry.tree])
        await repo.command(holder.path, ["read-tree", carry.index])
        await repo.command(holder.path, ["symbolic-ref", "HEAD", ref])
        if (carry.conflict && carry.stash)
            state.working.push({ id: carry.conflict.id, path: holder.path, branch: ref, head: target, stash: carry.stash, conflict: carry.conflict })
    }
    if (unresolved) {
        await updateRefs([{ ref: stack.temporaryRef, before: await repo.resolveRef(stack.temporaryRef), after: tip }])
        for (const holder of holders) {
            const branch = stack.branches.find(b => b.ref == holder.branchRef)
            if (branch && branch != stack.branches.at(-1)) {
                // A single branch cannot back two worktrees. Keep intermediate worktrees at their frozen ordinary refs.
                continue
            }
            await checkout(holder, stack.temporaryRef, tip)
        }
    } else {
        await updateRefs(stack.branches.map(b => ({ ref: b.ref, before: b.before, after: b.current })))
        for (const holder of holders) {
            const branch = stack.branches.find(b => b.ref == holder.branchRef) ?? stack.branches.at(-1)!
            await checkout(holder, branch.ref, branch.current)
        }
        const temporary = await repo.resolveRef(stack.temporaryRef)
        if (temporary)
            await updateRefs([{ ref: stack.temporaryRef, before: temporary, after: null }])
        state.stacks = state.stacks.filter(s => s.id != stack.id)
        for (const child of state.stacks.filter(s => s.dependency?.stackId == stack.id))
            child.dependency = undefined
    }
}

export async function applyStashConflict(repo: RepositoryGit, path: string, stash: string, changes: Changes) {
    const state = await readConflictState(repo)
    if (state.working.some(w => normalize(w.path) == normalize(path) && !w.suspended))
        throw new Error("This worktree already has a Working Changes Conflict.")
    const before = await repo.resolveRef(conflictStateRef)
    const head = await gitHead(repo, path)
    let stashTree = await gitText(repo, ["rev-parse", `${stash}^{tree}`])
    // Include the stash's untracked parent in the same merge so collisions are deferred too.
    const untracked = await repo.run(path, ["rev-parse", "--verify", `${stash}^3`])
    if (!untracked.exitCode) {
        const extras = await treeEntries(repo, untracked.stdout.toString().trim())
        stashTree = await replaceTreeFiles(repo, stashTree, Object.fromEntries(extras))
    }
    const merged = await replayTree(repo, await commitParent(repo, stash), head, stashTree, crypto.randomUUID())
    if (!merged.conflict)
        throw new Error("The stash failed for a reason other than a content conflict. Its original state is preserved.")
    const branch = (await repo.run(path, ["symbolic-ref", "--quiet", "HEAD"])).stdout.toString().trim() || null
    state.working.push({ id: merged.conflict.id, path, branch, head, stash, conflict: merged.conflict })
    await repo.command(path, ["read-tree", "--reset", "-u", merged.tree])
    await repo.command(path, ["read-tree", head])
    changes.set(conflictStateRef, await storeConflictState(repo, state, before))
}
async function gitHead(repo: RepositoryGit, path: string) {
    return (await repo.command(path, ["rev-parse", "HEAD"])).toString().trim()
}
async function workingTree(repo: RepositoryGit, path: string) {
    return withConflictScratch(async scratch => {
        const env = { GIT_INDEX_FILE: join(scratch, "index") }
        await repo.command(path, ["read-tree", "HEAD"], undefined, env)
        await repo.command(path, ["add", "-A"], undefined, env)
        return (await repo.command(path, ["write-tree"], undefined, env)).toString().trim()
    })
}
async function dropStash(repo: RepositoryGit, oid: string, changes: Changes) {
    const list = (await gitText(repo, ["stash", "list", "--format=%H"])).split("\n")
    const index = list.indexOf(oid)
    if (index < 0)
        throw new Error("The retained stash was removed externally. Restore it before accepting.")
    await gitText(repo, ["stash", "drop", `stash@{${index}}`])
    changes.set("refs/stash", await repo.resolveRef("refs/stash"))
}
async function runMergeTool(repo: RepositoryGit, subject: ConflictSubject, file: ConflictFile, candidate: ResolutionCandidate) {
    if ([file.base, file.left, file.right].some(entry => entry && !entry.mode.startsWith("100")))
        throw new Error("Use a named version for symbolic-link and submodule conflicts.")
    // Git owns configured tool selection and command expansion. Only temporary copies are exposed.
    const name = (await repo.run(repo.descriptor.mainWorktree, ["config", "--get", "merge.tool"])).stdout.toString().trim()
    if (!name)
        throw new Error("Configure Git merge.tool before opening an external merge tool.")
    const directory = join(
        repo.descriptor.commonDirectory,
        "workbench",
        "resolutions",
        subject.id,
        subject.input,
        createHash("sha256").update(file.path).digest("hex"),
    )
    await mkdir(directory, { recursive: true })
    for (
        const [name, entry] of [["BASE", file.base], ["LOCAL", file.left], ["REMOTE", file.right], [
            "MERGED",
            file.path in candidate.files ? candidate.files[file.path] : file.provisional,
        ]] as const
    ) {
        const target = join(directory, name)
        // Recover saved external edits after a crash; never truncate an existing result.
        try {
            await writeFile(target, await blob(repo, entry) ?? "", { flag: name == "MERGED" ? "wx" : "w" })
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code == "EEXIST"))
                throw error
        }
    }
    const gitExec = await gitText(repo, ["--exec-path"])
    const shell = process.platform == "win32" ? resolve(dirname(repo.descriptor.git.path), "..", "bin", "bash.exe") : "sh"
    const script = 'TOOL_MODE=merge; . "$GIT_EXEC_PATH/git-mergetool--lib"; initialize_merge_tool "$WB_TOOL" && run_merge_tool "$WB_TOOL" true'
    const processTool = Bun.spawn([shell, "-c", script], {
        cwd: repo.descriptor.mainWorktree,
        env: {
            ...process.env,
            GIT_EXEC_PATH: gitExec,
            WB_TOOL: name,
            BASE: join(directory, "BASE"),
            LOCAL: join(directory, "LOCAL"),
            REMOTE: join(directory, "REMOTE"),
            MERGED: join(directory, "MERGED"),
            BACKUP: join(directory, "BACKUP"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    })
    const [code, stderr] = await Promise.all([processTool.exited, new Response(processTool.stderr).text(), new Response(processTool.stdout).text()])
    if (code)
        throw new Error(`The merge tool did not complete successfully. Saved edits remain recoverable. ${stderr}`)
    candidate.files[file.path] = {
        mode: file.provisional?.mode ?? "100644",
        object: await gitText(repo, ["hash-object", "-w", "--stdin"], await readFile(join(directory, "MERGED"))),
    }
}

async function cleanupResolutionFiles(repo: RepositoryGit, subject: ConflictSubject, file?: string) {
    const root = resolve(repo.descriptor.commonDirectory, "workbench", "resolutions")
    const path = resolve(root, subject.id, subject.input, ...(file ? [createHash("sha256").update(file).digest("hex")] : []))
    if (isAbsolute(relative(root, path)) || relative(root, path).startsWith(".."))
        throw new Error("Invalid resolution directory")
    await rm(path, { recursive: true, force: true })
}

export async function suspendWorkingConflicts(repo: RepositoryGit, changes: Changes) {
    const state = await readConflictState(repo).catch(() => undefined)
    if (!state)
        return
    const before = await repo.resolveRef(conflictStateRef)
    let changed = false
    for (const working of state.working.filter(w => !w.suspended)) {
        const ref = (await repo.run(working.path, ["symbolic-ref", "--quiet", "HEAD"])).stdout.toString().trim() || null
        if (ref == working.branch)
            continue
        const stash = await repo.resolveRef("refs/stash")
        if (stash) {
            working.suspended = stash
            changed = true
        }
    }
    if (changed)
        changes.set(conflictStateRef, await storeConflictState(repo, state, before))
}
