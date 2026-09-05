import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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
        repository.columns = [{
            kind: "branch",
            id: "branch:refs/heads/main",
            ref: "refs/heads/main",
            lastSeenObjectId: "1".repeat(40),
            width: 470,
            diffLayout: "split",
            worktreePath: repositoryPath,
        }, {
            kind: "virtual",
            id: "virtual:linked",
            worktreePath: resolve(repositoryPath, "linked"),
            lastSeenObjectId: "2".repeat(64),
            width: 310,
            diffLayout: "unified",
        }]
        repository.focusedColumnId = repository.columns[0].id
        const presentation = opened
        await manager.update(presentation)

        const restored = await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()
        expect(restored.activeRepositoryId).toBe(id)
        expect(restored.repositories[0]).toMatchObject({ status: "available", id })
        expect(restored).toEqual(presentation)
        expect(restored.persistenceError).toBeUndefined()
        presentation.repositories[0].columns[0].width = 999
        manager.snapshot().repositories[0].columns[0].width = 888
        expect(manager.snapshot().repositories[0].columns[0].width).toBe(470)
    })

    test("rejects the whole presentation before changing memory or disk", async () => {
        const repositoryPath = await temporaryDirectory("workbench-workspace-admission-")
        expect(runGit(repositoryPath, "init", "--quiet").exitCode).toBe(0)
        const statePath = resolve(await temporaryDirectory("workbench-workspace-state-"), "workspace.json")
        const settingsPath = resolve(await temporaryDirectory("workbench-workspace-settings-"), "settings.json")
        const manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        const opened = await manager.open(repositoryPath)
        const presentation = opened
        presentation.repositories[0].layoutInitialized = true
        presentation.repositories[0].columns = [{ kind: "branch", id: "main", ref: "refs/heads/main", lastSeenObjectId: "1".repeat(40), width: 470 }]
        await manager.update(presentation)
        const before = manager.snapshot()
        const disk = await readFile(statePath, "utf8")
        const repository = presentation.repositories[0]
        const column = repository.columns[0]
        const invalidColumns = [
            { ...column, id: "" },
            { ...column, ref: "  " },
            { ...column, lastSeenObjectId: "" },
            { ...column, width: 309 },
            { ...column, width: NaN },
            { ...column, diffLayout: "invalid" },
            { ...column, worktreePath: 42 },
            { ...column, worktreePath: " " },
            { ...column, kind: "virtual", worktreePath: "" },
        ]
        const invalid = [
            null,
            [],
            {},
            ...invalidColumns.map(column => ({ ...presentation, repositories: [{ ...repository, columns: [column] }] })),
            { ...presentation, repositories: [{ ...repository, columns: [column, column] }] },
            { ...presentation, repositories: [{ ...repository, columns: new Array(1) }] },
            { ...presentation, repositories: [repository, repository] },
            { ...presentation, activeRepositoryId: "unknown" },
            { ...presentation, repositories: [{ ...repository, focusedColumnId: "unknown" }] },
            { ...presentation, repositories: [{ ...repository, layoutInitialized: "yes" }] },
            // A valid edit preceding an unknown repository must not partially apply.
            { ...presentation, repositories: [{ ...repository, columns: [] }, { ...repository, id: "unknown" }] },
        ]
        for (const value of invalid) {
            await expect(manager.update(value)).rejects.toThrow()
            expect(manager.snapshot()).toEqual(before)
            expect(await readFile(statePath, "utf8")).toBe(disk)
        }
        expect(await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()).toEqual(before)
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
