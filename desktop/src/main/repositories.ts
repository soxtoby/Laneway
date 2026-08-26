import { GitError, type GitTask, inferCloneDirectoryName, initializeRepository, openRepository, type RepositoryGit, selectGit, startCloneRepository } from "@git-workbench/git"
import { defaultSettingsPath, readSettings, SettingsError, writeSettings } from "@git-workbench/settings"
import { type EntryError, type GitSettingsState, type RepositoryInfo, type WorkbenchSession } from "@git-workbench/shared"
import { resolve } from "node:path"

export class RepositorySession {
    private readonly repositories = new Map<string, RepositoryInfo>()
    private activeRepositoryId: string | undefined

    constructor(private readonly settingsPath = defaultSettingsPath()) {}

    snapshot(): WorkbenchSession {
        return {
            repositories: [...this.repositories.values()],
            activeRepositoryId: this.activeRepositoryId,
        }
    }

    async gitSettings(): Promise<GitSettingsState> {
        try {
            const settings = await readSettings(this.settingsPath)
            return {
                path: this.settingsPath,
                override: settings.gitPath,
                git: await selectGit(settings.gitPath),
            }
        } catch (error) {
            return {
                path: this.settingsPath,
                error: entryError(error),
            }
        }
    }

    async setGitOverride(path?: string): Promise<GitSettingsState> {
        const git = await selectGit(path)
        await writeSettings({ version: 1, gitPath: path ? resolve(path) : undefined }, this.settingsPath)
        return { path: this.settingsPath, override: path ? resolve(path) : undefined, git }
    }

    async resetSettings() {
        await writeSettings({ version: 1 }, this.settingsPath)
        return this.gitSettings()
    }

    async open(path: string) {
        const settings = await readSettings(this.settingsPath)
        return this.add(await openRepository(path, settings.gitPath))
    }

    async initialize(path: string, initialBranch?: string) {
        const settings = await readSettings(this.settingsPath)
        return this.add(await initializeRepository({ path, initialBranch, gitPath: settings.gitPath }))
    }

    async startClone(options: { source: string; destination: string; onProgress?: (message: string) => void }): Promise<GitTask<WorkbenchSession>> {
        const settings = await readSettings(this.settingsPath)
        const task = await startCloneRepository({ ...options, gitPath: settings.gitPath })
        return {
            cancel: task.cancel,
            result: task.result.then(repository => this.add(repository)),
        }
    }

    suggestedCloneDestination(source: string, parent: string) {
        return resolve(parent, inferCloneDirectoryName(source))
    }

    selectRepository(id: string) {
        if (!this.repositories.has(id))
            return false
        this.activeRepositoryId = id
        return true
    }

    private add(repository: RepositoryGit) {
        const info: RepositoryInfo = { ...repository.descriptor }
        this.repositories.set(info.id, info)
        this.activeRepositoryId = info.id
        return this.snapshot()
    }
}

export function entryError(error: unknown): EntryError {
    if (error instanceof GitError) {
        return {
            code: error.code,
            message: error.message,
            destination: typeof error.details?.destination == "string" ? error.details.destination : undefined,
            canRemoveDestination: error.details?.createdDestination === true,
        }
    }
    if (error instanceof SettingsError)
        return { code: error.code, message: error.message }
    return { code: "git.command-failed", message: error instanceof Error ? error.message : String(error) }
}
