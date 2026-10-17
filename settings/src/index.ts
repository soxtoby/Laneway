import type { Appearance, AuthorIdentitySettings, FileListView, RepositoryGraphSettings } from "@laneway/shared"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

export * from "./workspace"

export interface LanewaySettings {
    version: 1
    gitPath?: string
    virtualBranchPrefix?: string
    appearance?: Appearance
    fileListView?: FileListView
    authorIdentities?: AuthorIdentitySettings
    repositories?: Record<string, RepositoryGraphSettings>
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
        return resolve(environment.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "Laneway", "settings.json")
    else if (platform == "darwin")
        return resolve(homedir(), "Library", "Application Support", "Laneway", "settings.json")
    else
        return resolve(environment.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "laneway", "settings.json")
}

export async function readSettings(path = defaultSettingsPath()): Promise<LanewaySettings> {
    let content: string
    try {
        content = await readFile(path, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT")
            return { version: 1 }
        throw new SettingsError("settings.corrupt", `Laneway could not read its settings file at ${path}.`, path)
    }

    try {
        let value = JSON.parse(content) as unknown
        if (!value || typeof value != "object" || Array.isArray(value))
            throw new Error("Settings must be an object.")

        let record = value as Record<string, unknown>
        if (record.version != 1)
            throw new Error("Unsupported settings version.")
        if (record.gitPath != undefined && !nonEmptyString(record.gitPath))
            throw new Error("gitPath must be a non-empty string.")
        if (record.virtualBranchPrefix != undefined && !nonEmptyString(record.virtualBranchPrefix))
            throw new Error("virtualBranchPrefix must be a non-empty string.")

        let authorIdentities = parseAuthorIdentities(record.authorIdentities)
        let appearance = parseAppearance(record.appearance)
        let fileListView = parseFileListView(record.fileListView)
        let repositories = parseRepositories(record.repositories)

        return {
            version: 1,
            gitPath: record.gitPath as string | undefined,
            ...(record.virtualBranchPrefix ? { virtualBranchPrefix: record.virtualBranchPrefix as string } : {}),
            ...(appearance ? { appearance } : {}),
            ...(fileListView ? { fileListView } : {}),
            ...(authorIdentities ? { authorIdentities } : {}),
            ...(repositories ? { repositories } : {}),
        }
    } catch {
        throw new SettingsError(
            "settings.corrupt",
            `Laneway settings at ${path} are invalid. Repair the file or reset settings before using Git.`,
            path,
        )
    }
}

function parseAppearance(value: unknown): Appearance | undefined {
    if (value == undefined)
        return undefined
    if (value != "light" && value != "dark")
        throw new Error('appearance must be "light" or "dark".')
    return value as Appearance
}

function parseFileListView(value: unknown): FileListView | undefined {
    if (value == undefined)
        return undefined
    if (!value || typeof value != "object" || Array.isArray(value))
        throw new Error("fileListView must be an object.")

    let { layout, grouping } = value as Record<string, unknown>
    if (layout != "flat" && layout != "tree")
        throw new Error('fileListView.layout must be "flat" or "tree".')
    if (grouping != "none" && grouping != "change" && grouping != "kind")
        throw new Error('fileListView.grouping must be "none", "change", or "kind".')

    return { layout: layout as FileListView["layout"], grouping: grouping as FileListView["grouping"] }
}

function parseAuthorIdentities(value: unknown): AuthorIdentitySettings | undefined {
    if (value == undefined)
        return undefined
    if (!value || typeof value != "object" || Array.isArray(value))
        throw new Error("authorIdentities must be an object.")

    let record = value as Record<string, unknown>
    if (record.primary != undefined && !nonEmptyString(record.primary))
        throw new Error("authorIdentities.primary must be a non-empty string.")
    if (!Array.isArray(record.secondary) || !record.secondary.every(nonEmptyString))
        throw new Error("authorIdentities.secondary must contain non-empty strings.")

    return {
        primary: record.primary as string | undefined,
        secondary: [...new Set(record.secondary as string[])],
    }
}

function parseRepositories(value: unknown): Record<string, RepositoryGraphSettings> | undefined {
    if (value == undefined)
        return undefined
    if (!value || typeof value != "object" || Array.isArray(value))
        throw new Error("repositories must be an object.")

    let result: Record<string, RepositoryGraphSettings> = {}
    for (let [repositoryId, settings] of Object.entries(value as Record<string, unknown>)) {
        if (!repositoryId || !settings || typeof settings != "object" || Array.isArray(settings))
            throw new Error("repositories contains an invalid entry.")

        let record = settings as Record<string, unknown>
        if (record.selectedRemote != undefined && !nonEmptyString(record.selectedRemote))
            throw new Error("selectedRemote must be a non-empty string.")
        if (!Array.isArray(record.remotePatterns) || !record.remotePatterns.every(nonEmptyString))
            throw new Error("remotePatterns must contain non-empty strings.")

        result[repositoryId] = {
            selectedRemote: record.selectedRemote as string | undefined,
            remotePatterns: [...new Set(record.remotePatterns as string[])],
        }
    }

    return result
}

function nonEmptyString(value: unknown): value is string {
    return typeof value == "string" && value.trim() != ""
}

export async function writeSettings(settings: LanewaySettings, path = defaultSettingsPath()) {
    let temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
    try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 4)}\n`, { encoding: "utf8", flag: "wx" })
        await rename(temporaryPath, path)
    } catch {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw new SettingsError("settings.write-failed", `Laneway could not save settings at ${path}.`, path)
    }
}
