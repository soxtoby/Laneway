import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { OpenRepositories } from "../src/main/repositories"
import { WorkspaceManager } from "../src/main/workspace-manager"

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

describe("Workspace manager", () => {
    test("restores stable repository identity and column presentation", async () => {
        const repositoryPath = await temporaryDirectory("workbench-workspace-repository-")
        expect(runGit(repositoryPath, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        const statePath = resolve(await temporaryDirectory("workbench-workspace-state-"), "workspace.json")
        const settingsPath = resolve(await temporaryDirectory("workbench-workspace-settings-"), "settings.json")
        const manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await manager.load()
        const opened = await manager.open(repositoryPath)
        const id = opened.activeRepositoryId!
        const repository = opened.repositories[0]
        repository.layoutInitialized = true
        repository.columns = [{ kind: "branch", id: "branch:refs/heads/main", ref: "refs/heads/main", lastSeenObjectId: "1".repeat(40), width: 470 }]
        repository.focusedColumnId = repository.columns[0].id
        await manager.update(opened)

        const restored = await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()
        expect(restored.activeRepositoryId).toBe(id)
        expect(restored.repositories[0]).toMatchObject({ status: "available", id, columns: [{ width: 470 }] })
    })

    test("retains unavailable repositories and their layout", async () => {
        const repositoryPath = await temporaryDirectory("workbench-workspace-missing-")
        expect(runGit(repositoryPath, "init", "--quiet").exitCode).toBe(0)
        const statePath = resolve(await temporaryDirectory("workbench-workspace-state-"), "workspace.json")
        const settingsPath = resolve(await temporaryDirectory("workbench-workspace-settings-"), "settings.json")
        const manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await manager.load()
        const opened = await manager.open(repositoryPath)
        const id = opened.activeRepositoryId!
        await rm(repositoryPath, { recursive: true, force: true })

        const restored = await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()
        expect(restored.repositories[0]).toMatchObject({ status: "missing", id, path: repositoryPath })
    })

    test("remembers the parent of the last opened repository", async () => {
        const parentPath = await temporaryDirectory("workbench-workspace-parent-")
        const repositoryPath = resolve(parentPath, "repository")
        expect(runGit(parentPath, "init", "--initial-branch=main", "--quiet", repositoryPath).exitCode).toBe(0)
        const statePath = resolve(await temporaryDirectory("workbench-workspace-state-"), "workspace.json")
        const settingsPath = resolve(await temporaryDirectory("workbench-workspace-settings-"), "settings.json")
        const manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await manager.load()

        await manager.open(repositoryPath)

        const restored = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await restored.load()
        expect(restored.repositoryOpenDefaultPath()).toBe(parentPath)
    })
})
