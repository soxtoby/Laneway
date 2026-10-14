import { GitError, type GitInstallation, type GitTask, inferCloneDirectoryName, initializeRepository, openRepository, type RepositoryGit, selectGit, startCloneRepository } from "@laneway/git"
import { defaultSettingsPath, readSettings, SettingsError, WorkspaceStateError, writeSettings } from "@laneway/settings"
import type { Appearance, AuthorIdentitySettings, BranchGraph, BranchGraphReadOptions, BranchHistoryPage, BranchHistoryRequest, ChangesRequest, EntryError, FileDiffRequest, FileImageRequest, GitSettingsState, RepositoryGraphSettings, RepositoryInfo } from "@laneway/shared"
import type { FileHistoryRequest } from "@laneway/shared"
import { resolve } from "node:path"
import { watchRepository } from "./repository-watcher"

export class OpenRepositories {
    /** Called when an open repository's HEADs, refs, or worktree registrations change on disk. */
    changed: ((repositoryId: string) => void) | undefined
    private readonly repositories = new Map<string, { info: RepositoryInfo; git: RepositoryGit }>()
    private readonly watchers = new Map<string, { commonDirectory: string; stop(): void }>()
    private readonly graphReads = new Map<string, GitTask<BranchGraph>>()
    private readonly historyReads = new Map<string, GitTask<BranchHistoryPage>>()
    private readonly inspectionReads = new Map<string, Map<string, GitTask<unknown>>>()
    private cachedGit: { override: string | undefined; installation: GitInstallation } | undefined
    private settingsWrite: Promise<void> = Promise.resolve()

    constructor(
        private readonly settingsPath = defaultSettingsPath(),
        private readonly selectInstallation: typeof selectGit = selectGit,
    ) {}

    worktreeRepository(repositoryId: string) {
        return this.requireRepository(repositoryId).git
    }

    list() {
        return [...this.repositories.values()].map(repository => repository.info)
    }

