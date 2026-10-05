import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { connectRepository, GitError, inferCloneDirectoryName, initializeRepository, isLikelyCloneSource, openRepository, parseGitVersion, redactGitText, selectGit, startCloneRepository } from "../src/index"

let temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

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
        let git = await selectGit()
        expect(git.version).toMatch(/^\d+\.\d+\.\d+$/)
        expect(git.path.toLowerCase()).toContain("git")

        let explicit = Bun.which("git")!
        expect((await selectGit(explicit)).path).toBe(resolve(explicit))
    })

    test("requires an exact repository root and accepts a linked worktree", async () => {
        let repository = await temporaryDirectory("laneway git root ")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        let child = resolve(repository, "child")
        await Bun.write(resolve(child, ".keep"), "")

        await expect(openRepository(child)).rejects.toMatchObject({ code: "git.invalid-root" })
        expect((await connectRepository(child)).descriptor.root).toBe(repository)

        let linked = await temporaryDirectory("laneway linked ")
        expect(runGit(repository, "worktree", "add", "--detach", linked).exitCode).toBe(0)
        let opened = await openRepository(linked)

        expect(opened.descriptor.mainWorktree).toBe(repository)
        expect(opened.descriptor.selectedWorktree).toBe(linked)
        expect(opened.descriptor.id).toBe(resolve(repository, ".git"))
    })

    test("rejects bare repositories with an explanation", async () => {
        let repository = await temporaryDirectory("laneway-bare-")
        expect(runGit(repository, "init", "--bare", "--quiet").exitCode).toBe(0)

        await expect(openRepository(repository)).rejects.toMatchObject({
            code: "git.bare-repository",
            message: expect.stringContaining("Main Worktree"),
        })
    })

    test("explains a linked worktree whose Main Worktree is missing", async () => {
        let repository = await temporaryDirectory("laneway-missing-main-")
        let linkedParent = await temporaryDirectory("laneway-missing-main-linked-")
        let linked = resolve(linkedParent, "linked")
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

    for (let objectFormat of ["sha1", "sha256"] as const) {
        test(`initializes and mutates a ${objectFormat} repository`, async () => {
            let repository = resolve(await temporaryDirectory(`laneway-${objectFormat}-`), "repository")
            expect(runGit(resolve(repository, ".."), "init", `--object-format=${objectFormat}`, "--quiet", repository).exitCode).toBe(0)
            let git = await openRepository(repository)
            expect(git.descriptor.objectFormat).toBe(objectFormat)

            let objectId = await git.hashObject(`${objectFormat}\n`)
            await git.updateRefs([{ ref: "refs/laneway/test/object-format", before: null, after: objectId }])
            expect(await git.resolveRef("refs/laneway/test/object-format")).toBe(objectId)

            await git.updateRefs([{ ref: "refs/laneway/test/object-format", before: objectId, after: null }])
            expect(await git.resolveRef("refs/laneway/test/object-format")).toBeNull()
        })
    }

    test("initializes populated directories and clones a disposable local remote", async () => {
        let populated = await temporaryDirectory("laneway-init-")
        await writeFile(resolve(populated, "kept.txt"), "keep me")

        let initialized = await initializeRepository({ path: populated, initialBranch: "entry-test" })
        expect(initialized.descriptor.root).toBe(populated)
        expect(await Bun.file(resolve(populated, "kept.txt")).text()).toBe("keep me")

        let destination = resolve(await temporaryDirectory("laneway-clone-parent-"), "cloned repository")
        let clone = await startCloneRepository({ source: populated, destination })
        expect((await clone.result).descriptor.root).toBe(destination)
    })

    test("rejects a non-empty clone destination without changing it", async () => {
        let source = await temporaryDirectory("laneway-clone-source-")
        expect(runGit(source, "init", "--quiet").exitCode).toBe(0)
        let destination = await temporaryDirectory("laneway-clone-conflict-")
        await writeFile(resolve(destination, "keep.txt"), "keep me")

        await expect(startCloneRepository({ source, destination })).rejects.toMatchObject({
            code: "git.destination-conflict",
            details: { destination },
        })
        expect(await Bun.file(resolve(destination, "keep.txt")).text()).toBe("keep me")
    })

    test("cancels clone without deleting a destination Laneway created", async () => {
        let source = await temporaryDirectory("laneway-cancel-source-")
        expect(runGit(source, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(source, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(source, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        for (let index = 0; index < 250; index += 1)
            await writeFile(resolve(source, `file-${index}.txt`), `${"content ".repeat(500)}${index}\n`)
        expect(runGit(source, "add", ".").exitCode).toBe(0)
        expect(runGit(source, "commit", "--quiet", "-m", "Clone source").exitCode).toBe(0)

        let destination = resolve(await temporaryDirectory("laneway-cancel-parent-"), "partial")
        let clone = await startCloneRepository({ source: `file:///${source.replaceAll("\\", "/")}`, destination })
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

    test("recognizes text that could be a clone source", () => {
        expect(isLikelyCloneSource("https://example.test/org/repo.git")).toBe(true)
        expect(isLikelyCloneSource("  ssh://git@example.test/org/repo.git\n")).toBe(true)
        expect(isLikelyCloneSource("git@example.test:org/repo.git")).toBe(true)
        expect(isLikelyCloneSource("example.test:org/repo.git")).toBe(true)
        expect(isLikelyCloneSource("")).toBe(false)
        expect(isLikelyCloneSource("D:\\Source\\repo")).toBe(false)
        expect(isLikelyCloneSource("Clone https://example.test/org/repo.git today")).toBe(false)
        expect(isLikelyCloneSource("fix: tidy the clone dialog")).toBe(false)
    })
})

async function temporaryDirectory(prefix: string) {
    let path = await mkdtemp(resolve(tmpdir(), prefix))
    temporaryDirectories.push(path)
    return path
}

function runGit(cwd: string, ...args: string[]) {
    return Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" })
}
