import { historicalEditPrefix, normalize, readRegisteredWorktrees, type RepositoryGit } from "@laneway/git"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { captureRegistration } from "../worktrees/worktree-registration"
import type { Change, Registration, Snapshot, StashEntry } from "./operation-record"

export let fixtureRef = "refs/laneway/test/fixture"

export let recordedRefPrefixes = [
    "refs/heads",
    "refs/tags",
    "refs/stash",
    "refs/laneway/conflicts/current",
    "refs/laneway/conflict-candidates",
    historicalEditPrefix,
    fixtureRef,
]

/** Reads what an operation may change in four Git launches and one file read, however many worktrees exist. */
export async function captureSnapshot(repo: RepositoryGit): Promise<Snapshot> {
    let [refs, worktrees, stashes, configuration, metadata] = await Promise.all([
        readRecordedRefs(repo),
        readRegisteredWorktrees(repo),
        readStashList(repo),
        repo.run(repo.descriptor.mainWorktree, ["config", "--null", "--get-regexp", "^branch\\."]),
        readMetadata(repo),
    ])
    return {
        refs,
        worktrees: worktrees.map(w => ({
            id: w.id,
            path: w.path,
            main: w.main,
            head: /^0+$/.test(w.head) ? "" : w.head,
            branchRef: w.branchRef,
            locked: w.locked,
            lockReason: w.lockReason,
            missing: w.missing,
        })),
        stashes,
        branchConfig: configuration.stdout.toString().split("\0").filter(Boolean).map(record => {
            let split = record.indexOf("\n")
            return [record.slice(0, split), record.slice(split + 1)]
        }),
        metadata,
    }
}

export async function readRecordedRefs(repo: RepositoryGit) {
    let output = await repo.command(repo.descriptor.mainWorktree, ["for-each-ref", "--format=%(refname) %(objectname)", ...recordedRefPrefixes])
    return Object.fromEntries(output.toString().trim().split("\n").filter(Boolean).map(line => line.split(" "))) as Record<string, string>
}

export async function readStashList(repo: RepositoryGit): Promise<StashEntry[]> {
    let output = await repo.command(repo.descriptor.mainWorktree, ["stash", "list", "--format=%H%x00%gs"])
    return output.toString().trim().split("\n").filter(Boolean).map(record => {
        let split = record.indexOf("\0")
        return { object: record.slice(0, split), message: record.slice(split + 1) }
    })
}

export function metadataPath(repo: RepositoryGit) {
    return join(repo.descriptor.commonDirectory, "laneway-local.json")
}

async function readMetadata(repo: RepositoryGit) {
    return readFile(metadataPath(repo), "utf8").catch(error => {
        if (error.code != "ENOENT")
            throw error
        return null
    })
}

/**
 * The changes between two snapshots: ref moves, worktree HEAD moves, registrations added, removed, moved, or locked,
 * stash list, branch configuration, and metadata. `removing` supplies the retained registration of a removed worktree.
 */
export async function diffSnapshots(repo: RepositoryGit, before: Snapshot, after: Snapshot, removing = new Map<string, Registration>()): Promise<Change[]> {
    let changes: Change[] = []
    for (let ref of [...new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])].sort()) {
        if (before.refs[ref] != after.refs[ref])
            changes.push({ type: "ref", ref, before: before.refs[ref] ?? null, after: after.refs[ref] ?? null })
    }

    let worktrees = (await readRegisteredWorktrees(repo)).filter(w => !w.main)
    for (let id of [...new Set([...before.worktrees, ...after.worktrees].map(w => w.id))]) {
        let old = before.worktrees.find(w => w.id == id), next = after.worktrees.find(w => w.id == id)
        if (old && next && !old.main) {
            if (normalize(old.path) != normalize(next.path) || old.locked != next.locked) {
                let registration = await captureRegistration(repo, worktrees.find(w => w.id == id)!, false)
                changes.push({
                    type: "worktree",
                    id,
                    before: { ...registration, path: old.path, locked: old.locked, lockReason: old.lockReason },
                    after: { ...registration, path: next.path, locked: next.locked, lockReason: next.lockReason },
                })
            }
        } else if (next && !next.main)
            changes.push({ type: "worktree", id, before: null, after: await captureRegistration(repo, worktrees.find(w => w.id == id)!, false) })
        else if (old && !old.main) {
            let registration: Registration = removing.get(id) ?? {
                id,
                path: old.path,
                head: old.head,
                branchRef: old.branchRef,
                locked: old.locked,
                lockReason: old.lockReason,
                submodules: [],
            }
            changes.push({ type: "worktree", id, before: registration, after: null })
        }
        if (old && next && headOf(old) != headOf(next))
            changes.push({ type: "head", path: next.path, before: headOf(old), after: headOf(next) })
    }

    if (JSON.stringify(before.stashes) != JSON.stringify(after.stashes))
        changes.push({ type: "stashes", before: before.stashes, after: after.stashes })

    for (let key of [...new Set([...before.branchConfig, ...after.branchConfig].map(([key]) => key))].sort()) {
        let old = before.branchConfig.filter(([k]) => k == key).map(([, value]) => value)
        let next = after.branchConfig.filter(([k]) => k == key).map(([, value]) => value)
        if (JSON.stringify(old) != JSON.stringify(next))
            changes.push({ type: "config", key, before: old, after: next })
    }

    if (before.metadata != after.metadata)
        changes.push({ type: "metadata", before: before.metadata, after: after.metadata })

    return changes
}

/** A worktree's HEAD as recorded: the branch it has checked out, or the commit it is detached at. */
function headOf(worktree: Snapshot["worktrees"][number]) {
    return worktree.branchRef ?? worktree.head
}
