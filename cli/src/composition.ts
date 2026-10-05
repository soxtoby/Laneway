import { blob, conflictHunks, conflictStateRef, gitText, normalize, pathExists, readConflictState, readRegisteredWorktrees, replaceTreeFiles, replayTree, type RepositoryGit, retainedDocument, storeConflictState, temporaryBranchPrefix, treeEntries } from "@laneway/git"
import type { CompositionPreview, CompositionRequest, ConflictState, ConflictSubject, LocalPreview, LocalResult, ReplayStep, ResolutionCandidate, UnresolvedStack } from "@laneway/shared"
import { CompositionPreviewSchema, CompositionRequestSchema, ConflictStateSchema, ConflictSubjectSchema, LocalPreviewSchema, ResolutionCandidateSchema } from "@laneway/shared"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { compositionCommit } from "./composition-commits"
import { hasPathCollision, selectionTrees, workingTree } from "./composition-source"
import { extractFiles, isFileExtraction, prepareFileExtraction } from "./file-extraction"
import { captureGitCheckpoint, checkpointIdentity, checkpointMatches, type GitCheckpoint, GitCheckpointSchema } from "./git-checkpoint"

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
    before: GitCheckpoint
    commits: CommitPlan[]
    refs: Array<{ ref: string; before: string | null; after: string | null }>
    working: WorkingPlan[]
    state: ConflictState
    candidates: Array<{ ref: string; before: string; candidate: ResolutionCandidate }>
    preview: CompositionPreview
}
let plans = new WeakMap<LocalPreview, Plan>()
let stableIdentity = { GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z" }

let PlanSchema = z.object({
    before: GitCheckpointSchema,
    commits: z.array(
        z.object({
            oid: z.string(),
            parent: z.string(),
            tree: z.string(),
            source: z.string().optional(),
            message: z.string().optional(),
            conflict: ConflictSubjectSchema.optional(),
        }),
    ),
    refs: z.array(z.object({ ref: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
    working: z.array(z.object({
        path: z.string(),
        head: z.string(),
        ref: z.string().nullable(),
        tree: z.string(),
        index: z.string(),
        beforeTree: z.string(),
        beforeIndex: z.string(),
        conflict: ConflictSubjectSchema.optional(),
        stashBase: z.string(),
        stashTree: z.string(),
        stashIndex: z.string(),
        conflictBaseline: z.string(),
        conflictIndex: z.string(),
    })),
    state: ConflictStateSchema,
    candidates: z.array(z.object({ ref: z.string(), before: z.string(), candidate: ResolutionCandidateSchema })),
    preview: CompositionPreviewSchema,
})

export async function prepareComposition(
    repo: RepositoryGit,
    request: CompositionRequest,
    expectedToken?: string,
): Promise<{ before: GitCheckpoint; preview: LocalPreview }> {
    if (repo.descriptor.shallow || repo.descriptor.partial || repo.descriptor.sparse)
        throw new Error("Composition requires a complete, non-sparse repository.")

    let extraction = await prepareFileExtraction(repo, request)
    if (extraction)
        return extraction

    let worktrees = await readRegisteredWorktrees(repo)
    if (
        request.source.kind == "working"
        && !worktrees.some(w => !w.missing && normalize(w.path) == normalize(request.source.kind == "working" ? request.source.worktreePath : ""))
    ) {
        throw new Error("Choose an available Registered Worktree as the source.")
    }

    let affected = worktrees.filter(w => !w.missing).map(w => w.path)
    let before = await captureGitCheckpoint(repo, affected, undefined, worktrees)
    for (let w of worktrees.filter(w => !w.missing)) {
        for (let marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
            if (await pathExists(join(w.gitDirectory, marker)))
                throw new Error("Finish the existing Git operation before composition.")
        }
        if ((await repo.command(w.path, ["ls-files", "--unmerged", "-z"])).length)
            throw new Error("Resolve the Git index conflicts before composition.")
    }

    let [remoteRefs, configuration, attributes] = await Promise.all([
        gitText(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/laneway/conflict-candidates"]),
        gitText(repo, ["config", "--null", "--list", "--includes"]),
        readFile(join(repo.descriptor.commonDirectory, "info", "attributes"), "utf8").catch(error => {
            if ((error as NodeJS.ErrnoException).code != "ENOENT")
                throw error
            return ""
        }),
    ])
    let token = id(
        checkpointIdentity(before),
        remoteRefs,
        configuration,
        attributes,
        JSON.stringify(CompositionRequestSchema.parse({ ...request, allowConflicts: false })),
    )

    let cached = expectedToken == token ? await readPlan(repo, token) : undefined
    if (cached) {
        for (let working of cached.plan.working)
            await verifyIgnoredFiles(repo, working.path, working.tree)
        cached.plan.before = before
        plans.set(cached.preview, cached.plan)
        return { before, preview: cached.preview }
    }

    let [state, graph, selection] = await Promise.all([
        readConflictState(repo, before.refs[conflictStateRef] ?? null),
        repo.startReadBranchGraph({ authorIdentities: { secondary: [] }, remotePatterns: [], selectedRemote: request.selectedRemote }).result,
        request.source.kind == "branch" ? undefined : selectionTrees(repo, request),
    ])
    let originalState = structuredClone(state)
    let tips = new Map(Object.entries(before.refs).filter(([ref]) => ref.startsWith("refs/heads/") && !ref.startsWith(temporaryBranchPrefix)))
    for (let stack of state.stacks) {
        if (await repo.resolveRef(stack.temporaryRef) != (stack.steps.at(-1)?.current ?? stack.base))
            throw new Error("The unresolved stack moved externally. Refresh its recovery mapping first.")
        for (let b of stack.branches)
            tips.set(b.ref, b.current)
    }

    let history = (tips.size ? await gitText(repo, ["rev-list", "--format=%H %T %P", "--no-commit-header", ...new Set(tips.values())]) : "")
        .split("\n").filter(Boolean).map(line => line.split(" "))
    let parentMap = new Map(history.map(([oid, , ...parents]) => [oid, parents.filter(Boolean)]))
    let parents = async (_repo: RepositoryGit, value: string) => parentMap.get(value) ?? readParents(repo, value)
    let trees = new Map<string, Promise<string>>(history.map(([oid, tree]) => [oid, Promise.resolve(tree)]))
    let tree = (_repo: RepositoryGit, value: string) => {
        if (!trees.has(value))
            trees.set(value, readTree(repo, value))
        return trees.get(value)!
    }

    let primaryLocal = graph.primaryBranch.ref && graph.primaryBranch.remote
        ? `refs/heads/${graph.primaryBranch.ref.slice(`refs/remotes/${graph.primaryBranch.remote}/`.length)}`
        : undefined
    // Published Primary history may be rewritten, but the preview reports it so the user confirms before remote history changes.
    let publishedTip = primaryLocal && graph.primaryBranch.ref ? await repo.resolveRef(graph.primaryBranch.ref) : null
    let primaryReachable = publishedTip ? new Set((await gitText(repo, ["rev-list", publishedTip])).split("\n")) : new Set<string>()

    let preview: CompositionPreview = { branches: [], removed: [], conflicts: [], published: [], skipped: [], noop: false }
    let workingTrees = new Map<string, Promise<string>>()
    let currentTree = (path: string) => {
        let key = normalize(path)
        if (!workingTrees.has(key))
            workingTrees.set(key, workingTree(repo, path))
        return workingTrees.get(key)!
    }

    let commits: CommitPlan[] = [], candidates: Plan["candidates"] = []
    let oldSubjects = new Map(originalState.stacks.flatMap(s => s.steps.filter(s => s.conflict).map(s => [s.current, s.conflict!] as const)))
    let mutations = new Map<string, TreeChange>(), inserted = new Map<string, string>(), overrides = new Map<string, string>()
    let messages = new Map<string, string>()
    let deleted = new Set<string>(), onlyBranches = new Set<string>()
    let sourceWorking: TreeChange | undefined, destinationWorking: TreeChange | undefined
    let merge = async (base: string, left: string, right: string, label: string): Promise<TreeChange> => {
        let result = await replayTree(repo, base, left, right, id(base, left, right, label), { left: `Before ${label}`, right: `Incoming ${label}` })
        if (result.conflict)
            preview.conflicts.push({ subject: label, files: result.conflict.files.map(f => f.path) })
        return result
    }

    if (request.source.kind == "branch") {
        let { branch } = request.source
        if (request.target.kind != "branch" || request.mode != "move")
            throw new Error("Rebase a branch by moving it onto another branch.")
        // A remote-only destination is never rewritten, so its tip is as good a new base as a local branch.
        let target = request.target.branch
        let destination = target.startsWith("refs/remotes/")
            ? remoteRefs.split("\n").find(line => line.startsWith(`${target} `))?.slice(target.length + 1)
            : tip(target)
        let source = tip(branch)
        if (source != request.source.tip || destination != request.target.tip)
            throw new Error("A branch moved. Review the drop target again.")
        if (source == destination)
            throw new Error("A branch cannot be rebased onto itself.")
        if (await ancestor(repo, source, destination))
            throw new Error(`${displayName(target)} already contains ${displayName(branch)}.`)

        let node = graph.branches.find(b => b.localRefs.includes(refName(branch)))
        let bases = !node ? [] : node.base.status == "known" ? [node.base.tip] : node.base.candidates.map(candidate => candidate.tip)
        if (!bases.length)
            throw new Error(`Laneway can't tell where ${displayName(branch)}'s own commits begin, because it has no Base Branch.`)

        // Only the branch's own commits move: the range stops at its Base, whichever branch it is dropped onto.
        // Candidates of an ambiguous Base share their closest fork in linear history, so each bounds the same commits.
        let ranges = new Set(
            await Promise.all(
                bases.map(base => gitText(repo, ["rev-list", "--reverse", "--first-parent", "--no-commit-header", "--format=%H %s", source, "--not", base])),
            ),
        )
        if (ranges.size > 1)
            throw new Error(`${displayName(branch)}'s Base Branch candidates disagree about which commits are its own.`)
        preview.commits = [...ranges][0].split("\n").filter(Boolean).map(line => {
            let [objectId, ...subject] = line.split(" ")
            return { objectId, subject: subject.join(" ") }
        })
        let range = preview.commits.map(commit => commit.objectId)
        if (!range.length)
            throw new Error("The branch has no unique commits to rebase.")
        for (let commit of range)
            await editable(commit)
        if ((await parents(repo, range[0]))[0] == destination)
            preview.noop = true
        overrides.set(range[0], destination)
        if (!request.descendants)
            onlyBranches.add(refName(branch))
    } else {
        let sourceSubject = request.source.kind == "commit"
            ? oldSubjects.get(request.source.objectId)
            : state.working.find(w => normalize(w.path) == normalize(request.source.kind == "working" ? request.source.worktreePath : ""))?.conflict
        if (sourceSubject && selection) {
            let remainder = await replayTree(repo, selection.selected, selection.after, selection.base, id("protect-source", selection.selected))
            await protect(sourceSubject, await tree(repo, selection.after), remainder.tree)
        }
        if (request.target.kind == "branch" && (request.source.kind != "commit" || request.files))
            throw new Error("Branch rows accept whole commits, not file selections.")
        let target = request.target
        if (target.kind != "working") {
            let destination = tip(target.branch)
            if (target.kind == "branch" && destination != target.tip)
                throw new Error("The destination branch moved.")
            let at = target.kind == "commit" ? target.objectId : target.kind == "seam" ? target.parentId : destination
            if (!await ancestor(repo, at, destination))
                throw new Error("The target is not in the selected branch.")
            if (target.kind == "commit")
                await editable(at)
            let wholeCommit = request.source.kind == "commit" && !request.files ? request.source.objectId : undefined
            if (request.source.kind == "commit" && request.source.objectId == at && target.kind == "commit")
                throw new Error("Choose a different destination commit.")
            // A whole commit travels with its own message; only composed file selections need a new one.
            if (target.kind == "seam" && !wholeCommit && !request.message.trim())
                throw new Error("Enter a commit message before transferring changes.")
            if (
                target.kind == "seam" && wholeCommit && request.mode == "move" && request.source.kind == "commit" && request.source.branch
                && refName(request.source.branch) == refName(target.branch) && (at == wholeCommit || (await parents(repo, wholeCommit))[0] == at)
            ) {
                throw new Error("The commit is already in that position.")
            }
            // Another branch may only build atop Primary history; the Primary Branch itself accepts seams anywhere in its own history.
            if (primaryReachable.has(at) && at != destination && target.kind != "commit" && refName(target.branch) != primaryLocal) {
                let node = graph.branches.find(b => b.localRefs.includes(refName(target.branch)))
                if (!(node?.base.status == "known" && node.base.tip == at))
                    throw new Error("Choose an insertion seam inside the editable branch, or atop Primary Branch.")
            }
            let result = await merge(selection!.base, at, selection!.selected, "transferred changes")
            await skippedAt(at, result)
            if (result.tree == await tree(repo, at) && request.mode == "copy") {
                preview.noop = true
                preview.skipped.push(...selection!.paths)
            } else if (target.kind == "commit") {
                await protect(oldSubjects.get(at), await tree(repo, at), result.tree)
                mutations.set(at, result)
                // Moving a whole commit into another squashes them, so the destination keeps both messages.
                if (wholeCommit && request.mode == "move")
                    messages.set(at, await combinedMessage(repo, at, wholeCommit))
            } else {
                let message = wholeCommit ? undefined : request.message
                let oid = await draftCommit(repo, at, result.tree, wholeCommit, message)
                commits.push({ oid, parent: at, tree: result.tree, source: wholeCommit, message, conflict: result.conflict })
                inserted.set(at, oid)
            }
        } else {
            let holder = worktrees.find(w => !w.missing && normalize(w.path) == normalize(target.worktreePath))
            if (!holder)
                throw new Error("Choose an available Registered Worktree.")
            if (request.source.kind == "working" && normalize(request.source.worktreePath) == normalize(holder.path))
                throw new Error("Choose another destination.")
            let current = await currentTree(holder.path)
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
                let source = request.source.objectId
                await editable(source)
                let result = await merge(selection!.selected, source, selection!.base, "source remainder")
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

    let mapped = new Map<string, string>(),
        stepByCommit = new Map<string, ReplayStep>(originalState.stacks.flatMap(s => s.steps.map(step => [step.current, step] as const)))
    let descendants = new Map<string, string[]>()
    for (let [oid, ps] of parentMap) {
        for (let parent of ps)
            descendants.set(parent, [...(descendants.get(parent) ?? []), oid])
    }

    let affectedCommits = new Set([...mutations.keys(), ...overrides.keys(), ...inserted.keys()])
    for (let oid of affectedCommits) {
        for (let child of descendants.get(oid) ?? [])
            affectedCommits.add(child)
    }

    let visiting = new Set<string>()
    let insertedResults = new Map<string, string>()
    let newTips = new Map(tips)
    if (!preview.noop) {
        for (let [ref, old] of tips) {
            if (onlyBranches.size && !onlyBranches.has(ref))
                continue
            let current = await rewrite(old, inheritsTarget(ref))
            if (inserted.has(old)) {
                let owns = request.target.kind != "working" && ref == refName(request.target.branch)
                if (owns)
                    current = await insert(commits.find(c => c.oid == inserted.get(old))!, current)
            }
            newTips.set(ref, current)
        }
    }

    let changedBranches = [...newTips.keys()].filter(ref => tips.get(ref) != newTips.get(ref))
    // A shared unresolved stack is rebuilt as branch-sized boundaries. Retain
    // unchanged boundaries too, plus their dependent metadata, not just moved tips.
    let rebuilding = new Set<string>()
    for (let changed = true; changed;) {
        changed = false
        for (let stack of state.stacks) {
            if (
                !rebuilding.has(stack.id)
                && (stack.branches.some(b => changedBranches.includes(b.ref)) || stack.dependency && rebuilding.has(stack.dependency.stackId))
            ) {
                rebuilding.add(stack.id)
                changed = true
                for (let branch of stack.branches) {
                    if (!changedBranches.includes(branch.ref))
                        changedBranches.push(branch.ref)
                }
            }
        }
    }

    preview.removed = [...new Set(preview.removed)]
    preview.skipped = [...new Set(preview.skipped)]
    preview.branches = changedBranches.map(ref => ref.slice(11))

    for (let ref of changedBranches) {
        let upstream = (await repo.run(repo.descriptor.mainWorktree, ["rev-parse", "--symbolic-full-name", `${ref}@{upstream}`])).stdout.toString().trim()
        // The Primary Branch's remote counterpart counts as published history even without tracking configuration.
        let remoteTip = upstream ? await repo.resolveRef(upstream) ?? tips.get(ref)! : ref == primaryLocal ? publishedTip : null
        if (remoteTip && !(await ancestor(repo, remoteTip, newTips.get(ref)!)))
            preview.published.push(ref.slice(11))
    }

    let refs: Plan["refs"] = [], affectedStacks = state.stacks.filter(s => s.branches.some(b => changedBranches.includes(b.ref)))
    state.stacks = state.stacks.filter(s => !affectedStacks.includes(s))
    let stackByBranch = new Map<string, UnresolvedStack>()
    let resolvedBranches = new Set<string>()
    let commitLookup = new Map(commits.map(c => [c.oid, c]))
    for (let ref of changedBranches)
        await branchStack(ref)
    for (let s of affectedStacks) {
        if (!state.stacks.some(current => current.temporaryRef == s.temporaryRef))
            refs.push({ ref: s.temporaryRef, before: before.refs[s.temporaryRef], after: null })
    }

    let working: WorkingPlan[] = []
    for (let holder of worktrees) {
        let oldStack = originalState.stacks.find(s => s.temporaryRef == holder.branchRef)
        let ref = oldStack?.branches.at(-1)?.ref ?? holder.branchRef
        let source = request.source.kind == "working" && normalize(holder.path) == normalize(request.source.worktreePath)
        let target = request.target.kind == "working" && normalize(holder.path) == normalize(request.target.worktreePath)
        if (!changedBranches.includes(ref ?? "") && !sourceWorking && !destinationWorking || !changedBranches.includes(ref ?? "") && !source && !target)
            continue
        if (holder.missing)
            throw new Error("An affected worktree is unavailable. Locate it before composition.")
        let head = (await repo.command(holder.path, ["rev-parse", "HEAD"])).toString().trim()
        let current = await currentTree(holder.path), index = (await repo.command(holder.path, ["write-tree"])).toString().trim()
        let files: TreeChange = { tree: current }, staged: TreeChange = { tree: index }
        let stagedSource = source && sourceWorking && request.view == "staged"
        if (source && sourceWorking) {
            if (request.view == "staged")
                staged = sourceWorking
            else {
                files = sourceWorking
                if (request.view == "combined") {
                    if (request.files?.some(f => f.lineIds))
                        staged = await merge(selection!.selected, index, selection!.base, "remaining staged changes")
                    else {
                        let original = await treeEntries(repo, selection!.base)
                        staged = {
                            tree: await replaceTreeFiles(repo, index, Object.fromEntries(selection!.paths.map(path => [path, original.get(path) ?? null]))),
                        }
                    }
                }
            }
        }

        let stashBase = target ? selection!.base : head
        let stashTree = target ? selection!.selected : files.tree
        let stashIndex = target ? selection!.base : staged.tree
        let newHead = ref ? newTips.get(ref) ?? head : head
        if (newHead != head) {
            if (!stagedSource)
                files = await merge(head, newHead, files.tree, "worktree restoration")
            staged = await merge(head, newHead, staged.tree, "staged restoration")
        }
        if (stagedSource)
            files = await merge(index, staged.tree, current, "remaining unstaged changes")
        // Transfer onto the restored destination. Applying it before restacking can
        // erase the selected change when it was already in the destination's HEAD.
        if (target && destinationWorking)
            files = newHead == head ? destinationWorking : await merge(selection!.base, files.tree, selection!.selected, "Working Changes transfer")

        let existing = state.working.find(w => normalize(w.path) == normalize(holder.path) && !w.suspended)
        await protect(existing?.conflict, current, files.tree)
        if (existing) {
            files = await preserveConflict(existing.conflict, current, files)
            if (existing.beforeTree && files.tree != current) {
                let retained = await replayTree(repo, current, existing.beforeTree, files.tree, id(existing.id, "retained-working"))
                if (retained.conflict)
                    throw new Error("This transfer overlaps the saved pre-conflict Working Changes.")
                existing.beforeTree = retained.tree
            }
            existing.head = newHead
            existing.conflict = files.conflict!
            existing.afterIndex = staged.tree
        }

        let conflict = existing ? undefined : files.conflict ?? staged.conflict
        let nextRef = ref ? stackByBranch.get(ref)?.temporaryRef ?? ref : null
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
        await verifyIgnoredFiles(repo, holder.path, files.tree)
    }

    if (!await checkpointMatches(repo, before))
        throw new Error("Repository content changed while preparing the transfer. Select and review it again.")
    if (remoteRefs != await gitText(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes", "refs/laneway/conflict-candidates"]))
        throw new Error("Remote refs changed while preparing the transfer. Review it again.")

    let local: LocalPreview = {
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

    let plan = { before, commits, refs, working, state, candidates, preview }
    plans.set(local, plan)
    await writePlan(repo, local, plan)
    return { before, preview: local }

    async function skippedAt(destination: string, result: TreeChange) {
        if (request.mode != "copy" || !selection)
            return
        let counts = async (a: string, b: string) =>
            new Map(
                (await gitText(repo, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", a, b])).split("\0").filter(Boolean).map(
                    record => {
                        let [added, removed, ...path] = record.split("\t")
                        return [path.join("\t"), [Number(added), Number(removed)]] as const
                    },
                ),
            )
        let requested = await counts(selection.base, selection.selected), applied = await counts(destination, result.tree)
        for (let path of selection.paths) {
            if (!requested.has(path) || result.conflict?.files.some(f => f.path == path))
                continue
            let change = applied.get(path), original = requested.get(path)!
            if (!change)
                preview.skipped.push(path)
            else if (change.some((count, i) => count < original[i]))
                preview.skipped.push(`${path} (partly already present)`)
        }
    }

    async function rewrite(old: string, includeInsert: boolean): Promise<string> {
        if (!affectedCommits.has(old))
            return old
        let key = `${old}:${includeInsert}`
        if (mapped.has(key))
            return mapped.get(key)!
        if (visiting.has(key))
            throw new Error("The transfer would create a history cycle.")
        visiting.add(key)

        let ps = await parents(repo, old)
        let parent = overrides.get(old) ?? (ps[0] ? await rewrite(ps[0], includeInsert) : undefined)
        if (ps.slice(1).some(p => affectedCommits.has(p) && (includeInsert || !inserted.size)))
            throw new Error("Composition cannot restack merge commits. Copy to a linear destination instead.")
        if (includeInsert && parent && inserted.has(ps[0]) && request.target.kind != "working") {
            let added = commits.find(c => c.oid == inserted.get(ps[0]))!
            parent = await insert(added, parent)
        }

        let current = old
        let changed = mutations.get(old)
        if (changed || overrides.has(old) || parent != ps[0]) {
            await editable(old)
            if (!parent)
                throw new Error("A rewritten commit requires a parent.")
            if (deleted.has(old)) {
                // A whole commit leaving its position was moved on purpose; only commits emptied by replay are reported.
                current = parent
            } else {
                let sourceTree = changed?.tree ?? await tree(repo, old)
                let result = parent == ps[0]
                    ? { tree: sourceTree, conflict: changed?.conflict }
                    : await merge(ps[0], parent, sourceTree, `commit ${old.slice(0, 8)}`)
                if (parent != ps[0] && request.target.kind == "commit" && request.target.objectId == old) {
                    let replayed = await merge(ps[0], parent, old, `commit ${old.slice(0, 8)}`)
                    result = await merge(selection!.base, replayed.tree, selection!.selected, "transferred changes")
                }
                let existing = oldSubjects.get(old)
                await protect(existing, await tree(repo, old), result.tree)
                if (result.tree == await tree(repo, parent) && !existing && !result.conflict) {
                    current = parent
                    preview.removed.push(old)
                } else {
                    let retained = await preserveConflict(existing, await tree(repo, old), {
                        tree: result.tree,
                        conflict: result.conflict ?? changed?.conflict,
                    })
                    let conflict = retained.conflict
                    result.tree = retained.tree
                    let message = messages.get(old)
                    let source = changed || existing ? await draftCommit(repo, ps[0], sourceTree, old, message) : old
                    current = await draftCommit(repo, parent, result.tree, old, message)
                    commits.push({ oid: current, parent, tree: result.tree, source: old, message, conflict })
                    stepByCommit.set(current, { id: conflict?.id ?? id(old), source, current, conflict })
                }
            }
        } else {
            let existing = oldSubjects.get(old)
            if (existing)
                stepByCommit.set(old, originalState.stacks.flatMap(s => s.steps).find(s => s.current == old)!)
        }

        mapped.set(key, current)
        visiting.delete(key)
        return current
    }

    async function editable(commit: string) {
        if ((await parents(repo, commit)).length != 1)
            throw new Error("Direct editing of root or merge commits is unavailable.")
        if (!parentMap.has(commit))
            throw new Error("Only commits in a local branch can be rewritten.")
    }

    async function preserveConflict(existing: ConflictSubject | undefined, oldTree: string, result: TreeChange) {
        if (!existing)
            return result
        await protect(existing, oldTree, result.tree)
        let incoming = result.conflict
        let files = new Map(existing.files.map(f => [f.path, { ...f }]))
        let replacements: Parameters<typeof replaceTreeFiles>[2] = {}
        if (incoming) {
            let entries = await treeEntries(repo, result.tree)
            for (let file of incoming.files) {
                files.set(file.path, { ...file })
                let entry = entries.get(file.path)
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

        let entries = await treeEntries(repo, result.tree)
        for (let file of files.values())
            file.provisional = entries.get(file.path) ?? null

        let conflict = { ...existing, tree: result.tree, files: [...files.values()], input: incoming ? id(existing.input, incoming.input) : existing.input }
        await carryCandidate(existing, oldTree, result.tree, conflict)
        return { tree: result.tree, conflict }
    }

    async function protect(subject: ConflictSubject | undefined, oldTree: string, newTree: string) {
        if (!subject || oldTree == newTree)
            return
        let old = await treeEntries(repo, oldTree), next = await treeEntries(repo, newTree)
        for (let file of subject.files) {
            if (!file.text) {
                let paths = [...new Set([...old.keys(), ...next.keys()])].filter(p =>
                    p == file.path || p.startsWith(file.path + "/") || file.path.startsWith(p + "/")
                )
                if (paths.some(p => JSON.stringify(old.get(p)) != JSON.stringify(next.get(p))))
                    throw new Error(`Resolve the structural or binary conflict in ${file.path} before transferring it.`)
                continue
            }
            let a = (await blob(repo, old.get(file.path) ?? null))?.toString() ?? ""
            let b = (await blob(repo, next.get(file.path) ?? null))?.toString() ?? ""
            let regions = (text: string) => conflictHunks(text, subject).map(h => text.slice(h.start, h.end))
            if (JSON.stringify(regions(a)) != JSON.stringify(regions(b)) || old.get(file.path)?.mode != next.get(file.path)?.mode)
                throw new Error(`The transfer overlaps existing conflicted lines in ${file.path}. Resolve those lines first.`)
        }
    }

    async function insert(added: CommitPlan, parent: string) {
        let cached = insertedResults.get(added.oid)
        if (cached)
            return cached
        let result = parent == added.parent
            ? { tree: added.tree, conflict: added.conflict }
            : await merge(selection!.base, parent, selection!.selected, "inserted commit")
        if (result.tree == await tree(repo, parent) && !result.conflict) {
            insertedResults.set(added.oid, parent)
            return parent
        }
        let current = await draftCommit(repo, parent, result.tree, added.source, added.message)
        commits.push({ ...added, oid: current, parent, tree: result.tree, conflict: result.conflict })
        stepByCommit.set(current, { id: result.conflict?.id ?? id(added.oid), source: current, current, conflict: result.conflict })
        insertedResults.set(added.oid, current)
        return current
    }

    async function carryCandidate(subject: ConflictSubject, old: string, next: string, updated = subject) {
        let ref = `refs/laneway/conflict-candidates/${subject.id}/${subject.input}`, before = await repo.resolveRef(ref)
        if (!before || old == next)
            return

        let candidate: ResolutionCandidate = JSON.parse((await repo.command(repo.descriptor.mainWorktree, ["show", `${before}:state.json`])).toString())
        let oldCandidate = await replaceTreeFiles(repo, old, candidate.files)
        let carried = await replayTree(repo, old, next, oldCandidate, id(subject.id, next))
        if (carried.conflict)
            throw new Error("This transfer overlaps saved conflict resolution progress.")
        let files = await treeEntries(repo, carried.tree)
        for (let path of Object.keys(candidate.files))
            candidate.files[path] = files.get(path) ?? null
        let nextRef = `refs/laneway/conflict-candidates/${updated.id}/${updated.input}`
        candidate.input = updated.input
        candidates.push({ ref: nextRef, before: nextRef == ref ? before : await repo.resolveRef(nextRef) ?? "", candidate })
    }

    function inheritsTarget(ref: string) {
        if (request.target.kind == "working")
            return false
        let target = refName(request.target.branch)
        if (ref == target)
            return true

        let node = graph.branches.find(b => b.localRefs.includes(ref))
        let seen = new Set<string>()
        while (node?.base.status == "known" && !seen.has(node.id)) {
            seen.add(node.id)
            let parentId = node.base.branchId
            node = graph.branches.find(b => b.id == parentId)
            if (node && (node.primary ? target == primaryLocal : node.preferredRef == target))
                return true
        }
        return false
    }

    async function branchStack(ref: string): Promise<UnresolvedStack | undefined> {
        if (stackByBranch.has(ref))
            return stackByBranch.get(ref)
        if (resolvedBranches.has(ref))
            return undefined
        let tip = newTips.get(ref)!
        let path: string[] = []
        let cursor = tip, upstream: string | undefined
        for (;;) {
            upstream = cursor == tip ? undefined : changedBranches.find(other => other != ref && newTips.get(other) == cursor)
            if (upstream || !commitLookup.has(cursor) && !oldSubjects.has(cursor))
                break
            path.unshift(cursor)
            cursor = commitLookup.get(cursor)?.parent ?? (await parents(repo, cursor))[0]
        }

        let parentStack = upstream ? await branchStack(upstream) : state.stacks.find(s => s.branches.some(b => b.current == cursor))
        let steps = path.map(current => stepByCommit.get(current) ?? { id: id(current), source: current, current })
        let unresolved = steps.some(s => s.conflict) || parentStack
        if (!unresolved) {
            refs.push({ ref, before: before.refs[ref], after: tip })
            resolvedBranches.add(ref)
            return undefined
        }
        let stackId = id(ref, tip),
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

    function tip(name: string) {
        let ref = refName(name), value = tips.get(ref)
        if (!value)
            throw new Error("The selected local branch no longer exists.")
        return value
    }
}

async function writePlan(repo: RepositoryGit, preview: LocalPreview, plan: Plan) {
    let directory = join(repo.descriptor.commonDirectory, "laneway")
    let data = JSON.stringify({ version: 1, preview, plan })
    await mkdir(directory, { recursive: true })
    let path = join(directory, "composition-preview.json")
    await writeFile(`${path}.tmp`, JSON.stringify({ data, hash: id(data) }))
    await rename(`${path}.tmp`, path)
}

async function readPlan(repo: RepositoryGit, token: string) {
    try {
        let stored = JSON.parse(await readFile(join(repo.descriptor.commonDirectory, "laneway", "composition-preview.json"), "utf8"))
        if (typeof stored.data != "string" || stored.hash != id(stored.data))
            return undefined
        let cached = z.object({ version: z.literal(1), preview: LocalPreviewSchema, plan: PlanSchema }).parse(JSON.parse(stored.data))
        if (cached.preview.token != token)
            return undefined
        let objects = [
            ...new Set([
                ...cached.plan.commits.flatMap(commit => [commit.oid, commit.tree]),
                ...cached.plan.working.flatMap(working => [working.tree, working.index, working.beforeTree, working.beforeIndex]),
            ]),
        ]
        let checked = await gitText(repo, ["cat-file", "--batch-check"], objects.join("\n") + "\n")
        return checked.includes(" missing") ? undefined : cached
    } catch {
        // A preview is disposable. Missing, expired or incompatible plans are rebuilt.
        return undefined
    }
}

async function verifyIgnoredFiles(repo: RepositoryGit, path: string, tree: string) {
    // Skip unrelated ignored directories (often entire dependency/build trees).
    // A directory match is only a candidate: adding a sibling file is harmless.
    let summarized = (await repo.command(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])).toString()
        .split("\0").filter(Boolean).map(name => name.replace(/\/$/, ""))
    if (!summarized.length)
        return
    let names = [...(await treeEntries(repo, tree)).keys()]
    if (!hasPathCollision(names, summarized))
        return
    let ignored = (await repo.command(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean)
    if (hasPathCollision(names, ignored))
        throw new Error("A transfer would replace an ignored file. Move that file before retrying.")
}

export async function mutateComposition(
    repo: RepositoryGit,
    request: CompositionRequest,
    preview: LocalPreview,
    changes: Map<string, string | null>,
    cancelled = () => false,
): Promise<LocalResult> {
    if (isFileExtraction(preview))
        return extractFiles(repo, preview, changes, cancelled)

    let plan = plans.get(preview)
    if (!plan)
        throw new Error("Prepare the transfer before executing it.")
    if (plan.preview.conflicts.length && !request.allowConflicts)
        throw new Error("The transfer would conflict. Choose resolve now or resolve later before continuing.")
    if (plan.preview.noop) {
        return {
            type: "result",
            command: "local",
            status: "performed",
            message: request.source.kind == "branch" && request.target.kind == "branch"
                ? `${displayName(request.source.branch)} is already on top of ${displayName(request.target.branch)}.`
                : "Already present",
        }
    }
    if (cancelled())
        throw new Error("Transfer cancelled before changing files or refs.")

    let drafts = new Map(plan.commits.map(c => [c.oid, c])), final = new Map<string, string>()
    for (let update of plan.refs) {
        if (update.after)
            update.after = await finalize(update.after)
    }

    for (let stack of plan.state.stacks) {
        stack.base = final.get(stack.base) ?? stack.base
        for (let step of stack.steps) {
            if (step.source == step.current)
                step.source = final.get(step.source) ?? step.source
            step.current = final.get(step.current) ?? step.current
        }
        for (let branch of stack.branches)
            branch.current = final.get(branch.current) ?? branch.current
    }

    for (let working of plan.working)
        working.head = final.get(working.head) ?? working.head
    for (let working of plan.state.working)
        working.head = final.get(working.head) ?? working.head
    if (cancelled() || !await checkpointMatches(repo, plan.before))
        throw new Error("Repository content changed or the transfer was cancelled during commit preparation. No transfer was applied.")
    // All trees and conflict inputs are prepared before this single ref transaction.
    let updates = [...plan.refs]
    for (let candidate of plan.candidates) {
        let objects = new Map(Object.values(candidate.candidate.files).filter(e => e && e.mode != "160000").map(e => [e!.object, "blob"]))
        updates.push({ ref: candidate.ref, before: candidate.before, after: await retainedDocument(repo, candidate.candidate, objects) })
    }

    for (let working of plan.working) {
        if (working.conflict) {
            let base = await draftCommit(repo, working.head, await readTree(repo, working.stashBase), undefined, "Composition stash base")
            let index = await draftCommit(repo, base, await readTree(repo, working.stashIndex), undefined, "Composition index")
            let stash = await gitText(repo, ["commit-tree", working.stashTree, "-p", base, "-p", index], "Transferred Working Changes\n")
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
    let stateBefore = plan.before.refs[conflictStateRef] ?? null
    if (JSON.stringify(plan.state) != JSON.stringify(await readConflictState(repo)))
        updates.push({ ref: conflictStateRef, before: stateBefore, after: await storeConflictState(repo, plan.state, stateBefore, false) })
    let unique = new Map(updates.map(u => [u.ref, u]))

    await repo.updateRefs([...unique.values()])
    for (let update of unique.values())
        changes.set(update.ref, update.after)

    for (let working of plan.working) {
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

    async function finalize(value: string): Promise<string> {
        if (final.has(value))
            return final.get(value)!
        let commit = drafts.get(value)
        if (!commit)
            return value
        let parent = await finalize(commit.parent)
        let created = await compositionCommit(repo, parent, commit.tree, commit.source, commit.message, cancelled)
        final.set(value, created)
        return created
    }
}

// A source commit supplies the author and, unless a message is given, the message.
async function draftCommit(repo: RepositoryGit, parent: string, value: string, source?: string, message?: string) {
    let env: Record<string, string> = { ...stableIdentity }
    if (source) {
        let raw = (await repo.command(repo.descriptor.mainWorktree, ["cat-file", "commit", source])).toString()
        let split = raw.indexOf("\n\n")
        let author = /^author (.*) <([^>]*)> (.+)$/m.exec(raw.slice(0, split))!
        env.GIT_AUTHOR_NAME = author[1]
        env.GIT_AUTHOR_EMAIL = author[2]
        env.GIT_AUTHOR_DATE = author[3]
        message ||= raw.slice(split + 2)
    }
    return gitText(repo, ["commit-tree", value, "-p", parent], message || "Composed changes", env)
}

function id(...values: string[]) {
    return createHash("sha256").update(values.join("\0")).digest("hex")
}

function refName(name: string) {
    return name.startsWith("refs/heads/") ? name : `refs/heads/${name}`
}

function displayName(ref: string) {
    return ref.replace(/^refs\/(heads|remotes)\//, "")
}

function readTree(repo: RepositoryGit, value: string) {
    return gitText(repo, ["rev-parse", `${value}^{tree}`])
}

async function readParents(repo: RepositoryGit, value: string) {
    return (await gitText(repo, ["show", "-s", "--format=%P", value])).split(" ").filter(Boolean)
}

async function ancestor(repo: RepositoryGit, a: string, b: string) {
    return !(await repo.run(repo.descriptor.mainWorktree, ["merge-base", "--is-ancestor", a, b])).exitCode
}

/** Two commits squashed into one read as Git's own squash message: the retained commit's message, then the incoming one. */
async function combinedMessage(repo: RepositoryGit, retained: string, incoming: string) {
    return `${(await commitMessage(repo, retained)).trimEnd()}\n\n${(await commitMessage(repo, incoming)).trimEnd()}\n`
}

async function commitMessage(repo: RepositoryGit, commit: string) {
    let raw = (await repo.command(repo.descriptor.mainWorktree, ["cat-file", "commit", commit])).toString()
    return raw.slice(raw.indexOf("\n\n") + 2)
}
