import { pathExists } from "@laneway/git"
import { parseWorkspacePresentation, readWorkspace, resetWorkspace, type StoredRepository, type StoredWorkspace, WorkspaceStateError, writeWorkspace } from "@laneway/settings"
import type { EntryError, OpenRepository, RepositoryInfo, Workspace } from "@laneway/shared"
import { basename, dirname } from "node:path"
import { entryError, type OpenRepositories } from "./repositories"

export class WorkspaceManager {
    private stored: StoredWorkspace = { version: 1, repositories: [] }
    private available = new Map<string, RepositoryInfo>()
    private persistenceError: EntryError | undefined
    private writesBlocked = false
    private writes: Promise<void> = Promise.resolve()

    constructor(
        private readonly openRepositories: OpenRepositories,
        private readonly path: string,
    ) {}

    async load() {
        try {
            const { workspace, skipped } = await readWorkspace(this.path)
            this.stored = workspace
            if (skipped > 0)
                this.persistenceError = { code: "workspace.partial", message: `${skipped} invalid saved repositories were skipped.` }
        } catch (error) {
            this.persistenceError = workspaceError(error)
            this.writesBlocked = true
            return this.snapshot()
        }
        for (const repository of this.stored.repositories.filter(repository => repository.open)) {
            try {
                const info = await this.openRepositories.open(repository.path, repository.id)
                if (repository.objectFormat && repository.objectFormat != info.objectFormat)
                    throw new Error("The repository object format no longer matches saved Workspace State.")
                this.available.set(repository.id, info)
            } catch {
                // The persisted record remains visible as missing.
                this.openRepositories.close(repository.id)
            }
        }
        return this.snapshot()
    }

    snapshot(): Workspace {
        const repositories: OpenRepository[] = this.stored.repositories.filter(repository => repository.open).map(repository => {
            const info = this.available.get(repository.id)
            const common = {
                id: repository.id,
                path: repository.path,
                columns: repository.columns.map(column => ({ ...column })),
                focusedColumnId: repository.focusedColumnId,
                layoutInitialized: repository.layoutInitialized,
            }
            return info
                ? { ...common, status: "available" as const, info }
                : {
                    ...common,
                    status: "missing" as const,
                    name: repository.name,
                    error: { code: "git.invalid-root" as const, message: `Repository unavailable at ${repository.path}.` },
                }
        })
        const activeRepositoryId = this.stored.activeRepositoryId && repositories.some(repository => repository.id == this.stored.activeRepositoryId)
            ? this.stored.activeRepositoryId
            : repositories[0]?.id
        return {
            repositories,
            ...(activeRepositoryId ? { activeRepositoryId } : {}),
            ...(this.persistenceError ? { persistenceError: this.persistenceError } : {}),
        }
    }

    repositoryOpenDefaultPath() {
        return this.stored.lastRepositoryParentPath
    }

    async refreshAvailability() {
        for (const [id, info] of this.available) {
            if (!await pathExists(info.mainWorktree)) {
                this.available.delete(id)
                this.openRepositories.close(id)
            }
        }
        return this.snapshot()
    }

    async open(path: string) {
        const retained = this.stored.repositories.find(repository => !repository.open && samePath(repository.path, path))
        const info = await this.openRepositories.open(path, retained?.id)
        let record = this.stored.repositories.find(repository => repository.id == info.id)
        if (!record) {
            record = storedRepository(info)
            this.stored.repositories.push(record)
        }
        record.open = true
        record.path = info.mainWorktree
        record.name = basename(info.mainWorktree)
        record.objectFormat = info.objectFormat
        this.stored.lastRepositoryParentPath = dirname(info.mainWorktree)
        this.available.set(record.id, info)
        this.stored.activeRepositoryId = record.id
        await this.save()
        return this.snapshot()
    }

    async add(info: RepositoryInfo) {
        const record = this.stored.repositories.find(repository => repository.id == info.id) ?? storedRepository(info)
        if (!this.stored.repositories.includes(record))
            this.stored.repositories.push(record)
        record.open = true
        this.stored.lastRepositoryParentPath = dirname(info.mainWorktree)
        this.available.set(info.id, info)
        this.stored.activeRepositoryId = info.id
        await this.save()
        return this.snapshot()
    }

