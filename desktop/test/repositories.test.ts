import { selectGit } from "@git-workbench/git"
import { readSettings } from "@git-workbench/settings"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { RepositorySession } from "../src/main/repositories"

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

describe("repository session", () => {
    test("deduplicates a repository and focuses the selected worktree", async () => {
        const repository = await temporaryDirectory("workbench-session-")
        const linkedParent = await temporaryDirectory("workbench-session-linked-")
        const linked = resolve(linkedParent, "linked")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        expect(runGit(repository, "worktree", "add", "--detach", linked).exitCode).toBe(0)
        const settingsPath = resolve(await temporaryDirectory("workbench-session-settings-"), "settings.json")
        const session = new RepositorySession(settingsPath)

        expect((await session.open(repository)).repositories).toHaveLength(1)
        const selected = await session.open(linked)
        expect(selected.repositories).toHaveLength(1)
        expect(selected.repositories[0].selectedWorktree).toBe(linked)
        expect(selected.activeRepositoryId).toBe(selected.repositories[0].id)
    })

    test("keeps session state in memory only", async () => {
        const repository = await temporaryDirectory("workbench-session-memory-")
        expect(runGit(repository, "init", "--quiet").exitCode).toBe(0)
        const settingsPath = resolve(await temporaryDirectory("workbench-session-settings-"), "settings.json")

        await new RepositorySession(settingsPath).open(repository)
        expect(new RepositorySession(settingsPath).snapshot()).toEqual({ repositories: [], activeRepositoryId: undefined })
    })

    test("caches Git selection until its setting changes", async () => {
        const settingsPath = resolve(await temporaryDirectory("workbench-session-settings-"), "settings.json")
        const installation = await selectGit()
        let selections = 0
        const session = new RepositorySession(settingsPath, async () => {
            selections += 1
            return installation
        })

        await session.gitSettings()
        await session.gitSettings()
        expect(selections).toBe(1)

        await session.setGitOverride(installation.path)
        await session.gitSettings()
        expect(selections).toBe(2)

        await session.resetSettings()
        expect(selections).toBe(3)
    })

    test("seeds graph identity and single-remote settings without persisting workspace state", async () => {
        const repository = await temporaryDirectory("workbench-session-graph-")
        expect(runGit(repository, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.name", "Workbench Test").exitCode).toBe(0)
        expect(runGit(repository, "config", "user.email", "workbench@example.invalid").exitCode).toBe(0)
        await writeFile(resolve(repository, "README.md"), "initial\n")
        expect(runGit(repository, "add", "README.md").exitCode).toBe(0)
        expect(runGit(repository, "commit", "--quiet", "-m", "Initial").exitCode).toBe(0)
        expect(runGit(repository, "remote", "add", "origin", ".").exitCode).toBe(0)
        const settingsPath = resolve(await temporaryDirectory("workbench-session-settings-"), "settings.json")
        const session = new RepositorySession(settingsPath)
        const opened = await session.open(repository)
        const repositoryId = opened.activeRepositoryId!

        const graph = await (await session.startBranchGraph(repositoryId)).result
        expect(graph.selectedRemote).toBe("origin")
        expect(await readSettings(settingsPath)).toMatchObject({
            authorIdentities: { primary: "workbench@example.invalid", secondary: [] },
            repositories: { [repositoryId]: { selectedRemote: "origin", remotePatterns: [] } },
        })

        await session.setAuthorIdentities({ primary: "primary@example.invalid", secondary: ["secondary@example.invalid"] })
        await session.setRepositoryGraphSettings(repositoryId, { selectedRemote: "origin", remotePatterns: ["origin/release/**"] })
        expect(await readSettings(settingsPath)).toMatchObject({
            authorIdentities: { primary: "primary@example.invalid", secondary: ["secondary@example.invalid"] },
            repositories: { [repositoryId]: { selectedRemote: "origin", remotePatterns: ["origin/release/**"] } },
        })
        expect(new RepositorySession(settingsPath).snapshot()).toEqual({ repositories: [], activeRepositoryId: undefined })
    })
})
