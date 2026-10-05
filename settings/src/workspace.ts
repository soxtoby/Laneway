import type { DiffLayout, ObjectFormat, Workspace, WorkspaceColumn } from "@laneway/shared"
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
        return resolve(environment.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "Laneway", "workspace.json")
    else if (platform == "darwin")
        return resolve(homedir(), "Library", "Application Support", "Laneway", "workspace.json")
    else
        return resolve(environment.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "laneway", "workspace.json")
}

export function parseWorkspacePresentation(value: unknown) {
    if (!value || typeof value != "object" || Array.isArray(value))
        throw new Error("Workspace State is invalid.")

    let record = value as Partial<Workspace>
    if (!Array.isArray(record.repositories))
        throw new Error("Workspace State is invalid.")

    let repositories = Array.from(record.repositories, repository => parsePresentation(repository)).filter(repository => repository != undefined)
    let ids = new Set(repositories.map(repository => repository.id))
    if (
        repositories.length != record.repositories.length || ids.size != repositories.length
        || (record.activeRepositoryId !== undefined && !ids.has(record.activeRepositoryId))
    ) {
        throw new Error("Workspace State is invalid.")
    }

    return { repositories, activeRepositoryId: record.activeRepositoryId }
}

export async function readWorkspace(path = defaultWorkspacePath()): Promise<{ workspace: StoredWorkspace; skipped: number }> {
    let content: string
    try {
        content = await readFile(path, "utf8")
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT")
            return { workspace: emptyWorkspace(), skipped: 0 }
        throw new WorkspaceStateError("workspace.corrupt", `Laneway could not read Workspace State at ${path}.`, path)
    }

    let value: unknown
    try {
        value = JSON.parse(content)
    } catch {
        throw new WorkspaceStateError("workspace.corrupt", `Workspace State at ${path} is not valid JSON.`, path)
    }

    if (!value || typeof value != "object" || Array.isArray(value))
        throw new WorkspaceStateError("workspace.corrupt", `Workspace State at ${path} must be an object.`, path)

    let record = value as Record<string, unknown>
    if (record.version != 1) {
        let code: WorkspaceStateError["code"] = typeof record.version == "number" && record.version > 1 ? "workspace.unsupported-version" : "workspace.corrupt"
        throw new WorkspaceStateError(code, `Workspace State at ${path} has an unsupported version.`, path)
    }
    if (!Array.isArray(record.repositories))
        throw new WorkspaceStateError("workspace.corrupt", `Workspace State at ${path} has no repository list.`, path)

    let seen = new Set<string>()
    let repositories: StoredRepository[] = []
    for (let value of record.repositories) {
        let repository = parseRepository(value)
        if (repository && !seen.has(repository.id)) {
            seen.add(repository.id)
            repositories.push(repository)
        }
    }

    let activeRepositoryId = nonEmptyString(record.activeRepositoryId) ? record.activeRepositoryId : undefined
    let lastRepositoryParentPath = nonEmptyString(record.lastRepositoryParentPath) ? record.lastRepositoryParentPath : undefined

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

export async function resetWorkspace(path = defaultWorkspacePath()) {
    await copyFile(path, `${path}.bak`).catch(() => undefined)
    let workspace = emptyWorkspace()
    await writeWorkspace(workspace, path)
    return workspace
}

export async function writeWorkspace(workspace: StoredWorkspace, path = defaultWorkspacePath()) {
    let temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
    try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temporaryPath, `${JSON.stringify(workspace, null, 4)}\n`, { encoding: "utf8", flag: "wx" })
        await rename(temporaryPath, path)
    } catch {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw new WorkspaceStateError("workspace.write-failed", `Laneway could not save Workspace State at ${path}.`, path)
    }
}

function emptyWorkspace(): StoredWorkspace {
    return { version: 1, repositories: [] }
}

function parseRepository(value: unknown): StoredRepository | undefined {
    if (!value || typeof value != "object" || Array.isArray(value))
        return undefined

    let record = value as Record<string, unknown>
    if (
        !nonEmptyString(record.path) || !nonEmptyString(record.name)
        || typeof record.open != "boolean" || !Array.isArray(record.anchors) || !record.anchors.every(nonEmptyString)
    ) {
        return undefined
    }

    let presentation = parsePresentation(record, true)
    if (!presentation)
        return undefined

    let objectFormat = record.objectFormat == "sha1" || record.objectFormat == "sha256" ? record.objectFormat as ObjectFormat : undefined
    return {
        ...presentation,
        path: record.path,
        name: record.name,
        ...(objectFormat ? { objectFormat } : {}),
        anchors: [...new Set(record.anchors as string[])],
        open: record.open,
    }
}

function parsePresentation(value: unknown, restoring = false) {
    if (!value || typeof value != "object" || Array.isArray(value))
        return undefined

    let record = value as Partial<StoredRepository>
    if (!nonEmptyString(record.id) || !Array.isArray(record.columns))
        return undefined

    let columns = Array.from(record.columns, column => parseColumn(column, restoring)).filter(column => column != undefined)
    if (columns.length != record.columns.length)
        return undefined

    let ids = new Set(columns.map(column => column.id))
    if (
        !restoring && (ids.size != columns.length || typeof record.layoutInitialized != "boolean"
            || (record.focusedColumnId !== undefined && !ids.has(record.focusedColumnId)))
    ) {
        return undefined
    }

    return {
        id: record.id,
        columns,
        ...(nonEmptyString(record.focusedColumnId) ? { focusedColumnId: record.focusedColumnId } : {}),
        layoutInitialized: record.layoutInitialized === true,
    }
}

function parseColumn(value: unknown, restoring = false): WorkspaceColumn | undefined {
    if (!value || typeof value != "object" || Array.isArray(value))
        return undefined

    let record = value as Record<string, unknown>
    if (
        !nonEmptyString(record.id) || !nonEmptyString(record.lastSeenObjectId) || typeof record.width != "number" || !Number.isFinite(record.width)
        || record.width < 310
    ) {
        return undefined
    }

    let diffLayout = record.diffLayout == "split" || record.diffLayout == "unified" ? record.diffLayout as DiffLayout : undefined
    let worktreePath = nonEmptyString(record.worktreePath) ? record.worktreePath : undefined
    let worktreeId = nonEmptyString(record.worktreeId) ? record.worktreeId : undefined
    if (
        !restoring && ((record.collapsed !== undefined && typeof record.collapsed != "boolean")
            || (record.diffLayout !== undefined && diffLayout === undefined)
            || (record.worktreePath !== undefined && worktreePath === undefined))
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
            ...(record.collapsed === true ? { collapsed: true } : {}),
            ...(diffLayout ? { diffLayout } : {}),
            ...(worktreePath ? { worktreePath } : {}),
            ...(worktreeId ? { worktreeId } : {}),
        }
    } else if (record.kind == "virtual" && nonEmptyString(record.worktreePath)) {
        return {
            kind: "virtual",
            id: record.id,
            worktreePath: record.worktreePath,
            ...(worktreeId ? { worktreeId } : {}),
            lastSeenObjectId: record.lastSeenObjectId,
            width: record.width,
            ...(record.collapsed === true ? { collapsed: true } : {}),
            ...(diffLayout ? { diffLayout } : {}),
        }
    } else {
        return undefined
    }
}

function nonEmptyString(value: unknown): value is string {
    return typeof value == "string" && value.trim() != ""
}
