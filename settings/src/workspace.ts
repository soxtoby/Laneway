import type { ObjectFormat, WorkspaceColumn } from "@git-workbench/shared"
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

export interface StoredRepository {
    id: string
    path: string
    name: string
    objectFormat?: ObjectFormat
    anchors: string[]
    open: boolean
    columns: WorkspaceColumn[]
    focusedColumnId?: string
    layoutInitialized: boolean
}

export interface StoredWorkspace {
    version: 1
    repositories: StoredRepository[]
    activeRepositoryId?: string
    lastRepositoryParentPath?: string
}

export class WorkspaceStateError extends Error {
    constructor(
        readonly code: "workspace.corrupt" | "workspace.unsupported-version" | "workspace.write-failed",
        message: string,
        readonly path: string,
    ) {
        super(message)
    }
}

export function defaultWorkspacePath(
    platform = process.platform,
    environment: NodeJS.ProcessEnv = process.env,
) {
    if (platform == "win32")
        return resolve(environment.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "Git Workbench", "workspace.json")
    if (platform == "darwin")
        return resolve(homedir(), "Library", "Application Support", "Git Workbench", "workspace.json")
    return resolve(environment.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "git-workbench", "workspace.json")
}

export async function readWorkspace(path = defaultWorkspacePath()): Promise<{ workspace: StoredWorkspace; skipped: number }> {
    let content: string
    try {
        content = await readFile(path, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT")
            return { workspace: emptyWorkspace(), skipped: 0 }
        throw new WorkspaceStateError("workspace.corrupt", `Workbench could not read Workspace State at ${path}.`, path)
    }
    let value: unknown
    try {
        value = JSON.parse(content)
    } catch {
        throw new WorkspaceStateError("workspace.corrupt", `Workspace State at ${path} is not valid JSON.`, path)
    }
    if (!value || typeof value != "object" || Array.isArray(value))
        throw new WorkspaceStateError("workspace.corrupt", `Workspace State at ${path} must be an object.`, path)
    const record = value as Record<string, unknown>
    if (record.version != 1) {
        const code = typeof record.version == "number" && record.version > 1 ? "workspace.unsupported-version" : "workspace.corrupt"
        throw new WorkspaceStateError(code, `Workspace State at ${path} has an unsupported version.`, path)
    }
    if (!Array.isArray(record.repositories))
        throw new WorkspaceStateError("workspace.corrupt", `Workspace State at ${path} has no repository list.`, path)
    const seen = new Set<string>()
    const repositories: StoredRepository[] = []
    for (const value of record.repositories) {
        const repository = parseRepository(value)
        if (!repository || seen.has(repository.id))
            continue
        seen.add(repository.id)
        repositories.push(repository)
    }
    const activeRepositoryId = nonEmptyString(record.activeRepositoryId) ? record.activeRepositoryId : undefined
    const lastRepositoryParentPath = nonEmptyString(record.lastRepositoryParentPath) ? record.lastRepositoryParentPath : undefined
    return {
        workspace: {
            version: 1,
            repositories,
            ...(activeRepositoryId ? { activeRepositoryId } : {}),
            ...(lastRepositoryParentPath ? { lastRepositoryParentPath } : {}),
        },
        skipped: record.repositories.length - repositories.length,
    }
}

export async function writeWorkspace(workspace: StoredWorkspace, path = defaultWorkspacePath()) {
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
    try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temporaryPath, `${JSON.stringify(workspace, null, 4)}\n`, { encoding: "utf8", flag: "wx" })
        await rename(temporaryPath, path)
    } catch {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw new WorkspaceStateError("workspace.write-failed", `Workbench could not save Workspace State at ${path}.`, path)
    }
}

export async function resetWorkspace(path = defaultWorkspacePath()) {
    await copyFile(path, `${path}.bak`).catch(() => undefined)
    const workspace = emptyWorkspace()
    await writeWorkspace(workspace, path)
    return workspace
}

function emptyWorkspace(): StoredWorkspace {
    return { version: 1, repositories: [] }
}

function parseRepository(value: unknown): StoredRepository | undefined {
    if (!value || typeof value != "object" || Array.isArray(value))
        return undefined
    const record = value as Record<string, unknown>
    if (
        !nonEmptyString(record.id) || !nonEmptyString(record.path) || !nonEmptyString(record.name)
        || typeof record.open != "boolean" || !Array.isArray(record.anchors) || !record.anchors.every(nonEmptyString)
        || !Array.isArray(record.columns)
    ) {
        return undefined
    }
    const columns = record.columns.map(parseColumn).filter(column => column != undefined)
    if (columns.length != record.columns.length)
        return undefined
    const objectFormat = record.objectFormat == "sha1" || record.objectFormat == "sha256" ? record.objectFormat as ObjectFormat : undefined
    const focusedColumnId = nonEmptyString(record.focusedColumnId) ? record.focusedColumnId : undefined
    return {
        id: record.id,
        path: record.path,
        name: record.name,
        ...(objectFormat ? { objectFormat } : {}),
        anchors: [...new Set(record.anchors as string[])],
        open: record.open,
        columns,
        ...(focusedColumnId ? { focusedColumnId } : {}),
        layoutInitialized: record.layoutInitialized === true,
    }
}

function parseColumn(value: unknown): WorkspaceColumn | undefined {
    if (!value || typeof value != "object" || Array.isArray(value))
        return undefined
    const record = value as Record<string, unknown>
    if (
        !nonEmptyString(record.id) || !nonEmptyString(record.lastSeenObjectId) || typeof record.width != "number" || !Number.isFinite(record.width)
        || record.width < 310
    ) {
        return undefined
    }
    if (record.kind == "branch" && nonEmptyString(record.ref)) {
        return {
            kind: "branch",
            id: record.id,
            ref: record.ref,
            lastSeenObjectId: record.lastSeenObjectId,
            width: record.width,
            ...(nonEmptyString(record.worktreePath) ? { worktreePath: record.worktreePath } : {}),
        }
    }
    if (record.kind == "virtual" && nonEmptyString(record.worktreePath))
        return { kind: "virtual", id: record.id, worktreePath: record.worktreePath, lastSeenObjectId: record.lastSeenObjectId, width: record.width }
    return undefined
}

function nonEmptyString(value: unknown): value is string {
    return typeof value == "string" && value.trim() != ""
}
