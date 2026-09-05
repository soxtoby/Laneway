import { GitError, type GitInstallation, type GitTask, inferCloneDirectoryName, initializeRepository, openRepository, type RepositoryGit, selectGit, startCloneRepository } from "@git-workbench/git"
import { defaultSettingsPath, readSettings, SettingsError, WorkspaceStateError, writeSettings } from "@git-workbench/settings"
import type { Appearance, AuthorIdentitySettings, BranchGraph, BranchGraphReadOptions, BranchHistoryPage, BranchHistoryRequest, ChangesRequest, EntryError, FileDiffRequest, GitSettingsState, RepositoryGraphSettings, RepositoryInfo } from "@git-workbench/shared"
import { resolve } from "node:path"

export class OpenRepositories {
    private readonly repositories = new Map<string, { info: RepositoryInfo; git: RepositoryGit }>()
    private readonly graphReads = new Map<string, GitTask<BranchGraph>>()
    private readonly historyReads = new Map<string, GitTask<BranchHistoryPage>>()
    private readonly inspectionReads = new Map<string, Map<string, GitTask<unknown>>>()
    private cachedGit: { override: string | undefined; installation: GitInstallation } | undefined
    private settingsWrite: Promise<void> = Promise.resolve()

    constructor(
        private readonly settingsPath = defaultSettingsPath(),
        private readonly selectInstallation: typeof selectGit = selectGit,
    ) {}

    list() {
        return [...this.repositories.values()].map(repository => repository.info)
    }

    async gitSettings(): Promise<GitSettingsState> {
        try {
            const settings = await readSettings(this.settingsPath)
            return {
                path: this.settingsPath,
                override: settings.gitPath,
                git: await this.git(settings.gitPath),
                authorIdentities: settings.authorIdentities ?? { secondary: [] },
            }
        } catch (error) {
            return {
                path: this.settingsPath,
                authorIdentities: { secondary: [] },
                error: entryError(error),
            }
        }
    }

    async setGitOverride(path?: string): Promise<GitSettingsState> {
        const git = await this.selectInstallation(path)
        const override = path ? resolve(path) : undefined
        const settings = await this.updateSettings(current => ({ ...current, gitPath: override }))
        this.cachedGit = { override, installation: git }
        return { path: this.settingsPath, override, git, authorIdentities: settings.authorIdentities ?? { secondary: [] } }
    }

    async resetSettings() {
        await this.updateSettings(() => ({ version: 1 }))
        this.cachedGit = undefined
        return this.gitSettings()
    }

    async setAuthorIdentities(authorIdentities: AuthorIdentitySettings) {
        await this.updateSettings(current => ({ ...current, authorIdentities }))
        return this.gitSettings()
    }

    async appearance(): Promise<Appearance> {
        try {
            return (await readSettings(this.settingsPath)).appearance ?? "light"
        } catch {
            return "light"
        }
    }

    async setAppearance(appearance: Appearance) {
        await this.updateSettings(current => ({ ...current, appearance }))
        return appearance
    }

    async setRepositoryGraphSettings(repositoryId: string, graphSettings: RepositoryGraphSettings) {
        await this.requireRepository(repositoryId)
        await this.updateSettings(current => ({
            ...current,
            repositories: { ...current.repositories, [repositoryId]: graphSettings },
        }))
        return graphSettings
    }

    async startBranchGraph(repositoryId: string, refreshRemote = false) {
        const repository = this.requireRepository(repositoryId)
        const settings = await readSettings(this.settingsPath)
        const graphSettings = settings.repositories?.[repositoryId] ?? { remotePatterns: [] }
        const options: BranchGraphReadOptions = {
            authorIdentities: settings.authorIdentities ?? { secondary: [] },
            selectedRemote: graphSettings.selectedRemote,
            remotePatterns: graphSettings.remotePatterns,
            refreshRemote,
        }
        this.graphReads.get(repositoryId)?.cancel()
        const read = repository.git.startReadBranchGraph(options)
        const tracked: GitTask<BranchGraph> = {
            cancel: read.cancel,
            result: read.result.then(async graph => {
                await this.seedGraphSettings(repositoryId, graph)
                return { ...graph, repositoryId }
            }).finally(() => {
                if (this.graphReads.get(repositoryId) == tracked)
                    this.graphReads.delete(repositoryId)
            }),
        }
        this.graphReads.set(repositoryId, tracked)
        return tracked
    }

    startBranchHistory(repositoryId: string, request: BranchHistoryRequest) {
        const repository = this.requireRepository(repositoryId)
        if (request.requestId) {
            const requestId = request.requestId
            return {
                result: this.trackInspection(repositoryId, requestId, () => repository.git.startReadBranchHistory(request)),
                cancel: () => {
                    this.cancelInspection(repositoryId, requestId)
                },
            }
        }
        this.historyReads.get(repositoryId)?.cancel()
        const read = repository.git.startReadBranchHistory(request)
        const tracked: GitTask<BranchHistoryPage> = {
            cancel: read.cancel,
            result: read.result.finally(() => {
                if (this.historyReads.get(repositoryId) == tracked)
                    this.historyReads.delete(repositoryId)
            }),
        }
        this.historyReads.set(repositoryId, tracked)
        return tracked
    }

    cancelBranchGraph(repositoryId: string) {
        const read = this.graphReads.get(repositoryId)
        read?.cancel()
        return Boolean(read)
    }

