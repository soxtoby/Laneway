import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { OpenRepositories } from "../src/main/repositories"
import { WorkspaceManager } from "../src/main/workspace-manager"

let temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Workspace manager", () => {
    test("restores stable repository identity and column presentation", async () => {
        let repositoryPath = await temporaryDirectory("laneway-workspace-repository-")
        expect(runGit(repositoryPath, "init", "--initial-branch=main", "--quiet").exitCode).toBe(0)
        let statePath = resolve(await temporaryDirectory("laneway-workspace-state-"), "workspace.json")
        let settingsPath = resolve(await temporaryDirectory("laneway-workspace-settings-"), "settings.json")
        let manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await manager.load()
        let opened = await manager.open(repositoryPath)
        let id = opened.activeRepositoryId!
        let repository = opened.repositories[0]
        repository.layoutInitialized = true
        repository.columns = [{
            kind: "branch",
            id: "branch:refs/heads/main",
            ref: "refs/heads/main",
            lastSeenObjectId: "1".repeat(40),
            width: 470,
            diffLayout: "split",
            collapsed: true,
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
        let presentation = opened
        await manager.update(presentation)

        let restored = await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()
        expect(restored.activeRepositoryId).toBe(id)
        expect(restored.repositories[0]).toMatchObject({ status: "available", id })
        expect(restored).toEqual(presentation)
        expect(restored.persistenceError).toBeUndefined()

        presentation.repositories[0].columns[0].width = 999
        manager.snapshot().repositories[0].columns[0].width = 888
        expect(manager.snapshot().repositories[0].columns[0].width).toBe(470)
    })

    test("rejects the whole presentation before changing memory or disk", async () => {
        let repositoryPath = await temporaryDirectory("laneway-workspace-admission-")
        expect(runGit(repositoryPath, "init", "--quiet").exitCode).toBe(0)
        let statePath = resolve(await temporaryDirectory("laneway-workspace-state-"), "workspace.json")
        let settingsPath = resolve(await temporaryDirectory("laneway-workspace-settings-"), "settings.json")
        let manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        let opened = await manager.open(repositoryPath)
        let presentation = opened
        presentation.repositories[0].layoutInitialized = true
        presentation.repositories[0].columns = [{ kind: "branch", id: "main", ref: "refs/heads/main", lastSeenObjectId: "1".repeat(40), width: 470 }]
        await manager.update(presentation)
        let before = manager.snapshot()
        let disk = await readFile(statePath, "utf8")
        let repository = presentation.repositories[0]
        let column = repository.columns[0]
        let invalidColumns = [
            { ...column, id: "" },
            { ...column, ref: "  " },
            { ...column, lastSeenObjectId: "" },
            { ...column, width: 309 },
            { ...column, width: NaN },
            { ...column, diffLayout: "invalid" },
            { ...column, collapsed: "true" },
            { ...column, worktreePath: 42 },
            { ...column, worktreePath: " " },
            { ...column, kind: "virtual", worktreePath: "" },
            { kind: "comparison", id: "comparison:x", width: 470, from: { kind: "branch", ref: "main" }, to: { kind: "branch", ref: "refs/heads/main" } },
            { kind: "comparison", id: "comparison:x", width: 470, from: { kind: "commit", objectId: "main" }, to: { kind: "branch", ref: "refs/heads/main" } },
            {
                kind: "comparison",
                id: "comparison:x",
                width: 470,
                from: { kind: "merge-base", ref: "refs/heads/main" },
                to: { kind: "branch", ref: "refs/heads/main" },
            },
        ]
        let invalid = [
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
        for (let value of invalid) {
            await expect(manager.update(value)).rejects.toThrow()
            expect(manager.snapshot()).toEqual(before)
            expect(await readFile(statePath, "utf8")).toBe(disk)
        }
        expect(await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()).toEqual(before)

        let comparison = {
            kind: "comparison" as const,
            id: "comparison:main..topic",
            width: 470,
            from: { kind: "merge-base" as const, ref: "refs/heads/main", withRef: "refs/heads/topic" },
            to: { kind: "branch" as const, ref: "refs/heads/topic" },
            diffLayout: "split" as const,
        }
        await manager.update({ ...presentation, repositories: [{ ...repository, columns: [column, comparison] }] })
        expect(manager.snapshot().repositories[0].columns[1]).toEqual(comparison)
        expect((await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()).repositories[0].columns[1]).toEqual(comparison)
    })

    test("retains unavailable repositories and their layout", async () => {
        let repositoryPath = await temporaryDirectory("laneway-workspace-missing-")
        expect(runGit(repositoryPath, "init", "--quiet").exitCode).toBe(0)
        let statePath = resolve(await temporaryDirectory("laneway-workspace-state-"), "workspace.json")
        let settingsPath = resolve(await temporaryDirectory("laneway-workspace-settings-"), "settings.json")
        let manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await manager.load()
        let opened = await manager.open(repositoryPath)
        let id = opened.activeRepositoryId!
        await rm(repositoryPath, { recursive: true, force: true })

        let restored = await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()
        expect(restored.repositories[0]).toMatchObject({ status: "missing", id, path: repositoryPath })
    })

    test("saves the repository label and icon with the presentation and clears them when left out", async () => {
        let repositoryPath = await temporaryDirectory("laneway-workspace-identity-")
        expect(runGit(repositoryPath, "init", "--quiet").exitCode).toBe(0)
        let statePath = resolve(await temporaryDirectory("laneway-workspace-state-"), "workspace.json")
        let settingsPath = resolve(await temporaryDirectory("laneway-workspace-settings-"), "settings.json")
        let manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await manager.load()
        let opened = await manager.open(repositoryPath)
        let repository = opened.repositories[0]
        let icon = { kind: "icon" as const, name: "folder-code", color: "teal" as const }

        await manager.update({ ...opened, repositories: [{ ...repository, label: "Shown name", icon }] })
        expect(manager.snapshot().repositories[0]).toMatchObject({ label: "Shown name", icon })
        let restored = await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()
        expect(restored.repositories[0]).toMatchObject({ label: "Shown name", icon })

        // An invalid identity rejects the whole presentation, like any other field.
        await expect(manager.update({ ...opened, repositories: [{ ...repository, icon: { kind: "emoji", emoji: "" } }] })).rejects.toThrow()
        expect(manager.snapshot().repositories[0]).toMatchObject({ label: "Shown name", icon })

        await manager.update(opened)
        expect(manager.snapshot().repositories[0].label).toBeUndefined()
        expect(manager.snapshot().repositories[0].icon).toBeUndefined()
    })

    test("saves repository scripts with the presentation, where running finds them, and rejects an invalid one", async () => {
        let repositoryPath = await temporaryDirectory("laneway-workspace-scripts-")
        expect(runGit(repositoryPath, "init", "--quiet").exitCode).toBe(0)
        let statePath = resolve(await temporaryDirectory("laneway-workspace-state-"), "workspace.json")
        let settingsPath = resolve(await temporaryDirectory("laneway-workspace-settings-"), "settings.json")
        let manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await manager.load()
        let opened = await manager.open(repositoryPath)
        let repository = opened.repositories[0]
        let script = { id: "build", name: "Build", command: "bun run build" }

        await manager.update({ ...opened, repositories: [{ ...repository, scripts: [script], lastScriptId: "build" }] })

        expect(manager.snapshot().repositories[0]).toMatchObject({ scripts: [script], lastScriptId: "build" })
        expect(manager.script(repository.id, "build")).toEqual(script)
        let restored = await new WorkspaceManager(new OpenRepositories(settingsPath), statePath).load()
        expect(restored.repositories[0]).toMatchObject({ scripts: [script], lastScriptId: "build" })

        // A script with two lines can't run as one command, so the whole presentation is refused.
        await expect(manager.update({ ...opened, repositories: [{ ...repository, scripts: [{ ...script, command: "a\nb" }] }] })).rejects.toThrow()
        expect(manager.script(repository.id, "build")).toEqual(script)

        await manager.update(opened)
        expect(manager.script(repository.id, "build")).toBeUndefined()
        expect(manager.snapshot().repositories[0].lastScriptId).toBeUndefined()
    })

    test("infers a repository's favicon only when it is unambiguous", async () => {
        let repositoryPath = await temporaryDirectory("laneway-workspace-favicon-")
        expect(runGit(repositoryPath, "init", "--quiet").exitCode).toBe(0)
        let statePath = resolve(await temporaryDirectory("laneway-workspace-state-"), "workspace.json")
        let settingsPath = resolve(await temporaryDirectory("laneway-workspace-settings-"), "settings.json")
        let load = async () => {
            let manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
            await manager.load()
            let workspace = manager.snapshot().repositories.length ? manager.snapshot() : await manager.open(repositoryPath)
            let repository = workspace.repositories[0]
            return repository.status == "available" ? repository.favicon : undefined
        }

        expect(await load()).toBeUndefined()

        // One directory holding several formats is one favicon, and the vector one is preferred.
        await mkdir(resolve(repositoryPath, "public"))
        await writeFile(resolve(repositoryPath, "public", "favicon.ico"), "ico")
        await writeFile(resolve(repositoryPath, "public", "favicon.svg"), "<svg/>")
        expect(await load()).toBe(resolve(repositoryPath, "public", "favicon.svg"))

        // Build output and dependencies are not searched.
        await mkdir(resolve(repositoryPath, "node_modules", "package"), { recursive: true })
        await writeFile(resolve(repositoryPath, "node_modules", "package", "favicon.png"), "png")
        expect(await load()).toBe(resolve(repositoryPath, "public", "favicon.svg"))

        // Different favicons in different places leave the repository without one.
        await mkdir(resolve(repositoryPath, "docs"))
        await writeFile(resolve(repositoryPath, "docs", "favicon.svg"), "<svg>other</svg>")
        expect(await load()).toBeUndefined()

        // Identical copies are the same favicon, found in directory order.
        await writeFile(resolve(repositoryPath, "docs", "favicon.svg"), "<svg/>")
        expect(await load()).toBe(resolve(repositoryPath, "docs", "favicon.svg"))
    })

    test("remembers the parent of the last opened repository", async () => {
        let parentPath = await temporaryDirectory("laneway-workspace-parent-")
        let repositoryPath = resolve(parentPath, "repository")
        expect(runGit(parentPath, "init", "--initial-branch=main", "--quiet", repositoryPath).exitCode).toBe(0)
        let statePath = resolve(await temporaryDirectory("laneway-workspace-state-"), "workspace.json")
        let settingsPath = resolve(await temporaryDirectory("laneway-workspace-settings-"), "settings.json")
        let manager = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await manager.load()

        await manager.open(repositoryPath)

        let restored = new WorkspaceManager(new OpenRepositories(settingsPath), statePath)
        await restored.load()
        expect(restored.repositoryOpenDefaultPath()).toBe(parentPath)
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
