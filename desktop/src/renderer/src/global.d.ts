import type { Appearance, AuthorIdentitySettings, BranchGraphResult, BranchHistoryRequest, BranchHistoryResult, EntryProgress, EntryResult, GitSettingsState, RepositoryGraphSettings, Workspace } from "@git-workbench/shared"
import type { ChangesRequest, ChangesResult, FileDiffRequest, FileDiffResult } from "@git-workbench/shared"
import type { WorktreeActionResult, WorktreePreviewResult, WorktreeRequest } from "@git-workbench/shared"

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
    appearance: Appearance
    defaultCloneParent: string
}

declare global {
    interface Window {
        workbench: {
            previewWorktree(repositoryId: string, request: WorktreeRequest): Promise<WorktreePreviewResult>
            executeWorktree(repositoryId: string, request: WorktreeRequest, token: string): Promise<WorktreeActionResult>
            transitionOperation(repositoryId: string, action: "undo" | "redo", basename?: string): Promise<WorktreeActionResult>
            readChanges(repositoryId: string, requestId: string, request: ChangesRequest): Promise<ChangesResult>
            readFileHistory(repositoryId: string, requestId: string, request: FileHistoryRequest): Promise<FileHistoryResult>
            readFileDiff(repositoryId: string, requestId: string, request: FileDiffRequest): Promise<FileDiffResult>
            cancelInspection(repositoryId: string, requestId: string): Promise<boolean>
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
            setAppearance(appearance: Appearance): Promise<Appearance>
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
import type { FileHistoryRequest, FileHistoryResult } from "@git-workbench/shared"
