import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

export interface WorkbenchSettings {
    version: 1
    gitPath?: string
}

export class SettingsError extends Error {
    constructor(
        readonly code: "settings.corrupt" | "settings.write-failed",
        message: string,
        readonly path: string,
    ) {
        super(message)
    }
}

export function defaultSettingsPath(
    platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
) {
    if (platform == "win32")
        return resolve(environment.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "Git Workbench", "settings.json")
    if (platform == "darwin")
        return resolve(homedir(), "Library", "Application Support", "Git Workbench", "settings.json")
    return resolve(environment.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "git-workbench", "settings.json")
}

export async function readSettings(path = defaultSettingsPath()): Promise<WorkbenchSettings> {
    let content: string
    try {
        content = await readFile(path, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT")
            return { version: 1 }
        throw new SettingsError("settings.corrupt", `Workbench could not read its settings file at ${path}.`, path)
    }

    try {
        const value = JSON.parse(content) as unknown
        if (!value || typeof value != "object" || Array.isArray(value))
            throw new Error("Settings must be an object.")
        const record = value as Record<string, unknown>
        if (record.version != 1)
            throw new Error("Unsupported settings version.")
        if (record.gitPath != undefined && (typeof record.gitPath != "string" || record.gitPath.trim() == ""))
            throw new Error("gitPath must be a non-empty string.")
        return { version: 1, gitPath: record.gitPath as string | undefined }
    } catch {
        throw new SettingsError(
            "settings.corrupt",
            `Workbench settings at ${path} are invalid. Repair the file or reset settings before using Git.`,
            path,
        )
    }
}

export async function writeSettings(settings: WorkbenchSettings, path = defaultSettingsPath()) {
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
    try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 4)}\n`, { encoding: "utf8", flag: "wx" })
        await rename(temporaryPath, path)
    } catch {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw new SettingsError("settings.write-failed", `Workbench could not save settings at ${path}.`, path)
    }
}
