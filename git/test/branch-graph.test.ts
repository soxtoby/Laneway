import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"
import { openRepository } from "../src/index"

let temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Branch Graph and lazy history", () => {
    for (let objectFormat of ["sha1", "sha256"] as const) {
        test(`reads a verified ${objectFormat} Branch Graph and lazy history`, async () => {
            let repository = resolve(await temporaryDirectory(`laneway-graph-${objectFormat}-`), "repository")
            expect(runGit(resolve(repository, ".."), "init", `--object-format=${objectFormat}`, "--initial-branch=main", "--quiet", repository).exitCode).toBe(
                0,
            )
            expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
            expect(runGit(repository, "config", "user.email", "primary@example.invalid").exitCode).toBe(0)
            await commitFile(repository, "README.md", "initial\n", "Initial")
            let mainTip = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "remote", "add", "upstream", ".").exitCode).toBe(0)
            expect(runGit(repository, "update-ref", "refs/remotes/upstream/main", mainTip).exitCode).toBe(0)
            expect(runGit(repository, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main").exitCode).toBe(0)
            expect(runGit(repository, "config", "branch.main.remote", "upstream").exitCode).toBe(0)
            expect(runGit(repository, "config", "branch.main.merge", "refs/heads/main").exitCode).toBe(0)

            expect(runGit(repository, "checkout", "-q", "-b", "feature/base").exitCode).toBe(0)
            await writeFile(resolve(repository, ".mailmap"), "Secondary Author <secondary@example.invalid> Laneway Test <legacy@example.invalid>\n")
            expect(runGit(repository, "add", ".mailmap").exitCode).toBe(0)
            await commitFile(repository, "base.txt", "base\n", "Base work")
            let baseTip = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "checkout", "-q", "-b", "feature/tip").exitCode).toBe(0)
            expect(runGit(repository, "config", "user.email", "legacy@example.invalid").exitCode).toBe(0)
            await commitFile(repository, "tip.txt", "one\n", "First tip commit")
            let taggedCommit = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "tag", "waypoint", taggedCommit).exitCode).toBe(0)
            expect(runGit(repository, "config", "user.email", "unrelated@example.invalid").exitCode).toBe(0)
            await commitFile(repository, "tip.txt", "two\n", "Second tip commit")
            expect(
                runGit(repository, "commit", "--quiet", "--amend", "-m", "Second tip commit", "-m", "Explains the tip.", "-m", "In two paragraphs.").exitCode,
            ).toBe(0)
            let tip = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "branch", "feature/alias", tip).exitCode).toBe(0)
            await writeFile(resolve(repository, "working.txt"), "stashed\n")
            expect(runGit(repository, "add", "working.txt").exitCode).toBe(0)
            expect(runGit(repository, "stash", "push", "-m", "Graph marker").exitCode).toBe(0)
            let detached = resolve(await temporaryDirectory(`laneway-graph-detached-${objectFormat}-`), "detached")
            expect(runGit(repository, "worktree", "add", "--detach", detached, mainTip).exitCode).toBe(0)

            let opened = await openRepository(repository)
            let graph = await opened.startReadBranchGraph({
                authorIdentities: { primary: "primary@example.invalid", secondary: ["secondary@example.invalid"] },
                selectedRemote: "upstream",
                remotePatterns: [],
            }).result

            let tipNode = graph.branches.find(branch => branch.refs.includes("refs/heads/feature/tip"))!
            expect(tipNode.localRefs).toContain("refs/heads/feature/alias")
            expect(tipNode.base).toMatchObject({ status: "known", ref: "refs/heads/feature/base", tip: baseTip })
            expect(tipNode.involvement).toBe("involved")
            expect(tipNode.markers).toHaveLength(1)
            expect(tipNode.markers[0].tooltip).toContain("Graph marker")
            expect(graph.primaryBranch).toMatchObject({ status: "known", remote: "upstream", ref: "refs/remotes/upstream/main" })
            expect(graph.virtualBranches).toContainEqual(expect.objectContaining({ name: basename(detached), objectId: mainTip }))
            expect(graph.tags).toContainEqual(expect.objectContaining({ name: "waypoint", objectId: taggedCommit, parentBranchId: tipNode.id }))

            let history = await opened.startReadBranchHistory({
                branchRef: "refs/heads/feature/tip",
                tip,
                baseTips: [baseTip],
                limit: 1,
            }).result
            expect(history.commits).toHaveLength(1)
            expect(history.commits[0]).toMatchObject({ objectId: tip, subject: "Second tip commit", body: "Explains the tip.\n\nIn two paragraphs." })
            expect(history.nextOffset).toBe(1)

            expect(runGit(repository, "checkout", "-q", "main").exitCode).toBe(0)
            expect(runGit(repository, "merge", "--no-ff", "feature/tip", "-m", "Merge feature").exitCode).toBe(0)
            let mergeTip = gitText(repository, "rev-parse", "HEAD")
            let mergedGraph = await opened.startReadBranchGraph({
                authorIdentities: { primary: "primary@example.invalid", secondary: ["secondary@example.invalid"] },
                selectedRemote: "upstream",
                remotePatterns: [],
            }).result
            expect(mergedGraph.branches.find(branch => branch.refs.includes("refs/heads/feature/tip"))?.merged).toBe(true)
            expect(mergedGraph.history.find(point => point.objectId == mergeTip)?.parentIds).toEqual([mainTip, tip])
            expect(mergedGraph.history.find(point => point.objectId == tip)?.parentIds).toEqual([taggedCommit])
            expect(mergedGraph.history.find(point => point.objectId == taggedCommit)?.parentIds).toEqual([baseTip])
            expect(mergedGraph.history.find(point => point.objectId == baseTip)?.parentIds).toEqual([mainTip])
        })
    }

    test("retains divergent upstream tips and reports an ambiguous Base without a Primary Branch", async () => {
        let repository = await temporaryDirectory("laneway-graph-ambiguous-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        let initial = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "candidate/left").exitCode).toBe(0)
        await commitFile(repository, "left.txt", "left\n", "Left")
        expect(runGit(repository, "checkout", "-q", "-b", "candidate/right", initial).exitCode).toBe(0)
        await commitFile(repository, "right.txt", "right\n", "Right")
        expect(runGit(repository, "checkout", "-q", "main").exitCode).toBe(0)
        await commitFile(repository, "main.txt", "main\n", "Main")
        expect(runGit(repository, "checkout", "-q", "-b", "feature/ambiguous", initial).exitCode).toBe(0)
        await commitFile(repository, "feature.txt", "feature\n", "Feature")

        let localTip = gitText(repository, "rev-parse", "HEAD")
        let initialTree = gitText(repository, "rev-parse", `${initial}^{tree}`)
        let remoteTip = gitText(repository, "commit-tree", initialTree, "-p", initial, "-m", "Remote divergence")
        expect(runGit(repository, "remote", "add", "origin", ".").exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/feature/ambiguous", remoteTip).exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.feature/ambiguous.remote", "origin").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.feature/ambiguous.merge", "refs/heads/feature/ambiguous").exitCode).toBe(0)

        let graph = await (await openRepository(repository)).startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: ["origin/**"],
        }).result
        let feature = graph.branches.find(branch => branch.preferredRef == "refs/heads/feature/ambiguous")!

        expect(feature.tip).toBe(localTip)
        expect(feature.upstreamTip).toBe(remoteTip)
        expect(feature.published).toBe(false)
        expect(graph.remoteTips).toContain(remoteTip)
        expect(feature).toMatchObject({ ahead: 1, behind: 1 })
        expect(feature.base.status).toBe("ambiguous")
        if (feature.base.status == "ambiguous") {
            expect(feature.base.candidates.map(candidate => candidate.name)).toEqual(expect.arrayContaining(["candidate/left", "candidate/right", "main"]))
            let history = await (await openRepository(repository)).startReadBranchHistory({
                branchRef: feature.preferredRef,
                tip: feature.tip,
                baseTips: feature.base.candidates.map(candidate => candidate.tip),
                limit: 50,
            }).result
            expect(history.commits.map(commit => commit.objectId)).toEqual([localTip])
            expect(history.nextOffset).toBeUndefined()
        }
    })

    test("falls back below a fork when sibling branches would be each other's Base", async () => {
        let repository = await temporaryDirectory("laneway-graph-siblings-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/base").exitCode).toBe(0)
        await commitFile(repository, "base.txt", "base\n", "Base")
        let baseTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/right").exitCode).toBe(0)
        await commitFile(repository, "shared.txt", "shared\n", "Shared")
        let shared = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "right.txt", "one\n", "Right one")
        await commitFile(repository, "right.txt", "two\n", "Right two")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/left", shared).exitCode).toBe(0)
        await commitFile(repository, "left.txt", "left\n", "Left")

        let opened = await openRepository(repository)
        let graph = await opened.startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: [],
        }).result
        for (let name of ["stack/left", "stack/right"]) {
            let branch = graph.branches.find(candidate => candidate.name == name)!
            expect(branch.base).toMatchObject({ status: "known", ref: "refs/heads/stack/base", tip: baseTip })

            let history = await opened.startReadBranchHistory({ branchRef: branch.preferredRef, tip: branch.tip, baseTips: [baseTip], limit: 50 }).result
            expect(history.commits.at(-1)?.objectId).toBe(shared)
        }
    })

    test("falls back below a fork when a sibling has branches stacked on it", async () => {
        let repository = await temporaryDirectory("laneway-graph-stacked-siblings-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        let mainTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/right").exitCode).toBe(0)
        await commitFile(repository, "early.txt", "early\n", "Early")
        let early = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "shared.txt", "shared\n", "Shared")
        let shared = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "right.txt", "right\n", "Right")
        let rightTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/middle").exitCode).toBe(0)
        await commitFile(repository, "middle.txt", "middle\n", "Middle")
        let middleTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/top").exitCode).toBe(0)
        await commitFile(repository, "top.txt", "top\n", "Top")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/left", shared).exitCode).toBe(0)
        await commitFile(repository, "left.txt", "left\n", "Left")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/lower", early).exitCode).toBe(0)
        await commitFile(repository, "lower.txt", "lower\n", "Lower")

        let opened = await openRepository(repository)
        let graph = await opened.startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: [],
        }).result
        let base = (name: string) => graph.branches.find(candidate => candidate.name == name)!.base
        expect(base("stack/lower")).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(base("stack/left")).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(base("stack/right")).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(base("stack/middle")).toMatchObject({ status: "known", ref: "refs/heads/stack/right", tip: rightTip })
        expect(base("stack/top")).toMatchObject({ status: "known", ref: "refs/heads/stack/middle", tip: middleTip })
    })

    test("keeps a sibling whose upstream sits at the fork as the other's Base", async () => {
        let repository = await temporaryDirectory("laneway-graph-published-fork-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        let mainTip = gitText(repository, "rev-parse", "HEAD")
        // stack/lower was published at the fork, then gained an unpublished commit while stack/upper still sits on the published tip.
        expect(runGit(repository, "checkout", "-q", "-b", "stack/lower").exitCode).toBe(0)
        await commitFile(repository, "lower.txt", "lower\n", "Lower")
        let fork = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/upper").exitCode).toBe(0)
        await commitFile(repository, "upper.txt", "upper\n", "Upper")
        expect(runGit(repository, "checkout", "-q", "stack/lower").exitCode).toBe(0)
        await commitFile(repository, "lower.txt", "lower again\n", "Lower again")
        let lowerTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "remote", "add", "origin", ".").exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/stack/lower", fork).exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.stack/lower.remote", "origin").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.stack/lower.merge", "refs/heads/stack/lower").exitCode).toBe(0)

        let graph = await (await openRepository(repository)).startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: [],
        }).result
        let base = (name: string) => graph.branches.find(candidate => candidate.name == name)!.base
        expect(base("stack/lower")).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(base("stack/upper")).toMatchObject({ status: "known", ref: "refs/heads/stack/lower", tip: lowerTip })
    })

    test("keeps the Primary Branch as Base beneath merged siblings sharing its fork point", async () => {
        let repository = await temporaryDirectory("laneway-graph-merged-siblings-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        // A stale ref on the main line beneath the fork point, like an old integration target.
        expect(runGit(repository, "branch", "stale/target").exitCode).toBe(0)
        await commitFile(repository, "fork.txt", "fork\n", "Fork point")
        let fork = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "feature/open").exitCode).toBe(0)
        await commitFile(repository, "open.txt", "open\n", "Open work")
        for (let name of ["merged/one", "merged/two"]) {
            expect(runGit(repository, "checkout", "-q", "-b", name, fork).exitCode).toBe(0)
            await commitFile(repository, `${name.replace("/", "-")}.txt`, "merged\n", `Merged ${name}`)
            expect(runGit(repository, "checkout", "-q", "main").exitCode).toBe(0)
            expect(runGit(repository, "merge", "--no-ff", name, "-m", `Merge ${name}`).exitCode).toBe(0)
        }
        // A branch fast-forwarded onto the main line after the fork point.
        expect(runGit(repository, "checkout", "-q", "-b", "merged/fast-forward").exitCode).toBe(0)
        await commitFile(repository, "fast-forward.txt", "fast-forward\n", "Fast-forwarded work")
        expect(runGit(repository, "checkout", "-q", "main").exitCode).toBe(0)
        expect(runGit(repository, "merge", "--ff-only", "merged/fast-forward").exitCode).toBe(0)
        let mainTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "remote", "add", "upstream", ".").exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/upstream/main", mainTip).exitCode).toBe(0)
        expect(runGit(repository, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.main.remote", "upstream").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.main.merge", "refs/heads/main").exitCode).toBe(0)

        let opened = await openRepository(repository)
        let graph = await opened.startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            selectedRemote: "upstream",
            remotePatterns: [],
        }).result
        let open = graph.branches.find(candidate => candidate.name == "feature/open")!
        expect(open.base).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(open.merged).toBe(false)
        for (let name of ["merged/one", "merged/two", "stale/target"])
            expect(graph.branches.find(candidate => candidate.name == name)?.merged).toBe(true)
        expect(graph.branches.find(candidate => candidate.name == "main")?.localRefs).toContain("refs/heads/merged/fast-forward")
    })

    test("marks branch history commits their remote already reaches", async () => {
        let repository = await temporaryDirectory("laneway-graph-remote-history-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        let baseTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "feature").exitCode).toBe(0)
        await commitFile(repository, "feature.txt", "one\n", "Published one")
        let publishedOne = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "feature.txt", "two\n", "Published two")
        let publishedTwo = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "feature.txt", "three\n", "Local")
        let local = gitText(repository, "rev-parse", "HEAD")

        // A backup with no upstream whose commits another remote branch already carries.
        expect(runGit(repository, "checkout", "-q", "-b", "backup", baseTip).exitCode).toBe(0)
        await commitFile(repository, "backup.txt", "backup\n", "Backed up")
        let backedUp = gitText(repository, "rev-parse", "HEAD")
        let copy = gitText(repository, "commit-tree", `${backedUp}^{tree}`, "-p", backedUp, "-m", "Copy")
        expect(runGit(repository, "remote", "add", "origin", ".").exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/feature", publishedTwo).exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/copy", copy).exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/main", baseTip).exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.main.remote", "origin").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.main.merge", "refs/heads/main").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.feature.remote", "origin").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.feature.merge", "refs/heads/feature").exitCode).toBe(0)

        let opened = await openRepository(repository)
        let graph = await opened.startReadBranchGraph({ authorIdentities: { primary: "laneway@example.invalid", secondary: [] }, remotePatterns: [] }).result
        expect(graph.remoteTips.toSorted()).toEqual([publishedTwo, copy, baseTip].toSorted())

        let node = (name: string) => graph.branches.find(branch => branch.name == name)!
        // Only a branch's own remote refs publish it; backup stays local although origin/copy carries its commits.
        expect([node("feature").published, node("backup").published, node("main").published]).toEqual([false, false, true])

        let read = (branch: string, tip: string, remoteTips?: string[]) =>
            opened.startReadBranchHistory({ branchRef: `refs/heads/${branch}`, tip, baseTips: [baseTip], remoteTips, limit: 50 }).result
        let remoteFlags = (page: Awaited<ReturnType<typeof read>>) => page.commits.map(commit => [commit.objectId, commit.remote])

        expect(remoteFlags(await read("feature", local, graph.remoteTips))).toEqual([[local, false], [publishedTwo, true], [publishedOne, true]])
        expect(remoteFlags(await read("backup", backedUp, graph.remoteTips))).toEqual([[backedUp, true]])
        expect(remoteFlags(await read("feature", local, [local]))).toEqual([[local, true], [publishedTwo, true], [publishedOne, true]])
        expect(remoteFlags(await read("feature", local))).toEqual([[local, undefined], [publishedTwo, undefined], [publishedOne, undefined]])
    })

    test("reads branch history along the first parent of merge commits", async () => {
        let repository = await temporaryDirectory("laneway-graph-first-parent-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        let baseTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "side").exitCode).toBe(0)
        await commitFile(repository, "side.txt", "side\n", "Side work")
        let sideTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "feature", baseTip).exitCode).toBe(0)
        await commitFile(repository, "feature.txt", "feature\n", "Feature work")
        let featureCommit = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "merge", "--no-ff", "side", "-m", "Merge side").exitCode).toBe(0)
        let mergeTip = gitText(repository, "rev-parse", "HEAD")

        let history = await (await openRepository(repository)).startReadBranchHistory({
            branchRef: "refs/heads/feature",
            tip: mergeTip,
            baseTips: [baseTip],
            limit: 50,
        }).result
        expect(history.commits.map(commit => commit.objectId)).toEqual([mergeTip, featureCommit])
        expect(history.commits.map(commit => commit.objectId)).not.toContain(sideTip)
    })

    test("marks a branch whose Base moved on after it forked", async () => {
        let repository = await temporaryDirectory("laneway-graph-behind-base-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        expect(runGit(repository, "checkout", "-q", "-b", "one").exitCode).toBe(0)
        await commitFile(repository, "one.txt", "one\n", "One")
        expect(runGit(repository, "checkout", "-q", "-b", "two").exitCode).toBe(0)
        await commitFile(repository, "two.txt", "two\n", "Two")
        expect(runGit(repository, "checkout", "-q", "main").exitCode).toBe(0)
        await commitFile(repository, "main.txt", "main\n", "Main moves on")
        expect(runGit(repository, "remote", "add", "upstream", ".").exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/upstream/main", "main").exitCode).toBe(0)
        expect(runGit(repository, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main").exitCode).toBe(0)

        let opened = await openRepository(repository)
        let options = { authorIdentities: { primary: "laneway@example.invalid", secondary: [] }, selectedRemote: "upstream", remotePatterns: [] }
        let graph = await opened.startReadBranchGraph(options).result
        let behindBase = Object.fromEntries(graph.branches.map(branch => [branch.name, branch.behindBase]))

        expect(behindBase).toEqual({ main: false, one: true, two: false })
    })

    test("keeps the Primary Branch as Base for a branch it has moved past", async () => {
        let repository = await temporaryDirectory("laneway-graph-passed-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        let fork = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "second.txt", "second\n", "Second")
        // A local branch left on the main line after its work was fast-forwarded into main.
        expect(runGit(repository, "branch", "merged/behind").exitCode).toBe(0)
        let behindTip = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "third.txt", "third\n", "Third")
        let mainTip = gitText(repository, "rev-parse", "HEAD")
        // Someone else's remote-only branches forked beneath the stale tip; they must not become its Base candidates.
        for (let name of ["other/one", "other/two"]) {
            expect(runGit(repository, "checkout", "-q", "-b", name, fork).exitCode).toBe(0)
            expect(runGit(repository, "-c", "user.email=other@example.invalid", "commit", "--quiet", "--allow-empty", "-m", `Other ${name}`).exitCode).toBe(0)
            expect(runGit(repository, "update-ref", `refs/remotes/upstream/${name}`, gitText(repository, "rev-parse", "HEAD")).exitCode).toBe(0)
            expect(runGit(repository, "checkout", "-q", "main").exitCode).toBe(0)
            expect(runGit(repository, "branch", "-D", name).exitCode).toBe(0)
        }
        expect(runGit(repository, "remote", "add", "upstream", ".").exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/upstream/main", mainTip).exitCode).toBe(0)
        expect(runGit(repository, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.main.remote", "upstream").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.main.merge", "refs/heads/main").exitCode).toBe(0)

        let opened = await openRepository(repository)
        let options = { authorIdentities: { primary: "laneway@example.invalid", secondary: [] }, selectedRemote: "upstream", remotePatterns: [] }
        let graph = await opened.startReadBranchGraph(options).result
        let behind = graph.branches.find(candidate => candidate.name == "merged/behind")!
        expect(behind.tip).toBe(behindTip)
        expect(behind.base).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(behind.merged).toBe(true)
        expect(graph.branches.map(branch => branch.name).sort()).toEqual(["main", "merged/behind"])

        let everything = await opened.startReadBranchGraph({ ...options, allBranches: true }).result
        expect(everything.branches.map(branch => branch.name).sort()).toEqual(["main", "merged/behind", "upstream/other/one", "upstream/other/two"])
        for (let name of ["upstream/other/one", "upstream/other/two"]) {
            let other = everything.branches.find(candidate => candidate.name == name)!
            expect(other.remoteOnly).toBe(true)
            expect(other.involvement).toBe("uninvolved")
            expect(other.base).toMatchObject({ status: "known", ref: "refs/heads/main" })
        }
    })

    test("reads a many-branch graph in under one second", async () => {
        let repository = await temporaryDirectory("laneway-graph-performance-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        let initial = gitText(repository, "rev-parse", "HEAD")
        let tree = gitText(repository, "rev-parse", "HEAD^{tree}")
        for (let index = 0; index < 40; index += 1) {
            let tip = gitText(repository, "commit-tree", tree, "-p", initial, "-m", `Branch ${index}`)
            expect(runGit(repository, "update-ref", `refs/heads/branch-${index}`, tip).exitCode).toBe(0)
        }

        let opened = await openRepository(repository)
        let started = performance.now()
        let graph = await opened.startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: [],
        }).result
        let elapsed = performance.now() - started

        expect(graph.branches).toHaveLength(41)
        expect(elapsed).toBeLessThan(1_000)
    }, 30_000)
})

async function temporaryDirectory(prefix: string) {
    let path = await mkdtemp(resolve(tmpdir(), prefix))
    temporaryDirectories.push(path)
    return path
}

function gitText(cwd: string, ...args: string[]) {
    let result = runGit(cwd, ...args)
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
}

async function commitFile(repository: string, path: string, content: string, message: string) {
    await writeFile(resolve(repository, path), content)
    expect(runGit(repository, "add", path).exitCode).toBe(0)
    expect(runGit(repository, "commit", "--quiet", "-m", message).exitCode).toBe(0)
}

function runGit(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
}
