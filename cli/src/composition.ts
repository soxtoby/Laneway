import { blob, conflictHunks, conflictStateRef, gitText, normalize, pathExists, readConflictState, readRegisteredWorktrees, replaceTreeFiles, replayTree, type RepositoryGit, retainedDocument, storeConflictState, temporaryBranchPrefix, treeEntries } from "@git-workbench/git"
import type { CompositionPreview, CompositionRequest, ConflictState, ConflictSubject, LocalPreview, LocalResult, ReplayStep, ResolutionCandidate, UnresolvedStack } from "@git-workbench/shared"
import { CompositionRequestSchema } from "@git-workbench/shared"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { compositionCommit } from "./composition-commits"
import { selectionTrees, workingTree } from "./composition-source"
import { captureWorktreeState, stateIdentity, type WorktreeState, worktreeStateMatches } from "./worktree-state"

type TreeChange = Awaited<ReturnType<typeof replayTree>>
interface CommitPlan {
    oid: string
    parent: string
    tree: string
    source?: string
    message?: string
    conflict?: ConflictSubject
}
interface WorkingPlan {
    path: string
    head: string
    ref: string | null
    tree: string
    index: string
    beforeTree: string
    beforeIndex: string
    conflict?: ConflictSubject
    stashBase: string
    stashTree: string
    stashIndex: string
    conflictBaseline: string
    conflictIndex: string
}
interface Plan {
    before: WorktreeState
    commits: CommitPlan[]
    refs: Array<{ ref: string; before: string | null; after: string | null }>
    working: WorkingPlan[]
    state: ConflictState
    candidates: Array<{ ref: string; before: string; candidate: ResolutionCandidate }>
    preview: CompositionPreview
}
const plans = new WeakMap<LocalPreview, Plan>()
const id = (...values: string[]) => createHash("sha256").update(values.join("\0")).digest("hex")
const refName = (name: string) => name.startsWith("refs/heads/") ? name : `refs/heads/${name}`
const readTree = (repo: RepositoryGit, value: string) => gitText(repo, ["rev-parse", `${value}^{tree}`])
const readParents = async (repo: RepositoryGit, value: string) => (await gitText(repo, ["show", "-s", "--format=%P", value])).split(" ").filter(Boolean)
const ancestor = async (repo: RepositoryGit, a: string, b: string) =>
    !(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", a, b])).exitCode
const stableIdentity = { GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z" }

async function draftCommit(repo: RepositoryGit, parent: string, value: string, source?: string, message = "Composed changes") {
    const env: Record<string, string> = { ...stableIdentity }
    if (source) {
        const raw = (await repo.command(repo.descriptor.mainWorktree, ["cat-file", "commit", source])).toString()
        const split = raw.indexOf("\n\n")
        const author = /^author (.*) <([^>]*)> (.+)$/m.exec(raw.slice(0, split))!
        env.GIT_AUTHOR_NAME = author[1]
        env.GIT_AUTHOR_EMAIL = author[2]
        env.GIT_AUTHOR_DATE = author[3]
        message = raw.slice(split + 2)
    }
    return gitText(repo, ["commit-tree", value, "-p", parent], message, env)
}

export async function prepareComposition(repo: RepositoryGit, request: CompositionRequest): Promise<{ before: WorktreeState; preview: LocalPreview }> {
    if (repo.descriptor.shallow || repo.descriptor.partial || repo.descriptor.sparse)
        throw new Error("Composition requires a complete, non-sparse repository.")
    const worktrees = await readRegisteredWorktrees(repo)
    if (
        request.source.kind == "working"
        && !worktrees.some(w => !w.missing && normalize(w.path) == normalize(request.source.kind == "working" ? request.source.worktreePath : ""))
    ) {
        throw new Error("Choose an available Registered Worktree as the source.")
    }
    const affected = worktrees.filter(w => !w.missing).map(w => w.path)
    const before = await captureWorktreeState(repo, affected)
    for (const w of worktrees.filter(w => !w.missing)) {
        for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
            if (await pathExists(join(w.gitDirectory, marker)))
                throw new Error("Finish the existing Git operation before composition.")
        }
        if ((await repo.command(w.path, ["ls-files", "--unmerged", "-z"])).length)
            throw new Error("Resolve the Git index conflicts before composition.")
    }
    const state = await readConflictState(repo)
    const originalState = structuredClone(state)
    const tips = new Map(Object.entries(before.refs).filter(([ref]) => ref.startsWith("refs/heads/") && !ref.startsWith(temporaryBranchPrefix)))
    for (const stack of state.stacks) {
        if (await repo.resolveRef(stack.temporaryRef) != (stack.steps.at(-1)?.current ?? stack.base))
            throw new Error("The unresolved stack moved externally. Refresh its recovery mapping first.")
        for (const b of stack.branches)
            tips.set(b.ref, b.current)
    }
    const parentMap = new Map(
        (tips.size ? await gitText(repo, ["rev-list", "--parents", ...new Set(tips.values())]) : "").split("\n").filter(Boolean).map(line => {
            const [oid, ...ps] = line.split(" ")
            return [oid, ps] as const
        }),
    )
    const parents = async (_repo: RepositoryGit, value: string) => parentMap.get(value) ?? readParents(repo, value)
    const trees = new Map<string, Promise<string>>()
    const tree = (_repo: RepositoryGit, value: string) => {
        if (!trees.has(value))
            trees.set(value, readTree(repo, value))
        return trees.get(value)!
    }
    const graph = await repo.startReadBranchGraph({ authorIdentities: { secondary: [] }, remotePatterns: [], selectedRemote: request.selectedRemote }).result
    const primary = graph.branches.find(b => b.primary)
    const primaryLocal = graph.primaryBranch.ref && graph.primaryBranch.remote
        ? `refs/heads/${graph.primaryBranch.ref.slice(`refs/remotes/${graph.primaryBranch.remote}/`.length)}`
        : undefined
    const primaryTips = [primary?.tip, ...(primaryLocal ? [await repo.resolveRef(primaryLocal)] : [])].filter((x): x is string => !!x)
    const primaryReachable = primaryTips.length ? new Set((await gitText(repo, ["rev-list", ...primaryTips])).split("\n")) : new Set<string>()
    function tip(name: string) {
        const ref = refName(name), value = tips.get(ref)
        if (!value)
            throw new Error("The selected local branch no longer exists.")
        return value
    }
    async function editable(commit: string) {
        if (primaryReachable.has(commit))
            throw new Error("Primary Branch history is protected. Copy these changes instead.")
        if ((await parents(repo, commit)).length != 1)
            throw new Error("Direct editing of root or merge commits is unavailable.")
        if (!parentMap.has(commit))
            throw new Error("Only commits in a local branch can be rewritten.")
    }
    const preview: CompositionPreview = { branches: [], removed: [], conflicts: [], published: [], skipped: [], noop: false }
    const commits: CommitPlan[] = [], candidates: Plan["candidates"] = []
    const oldSubjects = new Map(originalState.stacks.flatMap(s => s.steps.filter(s => s.conflict).map(s => [s.current, s.conflict!] as const)))
    const mutations = new Map<string, TreeChange>(), inserted = new Map<string, string>(), overrides = new Map<string, string>()
    const deleted = new Set<string>(), onlyBranches = new Set<string>()
    const selection = request.source.kind == "branch" ? undefined : await selectionTrees(repo, request)
    let sourceWorking: TreeChange | undefined, destinationWorking: TreeChange | undefined
    const merge = async (base: string, left: string, right: string, label: string): Promise<TreeChange> => {
        const result = await replayTree(repo, base, left, right, id(base, left, right, label), { left: `Before ${label}`, right: `Incoming ${label}` })
        if (result.conflict)
            preview.conflicts.push({ subject: label, files: result.conflict.files.map(f => f.path) })
        return result
    }
    async function skippedAt(destination: string, result: TreeChange) {
        if (request.mode != "copy" || !selection)
            return
        const counts = async (a: string, b: string) =>
            new Map(
                (await gitText(repo, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", a, b])).split("\0").filter(Boolean).map(
                    record => {
                        const [added, removed, ...path] = record.split("\t")
                        return [path.join("\t"), [Number(added), Number(removed)]] as const
                    },
                ),
            )
        const requested = await counts(selection.base, selection.selected), applied = await counts(destination, result.tree)
        for (const path of selection.paths) {
            if (!requested.has(path) || result.conflict?.files.some(f => f.path == path))
                continue
            const change = applied.get(path), original = requested.get(path)!
            if (!change)
                preview.skipped.push(path)
            else if (change.some((count, i) => count < original[i]))
                preview.skipped.push(`${path} (partly already present)`)
        }
    }
    async function protect(subject: ConflictSubject | undefined, oldTree: string, newTree: string) {
        if (!subject || oldTree == newTree)
            return
        const old = await treeEntries(repo, oldTree), next = await treeEntries(repo, newTree)
        for (const file of subject.files) {
            if (!file.text) {
                const paths = [...new Set([...old.keys(), ...next.keys()])].filter(p =>
                    p == file.path || p.startsWith(file.path + "/") || file.path.startsWith(p + "/")
                )
                if (paths.some(p => JSON.stringify(old.get(p)) != JSON.stringify(next.get(p))))
                    throw new Error(`Resolve the structural or binary conflict in ${file.path} before transferring it.`)
                continue
            }
            const a = (await blob(repo, old.get(file.path) ?? null))?.toString() ?? ""
            const b = (await blob(repo, next.get(file.path) ?? null))?.toString() ?? ""
            const regions = (text: string) => conflictHunks(text, subject).map(h => text.slice(h.start, h.end))
            if (JSON.stringify(regions(a)) != JSON.stringify(regions(b)) || old.get(file.path)?.mode != next.get(file.path)?.mode)
                throw new Error(`The transfer overlaps existing conflicted lines in ${file.path}. Resolve those lines first.`)
        }
    }
    async function preserveConflict(existing: ConflictSubject | undefined, oldTree: string, result: TreeChange) {
        if (!existing)
            return result
        await protect(existing, oldTree, result.tree)
        const incoming = result.conflict
        const files = new Map(existing.files.map(f => [f.path, { ...f }]))
        const replacements: Parameters<typeof replaceTreeFiles>[2] = {}
        if (incoming) {
            const entries = await treeEntries(repo, result.tree)
            for (const file of incoming.files) {
                files.set(file.path, { ...file })
                const entry = entries.get(file.path)
                if (file.text && entry) {
                    let content = (await blob(repo, entry))!.toString()
                    content = content.replaceAll(
                        `${"<".repeat(incoming.markerSize)} ${incoming.leftLabel}`,
                        `${"<".repeat(existing.markerSize)} ${existing.leftLabel}`,
                    )
                        .replaceAll(`${">".repeat(incoming.markerSize)} ${incoming.rightLabel}`, `${">".repeat(existing.markerSize)} ${existing.rightLabel}`)
                        .replaceAll("=".repeat(incoming.markerSize) + "\n", "=".repeat(existing.markerSize) + "\n")
                    replacements[file.path] = { ...entry, object: await gitText(repo, ["hash-object", "-w", "--stdin"], content) }
                }
            }
            result.tree = await replaceTreeFiles(repo, result.tree, replacements)
        }
        const entries = await treeEntries(repo, result.tree)
        for (const file of files.values())
            file.provisional = entries.get(file.path) ?? null
        const conflict = { ...existing, tree: result.tree, files: [...files.values()], input: incoming ? id(existing.input, incoming.input) : existing.input }
        await carryCandidate(existing, oldTree, result.tree, conflict)
        return { tree: result.tree, conflict }
    }
    if (request.source.kind == "branch") {
        if (request.target.kind != "branch" || request.mode != "move")
            throw new Error("Rebase a branch by moving it onto another local branch.")
        const source = tip(request.source.branch), destination = tip(request.target.branch)
        if (source != request.source.tip || destination != request.target.tip)
            throw new Error("A branch moved. Review the drop target again.")
        if (await ancestor(repo, source, destination))
            throw new Error("A branch cannot be rebased onto itself or its descendant.")
        const node = graph.branches.find(b => b.localRefs.includes(refName(request.source.kind == "branch" ? request.source.branch : "")))
        if (!node || node.base.status != "known")
            throw new Error("Choose an unambiguous Base Branch before rebasing.")
        const range = (await gitText(repo, ["rev-list", "--reverse", "--first-parent", source, "--not", node.base.tip])).split("\n").filter(Boolean)
        if (!range.length)
            throw new Error("The branch has no unique commits to rebase.")
        for (const commit of range)
            await editable(commit)
        overrides.set(range[0], destination)
        if (!request.descendants)
            onlyBranches.add(refName(request.source.branch))
    } else {
        const sourceSubject = request.source.kind == "commit"
            ? oldSubjects.get(request.source.objectId)
            : state.working.find(w => normalize(w.path) == normalize(request.source.kind == "working" ? request.source.worktreePath : ""))?.conflict
        if (sourceSubject && selection) {
            const remainder = await replayTree(repo, selection.selected, selection.after, selection.base, id("protect-source", selection.selected))
            await protect(sourceSubject, await tree(repo, selection.after), remainder.tree)
        }
        if (request.target.kind == "branch" && (request.source.kind != "commit" || request.files))
            throw new Error("Branch rows accept whole commits, not file selections.")
        const target = request.target
        if (target.kind != "working") {
            const destination = tip(target.branch)
            if (target.kind == "branch" && destination != target.tip)
                throw new Error("The destination branch moved.")
            const at = target.kind == "commit" ? target.objectId : target.kind == "seam" ? target.parentId : destination
            if (!await ancestor(repo, at, destination))
                throw new Error("The target is not in the selected branch.")
            if (target.kind == "commit")
                await editable(at)
            if (request.source.kind == "commit" && request.source.objectId == at && target.kind == "commit")
                throw new Error("Choose a different destination commit.")
            if (target.kind == "seam" && !request.message.trim())
                throw new Error("Enter a commit message before transferring changes.")
            if (primaryReachable.has(at) && at != destination && target.kind != "commit") {
                const node = graph.branches.find(b => b.localRefs.includes(refName(target.branch)))
                if (refName(target.branch) == primaryLocal || node?.base.status != "known" || node.base.tip != at)
                    throw new Error("Choose an insertion seam inside the editable branch, or atop Primary Branch.")
            }
            const result = await merge(selection!.base, at, selection!.selected, "transferred changes")
            await skippedAt(at, result)
            if (result.tree == await tree(repo, at) && request.mode == "copy") {
                preview.noop = true
                preview.skipped.push(...selection!.paths)
            } else if (target.kind == "commit") {
                await protect(oldSubjects.get(at), await tree(repo, at), result.tree)
                mutations.set(at, result)
            } else {
                const source = request.source.kind == "commit" && !request.files ? request.source.objectId : undefined
                const oid = await draftCommit(repo, at, result.tree, source, request.message)
                commits.push({ oid, parent: at, tree: result.tree, source, message: request.message, conflict: result.conflict })
                inserted.set(at, oid)
            }
        } else {
            const holder = worktrees.find(w => !w.missing && normalize(w.path) == normalize(target.worktreePath))
            if (!holder)
                throw new Error("Choose an available Registered Worktree.")
            if (request.source.kind == "working" && normalize(request.source.worktreePath) == normalize(holder.path))
                throw new Error("Choose another destination.")
            const current = await workingTree(repo, holder.path)
            destinationWorking = await merge(selection!.base, current, selection!.selected, "Working Changes transfer")
            await skippedAt(current, destinationWorking)
            await protect(state.working.find(w => normalize(w.path) == normalize(holder.path))?.conflict, current, destinationWorking.tree)
            if (current == destinationWorking.tree && request.mode == "copy") {
                preview.noop = true
                preview.skipped.push(...selection!.paths)
            }
        }
        if (!preview.noop && request.mode == "move") {
            if (request.source.kind == "commit") {
                const source = request.source.objectId
                await editable(source)
                const result = await merge(selection!.selected, source, selection!.base, "source remainder")
                await protect(oldSubjects.get(source), await tree(repo, source), result.tree)
                mutations.set(source, result)
                if (!request.files)
                    deleted.add(source)
            } else {
                sourceWorking = await merge(selection!.selected, selection!.after, selection!.base, "Working Changes remainder")
                await protect(
                    state.working.find(w => normalize(w.path) == normalize(request.source.kind == "working" ? request.source.worktreePath : ""))?.conflict,
                    await tree(repo, selection!.after),
                    sourceWorking.tree,
                )
            }
        }
    }
    const mapped = new Map<string, string>(),
        stepByCommit = new Map<string, ReplayStep>(originalState.stacks.flatMap(s => s.steps.map(step => [step.current, step] as const)))
    const descendants = new Map<string, string[]>()
    for (const [oid, ps] of parentMap) {
        for (const parent of ps)
            descendants.set(parent, [...(descendants.get(parent) ?? []), oid])
    }
    const affectedCommits = new Set([...mutations.keys(), ...overrides.keys(), ...inserted.keys()])
    for (const oid of affectedCommits) {
        for (const child of descendants.get(oid) ?? [])
            affectedCommits.add(child)
    }
    const visiting = new Set<string>()
    async function rewrite(old: string, includeInsert: boolean): Promise<string> {
        if (!affectedCommits.has(old))
            return old
        const key = `${old}:${includeInsert}`
        if (mapped.has(key))
            return mapped.get(key)!
        if (visiting.has(key))
            throw new Error("The transfer would create a history cycle.")
        visiting.add(key)
        const ps = await parents(repo, old)
        let parent = overrides.get(old) ?? (ps[0] ? await rewrite(ps[0], includeInsert) : undefined)
        if (ps.slice(1).some(p => affectedCommits.has(p) && (includeInsert || !inserted.size)))
            throw new Error("Composition cannot restack merge commits. Copy to a linear destination instead.")
        if (includeInsert && parent && inserted.has(ps[0]) && request.target.kind != "working") {
            const added = commits.find(c => c.oid == inserted.get(ps[0]))!
            parent = await insert(added, parent)
        }
        let current = old
        const changed = mutations.get(old)
        if (changed || overrides.has(old) || parent != ps[0]) {
            await editable(old)
            if (!parent)
                throw new Error("A rewritten commit requires a parent.")
            if (deleted.has(old)) {
                current = parent
                preview.removed.push(old)
            } else {
                const sourceTree = changed?.tree ?? await tree(repo, old)
                let result = parent == ps[0]
                    ? { tree: sourceTree, conflict: changed?.conflict }
                    : await merge(ps[0], parent, sourceTree, `commit ${old.slice(0, 8)}`)
                if (parent != ps[0] && request.target.kind == "commit" && request.target.objectId == old) {
                    const replayed = await merge(ps[0], parent, old, `commit ${old.slice(0, 8)}`)
                    result = await merge(selection!.base, replayed.tree, selection!.selected, "transferred changes")
                }
                const existing = oldSubjects.get(old)
                await protect(existing, await tree(repo, old), result.tree)
                if (result.tree == await tree(repo, parent) && !existing && !result.conflict) {
                    current = parent
                    preview.removed.push(old)
                } else {
                    const retained = await preserveConflict(existing, await tree(repo, old), {
                        tree: result.tree,
                        conflict: result.conflict ?? changed?.conflict,
                    })
                    const conflict = retained.conflict
                    result.tree = retained.tree
                    const source = changed || existing ? await draftCommit(repo, ps[0], sourceTree, old) : old
                    current = await draftCommit(repo, parent, result.tree, old)
                    commits.push({ oid: current, parent, tree: result.tree, source: old, conflict })
                    stepByCommit.set(current, { id: conflict?.id ?? id(old), source, current, conflict })
                }
            }
        } else {
            const existing = oldSubjects.get(old)
            if (existing)
                stepByCommit.set(old, originalState.stacks.flatMap(s => s.steps).find(s => s.current == old)!)
        }
        mapped.set(key, current)
        visiting.delete(key)
        return current
    }
    const insertedResults = new Map<string, string>()
    async function insert(added: CommitPlan, parent: string) {
        const cached = insertedResults.get(added.oid)
        if (cached)
            return cached
        const result = parent == added.parent
            ? { tree: added.tree, conflict: added.conflict }
            : await merge(selection!.base, parent, selection!.selected, "inserted commit")
        if (result.tree == await tree(repo, parent) && !result.conflict) {
            insertedResults.set(added.oid, parent)
            return parent
        }
        const current = await draftCommit(repo, parent, result.tree, added.source, added.message)
        commits.push({ ...added, oid: current, parent, tree: result.tree, conflict: result.conflict })
        stepByCommit.set(current, { id: result.conflict?.id ?? id(added.oid), source: current, current, conflict: result.conflict })
        insertedResults.set(added.oid, current)
        return current
    }
    async function carryCandidate(subject: ConflictSubject, old: string, next: string, updated = subject) {
        const ref = `refs/workbench/conflict-candidates/${subject.id}/${subject.input}`, before = await repo.resolveRef(ref)
        if (!before || old == next)
            return
        const candidate: ResolutionCandidate = JSON.parse((await repo.command(repo.descriptor.mainWorktree, ["show", `${before}:state.json`])).toString())
        const oldCandidate = await replaceTreeFiles(repo, old, candidate.files)
        const carried = await replayTree(repo, old, next, oldCandidate, id(subject.id, next))
        if (carried.conflict)
            throw new Error("This transfer overlaps saved conflict resolution progress.")
        const files = await treeEntries(repo, carried.tree)
        for (const path of Object.keys(candidate.files))
            candidate.files[path] = files.get(path) ?? null
        const nextRef = `refs/workbench/conflict-candidates/${updated.id}/${updated.input}`
        candidate.input = updated.input
        candidates.push({ ref: nextRef, before: nextRef == ref ? before : await repo.resolveRef(nextRef) ?? "", candidate })
    }
    const newTips = new Map(tips)
    function inheritsTarget(ref: string) {
        if (request.target.kind == "working")
            return false
        const target = refName(request.target.branch)
        if (ref == target)
            return true
        let node = graph.branches.find(b => b.localRefs.includes(ref))
        const seen = new Set<string>()
        while (node?.base.status == "known" && !seen.has(node.id)) {
            seen.add(node.id)
            const parentId = node.base.branchId
            node = graph.branches.find(b => b.id == parentId)
            if (node && (node.primary ? target == primaryLocal : node.preferredRef == target))
                return true
        }
        return false
    }
    if (!preview.noop) {
        for (const [ref, old] of tips) {
            if (onlyBranches.size && !onlyBranches.has(ref))
                continue
            let current = await rewrite(old, inheritsTarget(ref))
            if (inserted.has(old)) {
                const owns = request.target.kind != "working" && ref == refName(request.target.branch)
                if (owns)
                    current = await insert(commits.find(c => c.oid == inserted.get(old))!, current)
            }
            newTips.set(ref, current)
        }
    }
    const changedBranches = [...newTips.keys()].filter(ref => tips.get(ref) != newTips.get(ref))
    // A shared unresolved stack is rebuilt as branch-sized boundaries. Retain
    // unchanged boundaries too, plus their dependent metadata, not just moved tips.
    const rebuilding = new Set<string>()
    for (let changed = true; changed;) {
        changed = false
        for (const stack of state.stacks) {
            if (
                !rebuilding.has(stack.id)
                && (stack.branches.some(b => changedBranches.includes(b.ref)) || stack.dependency && rebuilding.has(stack.dependency.stackId))
            ) {
                rebuilding.add(stack.id)
                changed = true
                for (const branch of stack.branches) {
                    if (!changedBranches.includes(branch.ref))
                        changedBranches.push(branch.ref)
                }
            }
        }
    }
    preview.removed = [...new Set(preview.removed)]
    preview.skipped = [...new Set(preview.skipped)]
    preview.branches = changedBranches.map(ref => ref.slice(11))
    for (const ref of changedBranches) {
        const upstream = (await repo.run(repo.descriptor.mainWorktree, ["rev-parse", "--symbolic-full-name", `${ref}@{upstream}`])).stdout.toString().trim()
        if (upstream && !(await ancestor(repo, await repo.resolveRef(upstream) ?? tips.get(ref)!, newTips.get(ref)!)))
            preview.published.push(ref.slice(11))
    }
    const refs: Plan["refs"] = [], affectedStacks = state.stacks.filter(s => s.branches.some(b => changedBranches.includes(b.ref)))
    state.stacks = state.stacks.filter(s => !affectedStacks.includes(s))
    const stackByBranch = new Map<string, UnresolvedStack>()
    const resolvedBranches = new Set<string>()
    const commitLookup = new Map(commits.map(c => [c.oid, c]))
    async function branchStack(ref: string): Promise<UnresolvedStack | undefined> {
        if (stackByBranch.has(ref))
            return stackByBranch.get(ref)
        if (resolvedBranches.has(ref))
            return undefined
        const tip = newTips.get(ref)!
        const path: string[] = []
        let cursor = tip, upstream: string | undefined
        for (;;) {
            upstream = cursor == tip ? undefined : changedBranches.find(other => other != ref && newTips.get(other) == cursor)
            if (upstream || !commitLookup.has(cursor) && !oldSubjects.has(cursor))
                break
            path.unshift(cursor)
            cursor = commitLookup.get(cursor)?.parent ?? (await parents(repo, cursor))[0]
        }
        const parentStack = upstream ? await branchStack(upstream) : state.stacks.find(s => s.branches.some(b => b.current == cursor))
        const steps = path.map(current => stepByCommit.get(current) ?? { id: id(current), source: current, current })
        const unresolved = steps.some(s => s.conflict) || parentStack
        if (!unresolved) {
            refs.push({ ref, before: before.refs[ref], after: tip })
            resolvedBranches.add(ref)
            return undefined
        }
        const stackId = id(ref, tip),
            stack: UnresolvedStack = {
                id: stackId,
                temporaryRef: `${temporaryBranchPrefix}${ref.slice(11)}/${stackId.slice(0, 12)}`,
                base: cursor,
                branches: [{ ref, before: before.refs[ref], current: tip, step: steps.at(-1)?.id ?? "base" }],
                steps,
                ...(parentStack ? { dependency: { stackId: parentStack.id, branch: upstream ?? parentStack.branches.at(-1)!.ref } } : {}),
            }
        stackByBranch.set(ref, stack)
        state.stacks.push(stack)
        refs.push({ ref: stack.temporaryRef, before: before.refs[stack.temporaryRef] ?? null, after: tip })
        return stack
    }
    for (const ref of changedBranches)
        await branchStack(ref)
    for (const s of affectedStacks) {
        if (!state.stacks.some(current => current.temporaryRef == s.temporaryRef))
            refs.push({ ref: s.temporaryRef, before: before.refs[s.temporaryRef], after: null })
    }
    const working: WorkingPlan[] = []
    for (const holder of worktrees) {
        const oldStack = originalState.stacks.find(s => s.temporaryRef == holder.branchRef)
        const ref = oldStack?.branches.at(-1)?.ref ?? holder.branchRef
        const source = request.source.kind == "working" && normalize(holder.path) == normalize(request.source.worktreePath)
        const target = request.target.kind == "working" && normalize(holder.path) == normalize(request.target.worktreePath)
        if (!changedBranches.includes(ref ?? "") && !sourceWorking && !destinationWorking || !changedBranches.includes(ref ?? "") && !source && !target)
            continue
        if (holder.missing)
            throw new Error("An affected worktree is unavailable. Locate it before composition.")
        const head = (await repo.command(holder.path, ["rev-parse", "HEAD"])).toString().trim()
        const current = await workingTree(repo, holder.path), index = (await repo.command(holder.path, ["write-tree"])).toString().trim()
        let files: TreeChange = { tree: current }, staged: TreeChange = { tree: index }
        const stagedSource = source && sourceWorking && request.view == "staged"
        if (source && sourceWorking) {
            if (request.view == "staged")
                staged = sourceWorking
            else {
                files = sourceWorking
                if (request.view == "combined") {
                    if (request.files?.some(f => f.lineIds))
                        staged = await merge(selection!.selected, index, selection!.base, "remaining staged changes")
                    else {
                        const original = await treeEntries(repo, selection!.base)
                        staged = {
                            tree: await replaceTreeFiles(repo, index, Object.fromEntries(selection!.paths.map(path => [path, original.get(path) ?? null]))),
                        }
                    }
                }
            }
        }
        if (target && destinationWorking)
            files = destinationWorking
        const stashBase = target ? selection!.base : head
        const stashTree = target ? selection!.selected : files.tree
        const stashIndex = target ? selection!.base : staged.tree
        const newHead = ref ? newTips.get(ref) ?? head : head
        if (newHead != head) {
            if (!stagedSource)
                files = await merge(head, newHead, files.tree, "worktree restoration")
            staged = await merge(head, newHead, staged.tree, "staged restoration")
        }
        if (stagedSource)
            files = await merge(index, staged.tree, current, "remaining unstaged changes")
        const existing = state.working.find(w => normalize(w.path) == normalize(holder.path) && !w.suspended)
        await protect(existing?.conflict, current, files.tree)
        if (existing) {
            files = await preserveConflict(existing.conflict, current, files)
            if (existing.beforeTree && files.tree != current) {
                const retained = await replayTree(repo, current, existing.beforeTree, files.tree, id(existing.id, "retained-working"))
                if (retained.conflict)
                    throw new Error("This transfer overlaps the saved pre-conflict Working Changes.")
                existing.beforeTree = retained.tree
            }
            existing.head = newHead
            existing.conflict = files.conflict!
            existing.afterIndex = staged.tree
        }
        const conflict = existing ? undefined : files.conflict ?? staged.conflict
        const nextRef = ref ? stackByBranch.get(ref)?.temporaryRef ?? ref : null
        working.push({
            path: holder.path,
            head: newHead,
            ref: nextRef,
            tree: files.tree,
            index: staged.conflict ? await tree(repo, newHead) : staged.tree,
            beforeTree: current,
            beforeIndex: index,
            conflict,
            stashBase,
            stashTree,
            stashIndex,
            conflictBaseline: target ? current : await tree(repo, newHead),
            conflictIndex: target ? index : await tree(repo, newHead),
        })
        const ignored = (await repo.command(holder.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0").filter(
            Boolean,
        )
        const names = [...(await treeEntries(repo, files.tree)).keys()]
        if (ignored.some(p => names.some(n => n == p || n.startsWith(p + "/") || p.startsWith(n + "/"))))
            throw new Error("A transfer would replace an ignored file. Move that file before retrying.")
    }
    if (!await worktreeStateMatches(repo, before))
        throw new Error("Repository content changed while preparing the transfer. Select and review it again.")
    const remoteRefs = await gitText(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/workbench/conflict-candidates"])
    const token = id(stateIdentity(before), remoteRefs, JSON.stringify(CompositionRequestSchema.parse({ ...request, allowConflicts: false })))
    const local: LocalPreview = {
        token,
        affected,
        composition: preview,
        uniqueCommits: false,
        unborn: false,
        suggestedBranch: "",
        staged: false,
        files: [],
        stashes: [],
        worktrees: [],
    }
    plans.set(local, { before, commits, refs, working, state, candidates, preview })
    return { before, preview: local }
}

export async function mutateComposition(
    repo: RepositoryGit,
    request: CompositionRequest,
    preview: LocalPreview,
    changes: Map<string, string | null>,
    cancelled = () => false,
): Promise<LocalResult> {
    const plan = plans.get(preview)
    if (!plan)
        throw new Error("Prepare the transfer before executing it.")
    if (plan.preview.conflicts.length && !request.allowConflicts)
        throw new Error("The transfer would conflict. Choose resolve now or resolve later before continuing.")
    if (plan.preview.noop)
        return { type: "result", command: "local", status: "performed", message: "Already present" }
    if (cancelled())
        throw new Error("Transfer cancelled before changing files or refs.")
    const drafts = new Map(plan.commits.map(c => [c.oid, c])), final = new Map<string, string>()
    async function finalize(value: string): Promise<string> {
        if (final.has(value))
            return final.get(value)!
        const commit = drafts.get(value)
        if (!commit)
            return value
        const parent = await finalize(commit.parent)
        const created = await compositionCommit(repo, parent, commit.tree, commit.source, commit.message, cancelled)
        final.set(value, created)
        return created
    }
    for (const update of plan.refs) {
        if (update.after)
            update.after = await finalize(update.after)
    }
    for (const stack of plan.state.stacks) {
        stack.base = final.get(stack.base) ?? stack.base
        for (const step of stack.steps) {
            if (step.source == step.current)
                step.source = final.get(step.source) ?? step.source
            step.current = final.get(step.current) ?? step.current
        }
        for (const branch of stack.branches)
            branch.current = final.get(branch.current) ?? branch.current
    }
    for (const working of plan.working)
        working.head = final.get(working.head) ?? working.head
    for (const working of plan.state.working)
        working.head = final.get(working.head) ?? working.head
    if (cancelled() || !await worktreeStateMatches(repo, plan.before))
        throw new Error("Repository content changed or the transfer was cancelled during commit preparation. No transfer was applied.")
    // All trees and conflict inputs are prepared before this single ref transaction.
    const updates = [...plan.refs]
    for (const candidate of plan.candidates) {
        const objects = new Map(Object.values(candidate.candidate.files).filter(e => e && e.mode != "160000").map(e => [e!.object, "blob"]))
        updates.push({ ref: candidate.ref, before: candidate.before, after: await retainedDocument(repo, candidate.candidate, objects) })
    }
    for (const working of plan.working) {
        if (working.conflict) {
            const base = await draftCommit(repo, working.head, await readTree(repo, working.stashBase), undefined, "Composition stash base")
            const index = await draftCommit(repo, base, await readTree(repo, working.stashIndex), undefined, "Composition index")
            const stash = await gitText(repo, ["commit-tree", working.stashTree, "-p", base, "-p", index], "Transferred Working Changes\n")
            await repo.command(working.path, ["stash", "store", "-m", "Composition conflict", stash])
            changes.set("refs/stash", stash)
            plan.state.working.push({
                id: working.conflict.id,
                path: working.path,
                branch: working.ref,
                head: working.head,
                stash,
                conflict: working.conflict,
                beforeTree: working.conflictBaseline,
                beforeIndex: working.conflictIndex,
                afterIndex: working.index,
            })
        }
    }
    const stateBefore = plan.before.refs[conflictStateRef] ?? null
    if (JSON.stringify(plan.state) != JSON.stringify(await readConflictState(repo)))
        updates.push({ ref: conflictStateRef, before: stateBefore, after: await storeConflictState(repo, plan.state, stateBefore, false) })
    const unique = new Map(updates.map(u => [u.ref, u]))
    await repo.updateRefs([...unique.values()])
    for (const update of unique.values())
        changes.set(update.ref, update.after)
    for (const working of plan.working) {
        // Track the captured non-ignored untracked files in the temporary index
        // before checkout, so a moved addition is actually removed at its source.
        await repo.command(working.path, ["read-tree", working.beforeTree])
        await repo.command(working.path, ["read-tree", "--reset", "-u", working.tree])
        await repo.command(working.path, ["read-tree", working.index])
        if (working.ref)
            await repo.command(working.path, ["symbolic-ref", "HEAD", working.ref])
    }
    return {
        type: "result",
        command: "local",
        status: "performed",
        message: plan.preview.conflicts.length ? "Transfer completed with unresolved conflicts." : "Changes transferred.",
    }
}
