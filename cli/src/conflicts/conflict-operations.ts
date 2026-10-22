import { blob, candidateReady, conflictHunks, conflictStateRef, gitText, hasConflictMarkers, isText, normalize, readConflictState, readRegisteredWorktrees, readStoredHistoricalEdits, replaceTreeFiles, replayTree, type RepositoryGit, rewriteCommit, storeConflictState, temporaryBranchPrefix, treeEntries, withConflictScratch } from "@laneway/git"
import { type ConflictRequest, type ConflictState, type ConflictSubject, type UnresolvedStack } from "@laneway/shared"
import { lstat, readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { followAcceptedRewrites } from "../historical-edit/accepted-rewrites"
import { candidateRef, checkedCandidate, readCandidate, saveCandidate } from "./conflict-candidates"
import { conflictResult, findSubject } from "./conflict-inspection"
import { cleanupResolutionFiles, runMergeTool } from "./conflict-resolution-files"

export { conflictResult } from "./conflict-inspection"

type Changes = Map<string, string | null>
export let conflictMutation = (request: ConflictRequest) =>
    ["rewrite", "accept", "keep-stashed", "restore", "discard", "resume-working"].includes(request.action)

export interface ConflictSession {
    state: ConflictState
    before: string | null
    updateRefs: (updates: Parameters<RepositoryGit["updateRefs"]>[0]) => Promise<void>
    persist: () => Promise<void>
}

export interface StackRewritePlan {
    // Affected branches in stack order, as full refs.
    refs: string[]
    base: string
    path?: string
    // Explicit replay sources per branch, bottom-up. When omitted, the branches' linear local history is replayed.
    // For an existing Unresolved Stack these are incoming commits inserted before that branch's retained steps.
    sources?: string[][]
}

export async function conflictPaths(repo: RepositoryGit) {
    return (await readRegisteredWorktrees(repo)).filter(w => !w.missing).map(w => w.path)
}

export async function executeConflict(repo: RepositoryGit, request: ConflictRequest, changes: Changes, cancelled: () => boolean = () => false) {
    if (request.action == "list" || request.action == "inspect")
        return conflictResult(repo, request.action == "inspect" ? request.subject : undefined, request.action == "inspect" ? request.files : undefined)
    if (request.action == "publish-check" && !(await readConflictState(repo).catch(() => undefined)))
        return conflictResult(repo)
    let session = await openConflictSession(repo, changes)
    let { state, updateRefs, persist } = session
    if (request.action == "publish-check") {
        let result = await conflictResult(repo)
        let refs = request.branches.map(branchRef)
        let blocked = state.stacks.some(s => refs.includes(s.temporaryRef) || s.branches.some(b => refs.includes(b.ref)))
            || state.working.some(w => w.branch && refs.includes(w.branch))
        let inherited = false
        for (let ref of refs) {
            let tip = await repo.resolveRef(ref)
            if (!tip)
                continue
            for (let retained of state.retainedConflicts) {
                if (!(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", retained.commit, tip])).exitCode)
                    inherited = true
            }
        }
        result.publishable = !blocked && !inherited && !refs.some(ref => ref.startsWith(temporaryBranchPrefix))
        return result
    }
    if (request.action == "rewrite") {
        await rewriteStack(repo, session, { refs: request.branches, base: request.base, path: request.path }, changes, cancelled)
        await persist()
        return conflictResult(repo)
    }
    if (request.action == "restore" || request.action == "discard") {
        let stack = state.stacks.find(s => s.id == request.stack)
        if (!stack)
            throw new Error("The Unresolved Stack no longer exists.")
        if (request.action == "discard") {
            if (await repo.resolveRef(stack.temporaryRef))
                throw new Error("Use Operation History to undo a live unresolved update.")
            state.stacks = state.stacks.filter(s => s != stack)
        } else {
            if (request.adopt) {
                let adopted = branchRef(request.adopt)
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

    let found = findSubject(state, request.subject)
    let { subject } = found
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

    let candidate = await checkedCandidate(repo, subject, request)

    if (request.action == "cancel") {
        await repo.updateRefs([{ ref: candidateRef(subject), before: candidate.revision || null, after: null }])
        await cleanupResolutionFiles(repo, subject)
        return conflictResult(repo, subject.id)
    }

    if (request.action == "accept" || request.action == "keep-stashed") {
        if (request.action == "accept" && !await candidateReady(repo, subject, candidate))
            throw new Error("Resolve every recorded conflict before accepting this candidate.")
        if (found.working) {
            let working = found.working
            if (working.suspended)
                throw new Error("Resume these Working Changes before accepting them.")
            await requireWorktree(repo, working.path)
            if (await gitHead(repo, working.path) != working.head)
                throw new Error("The worktree moved. Resume the Working Changes Conflict on its original base.")
            let current = await workingTree(repo, working.path)
            let target = request.action == "accept"
                ? await replaceTreeFiles(repo, subject.tree, candidate.files)
                : working.beforeTree ?? await gitText(repo, ["rev-parse", `${working.head}^{tree}`])
            let restored = await replayTree(repo, subject.tree, current, target, crypto.randomUUID())
            if (restored.conflict)
                throw new Error("Later Working Changes overlap this result. Preserve or explicitly include them before accepting or keeping the stash.")
            await repo.command(working.path, ["read-tree", "--reset", "-u", restored.tree])
            await repo.command(working.path, ["read-tree", (request.action == "accept" ? working.afterIndex : working.beforeIndex) ?? working.head])
            if (request.action == "accept")
                await dropStash(repo, working.stash, changes)
            state.working = state.working.filter(w => w != working)
        } else {
            if (request.action == "keep-stashed")
                throw new Error("Only Working Changes Conflicts can be kept stashed.")
            let stack = found.stack!
            let sessions = await readStoredHistoricalEdits(repo)
            let previous = new Map(state.stacks.flatMap(s => s.steps.map(step => [step.id, step.current] as const)))
            await followTemporaryBranch(repo, stack)
            if (!stack.steps.includes(found.step!))
                throw new Error("The temporary branch no longer contains this commit. Update the stack to follow its current history.")
            found.step!.accepted = { input: subject.input, tree: await replaceTreeFiles(repo, subject.tree, candidate.files) }
            await rebaseStack(repo, stack, cancelled)
            await carryNewBranchCommits(repo, stack)
            await rebaseDependents(repo, state, stack, cancelled)
            if (cancelled())
                throw new Error("Acceptance cancelled before changing refs or files.")
            let affectedStacks = [...state.stacks].filter(s => s.id == stack.id || dependsOn(state, s, stack.id))
            for (let affected of affectedStacks)
                await publishProvisional(repo, state, affected, updateRefs, changes)
            await followAcceptedRewrites(repo, sessions, affectedStacks, previous, state, changes)
        }
        await persist()
        await cleanupResolutionFiles(repo, subject)
        return conflictResult(repo)
    }

    let file = subject.files.find(file => file.path == request.file)
    if (!file)
        throw new Error("Choose a recorded conflict file.")
    if (request.action == "choose") {
        if (request.hunk !== undefined) {
            if (request.side != "left" && request.side != "right")
                throw new Error("Choose a named side for this hunk.")
            let content = (await blob(repo, file.path in candidate.files ? candidate.files[file.path] : file.provisional))?.toString() ?? ""
            let hunk = conflictHunks(content, subject)[request.hunk]
            if (!hunk)
                throw new Error("The conflict hunk changed. Refresh the candidate.")
            let result = content.slice(0, hunk.start) + hunk[request.side] + content.slice(hunk.end)
            candidate.files[file.path] = { mode: file.provisional!.mode, object: await gitText(repo, ["hash-object", "-w", "--stdin"], result) }
        } else if (request.side == "suggestion") {
            if (!subject.suggestion)
                throw new Error("There is no previous result to use.")
            candidate.files[file.path] = (await treeEntries(repo, subject.suggestion)).get(file.path) ?? null
        } else {
            candidate.files[file.path] = request.side == "delete" ? null : file[request.side]
        }
    } else if (request.action == "edit") {
        let entry = candidate.files[file.path] ?? file.provisional ?? file.left ?? file.right
        if (!entry || !["100644", "100755"].includes(entry.mode) || !isText(Buffer.from(request.content)))
            throw new Error("Use a named side or an external tool for binary and structural conflicts.")
        candidate.files[file.path] = {
            mode: entry.mode,
            object: await gitText(repo, ["hash-object", "-w", "--stdin"], request.content),
        }
    } else if (request.action == "use-file") {
        await requireWorktree(repo, request.path)
        let absolute = resolve(request.path, file.path)
        let parent = await realpath(dirname(absolute))
        let root = await realpath(request.path)
        if (isAbsolute(relative(root, parent)) || relative(root, parent).startsWith(".."))
            throw new Error("Resolution files must stay inside the worktree.")
        let stat = await lstat(absolute)
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
// Reads authoritative conflict state and prepares CAS-guarded ref updates for one mutation.
export async function openConflictSession(repo: RepositoryGit, changes: Changes): Promise<ConflictSession> {
    let state = await readConflictState(repo)
    for (let step of state.stacks.flatMap(s => s.steps)) {
        if (step.conflict && !state.retainedConflicts.some(c => c.commit == step.current))
            state.retainedConflicts.push({ commit: step.current, source: step.source, conflict: step.conflict })
    }

    let before = await repo.resolveRef(conflictStateRef)

    let observedRefs = new Map<string, string | null>()
    for (let ref of await repo.listRefs("refs/heads/"))
        observedRefs.set(ref, await repo.resolveRef(ref))

    let updateRefs = async (updates: Parameters<RepositoryGit["updateRefs"]>[0]) => {
        for (let update of updates) {
            let expected = changes.has(update.ref) ? changes.get(update.ref) : observedRefs.get(update.ref) ?? null
            if (expected !== update.before)
                throw new Error("A branch changed during replay. Refresh the stack before accepting.")
        }
        await repo.updateRefs(updates)
        for (let update of updates)
            changes.set(update.ref, update.after)
    }

    let persist = async () => {
        changes.set(conflictStateRef, await storeConflictState(repo, state, before))
    }

    return { state, before, updateRefs, persist }
}
export async function rewriteStack(repo: RepositoryGit, session: ConflictSession, plan: StackRewritePlan, changes: Changes, cancelled: () => boolean) {
    let { state, updateRefs } = session
    let refs = plan.refs.map(branchRef)
    if (new Set(refs).size != refs.length)
        throw new Error("Choose each affected branch once, in stack order.")
    if (plan.sources && plan.sources.length != refs.length)
        throw new Error("Provide replay sources for every affected branch.")
    for (let ref of refs) {
        await gitText(repo, ["check-ref-format", ref])
        if (ref.startsWith(temporaryBranchPrefix))
            throw new Error("Choose the intended branch, not its temporary representation.")
    }

    await gitText(repo, ["cat-file", "-e", `${plan.base}^{commit}`])
    let stack = state.stacks.find(s => s.branches.at(-1)!.ref == refs.at(-1))
    if (stack) {
        if (JSON.stringify(stack.branches.map(b => b.ref)) != JSON.stringify(refs))
            throw new Error("Update all branches belonging to this Unresolved Stack together.")
        await followTemporaryBranch(repo, stack)
        stack.base = plan.base
        if (plan.sources) {
            for (let [index, branch] of stack.branches.entries()) {
                let incoming = plan.sources[index]!.map(source => ({ id: crypto.randomUUID(), source, current: source }))
                if (!incoming.length)
                    continue
                let previous = index == 0 ? "base" : stack.branches[index - 1]!.step
                let position = previous == "base" ? 0 : stack.steps.findIndex(step => step.id == previous) + 1
                stack.steps.splice(position, 0, ...incoming)
                if (branch.step == previous)
                    branch.step = incoming.at(-1)!.id
            }
        }
    } else {
        if (state.stacks.some(s => s.branches.some(b => refs.includes(b.ref))))
            throw new Error("These branches already belong to an Unresolved Stack. Update that stack first.")
        let branchTips = await Promise.all(refs.map(ref => repo.resolveRef(ref)))
        if (branchTips.some(tip => !tip))
            throw new Error("An affected branch no longer exists.")
        let upstreamBoundary = state.stacks.flatMap(s => s.branches).find(b => b.current == plan.base || b.before == plan.base)
        let steps: UnresolvedStack["steps"]
        let branches: UnresolvedStack["branches"]
        if (plan.sources) {
            steps = []
            branches = []
            let boundary = "base"
            for (let [index, ref] of refs.entries()) {
                let added = plan.sources[index]!.map(source => ({
                    id: crypto.randomUUID(),
                    source: state.retainedConflicts.find(c => c.commit == source)?.source ?? source,
                    current: source,
                }))
                steps.push(...added)
                boundary = added.at(-1)?.id ?? boundary
                branches.push({ ref, before: branchTips[index]!, current: branchTips[index]!, step: boundary })
            }
        } else {
            let fork = upstreamBoundary?.before ?? await gitText(repo, ["merge-base", branchTips[0]!, plan.base])
            let sources = await linearCommits(repo, fork, branchTips.at(-1)!)
            steps = sources.map(source => ({
                id: crypto.randomUUID(),
                source: state.retainedConflicts.find(c => c.commit == source)?.source ?? source,
                current: source,
            }))
            branches = refs.map((ref, i) => {
                let step = steps.find(s => s.current == branchTips[i])
                if (!step && branchTips[i] != fork)
                    throw new Error("Each affected branch must be a boundary in the replayed linear stack.")
                return { ref, before: branchTips[i]!, current: branchTips[i]!, step: step?.id ?? "base" }
            })
        }
        let stackId = crypto.randomUUID()
        stack = { id: stackId, temporaryRef: `${temporaryBranchPrefix}${refs.at(-1)!.slice(11)}/${stackId}`, base: plan.base, branches, steps }
        state.stacks.push(stack)
    }
    for (let upstream of state.stacks.filter(s => s.id != stack!.id)) {
        let boundary = upstream.branches.find(b => b.current == plan.base || b.before == plan.base)
        if (boundary) {
            stack.dependency = { stackId: upstream.id, branch: boundary.ref }
            stack.base = boundary.current
        }
    }
    if (plan.path) {
        let holder = await requireWorktree(repo, plan.path)
        if (holder.branchRef != refs.at(-1) && holder.branchRef != stack.temporaryRef)
            throw new Error("The destination must hold the intended tip branch or its temporary branch.")
    }
    await rebaseStack(repo, stack, cancelled)
    if (cancelled())
        throw new Error("Stack rewrite cancelled before changing refs or files.")
    await publishProvisional(repo, state, stack, updateRefs, changes, plan.path)
    return stack
}
async function carryNewBranchCommits(repo: RepositoryGit, stack: UnresolvedStack) {
    let changed = false

    for (let branch of stack.branches) {
        let actual = await repo.resolveRef(branch.ref)
        if (actual == branch.before)
            continue
        if (!actual || (await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", branch.before, actual])).exitCode)
            throw new Error("An intended branch was replaced externally. Review its new history before final acceptance.")
        let sources = await linearCommits(repo, branch.before, actual)
        let position = stack.steps.findIndex(step => step.id == branch.step) + 1
        let added = sources.map(source => ({ id: crypto.randomUUID(), source, current: source }))
        stack.steps.splice(position, 0, ...added)
        branch.step = added.at(-1)?.id ?? branch.step
        branch.before = actual
        changed = true
    }

    if (changed)
        await rebaseStack(repo, stack, () => false)
}
function dependsOn(state: ConflictState, stack: UnresolvedStack, id: string): boolean {
    let seen = new Set<string>()
    while (stack.dependency) {
        if (stack.dependency.stackId == id)
            return true
        if (seen.has(stack.id))
            throw new Error("Conflict dependencies contain a cycle.")
        seen.add(stack.id)
        let parent = state.stacks.find(s => s.id == stack.dependency!.stackId)
        if (!parent)
            return false
        stack = parent
    }
    return false
}
async function rebaseDependents(repo: RepositoryGit, state: ConflictState, upstream: UnresolvedStack, cancelled: () => boolean) {
    for (let stack of state.stacks.filter(s => s.dependency?.stackId == upstream.id)) {
        await followTemporaryBranch(repo, stack)
        stack.base = upstream.branches.find(b => b.ref == stack.dependency!.branch)!.current
        await rebaseStack(repo, stack, cancelled)
        await rebaseDependents(repo, state, stack, cancelled)
    }
}
async function followTemporaryBranch(repo: RepositoryGit, stack: UnresolvedStack) {
    let actual = await repo.resolveRef(stack.temporaryRef)
    if (!actual)
        throw new Error("The temporary branch is missing. Restore it before continuing.")
    let retained = stack.steps.at(-1)?.current ?? stack.base
    if (actual == retained)
        return
    if (!(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", retained, actual])).exitCode) {
        for (let source of await linearCommits(repo, retained, actual))
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
        for (let source of await linearCommits(repo, stack.steps[index].current, actual))
            stack.steps.push({ id: crypto.randomUUID(), source, current: source })
    }
    stack.branches.at(-1)!.step = stack.steps.at(-1)!.id
    stack.branches.at(-1)!.current = actual
}

async function linearCommits(repo: RepositoryGit, base: string, tip: string) {
    let lines = (await gitText(repo, ["rev-list", "--reverse", "--topo-order", "--parents", `${base}..${tip}`])).split("\n").filter(Boolean)
    if (lines.some(line => line.split(" ").length != 2))
        throw new Error("This rewrite requires a linear commit range.")
    return lines.map(line => line.split(" ")[0])
}
async function rebaseStack(repo: RepositoryGit, stack: UnresolvedStack, cancelled: () => boolean) {
    let parent = stack.base
    for (let step of stack.steps) {
        if (cancelled())
            throw new Error("Stack replay cancelled.")
        let previous = step.conflict
        let merged = await replayTree(repo, await commitParent(repo, step.source), parent, step.source, step.id, {
            left: `Before this commit at ${parent.slice(0, 8)}`,
            right: `This commit ${step.source.slice(0, 8)}`,
        })
        // Composition may retain conflict markers while changing unrelated lines.
        // Those regions remain explicit conflicts even when their replay is clean.
        if (!merged.conflict && previous) {
            let entries = await treeEntries(repo, merged.tree)
            let stillPresent = await Promise.all(previous.files.map(async file => {
                let content = await blob(repo, entries.get(file.path) ?? null)
                return !file.text || Boolean(content && hasConflictMarkers(content.toString(), previous))
            }))
            if (stillPresent.some(Boolean))
                merged.conflict = { ...previous, tree: merged.tree }
        }
        if (merged.conflict && previous?.input == merged.conflict.input) {
            merged.tree = await replaceTreeFiles(repo, merged.tree, Object.fromEntries(previous.files.map(file => [file.path, file.provisional])))
            merged.conflict = { ...previous, tree: merged.tree }
        }
        let tree = merged.tree
        if (merged.conflict && step.accepted?.input == merged.conflict.input) {
            let accepted = await treeEntries(repo, step.accepted.tree)
            tree = await replaceTreeFiles(repo, tree, Object.fromEntries(merged.conflict.files.map(f => [f.path, accepted.get(f.path) ?? null])))
            step.conflict = undefined
        } else {
            step.conflict = merged.conflict
            if (step.conflict) {
                if (step.accepted)
                    step.conflict.suggestion = step.accepted.tree
                else if (previous && previous.input != step.conflict.input) {
                    let old = await readCandidate(repo, previous)
                    step.conflict.suggestion = await replaceTreeFiles(repo, previous.tree, old.files)
                } else if (previous?.suggestion) {
                    step.conflict.suggestion = previous.suggestion
                }
            }
        }
        let currentTree = await gitText(repo, ["rev-parse", `${step.current}^{tree}`])
        let currentParent = await commitParent(repo, step.current)
        step.current = currentTree == tree && currentParent == parent ? step.current : await rewriteCommit(repo, step.source, parent, tree)
        parent = step.current
    }

    for (let branch of stack.branches) {
        if (branch.step == "base")
            branch.current = stack.base
        else {
            let step = stack.steps.find(step => step.id == branch.step)
            if (!step)
                throw new Error("External history removed an intermediate branch boundary. Review the branch mapping before continuing.")
            branch.current = step.current
        }
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
    let upstream = stack.dependency && state.stacks.find(s => s.id == stack.dependency!.stackId)
    let unresolved = stack.steps.some(s => s.conflict) || Boolean(upstream)
    let worktrees = await readRegisteredWorktrees(repo)
    let holders = worktrees.filter(w => w.branchRef == stack.temporaryRef || w.path == path || stack.branches.some(b => b.ref == w.branchRef))
    for (let holder of holders) {
        if (holder.missing)
            throw new Error("An affected worktree is unavailable.")
        await requireWorktree(repo, holder.path)
    }

    let tip = stack.steps.at(-1)?.current ?? stack.base

    let working = new Map<string, { tree: string; conflict?: ConflictSubject; index: string; oldHead: string; stash?: string }>()
    let duplicateHolders = holders.filter(w => w.branchRef == stack.branches.at(-1)!.ref && holders.some(other => other.branchRef == stack.temporaryRef))
    for (let holder of holders) {
        if (duplicateHolders.includes(holder))
            continue
        let boundary = stack.branches.find(b => b.ref == holder.branchRef)
        if (unresolved && boundary && boundary != stack.branches.at(-1))
            continue
        let target = unresolved ? tip : (boundary?.current ?? tip)
        let oldHead = await gitHead(repo, holder.path)
        let dirty = Boolean((await repo.command(holder.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length)
        let current = dirty ? await workingTree(repo, holder.path) : await gitText(repo, ["rev-parse", `${oldHead}^{tree}`])
        let merged = dirty
            ? await replayTree(repo, oldHead, target, current, crypto.randomUUID())
            : { tree: await gitText(repo, ["rev-parse", `${target}^{tree}`]) }
        let index = (await repo.command(holder.path, ["write-tree"])).toString().trim()
        let staged = dirty ? await replayTree(repo, oldHead, target, index, crypto.randomUUID()) : merged
        if (await gitHead(repo, holder.path) != oldHead || await workingTree(repo, holder.path) != current)
            throw new Error("Working Changes moved while preparing resolution. Refresh and retry.")
        working.set(holder.path, { ...merged, oldHead, index: staged.conflict ? await gitText(repo, ["rev-parse", `${target}^{tree}`]) : staged.tree })
    }

    for (let holder of duplicateHolders)
        await repo.command(holder.path, ["checkout", "--detach", holder.head])
    for (let [path, carry] of working) {
        if (carry.conflict) {
            await repo.command(path, ["stash", "push", "--include-untracked", "-m", "Working Changes during conflict resolution"])
            carry.stash = (await repo.resolveRef("refs/stash"))!
            changes.set("refs/stash", carry.stash)
        }
    }

    if (unresolved) {
        await updateRefs([{ ref: stack.temporaryRef, before: await repo.resolveRef(stack.temporaryRef), after: tip }])
        for (let holder of holders) {
            let branch = stack.branches.find(b => b.ref == holder.branchRef)
            if (branch && branch != stack.branches.at(-1)) {
                // A single branch cannot back two worktrees. Keep intermediate worktrees at their frozen ordinary refs.
                continue
            }
            await checkout(holder, stack.temporaryRef, tip)
        }
    } else {
        await updateRefs(stack.branches.map(b => ({ ref: b.ref, before: b.before, after: b.current })))
        for (let holder of holders) {
            let branch = stack.branches.find(b => b.ref == holder.branchRef) ?? stack.branches.at(-1)!
            await checkout(holder, branch.ref, branch.current)
        }
        let temporary = await repo.resolveRef(stack.temporaryRef)
        if (temporary)
            await updateRefs([{ ref: stack.temporaryRef, before: temporary, after: null }])
        state.stacks = state.stacks.filter(s => s.id != stack.id)
        for (let child of state.stacks.filter(s => s.dependency?.stackId == stack.id))
            child.dependency = undefined
    }

    async function checkout(holder: typeof holders[number], ref: string, target: string) {
        if (duplicateHolders.includes(holder))
            return
        let carry = working.get(holder.path)!
        await repo.command(holder.path, ["read-tree", "--reset", "-u", carry.tree])
        await repo.command(holder.path, ["read-tree", carry.index])
        await repo.command(holder.path, ["symbolic-ref", "HEAD", ref])
        if (carry.conflict && carry.stash)
            state.working.push({ id: carry.conflict.id, path: holder.path, branch: ref, head: target, stash: carry.stash, conflict: carry.conflict })
    }
}
async function requireWorktree(repo: RepositoryGit, path: string, clean = false) {
    let worktree = (await readRegisteredWorktrees(repo)).find(w => normalize(w.path) == normalize(path) && !w.missing)
    if (!worktree)
        throw new Error("Choose a registered, available worktree.")
    if (clean && (await repo.command(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length)
        throw new Error("Commit or stash Working Changes before replacing this worktree's tree.")
    return worktree
}

/**
 * Merges a stash into the worktree's current files, deferring any conflict as a Working Changes Conflict, and returns
 * whether it did. A clean merge is written only with `allowClean`, arriving unstaged; the caller then consumes the stash.
 */
export async function applyStashConflict(repo: RepositoryGit, path: string, stash: string, changes: Changes, allowClean = false) {
    let state = await readConflictState(repo)
    if (state.working.some(w => normalize(w.path) == normalize(path) && !w.suspended))
        throw new Error("This worktree already has a Working Changes Conflict.")

    let before = await repo.resolveRef(conflictStateRef)
    let head = await gitHead(repo, path)
    let index = (await repo.command(path, ["write-tree"])).toString().trim()
    // Returning from Historical Edit restores its changes over the original ones, which Keep stashed must leave in place.
    let current = await workingTree(repo, path)
    let dirty = current != index || index != await gitText(repo, ["rev-parse", `${head}^{tree}`])
    let stashTree = await gitText(repo, ["rev-parse", `${stash}^{tree}`])
    // Include the stash's untracked parent in the same merge so collisions are deferred too.
    let untracked = await repo.run(path, ["rev-parse", "--verify", `${stash}^3`])
    if (!untracked.exitCode) {
        let extras = await treeEntries(repo, untracked.stdout.toString().trim())
        stashTree = await replaceTreeFiles(repo, stashTree, Object.fromEntries(extras))
    }

    let merged = await replayTree(repo, await commitParent(repo, stash), current, stashTree, crypto.randomUUID(), {
        left: `Current files before restoring stash at ${head.slice(0, 8)}`,
        right: `Stashed changes ${stash.slice(0, 8)}`,
    })
    if (!merged.conflict && !allowClean)
        throw new Error("The stash failed for a reason other than a content conflict. Its original state is preserved.")

    if (merged.conflict) {
        let branch = (await repo.run(path, ["symbolic-ref", "--quiet", "HEAD"])).stdout.toString().trim() || null
        let retained = dirty ? { beforeTree: current, beforeIndex: index, afterIndex: index } : {}
        state.working.push({ id: merged.conflict.id, path, branch, head, stash, conflict: merged.conflict, ...retained })
    }
    // Tracking the current untracked files first lets the checkout replace them where the stash changes them.
    await repo.command(path, ["read-tree", current])
    await repo.command(path, ["read-tree", "--reset", "-u", merged.tree])
    await repo.command(path, ["read-tree", index])
    if (merged.conflict)
        changes.set(conflictStateRef, await storeConflictState(repo, state, before))
    return Boolean(merged.conflict)
}
export async function gitHead(repo: RepositoryGit, path: string) {
    return (await repo.command(path, ["rev-parse", "HEAD"])).toString().trim()
}
async function workingTree(repo: RepositoryGit, path: string) {
    return withConflictScratch(async scratch => {
        let env = { GIT_INDEX_FILE: join(scratch, "index") }
        await repo.command(path, ["read-tree", "HEAD"], undefined, env)
        await repo.command(path, ["add", "-A"], undefined, env)
        return (await repo.command(path, ["write-tree"], undefined, env)).toString().trim()
    })
}
export async function dropStash(repo: RepositoryGit, oid: string, changes: Changes) {
    let list = (await gitText(repo, ["stash", "list", "--format=%H"])).split("\n")
    let index = list.indexOf(oid)
    if (index < 0)
        throw new Error("The retained stash was removed externally. Restore it before accepting.")
    await gitText(repo, ["stash", "drop", `stash@{${index}}`])
    changes.set("refs/stash", await repo.resolveRef("refs/stash"))
}

export async function suspendWorkingConflicts(repo: RepositoryGit, changes: Changes) {
    let state = await readConflictState(repo).catch(() => undefined)
    if (!state)
        return

    let before = await repo.resolveRef(conflictStateRef)

    let changed = false
    for (let working of state.working.filter(w => !w.suspended)) {
        let ref = (await repo.run(working.path, ["symbolic-ref", "--quiet", "HEAD"])).stdout.toString().trim() || null
        if (ref == working.branch)
            continue
        let stash = await repo.resolveRef("refs/stash")
        if (stash) {
            working.suspended = stash
            changed = true
        }
    }

    if (changed)
        changes.set(conflictStateRef, await storeConflictState(repo, state, before))
}

function commitParent(repo: RepositoryGit, commit: string) {
    return gitText(repo, ["rev-parse", `${commit}^`])
}

function branchRef(name: string) {
    return name.startsWith("refs/heads/") ? name : `refs/heads/${name}`
}
