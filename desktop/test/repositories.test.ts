import { selectGit } from "@git-workbench/git"
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
})
