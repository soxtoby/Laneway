import type { AuthorIdentitySettings, BranchGraphResult, BranchHistoryRequest, BranchHistoryResult, EntryProgress, EntryResult, GitSettingsState, RepositoryGraphSettings, Workspace } from "@git-workbench/shared"

interface EngineStatusReady {
    state: "ready"
    path: string
    name: "workbench-engine"
    version: string
}

interface EngineStatusError {
    state: "error"
    path: string
    error: string
}

interface AppState {
    workspace: Workspace
    settings: GitSettingsState
    engine: EngineStatusReady | EngineStatusError
    defaultCloneParent: string
}

declare global {
    interface Window {
        workbench: {
            getState(): Promise<AppState>
            openRepository(): Promise<EntryResult>
            chooseDirectory(defaultPath?: string): Promise<string | undefined>
            suggestCloneDestination(source: string, parent: string): Promise<string>
            cloneRepository(source: string, destination: string): Promise<EntryResult>
            initializeRepository(path: string, initialBranch?: string): Promise<EntryResult>
            cancelEntry(): Promise<boolean>
            selectRepository(id: string): Promise<Workspace>
            closeRepository(id: string): Promise<Workspace>
            locateRepository(id: string, useAnyway?: boolean): Promise<Workspace>
            updateWorkspace(workspace: Workspace): Promise<Workspace>
            resetWorkspace(): Promise<Workspace>
            chooseGit(): Promise<GitSettingsState>
            useGitFromPath(): Promise<GitSettingsState>
            resetSettings(): Promise<GitSettingsState>
            setAuthorIdentities(settings: AuthorIdentitySettings): Promise<GitSettingsState>
            openSettingsFile(): Promise<string>
            readBranchGraph(repositoryId: string, refreshRemote?: boolean): Promise<BranchGraphResult>
            cancelBranchGraph(repositoryId: string): Promise<boolean>
            readBranchHistory(repositoryId: string, history: BranchHistoryRequest): Promise<BranchHistoryResult>
            cancelBranchHistory(repositoryId: string): Promise<boolean>
            setRepositoryGraphSettings(repositoryId: string, settings: RepositoryGraphSettings): Promise<RepositoryGraphSettings>
            onEntryProgress(listener: (progress: EntryProgress) => void): () => void
        }
    }
}

export {}
