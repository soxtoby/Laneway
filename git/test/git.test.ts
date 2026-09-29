import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"
import { connectRepository, GitError, inferCloneDirectoryName, initializeRepository, openRepository, parseGitVersion, redactGitText, selectGit, startCloneRepository } from "../src/index"

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string) {
    const path = await mkdtemp(resolve(tmpdir(), prefix))
    temporaryDirectories.push(path)
    return path
}

function runGit(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
}

function gitText(cwd: string, ...args: string[]) {
    const result = runGit(cwd, ...args)
    expect(result.exitCode).toBe(0)
    return result.stdout.toString().trim()
}

async function commitFile(repository: string, path: string, content: string, message: string) {
    await writeFile(resolve(repository, path), content)
    expect(runGit(repository, "add", path).exitCode).toBe(0)
    expect(runGit(repository, "commit", "--quiet", "-m", message).exitCode).toBe(0)
}

describe("system Git", () => {
    test("parses vendor versions and enforces the V1 floor", () => {
        expect(parseGitVersion("git version 2.51.1.windows.1\n")).toBe("2.51.1")
        expect(() => parseGitVersion("git version 2.40.9")).toThrow(GitError)
        expect(() => parseGitVersion("not git")).toThrow(GitError)
    })

    test("redacts credentials, sensitive query values, headers, and exact secrets", () => {
        expect(redactGitText(
            "fatal: https://user:password@example.test/repo.git?token=secret\nAuthorization: bearer secret",
            ["secret"],
        )).toBe("fatal: https://example.test/repo.git?token=[redacted]\nAuthorization: [redacted]")
    })

    test("resolves the selected executable", async () => {
        const git = await selectGit()
        expect(git.version).toMatch(/^\d+\.\d+\.\d+$/)
        expect(git.path.toLowerCase()).toContain("git")
    })

    test("requires an exact repository root and accepts a linked worktree", async () => {
        const repository = await temporaryDirectory("laneway git root ")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        const child = resolve(repository, "child")
        await Bun.write(resolve(child, ".keep"), "")

        await expect(openRepository(child)).rejects.toMatchObject({ code: "git.invalid-root" })
        expect((await connectRepository(child)).descriptor.root).toBe(repository)

        const linked = await temporaryDirectory("laneway linked ")
        expect(runGit(repository, "worktree", "add", "--detach", linked).exitCode).toBe(0)
        const opened = await openRepository(linked)
        expect(opened.descriptor.mainWorktree).toBe(repository)
        expect(opened.descriptor.selectedWorktree).toBe(linked)
        expect(opened.descriptor.id).toBe(resolve(repository, ".git"))
    })

    test("rejects bare repositories with an explanation", async () => {
        const repository = await temporaryDirectory("laneway-bare-")
        expect(runGit(repository, "init", "--bare", "--quiet").exitCode).toBe(0)

        await expect(openRepository(repository)).rejects.toMatchObject({
            code: "git.bare-repository",
            message: expect.stringContaining("Main Worktree"),
        })
    })

    test("explains a linked worktree whose Main Worktree is missing", async () => {
        const repository = await temporaryDirectory("laneway-missing-main-")
        const linkedParent = await temporaryDirectory("laneway-missing-main-linked-")
        const linked = resolve(linkedParent, "linked")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        expect(runGit(repository, "worktree", "add", "--detach", linked).exitCode).toBe(0)
        await rm(repository, { recursive: true, force: true })

        await expect(openRepository(linked)).rejects.toMatchObject({
            code: "git.missing-main-worktree",
            message: expect.stringContaining("Main Worktree"),
        })
    })

    for (const objectFormat of ["sha1", "sha256"] as const) {
        test(`initializes and mutates a ${objectFormat} repository`, async () => {
            const repository = resolve(await temporaryDirectory(`laneway-${objectFormat}-`), "repository")
            expect(runGit(resolve(repository, ".."), "init", `--object-format=${objectFormat}`, "--quiet", repository).exitCode).toBe(0)
            const git = await openRepository(repository)
            expect(git.descriptor.objectFormat).toBe(objectFormat)

            const objectId = await git.hashObject(`${objectFormat}\n`)
            await git.updateRefs([{ ref: "refs/laneway/test/object-format", before: null, after: objectId }])
            expect(await git.resolveRef("refs/laneway/test/object-format")).toBe(objectId)
            await git.updateRefs([{ ref: "refs/laneway/test/object-format", before: objectId, after: null }])
            expect(await git.resolveRef("refs/laneway/test/object-format")).toBeNull()
        })

        test(`reads a verified ${objectFormat} Branch Graph and lazy history`, async () => {
            const repository = resolve(await temporaryDirectory(`laneway-graph-${objectFormat}-`), "repository")
            expect(runGit(resolve(repository, ".."), "init", `--object-format=${objectFormat}`, "--initial-branch=main", "--quiet", repository).exitCode).toBe(
                0,
            )
            expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
            expect(runGit(repository, "config", "user.email", "primary@example.invalid").exitCode).toBe(0)
            await commitFile(repository, "README.md", "initial\n", "Initial")
            const mainTip = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "remote", "add", "upstream", ".").exitCode).toBe(0)
            expect(runGit(repository, "update-ref", "refs/remotes/upstream/main", mainTip).exitCode).toBe(0)
            expect(runGit(repository, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main").exitCode).toBe(0)
            expect(runGit(repository, "config", "branch.main.remote", "upstream").exitCode).toBe(0)
            expect(runGit(repository, "config", "branch.main.merge", "refs/heads/main").exitCode).toBe(0)

            expect(runGit(repository, "checkout", "-q", "-b", "feature/base").exitCode).toBe(0)
            await writeFile(resolve(repository, ".mailmap"), "Secondary Author <secondary@example.invalid> Laneway Test <legacy@example.invalid>\n")
            expect(runGit(repository, "add", ".mailmap").exitCode).toBe(0)
            await commitFile(repository, "base.txt", "base\n", "Base work")
            const baseTip = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "checkout", "-q", "-b", "feature/tip").exitCode).toBe(0)
            expect(runGit(repository, "config", "user.email", "legacy@example.invalid").exitCode).toBe(0)
            await commitFile(repository, "tip.txt", "one\n", "First tip commit")
            const taggedCommit = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "tag", "waypoint", taggedCommit).exitCode).toBe(0)
            expect(runGit(repository, "config", "user.email", "unrelated@example.invalid").exitCode).toBe(0)
            await commitFile(repository, "tip.txt", "two\n", "Second tip commit")
            const tip = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "branch", "feature/alias", tip).exitCode).toBe(0)
            await writeFile(resolve(repository, "working.txt"), "stashed\n")
            expect(runGit(repository, "add", "working.txt").exitCode).toBe(0)
            expect(runGit(repository, "stash", "push", "-m", "Graph marker").exitCode).toBe(0)
            const detached = resolve(await temporaryDirectory(`laneway-graph-detached-${objectFormat}-`), "detached")
            expect(runGit(repository, "worktree", "add", "--detach", detached, mainTip).exitCode).toBe(0)

            const opened = await openRepository(repository)
            const graph = await opened.startReadBranchGraph({
                authorIdentities: { primary: "primary@example.invalid", secondary: ["secondary@example.invalid"] },
                selectedRemote: "upstream",
                remotePatterns: [],
            }).result

            const tipNode = graph.branches.find(branch => branch.refs.includes("refs/heads/feature/tip"))!
            expect(tipNode.localRefs).toContain("refs/heads/feature/alias")
            expect(tipNode.base).toMatchObject({ status: "known", ref: "refs/heads/feature/base", tip: baseTip })
            expect(tipNode.involvement).toBe("involved")
            expect(tipNode.markers).toHaveLength(1)
            expect(tipNode.markers[0].tooltip).toContain("Graph marker")
            expect(graph.primaryBranch).toMatchObject({ status: "known", remote: "upstream", ref: "refs/remotes/upstream/main" })
            expect(graph.virtualBranches).toContainEqual(expect.objectContaining({ name: basename(detached), objectId: mainTip }))
            expect(graph.tags).toContainEqual(expect.objectContaining({ name: "waypoint", objectId: taggedCommit, parentBranchId: tipNode.id }))

            const history = await opened.startReadBranchHistory({
                branchRef: "refs/heads/feature/tip",
                tip,
                baseTips: [baseTip],
                limit: 1,
            }).result
            expect(history.commits).toHaveLength(1)
            expect(history.commits[0]).toMatchObject({ objectId: tip, subject: "Second tip commit" })
            expect(history.nextOffset).toBe(1)

            expect(runGit(repository, "checkout", "-q", "main").exitCode).toBe(0)
            expect(runGit(repository, "merge", "--no-ff", "feature/tip", "-m", "Merge feature").exitCode).toBe(0)
            const mergeTip = gitText(repository, "rev-parse", "HEAD")
            const mergedGraph = await opened.startReadBranchGraph({
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
        const repository = await temporaryDirectory("laneway-graph-ambiguous-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        const initial = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "candidate/left").exitCode).toBe(0)
        await commitFile(repository, "left.txt", "left\n", "Left")
        expect(runGit(repository, "checkout", "-q", "-b", "candidate/right", initial).exitCode).toBe(0)
        await commitFile(repository, "right.txt", "right\n", "Right")
        expect(runGit(repository, "checkout", "-q", "main").exitCode).toBe(0)
        await commitFile(repository, "main.txt", "main\n", "Main")
        expect(runGit(repository, "checkout", "-q", "-b", "feature/ambiguous", initial).exitCode).toBe(0)
        await commitFile(repository, "feature.txt", "feature\n", "Feature")

        const localTip = gitText(repository, "rev-parse", "HEAD")
        const initialTree = gitText(repository, "rev-parse", `${initial}^{tree}`)
        const remoteTip = gitText(repository, "commit-tree", initialTree, "-p", initial, "-m", "Remote divergence")
        expect(runGit(repository, "remote", "add", "origin", ".").exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/feature/ambiguous", remoteTip).exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.feature/ambiguous.remote", "origin").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.feature/ambiguous.merge", "refs/heads/feature/ambiguous").exitCode).toBe(0)

        const graph = await (await openRepository(repository)).startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: ["origin/**"],
        }).result
        const feature = graph.branches.find(branch => branch.preferredRef == "refs/heads/feature/ambiguous")!
        expect(feature.tip).toBe(localTip)
        expect(feature.upstreamTip).toBe(remoteTip)
        expect(feature.published).toBe(false)
        expect(graph.remoteTips).toContain(remoteTip)
        expect(feature).toMatchObject({ ahead: 1, behind: 1 })
        expect(feature.base.status).toBe("ambiguous")
        if (feature.base.status == "ambiguous") {
            expect(feature.base.candidates.map(candidate => candidate.name)).toEqual(expect.arrayContaining(["candidate/left", "candidate/right", "main"]))
            const history = await (await openRepository(repository)).startReadBranchHistory({
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
        const repository = await temporaryDirectory("laneway-graph-siblings-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/base").exitCode).toBe(0)
        await commitFile(repository, "base.txt", "base\n", "Base")
        const baseTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/right").exitCode).toBe(0)
        await commitFile(repository, "shared.txt", "shared\n", "Shared")
        const shared = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "right.txt", "one\n", "Right one")
        await commitFile(repository, "right.txt", "two\n", "Right two")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/left", shared).exitCode).toBe(0)
        await commitFile(repository, "left.txt", "left\n", "Left")

        const opened = await openRepository(repository)
        const graph = await opened.startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: [],
        }).result
        for (const name of ["stack/left", "stack/right"]) {
            const branch = graph.branches.find(candidate => candidate.name == name)!
            expect(branch.base).toMatchObject({ status: "known", ref: "refs/heads/stack/base", tip: baseTip })
            const history = await opened.startReadBranchHistory({ branchRef: branch.preferredRef, tip: branch.tip, baseTips: [baseTip], limit: 50 }).result
            expect(history.commits.at(-1)?.objectId).toBe(shared)
        }
    })

    test("falls back below a fork when a sibling has branches stacked on it", async () => {
        const repository = await temporaryDirectory("laneway-graph-stacked-siblings-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        const mainTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/right").exitCode).toBe(0)
        await commitFile(repository, "early.txt", "early\n", "Early")
        const early = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "shared.txt", "shared\n", "Shared")
        const shared = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "right.txt", "right\n", "Right")
        const rightTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/middle").exitCode).toBe(0)
        await commitFile(repository, "middle.txt", "middle\n", "Middle")
        const middleTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/top").exitCode).toBe(0)
        await commitFile(repository, "top.txt", "top\n", "Top")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/left", shared).exitCode).toBe(0)
        await commitFile(repository, "left.txt", "left\n", "Left")
        expect(runGit(repository, "checkout", "-q", "-b", "stack/lower", early).exitCode).toBe(0)
        await commitFile(repository, "lower.txt", "lower\n", "Lower")

        const opened = await openRepository(repository)
        const graph = await opened.startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: [],
        }).result
        const base = (name: string) => graph.branches.find(candidate => candidate.name == name)!.base
        expect(base("stack/lower")).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(base("stack/left")).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(base("stack/right")).toMatchObject({ status: "known", ref: "refs/heads/main", tip: mainTip })
        expect(base("stack/middle")).toMatchObject({ status: "known", ref: "refs/heads/stack/right", tip: rightTip })
        expect(base("stack/top")).toMatchObject({ status: "known", ref: "refs/heads/stack/middle", tip: middleTip })
    })

    test("marks branch history commits their remote already reaches", async () => {
        const repository = await temporaryDirectory("laneway-graph-remote-history-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        const baseTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "feature").exitCode).toBe(0)
        await commitFile(repository, "feature.txt", "one\n", "Published one")
        const publishedOne = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "feature.txt", "two\n", "Published two")
        const publishedTwo = gitText(repository, "rev-parse", "HEAD")
        await commitFile(repository, "feature.txt", "three\n", "Local")
        const local = gitText(repository, "rev-parse", "HEAD")
        // A backup with no upstream whose commits another remote branch already carries.
        expect(runGit(repository, "checkout", "-q", "-b", "backup", baseTip).exitCode).toBe(0)
        await commitFile(repository, "backup.txt", "backup\n", "Backed up")
        const backedUp = gitText(repository, "rev-parse", "HEAD")
        const copy = gitText(repository, "commit-tree", `${backedUp}^{tree}`, "-p", backedUp, "-m", "Copy")
        expect(runGit(repository, "remote", "add", "origin", ".").exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/feature", publishedTwo).exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/copy", copy).exitCode).toBe(0)
        expect(runGit(repository, "update-ref", "refs/remotes/origin/main", baseTip).exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.main.remote", "origin").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.main.merge", "refs/heads/main").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.feature.remote", "origin").exitCode).toBe(0)
        expect(runGit(repository, "config", "branch.feature.merge", "refs/heads/feature").exitCode).toBe(0)

        const opened = await openRepository(repository)
        const graph = await opened.startReadBranchGraph({ authorIdentities: { primary: "laneway@example.invalid", secondary: [] }, remotePatterns: [] }).result
        expect(graph.remoteTips.toSorted()).toEqual([publishedTwo, copy, baseTip].toSorted())
        const node = (name: string) => graph.branches.find(branch => branch.name == name)!
        // Only a branch's own remote refs publish it; backup stays local although origin/copy carries its commits.
        expect([node("feature").published, node("backup").published, node("main").published]).toEqual([false, false, true])

        const read = (branch: string, tip: string, remoteTips?: string[]) =>
            opened.startReadBranchHistory({ branchRef: `refs/heads/${branch}`, tip, baseTips: [baseTip], remoteTips, limit: 50 }).result
        const remoteFlags = (page: Awaited<ReturnType<typeof read>>) => page.commits.map(commit => [commit.objectId, commit.remote])
        expect(remoteFlags(await read("feature", local, graph.remoteTips))).toEqual([[local, false], [publishedTwo, true], [publishedOne, true]])
        expect(remoteFlags(await read("backup", backedUp, graph.remoteTips))).toEqual([[backedUp, true]])
        expect(remoteFlags(await read("feature", local, [local]))).toEqual([[local, true], [publishedTwo, true], [publishedOne, true]])
        expect(remoteFlags(await read("feature", local))).toEqual([[local, undefined], [publishedTwo, undefined], [publishedOne, undefined]])
    })

    test("reads branch history along the first parent of merge commits", async () => {
        const repository = await temporaryDirectory("laneway-graph-first-parent-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        const baseTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "side").exitCode).toBe(0)
        await commitFile(repository, "side.txt", "side\n", "Side work")
        const sideTip = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "feature", baseTip).exitCode).toBe(0)
        await commitFile(repository, "feature.txt", "feature\n", "Feature work")
        const featureCommit = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "merge", "--no-ff", "side", "-m", "Merge side").exitCode).toBe(0)
        const mergeTip = gitText(repository, "rev-parse", "HEAD")

        const history = await (await openRepository(repository)).startReadBranchHistory({
            branchRef: "refs/heads/feature",
            tip: mergeTip,
            baseTips: [baseTip],
            limit: 50,
        }).result
        expect(history.commits.map(commit => commit.objectId)).toEqual([mergeTip, featureCommit])
        expect(history.commits.map(commit => commit.objectId)).not.toContain(sideTip)
    })

    test("reads a many-branch graph in under one second", async () => {
        const repository = await temporaryDirectory("laneway-graph-performance-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        const initial = gitText(repository, "rev-parse", "HEAD")
        const tree = gitText(repository, "rev-parse", "HEAD^{tree}")
        for (let index = 0; index < 40; index += 1) {
            const tip = gitText(repository, "commit-tree", tree, "-p", initial, "-m", `Branch ${index}`)
            expect(runGit(repository, "update-ref", `refs/heads/branch-${index}`, tip).exitCode).toBe(0)
        }

        const opened = await openRepository(repository)
        const started = performance.now()
        const graph = await opened.startReadBranchGraph({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            remotePatterns: [],
        }).result
        const elapsed = performance.now() - started

        expect(graph.branches).toHaveLength(41)
        expect(elapsed).toBeLessThan(1_000)
    }, 30_000)

    test("initializes populated directories and clones a disposable local remote", async () => {
        const populated = await temporaryDirectory("laneway-init-")
        await writeFile(resolve(populated, "kept.txt"), "keep me")
        const initialized = await initializeRepository({ path: populated, initialBranch: "entry-test" })
        expect(initialized.descriptor.root).toBe(populated)
        expect(await Bun.file(resolve(populated, "kept.txt")).text()).toBe("keep me")

        const destination = resolve(await temporaryDirectory("laneway-clone-parent-"), "cloned repository")
        const clone = await startCloneRepository({ source: populated, destination })
        expect((await clone.result).descriptor.root).toBe(destination)
    })

    test("rejects a non-empty clone destination without changing it", async () => {
        const source = await temporaryDirectory("laneway-clone-source-")
        expect(runGit(source, "init", "--quiet").exitCode).toBe(0)
        const destination = await temporaryDirectory("laneway-clone-conflict-")
        await writeFile(resolve(destination, "keep.txt"), "keep me")

        await expect(startCloneRepository({ source, destination })).rejects.toMatchObject({
            code: "git.destination-conflict",
            details: { destination },
        })
        expect(await Bun.file(resolve(destination, "keep.txt")).text()).toBe("keep me")
    })

    test("cancels clone without deleting a destination Laneway created", async () => {
        const source = await temporaryDirectory("laneway-cancel-source-")
        expect(runGit(source, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(source, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(source, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        for (let index = 0; index < 250; index += 1)
            await writeFile(resolve(source, `file-${index}.txt`), `${"content ".repeat(500)}${index}\n`)
        expect(runGit(source, "add", ".").exitCode).toBe(0)
        expect(runGit(source, "commit", "--quiet", "-m", "Clone source").exitCode).toBe(0)

        const destination = resolve(await temporaryDirectory("laneway-cancel-parent-"), "partial")
        const clone = await startCloneRepository({ source: `file:///${source.replaceAll("\\", "/")}`, destination })
        clone.cancel()

        await expect(clone.result).rejects.toMatchObject({
            code: "git.cancelled",
            details: { destination, createdDestination: true },
        })
    })

    test("infers ordinary clone directory names", () => {
        expect(inferCloneDirectoryName("https://example.test/org/repo.git")).toBe("repo")
        expect(inferCloneDirectoryName("git@example.test:org/repo.git")).toBe("repo")
    })
})