    cancelBranchHistory(repositoryId: string) {
        const read = this.historyReads.get(repositoryId)
        read?.cancel()
        return Boolean(read)
    }

    readChanges(repositoryId: string, requestId: string, request: ChangesRequest) {
        return this.trackInspection(repositoryId, requestId, () => this.requireRepository(repositoryId).git.startReadChanges(request))
    }

    readFileDiff(repositoryId: string, requestId: string, request: FileDiffRequest) {
        return this.trackInspection(repositoryId, requestId, () => this.requireRepository(repositoryId).git.startReadFileDiff(request))
    }

    cancelInspection(repositoryId: string, requestId: string) {
        const read = this.inspectionReads.get(repositoryId)?.get(requestId)
        read?.cancel()
        return Boolean(read)
    }

    private trackInspection<T>(repositoryId: string, requestId: string, start: () => GitTask<T>) {
        let reads = this.inspectionReads.get(repositoryId)
        if (!reads) {
            reads = new Map()
            this.inspectionReads.set(repositoryId, reads)
        }
        reads.get(requestId)?.cancel()
        const read = start()
        reads.set(requestId, read)
        return read.result.finally(() => {
            if (reads.get(requestId) == read)
                reads.delete(requestId)
            if (reads.size == 0)
                this.inspectionReads.delete(repositoryId)
        })
    }

    async open(path: string, id?: string) {
        const settings = await readSettings(this.settingsPath)
        return this.add(await openRepository(path, await this.git(settings.gitPath)), id)
    }

    async initialize(path: string, initialBranch?: string, id?: string) {
        const settings = await readSettings(this.settingsPath)
        return this.add(await initializeRepository({ path, initialBranch, git: await this.git(settings.gitPath) }), id)
    }

    async startClone(options: { source: string; destination: string; onProgress?: (message: string) => void; id?: string }): Promise<GitTask<RepositoryInfo>> {
        const settings = await readSettings(this.settingsPath)
        const task = await startCloneRepository({ ...options, git: await this.git(settings.gitPath) })
        return {
            cancel: task.cancel,
            result: task.result.then(repository => this.add(repository, options.id)),
        }
    }

    suggestedCloneDestination(source: string, parent: string) {
        return resolve(parent, inferCloneDirectoryName(source))
    }

    close(id: string) {
        this.graphReads.get(id)?.cancel()
        this.historyReads.get(id)?.cancel()
        for (const read of this.inspectionReads.get(id)?.values() ?? [])
            read.cancel()
        return this.repositories.delete(id)
    }

    async containsObject(id: string, objectId: string) {
        try {
            return await this.requireRepository(id).git.resolveRef(objectId) == objectId
        } catch {
            return false
        }
    }

    private async git(override: string | undefined): Promise<GitInstallation> {
        if (this.cachedGit && this.cachedGit.override == override)
            return this.cachedGit.installation
        const installation = await this.selectInstallation(override)
        this.cachedGit = { override, installation }
        return installation
    }

    private add(repository: RepositoryGit, preferredId?: string) {
        const existing = [...this.repositories.values()].find(candidate => candidate.git.descriptor.commonDirectory == repository.descriptor.commonDirectory)
        const id = existing?.info.id ?? preferredId ?? crypto.randomUUID()
        const info: RepositoryInfo = { ...repository.descriptor, id }
        if (existing && existing.info.id != id)
            this.repositories.delete(existing.info.id)
        this.repositories.set(id, { info, git: repository })
        return info
    }

    private requireRepository(repositoryId: string) {
        const repository = this.repositories.get(repositoryId)
        if (!repository)
            throw new GitError("git.invalid-root", "The repository is no longer open in this Workspace.", { repositoryId })
        return repository
    }

    private async seedGraphSettings(repositoryId: string, graph: BranchGraph) {
        await this.updateSettings(current => {
            const authorIdentities = current.authorIdentities?.primary || !graph.effectiveAuthorEmail
                ? current.authorIdentities
                : { primary: graph.effectiveAuthorEmail, secondary: current.authorIdentities?.secondary ?? [] }
            const existing = current.repositories?.[repositoryId] ?? { remotePatterns: [] }
            const repository = existing.selectedRemote || !graph.selectedRemote
                ? existing
                : { ...existing, selectedRemote: graph.selectedRemote }
            return {
                ...current,
                ...(authorIdentities ? { authorIdentities } : {}),
                repositories: { ...current.repositories, [repositoryId]: repository },
            }
        })
    }

    private async updateSettings(change: (settings: Awaited<ReturnType<typeof readSettings>>) => Awaited<ReturnType<typeof readSettings>>) {
        let result: Awaited<ReturnType<typeof readSettings>> | undefined
        const write = async () => {
            result = change(await readSettings(this.settingsPath))
            await writeSettings(result, this.settingsPath)
        }
        this.settingsWrite = this.settingsWrite.then(write, write)
        await this.settingsWrite
        return result!
    }
}

export function entryError(error: unknown): EntryError {
    if (error instanceof GitError) {
        return {
            code: error.code,
            message: error.message,
            destination: typeof error.details?.destination == "string" ? error.details.destination : undefined,
        }
    }
    if (error instanceof SettingsError)
        return { code: error.code, message: error.message }
    if (error instanceof WorkspaceStateError)
        return { code: error.code, message: error.message }
    return { code: "git.command-failed", message: error instanceof Error ? error.message : String(error) }
}
