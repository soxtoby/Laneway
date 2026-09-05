import { selectGit } from "@git-workbench/git"
import { readSettings } from "@git-workbench/settings"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { OpenRepositories } from "../src/main/repositories"

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

describe("open repositories", () => {
    test("isolates inspection cancellation by request and cancels reads on close", async () => {
        const path = await temporaryDirectory("workbench-inspection-requests-")
        expect(runGit(path, "init", "--quiet").exitCode).toBe(0)
        await writeFile(resolve(path, "file.txt"), "content\n")
        const settingsPath = resolve(await temporaryDirectory("workbench-inspection-settings-"), "settings.json")
        const repositories = new OpenRepositories(settingsPath)
        const repository = await repositories.open(path)
        const source = { kind: "working" as const, worktreePath: path }
        const cancelled = repositories.readChanges(repository.id, "column-one", { source })
        const independent = repositories.readChanges(repository.id, "column-two", { source })
        repositories.cancelInspection(repository.id, "column-one")
        await expect(cancelled).rejects.toMatchObject({ code: "git.cancelled" })
        expect((await independent).files[0].path).toBe("file.txt")
        const superseded = repositories.readChanges(repository.id, "same", { source })
        const latest = repositories.readChanges(repository.id, "same", { source })
        await expect(superseded).rejects.toMatchObject({ code: "git.cancelled" })
        await latest
        const closing = repositories.readFileDiff(repository.id, "diff", { source, path: "file.txt" })
        repositories.close(repository.id)
        await expect(closing).rejects.toMatchObject({ code: "git.cancelled" })
    })

    test("deduplicates a repository and focuses the selected worktree", async () => {
        const repository = await temporaryDirectory("workbench-open-repository-")
        const linkedParent = await temporaryDirectory("workbench-open-repository-linked-")
        const linked = resolve(linkedParent, "linked")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        expect(runGit(repository, "worktree", "add", "--detach", linked).exitCode).toBe(0)
        const settingsPath = resolve(await temporaryDirectory("workbench-open-repository-settings-"), "settings.json")
        const repositories = new OpenRepositories(settingsPath)

        await repositories.open(repository)
        const selected = await repositories.open(linked)
        expect(repositories.list()).toHaveLength(1)
        expect(selected.selectedWorktree).toBe(linked)
    })

    test("keeps its collection in memory only", async () => {
        const repository = await temporaryDirectory("workbench-open-repository-memory-")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        const settingsPath = resolve(await temporaryDirectory("workbench-open-repository-settings-"), "settings.json")

        await new OpenRepositories(settingsPath).open(repository)
        expect(new OpenRepositories(settingsPath).list()).toEqual([])
    })

    test("caches Git selection until its setting changes", async () => {
        const settingsPath = resolve(await temporaryDirectory("workbench-open-repository-settings-"), "settings.json")
        const installation = await selectGit()
        let selections = 0
        const repositories = new OpenRepositories(settingsPath, async () => {
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
        const repository = await temporaryDirectory("workbench-open-repository-graph-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        expect(runGit(repository, "remote", "add", "origin", ".").exitCode).toBe(0)
        const settingsPath = resolve(await temporaryDirectory("workbench-open-repository-settings-"), "settings.json")
        const repositories = new OpenRepositories(settingsPath)
        const opened = await repositories.open(repository)
        const repositoryId = opened.id

        const graph = await (await repositories.startBranchGraph(repositoryId)).result
        expect(graph.selectedRemote).toBe("origin")
        expect(await readSettings(settingsPath)).toMatchObject({
            authorIdentities: { primary: "workbench@example.invalid", secondary: [] },
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
})
