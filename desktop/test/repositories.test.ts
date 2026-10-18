import { selectGit } from "@laneway/git"
import { readSettings } from "@laneway/settings"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { entryDirectory, OpenRepositories } from "../src/main/repositories"

let temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("open repositories", () => {
    test("isolates inspection cancellation by request and cancels reads on close", async () => {
        let path = await temporaryDirectory("laneway-inspection-requests-")
        expect(runGit(path, "init", "--quiet").exitCode).toBe(0)
        await writeFile(resolve(path, "file.txt"), "content\n")
        let settingsPath = resolve(await temporaryDirectory("laneway-inspection-settings-"), "settings.json")
        let repositories = new OpenRepositories(settingsPath)
        let repository = await repositories.open(path)
        let source = { kind: "working" as const, worktreePath: path }

        let cancelled = repositories.readChanges(repository.id, "column-one", { source })
        let independent = repositories.readChanges(repository.id, "column-two", { source })
        repositories.cancelInspection(repository.id, "column-one")
        await expect(cancelled).rejects.toMatchObject({ code: "git.cancelled" })
        expect((await independent).files[0].path).toBe("file.txt")

        let superseded = repositories.readChanges(repository.id, "same", { source })
        let latest = repositories.readChanges(repository.id, "same", { source })
        await expect(superseded).rejects.toMatchObject({ code: "git.cancelled" })
        await latest

        let closing = repositories.readFileDiff(repository.id, "diff", { source, path: "file.txt" })
        repositories.close(repository.id)
        await expect(closing).rejects.toMatchObject({ code: "git.cancelled" })
    })

    test("deduplicates a repository and focuses the selected worktree", async () => {
        let repository = await temporaryDirectory("laneway-open-repository-")
        let linkedParent = await temporaryDirectory("laneway-open-repository-linked-")
        let linked = resolve(linkedParent, "linked")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        expect(runGit(repository, "worktree", "add", "--detach", linked).exitCode).toBe(0)
        let settingsPath = resolve(await temporaryDirectory("laneway-open-repository-settings-"), "settings.json")
        let repositories = new OpenRepositories(settingsPath)

        await repositories.open(repository)
        let selected = await repositories.open(linked)
        expect(repositories.list()).toHaveLength(1)
        expect(selected.selectedWorktree).toBe(linked)
    })

    test("keeps its collection in memory only", async () => {
        let repository = await temporaryDirectory("laneway-open-repository-memory-")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        let settingsPath = resolve(await temporaryDirectory("laneway-open-repository-settings-"), "settings.json")

        await new OpenRepositories(settingsPath).open(repository)
        expect(new OpenRepositories(settingsPath).list()).toEqual([])
    })

    test("caches Git selection until its setting changes", async () => {
        let settingsPath = resolve(await temporaryDirectory("laneway-open-repository-settings-"), "settings.json")
        let installation = await selectGit()
        let selections = 0
        let repositories = new OpenRepositories(settingsPath, async () => {
            selections += 1
            return installation
        })

        await repositories.gitSettings()
        await repositories.gitSettings()
        expect(selections).toBe(1)

        await repositories.setGitOverride(installation.path)
        await repositories.gitSettings()
        expect(selections).toBe(2)

        await repositories.resetSettings()
        expect(selections).toBe(3)
    })

    test("seeds graph identity and single-remote settings without persisting workspace state", async () => {
        let repository = await temporaryDirectory("laneway-open-repository-graph-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Laneway Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "laneway@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        expect(runGit(repository, "remote", "add", "origin", ".").exitCode).toBe(0)
        let settingsPath = resolve(await temporaryDirectory("laneway-open-repository-settings-"), "settings.json")
        let repositories = new OpenRepositories(settingsPath)
        let opened = await repositories.open(repository)
        let repositoryId = opened.id

        let graph = await (await repositories.startBranchGraph(repositoryId)).result
        expect(graph.selectedRemote).toBe("origin")
        expect(await readSettings(settingsPath)).toMatchObject({
            authorIdentities: { primary: "laneway@example.invalid", secondary: [] },
            repositories: { [repositoryId]: { selectedRemote: "origin", remotePatterns: [] } },
        })

        await repositories.setAuthorIdentities({ primary: "primary@example.invalid", secondary: ["secondary@example.invalid"] })
        await repositories.setRepositoryGraphSettings(repositoryId, { selectedRemote: "origin", remotePatterns: ["origin/release/**"] })
        expect(await readSettings(settingsPath)).toMatchObject({
            authorIdentities: { primary: "primary@example.invalid", secondary: ["secondary@example.invalid"] },
            repositories: { [repositoryId]: { selectedRemote: "origin", remotePatterns: ["origin/release/**"] } },
        })
        expect(new OpenRepositories(settingsPath).list()).toEqual([])
    })

    test("creates a new repository only directly inside the chosen parent", async () => {
        let parent = resolve(await temporaryDirectory("laneway-entry-parent-"), "parent")
        let settingsPath = resolve(await temporaryDirectory("laneway-entry-settings-"), "settings.json")

        expect(entryDirectory(parent, "project")).toBe(resolve(parent, "project"))
        for (let name of ["..\\outside", "../outside", "\\outside", "nested\\project", "nested/project", ".", "..", "C:outside"])
            expect(() => entryDirectory(parent, name), name).toThrow("Enter a directory name rather than a path")
        await expect(new OpenRepositories(settingsPath).initialize(parent, "../outside")).rejects.toMatchObject({ code: "git.command-failed" })
        expect(existsSync(resolve(parent, "../outside"))).toBe(false)
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