    async gitSettings(): Promise<GitSettingsState> {
        try {
            let settings = await readSettings(this.settingsPath)
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
        let git = await this.selectInstallation(path)
        let override = path ? resolve(path) : undefined
        let settings = await this.updateSettings(current => ({ ...current, gitPath: override }))

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

    async startBranchGraph(repositoryId: string, refreshRemote = false, allBranches = false) {
        let repository = this.requireRepository(repositoryId)
        let settings = await readSettings(this.settingsPath)
        let graphSettings = settings.repositories?.[repositoryId] ?? { remotePatterns: [] }
        let options: BranchGraphReadOptions = {
            authorIdentities: settings.authorIdentities ?? { secondary: [] },
            selectedRemote: graphSettings.selectedRemote,
            remotePatterns: graphSettings.remotePatterns,
            allBranches,
            refreshRemote,
        }

        this.graphReads.get(repositoryId)?.cancel()
        let read = repository.git.startReadBranchGraph(options)
        let tracked: GitTask<BranchGraph> = {
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
        let repository = this.requireRepository(repositoryId)

        if (request.requestId) {
            let requestId = request.requestId
            return {
                result: this.trackInspection(repositoryId, requestId, () => repository.git.startReadBranchHistory(request)),
                cancel: () => {
                    this.cancelInspection(repositoryId, requestId)
                },
            }
        }

        this.historyReads.get(repositoryId)?.cancel()
        let read = repository.git.startReadBranchHistory(request)
        let tracked: GitTask<BranchHistoryPage> = {
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
        let read = this.graphReads.get(repositoryId)
        read?.cancel()
        return Boolean(read)
    }

    cancelBranchHistory(repositoryId: string) {
        let read = this.historyReads.get(repositoryId)
        read?.cancel()
        return Boolean(read)
    }

    readChanges(repositoryId: string, requestId: string, request: ChangesRequest) {
        return this.trackInspection(repositoryId, requestId, () => this.requireRepository(repositoryId).git.startReadChanges(request))
    }

    readFileHistory(repositoryId: string, requestId: string, request: FileHistoryRequest) {
        return this.trackInspection(repositoryId, requestId, () => this.requireRepository(repositoryId).git.startReadFileHistory(request))
    }

    readFileDiff(repositoryId: string, requestId: string, request: FileDiffRequest) {
        return this.trackInspection(repositoryId, requestId, () => this.requireRepository(repositoryId).git.startReadFileDiff(request))
    }

    readFileImage(repositoryId: string, requestId: string, request: FileImageRequest) {
        return this.trackInspection(repositoryId, requestId, () => this.requireRepository(repositoryId).git.startReadFileImage(request))
    }

    cancelInspection(repositoryId: string, requestId: string) {
        let read = this.inspectionReads.get(repositoryId)?.get(requestId)
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
        let read = start()
        reads.set(requestId, read)

        return read.result.finally(() => {
            if (reads.get(requestId) == read)
                reads.delete(requestId)
            if (reads.size == 0)
                this.inspectionReads.delete(repositoryId)
        })
    }

    async open(path: string, id?: string) {
        let settings = await readSettings(this.settingsPath)
        return this.add(await openRepository(path, await this.git(settings.gitPath)), id)
    }

    async initialize(parent: string, name: string, initialBranch?: string, id?: string) {
        let settings = await readSettings(this.settingsPath)
        return this.add(await initializeRepository({ path: resolve(parent, name), initialBranch, git: await this.git(settings.gitPath) }), id)
    }

    async startClone(
        options: { source: string; parent: string; name: string; onProgress?: (message: string) => void; id?: string },
    ): Promise<GitTask<RepositoryInfo>> {
        let settings = await readSettings(this.settingsPath)
        let { parent, name, ...clone } = options
        let task = await startCloneRepository({ ...clone, destination: resolve(parent, name), git: await this.git(settings.gitPath) })

        return {
            cancel: task.cancel,
            result: task.result.then(repository => this.add(repository, options.id)),
        }
    }

    suggestedCloneDirectoryName(source: string) {
        return inferCloneDirectoryName(source)
    }

    close(id: string) {
        this.graphReads.get(id)?.cancel()
        this.historyReads.get(id)?.cancel()
        for (let read of this.inspectionReads.get(id)?.values() ?? [])
            read.cancel()

        this.unwatch(id)
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

        let installation = await this.selectInstallation(override)
        this.cachedGit = { override, installation }

        return installation
    }

    private add(repository: RepositoryGit, preferredId?: string) {
        let existing = [...this.repositories.values()].find(candidate => candidate.git.descriptor.commonDirectory == repository.descriptor.commonDirectory)
        let id = existing?.info.id ?? preferredId ?? crypto.randomUUID()
        let info: RepositoryInfo = { ...repository.descriptor, id }
        if (existing && existing.info.id != id) {
            this.repositories.delete(existing.info.id)
            this.unwatch(existing.info.id)
        }

        this.repositories.set(id, { info, git: repository })
        let { commonDirectory } = repository.descriptor
        if (this.watchers.get(id)?.commonDirectory != commonDirectory) {
            this.unwatch(id)
            this.watchers.set(id, { commonDirectory, stop: watchRepository(commonDirectory, () => this.changed?.(id)) })
        }

        return info
    }

    private unwatch(id: string) {
        this.watchers.get(id)?.stop()
        this.watchers.delete(id)
    }

    private requireRepository(repositoryId: string) {
        let repository = this.repositories.get(repositoryId)
        if (!repository)
            throw new GitError("git.invalid-root", "The repository is no longer open in this Workspace.", { repositoryId })
        return repository
    }

    private async seedGraphSettings(repositoryId: string, graph: BranchGraph) {
        await this.updateSettings(current => {
            let authorIdentities = current.authorIdentities?.primary || !graph.effectiveAuthorEmail
                ? current.authorIdentities
                : { primary: graph.effectiveAuthorEmail, secondary: current.authorIdentities?.secondary ?? [] }
            let existing = current.repositories?.[repositoryId] ?? { remotePatterns: [] }
            let repository = existing.selectedRemote || !graph.selectedRemote
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
        let write = async () => {
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
    } else if (error instanceof SettingsError)
        return { code: error.code, message: error.message }
    else if (error instanceof WorkspaceStateError)
        return { code: error.code, message: error.message }
    else
        return { code: "git.command-failed", message: error instanceof Error ? error.message : String(error) }
}
