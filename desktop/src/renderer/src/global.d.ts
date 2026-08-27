import type { EntryProgress, EntryResult, GitSettingsState, WorkbenchSession } from "@git-workbench/shared"

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
    session: WorkbenchSession
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
            selectRepository(id: string): Promise<WorkbenchSession>
            chooseGit(): Promise<GitSettingsState>
            useGitFromPath(): Promise<GitSettingsState>
            resetSettings(): Promise<GitSettingsState>
            openSettingsFile(): Promise<string>
            onEntryProgress(listener: (progress: EntryProgress) => void): () => void
        }
    }
}

export {}
