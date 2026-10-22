import { connectRepository, readConflictState } from "@laneway/git"
import { afterEach, expect, test } from "bun:test"
import { conflict, git } from "./composition-fixture"
import { accept, choose, commit, createConflictFixtures } from "./conflicts-fixture"

let { fixture, cleanup } = createConflictFixtures()
afterEach(cleanup)

test("accepting a descendant first reopens changed inputs after upstream resolution", async () => {
    let { path, base } = await fixture()
    git(path, "reset", "--hard", "HEAD^")
    await commit(path, "a.txt", "downstream\n", "downstream conflict")
    let result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })

    expect(result.conflicts).toHaveLength(2)

    let [upstream, downstream] = result.conflicts.map(c => c.id)
    await choose(path, downstream, "right")
    await accept(path, downstream)

    expect((await conflict(path, { action: "list" })).conflicts.map(c => c.id)).toEqual([upstream])

    await choose(path, upstream, "left")
    await accept(path, upstream)
    let reopened = (await conflict(path, { action: "inspect", subject: downstream })).view!

    expect(reopened.ready).toBe(false)
    expect(reopened.files[0].suggestionText).toBe("downstream\n")

    await choose(path, downstream, "right")
    await accept(path, downstream)

    expect(git(path, "show", "HEAD:a.txt")).toBe("downstream")
}, 120_000)

test("exact-input candidates survive explicit updates; changed inputs preserve suggestions", async () => {
    let { path, base } = await fixture()
    let subject = (await conflict(path, { action: "rewrite", branches: ["topic"], base, path })).conflicts[0].id
    await choose(path, subject, "right")
    let chosen = (await conflict(path, { action: "inspect", subject })).view!
    await conflict(path, { action: "rewrite", branches: ["topic"], base, path })

    expect((await conflict(path, { action: "inspect", subject })).view!.candidate.revision).toBe(chosen.candidate.revision)

    let temporary = git(path, "branch", "--show-current")
    git(path, "switch", "main")
    let newer = await commit(path, "a.txt", "newer main\n", "new base")
    git(path, "switch", temporary)
    await conflict(path, { action: "rewrite", branches: ["topic"], base: newer, path })
    let changed = (await conflict(path, { action: "inspect", subject })).view!

    expect(changed.ready).toBe(false)
    expect(changed.subject.input).not.toBe(chosen.subject.input)
    expect(changed.files[0].suggestionText).toBe("topic\n")
    await expect(conflict(path, { action: "accept", subject, input: chosen.subject.input, revision: chosen.candidate.revision })).rejects.toThrow(
        "inputs changed",
    )
}, 120_000)

test("a moving base does not change resolution; external provisional descendants survive", async () => {
    let { path, base } = await fixture()
    let result = await conflict(path, { action: "rewrite", branches: ["topic"], base, path })
    let subject = result.conflicts[0].id
    let originalView = (await conflict(path, { action: "inspect", subject })).view!
    await commit(path, "external.txt", "external\n", "external child")
    git(path, "branch", "-f", "main", "topic")
    await choose(path, subject, "right")
    await accept(path, subject)

    expect(git(path, "show", "HEAD:external.txt")).toBe("external")
    expect(git(path, "log", "--oneline")).toContain("external child")
    expect(originalView.subject.leftLabel).toContain(base.slice(0, 8))
}, 120_000)

test("multiple branch boundaries and a dependent stack restack together", async () => {
    let { path, original, base, before } = await fixture()
    git(path, "branch", "lower", original)
    git(path, "switch", "-qc", "sibling", original)
    await commit(path, "sibling.txt", "sibling\n", "sibling")
    git(path, "switch", "topic")
    let first = await conflict(path, { action: "rewrite", branches: ["lower", "topic"], base, path })
    let repo = await connectRepository(path)
    let state = await readConflictState(repo)
    let provisionalBase = state.stacks[0].branches[0].current
    await conflict(path, { action: "rewrite", branches: ["sibling"], base: provisionalBase })
    let graph = await repo.startReadBranchGraph({ authorIdentities: { primary: "conflict@example.invalid", secondary: [] }, remotePatterns: [] }).result

    expect(graph.branches.some(b => b.name.startsWith("laneway/"))).toBe(false)
    expect(graph.branches.find(b => b.name == "topic")!.tip).not.toBe(before)
    expect(graph.branches.find(b => b.name == "lower")!.unresolved).toBeDefined()

    let comparison = await repo.startReadChanges({
        source: { kind: "refs", from: { kind: "branch", ref: "refs/heads/main" }, to: { kind: "branch", ref: "refs/heads/topic" } },
    }).result

    expect(comparison.source).toEqual({ kind: "comparison", fromObjectId: base, toObjectId: graph.branches.find(b => b.name == "topic")!.tip })

    await choose(path, first.conflicts[0].id, "right")
    await accept(path, first.conflicts[0].id)
    let remaining = await readConflictState(repo)
    for (let stack of remaining.stacks) {
        for (let step of stack.steps) {
            if (step.conflict) {
                await choose(path, step.conflict.id, "right")
                await accept(path, step.conflict.id)
            }
        }
    }

    expect(git(path, "show", "sibling:sibling.txt")).toBe("sibling")
    expect(git(path, "merge-base", "lower", "topic")).toBe(git(path, "rev-parse", "lower"))
}, 180_000)
