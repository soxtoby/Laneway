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
        const repository = await temporaryDirectory("workbench git root ")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        const child = resolve(repository, "child")
        await Bun.write(resolve(child, ".keep"), "")

        await expect(openRepository(child)).rejects.toMatchObject({ code: "git.invalid-root" })
        expect((await connectRepository(child)).descriptor.root).toBe(repository)

        const linked = await temporaryDirectory("workbench linked ")
        expect(runGit(repository, "worktree", "add", "--detach", linked).exitCode).toBe(0)
        const opened = await openRepository(linked)
        expect(opened.descriptor.mainWorktree).toBe(repository)
        expect(opened.descriptor.selectedWorktree).toBe(linked)
        expect(opened.descriptor.id).toBe(resolve(repository, ".git"))
    })

    test("rejects bare repositories with an explanation", async () => {
        const repository = await temporaryDirectory("workbench-bare-")
        expect(runGit(repository, "init", "--bare", "--quiet").exitCode).toBe(0)

        await expect(openRepository(repository)).rejects.toMatchObject({
            code: "git.bare-repository",
            message: expect.stringContaining("Main Worktree"),
        })
    })

    test("explains a linked worktree whose Main Worktree is missing", async () => {
        const repository = await temporaryDirectory("workbench-missing-main-")
        const linkedParent = await temporaryDirectory("workbench-missing-main-linked-")
        const linked = resolve(linkedParent, "linked")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
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
            const repository = resolve(await temporaryDirectory(`workbench-${objectFormat}-`), "repository")
            expect(runGit(resolve(repository, ".."), "init", `--object-format=${objectFormat}`, "--quiet", repository).exitCode).toBe(0)
            const git = await openRepository(repository)
            expect(git.descriptor.objectFormat).toBe(objectFormat)

            const objectId = await git.hashObject(`${objectFormat}\n`)
            await git.updateRefs([{ ref: "refs/workbench/test/object-format", before: null, after: objectId }])
            expect(await git.resolveRef("refs/workbench/test/object-format")).toBe(objectId)
            await git.updateRefs([{ ref: "refs/workbench/test/object-format", before: objectId, after: null }])
            expect(await git.resolveRef("refs/workbench/test/object-format")).toBeNull()
        })

        test(`reads a verified ${objectFormat} Branch Graph and lazy history`, async () => {
            const repository = resolve(await temporaryDirectory(`workbench-graph-${objectFormat}-`), "repository")
            expect(runGit(resolve(repository, ".."), "init", `--object-format=${objectFormat}`, "--initial-branch=main", "--quiet", repository).exitCode).toBe(
                0,
            )
            expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
            expect(runGit(repository, "config", "user.email", "primary@example.invalid").exitCode).toBe(0)
            await commitFile(repository, "README.md", "initial\n", "Initial")
            const mainTip = gitText(repository, "rev-parse", "HEAD")
            expect(runGit(repository, "update-ref", "refs/remotes/upstream/main", mainTip).exitCode).toBe(0)
            expect(runGit(repository, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main").exitCode).toBe(0)
            expect(runGit(repository, "config", "branch.main.remote", "upstream").exitCode).toBe(0)
            expect(runGit(repository, "config", "branch.main.merge", "refs/heads/main").exitCode).toBe(0)

            expect(runGit(repository, "checkout", "-q", "-b", "feature/base").exitCode).toBe(0)
            await writeFile(resolve(repository, ".mailmap"), "Secondary Author <secondary@example.invalid> Workbench Test <legacy@example.invalid>\n")
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
            const detached = resolve(await temporaryDirectory(`workbench-graph-detached-${objectFormat}-`), "detached")
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
                baseTip,
                limit: 1,
            }).result
            expect(history.commits).toHaveLength(1)
            expect(history.commits[0]).toMatchObject({ objectId: tip, subject: "Second tip commit" })
            expect(history.nextOffset).toBe(1)
        })
    }

    test("retains divergent upstream tips and reports an ambiguous Base without a Primary Branch", async () => {
        const repository = await temporaryDirectory("workbench-graph-ambiguous-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
        await commitFile(repository, "README.md", "initial\n", "Initial")
        const initial = gitText(repository, "rev-parse", "HEAD")
        expect(runGit(repository, "checkout", "-q", "-b", "candidate/left").exitCode).toBe(0)
        await commitFile(repository, "left.txt", "left\n", "Left")
        expect(runGit(repository, "checkout", "-q", "-b", "candidate/right", initial).exitCode).toBe(0)
        await commitFile(repository, "right.txt", "right\n", "Right")
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
            authorIdentities: { primary: "workbench@example.invalid", secondary: [] },
            remotePatterns: ["origin/**"],
        }).result
        const feature = graph.branches.find(branch => branch.preferredRef == "refs/heads/feature/ambiguous")!
        expect(feature.tip).toBe(localTip)
        expect(feature.upstreamTip).toBe(remoteTip)
        expect(feature).toMatchObject({ ahead: 1, behind: 1 })
        expect(feature.base.status).toBe("ambiguous")
        if (feature.base.status == "ambiguous")
            expect(feature.base.candidates.map(candidate => candidate.name)).toEqual(expect.arrayContaining(["candidate/left", "candidate/right", "main"]))
    })

    test("reads a many-branch graph in under one second", async () => {
        const repository = await temporaryDirectory("workbench-graph-performance-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
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
            authorIdentities: { primary: "workbench@example.invalid", secondary: [] },
            remotePatterns: [],
        }).result
        const elapsed = performance.now() - started

        expect(graph.branches).toHaveLength(41)
        expect(elapsed).toBeLessThan(1_000)
    })

    test("initializes populated directories and clones a disposable local remote", async () => {
        const populated = await temporaryDirectory("workbench-init-")
        await writeFile(resolve(populated, "kept.txt"), "keep me")
        const initialized = await initializeRepository({ path: populated, initialBranch: "entry-test" })
        expect(initialized.descriptor.root).toBe(populated)
        expect(await Bun.file(resolve(populated, "kept.txt")).text()).toBe("keep me")

        const destination = resolve(await temporaryDirectory("workbench-clone-parent-"), "cloned repository")
        const clone = await startCloneRepository({ source: populated, destination })
        expect((await clone.result).descriptor.root).toBe(destination)
    })

    test("rejects a non-empty clone destination without changing it", async () => {
        const source = await temporaryDirectory("workbench-clone-source-")
        expect(runGit(source, "init", "--quiet").exitCode).toBe(0)
        const destination = await temporaryDirectory("workbench-clone-conflict-")
        await writeFile(resolve(destination, "keep.txt"), "keep me")

        await expect(startCloneRepository({ source, destination })).rejects.toMatchObject({
            code: "git.destination-conflict",
            details: { destination },
        })
        expect(await Bun.file(resolve(destination, "keep.txt")).text()).toBe("keep me")
    })

    test("cancels clone without deleting a destination Workbench created", async () => {
        const source = await temporaryDirectory("workbench-cancel-source-")
        expect(runGit(source, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(source, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(source, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
        for (let index = 0; index < 250; index += 1)
            await writeFile(resolve(source, `file-${index}.txt`), `${"content ".repeat(500)}${index}\n`)
        expect(runGit(source, "add", ".").exitCode).toBe(0)
        expect(runGit(source, "commit", "--quiet", "-m", "Clone source").exitCode).toBe(0)

        const destination = resolve(await temporaryDirectory("workbench-cancel-parent-"), "partial")
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