    async locate(id: string, path: string, useAnyway = false) {
        const record = this.requireStored(id)
        const info = await this.openRepositories.open(path, id)
        const anchors = new Set(record.anchors)
        const matchingAnchor = anchors.size == 0
            || (await Promise.all([...anchors].map(anchor => this.openRepositories.containsObject(id, anchor)))).some(Boolean)
        const plausible = (!record.objectFormat || record.objectFormat == info.objectFormat) && matchingAnchor
        if (!plausible && !useAnyway) {
            this.openRepositories.close(id)
            throw new Error("The selected repository does not match saved Workspace State.")
        }
        record.path = info.mainWorktree
        record.name = basename(info.mainWorktree)
        record.objectFormat = info.objectFormat
        this.stored.lastRepositoryParentPath = dirname(info.mainWorktree)
        this.available.set(id, info)
        await this.save()
        return this.snapshot()
    }

    async select(id: string) {
        this.requireStored(id)
        this.stored.activeRepositoryId = id
        await this.save()
        return this.snapshot()
    }

    async close(id: string) {
        const open = this.stored.repositories.filter(repository => repository.open)
        const index = open.findIndex(repository => repository.id == id)
        const record = this.requireStored(id)
        record.open = false
        this.available.delete(id)
        this.openRepositories.close(id)
        if (this.stored.activeRepositoryId == id)
            this.stored.activeRepositoryId = open[index + 1]?.id ?? open[index - 1]?.id
        await this.save()
        return this.snapshot()
    }

    async update(value: unknown) {
        const workspace = parseWorkspacePresentation(value)
        const previous = JSON.stringify(this.stored)
        const openIds = new Set(workspace.repositories.map(repository => repository.id))
        const ordered: StoredRepository[] = workspace.repositories.map(repository => ({
            ...this.requireStored(repository.id),
            ...repository,
            focusedColumnId: repository.focusedColumnId,
            open: true,
            anchors: [...new Set(repository.columns.map(column => column.lastSeenObjectId))],
        }))
        for (const stored of this.stored.repositories.filter(repository => !openIds.has(repository.id)))
            ordered.push({ ...stored, open: false })
        this.stored.repositories = ordered
        this.stored.activeRepositoryId = workspace.activeRepositoryId
        if (JSON.stringify(this.stored) != previous)
            await this.save()
        return this.snapshot()
    }

    async reset() {
        await resetWorkspace(this.path)
        for (const repository of this.available.keys())
            this.openRepositories.close(repository)
        this.available.clear()
        this.stored = { version: 1, repositories: [] }
        this.persistenceError = undefined
        this.writesBlocked = false
        return this.snapshot()
    }

    flush() {
        return this.writes
    }

    private requireStored(id: string) {
        const record = this.stored.repositories.find(repository => repository.id == id)
        if (!record)
            throw new Error("The repository is not part of this Workspace.")
        return record
    }

    private async save() {
        if (this.writesBlocked)
            throw new WorkspaceStateError("workspace.write-failed", "Reset Workspace State before saving changes.", this.path)
        const write = () => writeWorkspace(this.stored, this.path)
        this.writes = this.writes.then(write, write)
        try {
            await this.writes
            if (this.persistenceError?.code == "workspace.write-failed" || this.persistenceError?.code == "workspace.partial")
                this.persistenceError = undefined
        } catch (error) {
            this.persistenceError = workspaceError(error)
        }
    }
}

function storedRepository(info: RepositoryInfo): StoredRepository {
    return {
        id: info.id,
        path: info.mainWorktree,
        name: basename(info.mainWorktree),
        objectFormat: info.objectFormat,
        anchors: [],
        open: true,
        columns: [],
        layoutInitialized: false,
    }
}

function workspaceError(error: unknown): EntryError {
    if (error instanceof WorkspaceStateError)
        return { code: error.code, message: error.message }
    return entryError(error)
}

function samePath(left: string, right: string) {
    return process.platform == "win32" ? left.toLocaleLowerCase() == right.toLocaleLowerCase() : left == right
}
