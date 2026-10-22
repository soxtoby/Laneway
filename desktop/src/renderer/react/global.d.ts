import type { Appearance, AuthorIdentitySettings, BranchGraphResult, BranchHistoryRequest, BranchHistoryResult, EntryDefaults, EntryProgress, EntryResult, GitSettingsState, RepositoryGraphSettings, RepositoryImageFile, Workspace } from "@laneway/shared"
import type { ChangesRequest, ChangesResult, FileDiffRequest, FileDiffResult, FileImageRequest, FileImageResult, FileListView } from "@laneway/shared"
import type { WorktreeActionResult, WorktreePreviewResult, WorktreeRequest } from "@laneway/shared"
import type { CommitDraft, LocalActionResult, LocalRequest } from "@laneway/shared"
import type { DiscardRequest, DiscardResult, DiscardUndoResult } from "@laneway/shared"
import type { ConflictActionResult, ConflictRequest } from "@laneway/shared"
import type { PullActionResult, PullProgress, PullRequest } from "@laneway/shared"
import type { RecoveryActionResult, RecoveryRequest } from "@laneway/shared"
import type { HistoricalEditActionResult, HistoricalEditRequest } from "@laneway/shared"

interface EngineStatusReady {
    state: "ready"
    path: string
    name: "lane"
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
    fileListView: FileListView
    showCommitAges: boolean
}

declare global {
    // Chromium scrolls only the nearest scroll container with `container: "nearest"`; TypeScript's DOM types lack it.
    interface ScrollIntoViewOptions {
        container?: "all" | "nearest"
    }

    interface Window {
        laneway: {
            recoverWorktree(repositoryId: string, request: RecoveryRequest): Promise<RecoveryActionResult>
            pullLatest(repositoryId: string, request: PullRequest): Promise<PullActionResult>
            cancelPull(repositoryId: string): Promise<boolean>
            onPullProgress(listener: (progress: PullProgress) => void): () => void
            readConflictContent(repositoryId: string, object: string): Promise<string | null>
            conflictOperation(repositoryId: string, request: ConflictRequest): Promise<ConflictActionResult>
            /** Enters, returns from, or restarts a worktree's Historical Edit; applying is a compose request. */
            historicalEdit(repositoryId: string, request: HistoricalEditRequest): Promise<HistoricalEditActionResult>
            previewWorktree(repositoryId: string, request: WorktreeRequest): Promise<WorktreePreviewResult>
            localOperation(repositoryId: string, request: LocalRequest, token?: string): Promise<LocalActionResult>
            /** Applies a Working Changes Discard immediately, setting the originals aside for a short undo window. */
            discardChanges(repositoryId: string, request: DiscardRequest): Promise<DiscardResult>
            undoDiscard(repositoryId: string, id: string): Promise<DiscardUndoResult>
            /** Releases a discard's originals, making it final. */
            settleDiscard(repositoryId: string, id: string): Promise<void>
            readCommitDraft(repositoryId: string, path: string): Promise<CommitDraft>
            saveCommitDraft(repositoryId: string, path: string, draft: CommitDraft): Promise<void>
            executeWorktree(repositoryId: string, request: WorktreeRequest, token: string): Promise<WorktreeActionResult>
            transitionOperation(repositoryId: string, action: "undo" | "redo", basename?: string): Promise<WorktreeActionResult>
            readChanges(repositoryId: string, requestId: string, request: ChangesRequest): Promise<ChangesResult>
            readFileHistory(repositoryId: string, requestId: string, request: FileHistoryRequest): Promise<FileHistoryResult>
            readFileDiff(repositoryId: string, requestId: string, request: FileDiffRequest): Promise<FileDiffResult>
            readFileImage(repositoryId: string, requestId: string, request: FileImageRequest): Promise<FileImageResult>
            cancelInspection(repositoryId: string, requestId: string): Promise<boolean>
            getState(): Promise<AppState>
            openRepository(): Promise<EntryResult>
            chooseDirectory(defaultPath?: string): Promise<string | undefined>
            entryDefaults(form: "clone" | "init"): Promise<EntryDefaults>
            suggestCloneDirectoryName(source: string): Promise<string>
            cloneRepository(source: string, parent: string, name: string): Promise<EntryResult>
            initializeRepository(parent: string, name: string, initialBranch?: string): Promise<EntryResult>
            cancelEntry(): Promise<boolean>
            selectRepository(id: string): Promise<Workspace>
            closeRepository(id: string): Promise<Workspace>
            locateRepository(id: string, useAnyway?: boolean): Promise<Workspace>
            updateWorkspace(workspace: Workspace): Promise<Workspace>
            resetWorkspace(): Promise<Workspace>
            /** The bytes of a favicon or chosen icon image, or nothing when it cannot be read as an icon. */
            readIconImage(path: string): Promise<{ bytes: Uint8Array; mime: string } | undefined>
            /** The image files in an open repository's Main Worktree, likely icons first; empty for a missing repository. */
            listRepositoryImages(repositoryId: string): Promise<RepositoryImageFile[]>
            chooseGit(): Promise<GitSettingsState>
            useGitFromPath(): Promise<GitSettingsState>
            resetSettings(): Promise<GitSettingsState>
            setAuthorIdentities(settings: AuthorIdentitySettings): Promise<GitSettingsState>
            openSettingsFile(): Promise<string>
            setAppearance(appearance: Appearance): Promise<Appearance>
            setFileListView(view: FileListView): Promise<FileListView>
            setShowCommitAges(shown: boolean): Promise<boolean>
            readBranchGraph(repositoryId: string, refreshRemote?: boolean, allBranches?: boolean): Promise<BranchGraphResult>
            cancelBranchGraph(repositoryId: string): Promise<boolean>
            readBranchHistory(repositoryId: string, history: BranchHistoryRequest): Promise<BranchHistoryResult>
            cancelBranchHistory(repositoryId: string): Promise<boolean>
            setRepositoryGraphSettings(repositoryId: string, settings: RepositoryGraphSettings): Promise<RepositoryGraphSettings>
            onEntryProgress(listener: (progress: EntryProgress) => void): () => void
            /** Fires after HEAD, refs, or worktree registrations change on disk, from any tool. */
            onRepositoryChanged(listener: (change: { repositoryId: string }) => void): () => void
        }
    }
}

export {}
import type { FileHistoryRequest, FileHistoryResult } from "@laneway/shared"
