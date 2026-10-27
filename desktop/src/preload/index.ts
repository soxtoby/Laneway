import type { Appearance, AuthorIdentitySettings, BranchHistoryRequest, EntryProgress, RepositoryGraphSettings, Workspace } from "@laneway/shared"
import type { ChangesRequest, FileDiffRequest, FileImageRequest, FileListView, FileVersionRequest } from "@laneway/shared"
import type { FileHistoryRequest } from "@laneway/shared"
import type { WorktreeRequest } from "@laneway/shared"
import type { CommitDraft, LocalRequest } from "@laneway/shared"
import type { DiscardRequest } from "@laneway/shared"
import type { ConflictRequest } from "@laneway/shared"
import type { PullProgress, PullRequest } from "@laneway/shared"
import type { PublishProgress, PublishRequest } from "@laneway/shared"
import type { RecoveryRequest } from "@laneway/shared"
import type { HistoricalEditRequest } from "@laneway/shared"
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("laneway", {
    recoverWorktree: (repositoryId: string, request: RecoveryRequest) => ipcRenderer.invoke("worktree:recover", repositoryId, request),
    pullLatest: (repositoryId: string, request: PullRequest) => ipcRenderer.invoke("pull:latest", repositoryId, request),
    cancelPull: (repositoryId: string) => ipcRenderer.invoke("pull:cancel", repositoryId),
    onPullProgress: (listener: (progress: PullProgress) => void) => {
        let handler = (_event: Electron.IpcRendererEvent, progress: PullProgress) => listener(progress)
        ipcRenderer.on("pull:progress", handler)
        return () => ipcRenderer.off("pull:progress", handler)
    },
    publish: (repositoryId: string, request: PublishRequest) => ipcRenderer.invoke("publish:run", repositoryId, request),
    onPublishProgress: (listener: (progress: PublishProgress) => void) => {
        let handler = (_event: Electron.IpcRendererEvent, progress: PublishProgress) => listener(progress)
        ipcRenderer.on("publish:progress", handler)
        return () => ipcRenderer.off("publish:progress", handler)
    },
    readConflictContent: (repositoryId: string, object: string) => ipcRenderer.invoke("conflict:content", repositoryId, object),
    conflictOperation: (repositoryId: string, request: ConflictRequest) => ipcRenderer.invoke("conflict:operation", repositoryId, request),
    historicalEdit: (repositoryId: string, request: HistoricalEditRequest) => ipcRenderer.invoke("edit:operation", repositoryId, request),
    previewWorktree: (repositoryId: string, request: WorktreeRequest) => ipcRenderer.invoke("worktree:preview", repositoryId, request),
    localOperation: (repositoryId: string, request: LocalRequest, token?: string) => ipcRenderer.invoke("local:operation", repositoryId, request, token),
    discardChanges: (repositoryId: string, request: DiscardRequest) => ipcRenderer.invoke("discard:apply", repositoryId, request),
    undoDiscard: (repositoryId: string, id: string) => ipcRenderer.invoke("discard:undo", repositoryId, id),
    settleDiscard: (repositoryId: string, id: string) => ipcRenderer.invoke("discard:settle", repositoryId, id),
    readCommitDraft: (repositoryId: string, path: string) => ipcRenderer.invoke("commit:draft", repositoryId, path),
    saveCommitDraft: (repositoryId: string, path: string, draft: CommitDraft) => ipcRenderer.invoke("commit:draft", repositoryId, path, draft),
    executeWorktree: (repositoryId: string, request: WorktreeRequest, token?: string) => ipcRenderer.invoke("worktree:execute", repositoryId, request, token),
    transitionOperation: (repositoryId: string, action: "undo" | "redo", basename?: string) =>
        ipcRenderer.invoke("worktree:history", repositoryId, action, basename),
    readChanges: (repositoryId: string, requestId: string, request: ChangesRequest) => ipcRenderer.invoke("changes:read", repositoryId, requestId, request),
    readFileHistory: (repositoryId: string, requestId: string, request: FileHistoryRequest) =>
        ipcRenderer.invoke("history:read", repositoryId, requestId, request),
    readFileDiff: (repositoryId: string, requestId: string, request: FileDiffRequest) => ipcRenderer.invoke("changes:diff", repositoryId, requestId, request),
    readFileImage: (repositoryId: string, requestId: string, request: FileImageRequest) =>
        ipcRenderer.invoke("changes:image", repositoryId, requestId, request),
    readFileVersion: (repositoryId: string, requestId: string, request: FileVersionRequest) =>
        ipcRenderer.invoke("changes:version", repositoryId, requestId, request),
    cancelInspection: (repositoryId: string, requestId: string) => ipcRenderer.invoke("changes:cancel", repositoryId, requestId),
    readRemoteImage: (url: string) => ipcRenderer.invoke("markdown:image", url),
    openLink: (url: string) => ipcRenderer.invoke("markdown:open-link", url),
    getState: () => ipcRenderer.invoke("app:state"),
    openRepository: () => ipcRenderer.invoke("entry:open"),
    chooseDirectory: (defaultPath?: string) => ipcRenderer.invoke("entry:choose-directory", { defaultPath }),
    entryDefaults: (form: "clone" | "init") => ipcRenderer.invoke("entry:defaults", { form }),
    suggestCloneDirectoryName: (source: string) => ipcRenderer.invoke("entry:suggest-clone", { source }),
    cloneRepository: (source: string, parent: string, name: string) => ipcRenderer.invoke("entry:clone", { source, parent, name }),
    initializeRepository: (parent: string, name: string, initialBranch?: string) => ipcRenderer.invoke("entry:initialize", { parent, name, initialBranch }),
    cancelEntry: () => ipcRenderer.invoke("entry:cancel"),
    selectRepository: (id: string) => ipcRenderer.invoke("workspace:select", { id }),
    closeRepository: (id: string) => ipcRenderer.invoke("workspace:close", { id }),
    locateRepository: (id: string, useAnyway = false) => ipcRenderer.invoke("workspace:locate", { id, useAnyway }),
    updateWorkspace: (workspace: Workspace) => ipcRenderer.invoke("workspace:update", { workspace }),
    resetWorkspace: () => ipcRenderer.invoke("workspace:reset"),
    readIconImage: (path: string) => ipcRenderer.invoke("icon:read", { path }),
    listRepositoryImages: (repositoryId: string) => ipcRenderer.invoke("icon:list", { repositoryId }),
    runScript: (repositoryId: string, path: string, scriptId: string) => ipcRenderer.invoke("script:run", { repositoryId, path, scriptId }),
    chooseGit: () => ipcRenderer.invoke("settings:choose-git"),
    useGitFromPath: () => ipcRenderer.invoke("settings:use-path"),
    resetSettings: () => ipcRenderer.invoke("settings:reset"),
    setAuthorIdentities: (settings: AuthorIdentitySettings) => ipcRenderer.invoke("settings:author-identities", settings),
    openSettingsFile: () => ipcRenderer.invoke("settings:open-file"),
    setAppearance: (appearance: Appearance) => ipcRenderer.invoke("settings:appearance", { appearance }),
    setFileListView: (view: FileListView) => ipcRenderer.invoke("settings:file-list-view", { view }),
    setShowCommitAges: (shown: boolean) => ipcRenderer.invoke("settings:show-commit-ages", { shown }),
    setGraphWidth: (width: number) => ipcRenderer.invoke("settings:graph-width", { width }),
    readBranchGraph: (repositoryId: string, refreshRemote = false, allBranches = false) =>
        ipcRenderer.invoke("graph:read", { repositoryId, refreshRemote, allBranches }),
    cancelBranchGraph: (repositoryId: string) => ipcRenderer.invoke("graph:cancel", { repositoryId }),
    readBranchHistory: (repositoryId: string, history: BranchHistoryRequest) => ipcRenderer.invoke("graph:history", { repositoryId, history }),
    cancelBranchHistory: (repositoryId: string) => ipcRenderer.invoke("graph:history-cancel", { repositoryId }),
    setRepositoryGraphSettings: (repositoryId: string, settings: RepositoryGraphSettings) => ipcRenderer.invoke("graph:settings", { repositoryId, settings }),
    onEntryProgress: (listener: (progress: EntryProgress) => void) => {
        let handler = (_event: Electron.IpcRendererEvent, progress: EntryProgress) => listener(progress)
        ipcRenderer.on("entry:progress", handler)
        return () => ipcRenderer.off("entry:progress", handler)
    },
    onRepositoryChanged: (listener: (change: { repositoryId: string }) => void) => {
        let handler = (_event: Electron.IpcRendererEvent, change: { repositoryId: string }) => listener(change)
        ipcRenderer.on("repository:changed", handler)
        return () => ipcRenderer.off("repository:changed", handler)
    },
})
