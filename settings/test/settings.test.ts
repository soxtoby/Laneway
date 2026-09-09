import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { defaultSettingsPath, defaultWorkspacePath, readSettings, readWorkspace, resetWorkspace, SettingsError, WorkspaceStateError, writeSettings, writeWorkspace } from "../src/index"

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Workspace State", () => {
    test("uses a separate application-data document", () => {
        expect(defaultWorkspacePath("win32", { APPDATA: "D:\\Profile\\Roaming" })).toBe("D:\\Profile\\Roaming\\Git Workbench\\workspace.json")
    })

    test("round-trips presentation state and ignores unknown fields", async () => {
        const path = (await temporarySettingsPath()).replace("settings.json", "workspace.json")
        await writeWorkspace({
            version: 1,
            repositories: [{
                id: "repository-1",
                path: "D:\\Source\\project",
                name: "project",
                objectFormat: "sha1",
                anchors: ["1".repeat(40)],
                open: true,
                layoutInitialized: true,
                focusedColumnId: "branch:main",
                columns: [{
                    kind: "branch",
                    id: "branch:main",
                    ref: "refs/heads/main",
                    lastSeenObjectId: "1".repeat(40),
                    width: 420,
                    collapsed: true,
                    diffLayout: "split",
                }],
            }],
            activeRepositoryId: "repository-1",
        }, path)
        const value = JSON.parse(await readFile(path, "utf8"))
        value.unknown = true
        await writeFile(path, JSON.stringify(value))

        expect((await readWorkspace(path)).workspace.repositories[0]).toMatchObject({
            id: "repository-1",
            layoutInitialized: true,
            columns: [{ width: 420, diffLayout: "split" }],
        })
    })

    test("skips malformed repository records", async () => {
        const path = (await temporarySettingsPath()).replace("settings.json", "workspace.json")
        await mkdir(resolve(path, ".."), { recursive: true })
        await writeFile(path, JSON.stringify({ version: 1, repositories: [{ id: "bad" }] }))
        const result = await readWorkspace(path)
        expect(result.workspace.repositories).toEqual([])
        expect(result.skipped).toBe(1)
    })

    test("preserves corrupt state as a best-effort backup on reset", async () => {
        const path = (await temporarySettingsPath()).replace("settings.json", "workspace.json")
        await mkdir(resolve(path, ".."), { recursive: true })
        await writeFile(path, "broken")
        await resetWorkspace(path)
        expect(await readFile(`${path}.bak`, "utf8")).toBe("broken")
        expect((await readWorkspace(path)).workspace).toEqual({ version: 1, repositories: [] })
    })

    test("rejects unknown future versions", async () => {
        const path = (await temporarySettingsPath()).replace("settings.json", "workspace.json")
        await mkdir(resolve(path, ".."), { recursive: true })
        await writeFile(path, JSON.stringify({ version: 2, repositories: [] }))
        await expect(readWorkspace(path)).rejects.toBeInstanceOf(WorkspaceStateError)
        await expect(readWorkspace(path)).rejects.toMatchObject({ code: "workspace.unsupported-version" })
    })
})

async function temporarySettingsPath() {
    const directory = await mkdtemp(resolve(tmpdir(), "workbench-settings-"))
    temporaryDirectories.push(directory)
    return resolve(directory, "nested", "settings.json")
}

describe("Workbench settings", () => {
    test("uses the platform configuration directory", () => {
        expect(defaultSettingsPath("win32", { APPDATA: "D:\\Profile\\Roaming" })).toBe("D:\\Profile\\Roaming\\Git Workbench\\settings.json")
    })

    test("returns defaults when no file exists", async () => {
        expect(await readSettings(await temporarySettingsPath())).toEqual({ version: 1 })
    })

    test("round-trips the global Git override", async () => {
        const path = await temporarySettingsPath()
        await writeSettings({ version: 1, gitPath: "D:\\Git\\cmd\\git.exe" }, path)
        await writeSettings({ version: 1, gitPath: "D:\\PortableGit\\git.exe" }, path)

        expect(await readSettings(path)).toEqual({ version: 1, gitPath: "D:\\PortableGit\\git.exe" })
        expect(await readFile(path, "utf8")).toEndWith("\n")
    })

    test("round-trips author identities and repository graph settings", async () => {
        const path = await temporarySettingsPath()
        await writeSettings({
            version: 1,
            authorIdentities: { primary: "developer@example.test", secondary: ["old@example.test"] },
            repositories: {
                "D:\\Source\\project\\.git": {
                    selectedRemote: "upstream",
                    remotePatterns: ["upstream/release/*"],
                },
            },
        }, path)

        expect(await readSettings(path)).toEqual({
            version: 1,
            authorIdentities: { primary: "developer@example.test", secondary: ["old@example.test"] },
            repositories: {
                "D:\\Source\\project\\.git": {
                    selectedRemote: "upstream",
                    remotePatterns: ["upstream/release/*"],
                },
            },
        })
    })

    test("round-trips the appearance preference and rejects unknown values", async () => {
        const path = await temporarySettingsPath()
        await writeSettings({ version: 1, appearance: "dark" }, path)

        expect(await readSettings(path)).toEqual({ version: 1, appearance: "dark" })

        await writeFile(path, JSON.stringify({ version: 1, appearance: "sepia" }))
        await expect(readSettings(path)).rejects.toMatchObject({ code: "settings.corrupt", path })
    })

    test("reports corrupt settings without falling back", async () => {
        const path = await temporarySettingsPath()
        await mkdir(resolve(path, ".."), { recursive: true })
        await writeFile(path, "not-json")

        await expect(readSettings(path)).rejects.toBeInstanceOf(SettingsError)
        await expect(readSettings(path)).rejects.toMatchObject({ code: "settings.corrupt", path })
    })
})
