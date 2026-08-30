import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { defaultSettingsPath, readSettings, SettingsError, writeSettings } from "../src/index"

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
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

    test("reports corrupt settings without falling back", async () => {
        const path = await temporarySettingsPath()
        await mkdir(resolve(path, ".."), { recursive: true })
        await writeFile(path, "not-json")

        await expect(readSettings(path)).rejects.toBeInstanceOf(SettingsError)
        await expect(readSettings(path)).rejects.toMatchObject({ code: "settings.corrupt", path })
    })
})
