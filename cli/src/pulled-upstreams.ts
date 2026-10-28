import type { RepositoryGit } from "@laneway/git"
import { isAncestor } from "./active-stack"

// Records are branch configuration: Git keeps it with its branch through renames and deletion, and Operation History
// records it, so undoing a pull restores the records the pull cleared.
let variable = "lanewaypulledupstream"

/**
 * The upstream tip each branch last pulled, by branch ref, recorded only while a Laneway fetch has moved the upstream
 * since; otherwise its remote-tracking tip is the one last pulled. Null when the upstream had not been fetched, or when
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
        repo.command(main, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "refs/heads/"]),
    ])
    for (let line of branches.toString().split("\n").filter(Boolean)) {
        let [ref, local, upstream] = line.split("\0") as [string, string, string]
        if (!upstream.startsWith("refs/remotes/"))
            continue
        let tip = after.get(upstream) ?? null
        let previous = before.get(upstream) ?? null
        let pulled = records.has(ref) ? records.get(ref)! : previous != tip ? previous : undefined
        if (pulled === undefined)
            continue
        let current = await caughtUp(repo, local, tip, pulled)
        if (current && records.has(ref))
            await forgetPulledUpstream(repo, ref)
        else if (!current && !records.has(ref))
            await repo.command(main, ["config", "--local", key(ref), pulled ?? ""])
    }
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
