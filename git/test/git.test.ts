import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
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
    }

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
