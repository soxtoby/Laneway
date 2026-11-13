import type { RepositoryGit } from "@laneway/git"
import { isAncestor } from "./active-stack"

// Records are branch configuration: Git keeps it with its branch through renames and deletion, and Operation History
// records it, so undoing a pull restores the records the pull cleared.
let variable = "lanewaypulledupstream"

/** How Laneway fetches a remote, which the reflog of each remote-tracking branch it moves remembers. */
export let laneFetch = ["fetch", "--prune", "--no-write-fetch-head"]

/**
 * The upstream tip each branch last pulled, by branch ref, recorded while a fetch has moved the upstream since or a pull
 * left the branch with copies of its commits; otherwise its remote-tracking tip is the one last pulled. Null when the upstream had not been fetched, or when
 * its tip is no longer in the repository.
 */
export async function readPulledUpstreams(repo: RepositoryGit) {
    let main = repo.descriptor.mainWorktree
    let result = await repo.run(main, ["config", "--local", "--null", "--get-regexp", `^branch\\..*\\.${variable}$`])
    if (result.exitCode > 1)
        throw new Error(result.stderr.toString().trim() || "Git could not read branch configuration.")

    let records = new Map<string, string | null>()
    for (let entry of result.stdout.toString().split("\0").filter(Boolean)) {
        let [key, value = ""] = entry.split("\n")
        records.set(`refs/heads/${key!.slice("branch.".length, -variable.length - 1)}`, value || null)
    }

    let tips = [...new Set(records.values())].filter(tip => tip != null)
    if (tips.length) {
        let output = await repo.command(main, ["cat-file", "--batch-check=%(objectname)"], tips.map(tip => `${tip}\n`).join(""))
        let present = new Set(output.toString().split("\n").filter(line => !line.endsWith(" missing")))
        for (let [ref, tip] of records) {
            if (tip && !present.has(tip))
                records.set(ref, null)
        }
    }
    return records
}

/** Remote-tracking tips by ref, read before a fetch so the upstreams it moves can be recorded after it. */
export async function readRemoteTips(repo: RepositoryGit) {
    let output = await repo.command(repo.descriptor.mainWorktree, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/remotes/"])
    return new Map(output.toString().split("\n").filter(Boolean).map(line => line.split("\0") as [string, string]))
}

/**
 * Records the tip each branch's upstream had before a fetch moved it, unless an earlier fetch already did, and forgets
 * the records of branches that have since caught up. `before` holds the remote-tracking tips read before fetching.
 * Called under the mutation lock and outside any Laneway Operation, so undoing an operation never discards a record.
 */
export async function recordFetchedUpstreams(repo: RepositoryGit, before: Map<string, string>) {
    let main = repo.descriptor.mainWorktree
    let [records, after, branches] = await Promise.all([
        readPulledUpstreams(repo),
        readRemoteTips(repo),
        repo.command(main, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:trackshort)", "refs/heads/"]),
    ])
    for (let line of branches.toString().split("\n").filter(Boolean)) {
        let [ref, local, upstream, track] = line.split("\0") as [string, string, string, string]
        if (!upstream.startsWith("refs/remotes/"))
            continue
        let tip = after.get(upstream) ?? null
        let previous = before.get(upstream) ?? null
        let lacking = track.includes("<")
        let pulled = records.has(ref)
            ? records.get(ref)!
            // Another tool's fetch may have moved the upstream before this one did, or instead of it.
            : (lacking && previous ? await heldUpstream(repo, ref, upstream, local, previous) : undefined) ?? (previous != tip ? previous : undefined)
        if (pulled === undefined)
            continue
        // Published since, by any tool, and then rewritten: the upstream's tip was the branch's own.
        if (records.has(ref) && lacking && tip && tip != pulled && await heldUpstream(repo, ref, upstream, local, tip) == tip) {
            await forgetPulledUpstream(repo, ref)
            continue
        }
        let current = await caughtUp(repo, local, tip, pulled)
        // A pull that replayed the upstream's commits keeps its record until the branch's history holds the tip.
        if (current && records.has(ref) && !lacking)
            await forgetPulledUpstream(repo, ref)
        else if (!current && !records.has(ref))
            await repo.command(main, ["config", "--local", key(ref), pulled ?? ""])
    }
}

/**
 * The newest tip in an upstream's reflog that the branch's history has held, going by the branch's own reflog: the tip
 * it last pulled, whichever tool fetched since. Undefined when the reflogs can't say.
 */
async function heldUpstream(repo: RepositoryGit, ref: string, upstream: string, local: string, tip: string) {
    let [entries, held] = await Promise.all([reflog(repo, upstream, 50), reflog(repo, ref, 200)])
    let start = entries.findIndex(entry => entry.tip == tip)
    // A tip Laneway fetched has its record already, or was pulled; one it replayed is in no history the branch held.
    if (start < 0 || !held.length || entries[start]!.subject.startsWith(laneFetch.join(" ")))
        return undefined
    for (let entry of entries.slice(start)) {
        let lacking = await repo.run(repo.descriptor.mainWorktree, [
            "rev-list",
            "--max-count=1",
            entry.tip,
            "--not",
            local,
            ...new Set(held.map(item => item.tip)),
        ])
        if (lacking.exitCode == 0 && !lacking.stdout.toString().trim())
            return entry.tip
    }
    return undefined
}

/** What a ref's reflog remembers, newest first. */
async function reflog(repo: RepositoryGit, ref: string, limit: number) {
    let result = await repo.run(repo.descriptor.mainWorktree, ["log", "--walk-reflogs", `--max-count=${limit}`, "--format=%H %gs", ref, "--"])
    let lines = result.exitCode == 0 ? result.stdout.toString().split("\n").filter(Boolean) : []
    return lines.map(line => ({ tip: line.slice(0, line.indexOf(" ")), subject: line.slice(line.indexOf(" ") + 1) }))
}

/** Records the upstream tip a branch last pulled while its history doesn't hold that tip. */
export async function savePulledUpstream(repo: RepositoryGit, ref: string, tip: string) {
    await repo.command(repo.descriptor.mainWorktree, ["config", "--local", key(ref), tip])
}

/** Whether a branch holds everything its upstream does, or its upstream is back at the tip the branch last pulled. */
export async function caughtUp(repo: RepositoryGit, local: string, upstream: string | null, pulled: string | null) {
    return upstream != null && (upstream == pulled || await isAncestor(repo, upstream, local))
}

/** Forgets the tip a branch last pulled, once it has pulled its upstream's current tip. */
export async function forgetPulledUpstream(repo: RepositoryGit, ref: string) {
    await repo.run(repo.descriptor.mainWorktree, ["config", "--local", "--unset-all", key(ref)])
}

/** Whether a branch configuration key, as Git lists it, is one of these records. */
export function pulledUpstreamKey(key: string) {
    return key.startsWith("branch.") && key.endsWith(`.${variable}`)
}

function key(ref: string) {
    return `branch.${ref.slice("refs/heads/".length)}.${variable}`
}
