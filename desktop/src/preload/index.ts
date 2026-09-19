import type { Appearance, AuthorIdentitySettings, BranchHistoryRequest, EntryProgress, RepositoryGraphSettings, Workspace } from "@git-workbench/shared"
import type { ChangesRequest, FileDiffRequest } from "@git-workbench/shared"
import type { WorktreeRequest } from "@git-workbench/shared"
import type { CommitDraft, LocalRequest } from "@git-workbench/shared"
import type { ConflictRequest } from "@git-workbench/shared"
import type { PullProgress, PullRequest } from "@git-workbench/shared"
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("workbench", {
    pullLatest: (repositoryId: string, request: PullRequest) => ipcRenderer.invoke("pull:latest", repositoryId, request),
    cancelPull: (repositoryId: string) => ipcRenderer.invoke("pull:cancel", repositoryId),
    onPullProgress: (listener: (progress: PullProgress) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, progress: PullProgress) => listener(progress)
        ipcRenderer.on("pull:progress", handler)
        return () => ipcRenderer.off("pull:progress", handler)
    },
    readConflictContent: (repositoryId: string, object: string) => ipcRenderer.invoke("conflict:content", repositoryId, object),
    conflictOperation: (repositoryId: string, request: ConflictRequest) => ipcRenderer.invoke("conflict:operation", repositoryId, request),
    previewWorktree: (repositoryId: string, request: WorktreeRequest) => ipcRenderer.invoke("worktree:preview", repositoryId, request),
    localOperation: (repositoryId: string, request: LocalRequest, token?: string) => ipcRenderer.invoke("local:operation", repositoryId, request, token),
    readCommitDraft: (repositoryId: string, path: string) => ipcRenderer.invoke("commit:draft", repositoryId, path),
    saveCommitDraft: (repositoryId: string, path: string, draft: CommitDraft) => ipcRenderer.invoke("commit:draft", repositoryId, path, draft),
    executeWorktree: (repositoryId: string, request: WorktreeRequest, token: string) => ipcRenderer.invoke("worktree:execute", repositoryId, request, token),
    transitionOperation: (repositoryId: string, action: "undo" | "redo", basename?: string) =>
        ipcRenderer.invoke("worktree:history", repositoryId, action, basename),
    readChanges: (repositoryId: string, requestId: string, request: ChangesRequest) => ipcRenderer.invoke("changes:read", repositoryId, requestId, request),
    readFileHistory: (repositoryId: string, requestId: string, request: FileHistoryRequest) =>
        ipcRenderer.invoke("history:read", repositoryId, requestId, request),
    readFileDiff: (repositoryId: string, requestId: string, request: FileDiffRequest) => ipcRenderer.invoke("changes:diff", repositoryId, requestId, request),
    cancelInspection: (repositoryId: string, requestId: string) => ipcRenderer.invoke("changes:cancel", repositoryId, requestId),
    getState: () => ipcRenderer.invoke("app:state"),
    openRepository: () => ipcRenderer.invoke("entry:open"),
    chooseDirectory: (defaultPath?: string) => ipcRenderer.invoke("entry:choose-directory", { defaultPath }),
    suggestCloneDestination: (source: string, parent: string) => ipcRenderer.invoke("entry:suggest-clone", { source, parent }),
    cloneRepository: (source: string, destination: string) => ipcRenderer.invoke("entry:clone", { source, destination }),
    initializeRepository: (path: string, initialBranch?: string) => ipcRenderer.invoke("entry:initialize", { path, initialBranch }),
    cancelEntry: () => ipcRenderer.invoke("entry:cancel"),
    selectRepository: (id: string) => ipcRenderer.invoke("workspace:select", { id }),
    closeRepository: (id: string) => ipcRenderer.invoke("workspace:close", { id }),
    locateRepository: (id: string, useAnyway = false) => ipcRenderer.invoke("workspace:locate", { id, useAnyway }),
    updateWorkspace: (workspace: Workspace) => ipcRenderer.invoke("workspace:update", { workspace }),
    resetWorkspace: () => ipcRenderer.invoke("workspace:reset"),
    chooseGit: () => ipcRenderer.invoke("settings:choose-git"),
    useGitFromPath: () => ipcRenderer.invoke("settings:use-path"),
    resetSettings: () => ipcRenderer.invoke("settings:reset"),
    setAuthorIdentities: (settings: AuthorIdentitySettings) => ipcRenderer.invoke("settings:author-identities", settings),
    openSettingsFile: () => ipcRenderer.invoke("settings:open-file"),
    setAppearance: (appearance: Appearance) => ipcRenderer.invoke("settings:appearance", { appearance }),
    readBranchGraph: (repositoryId: string, refreshRemote = false) => ipcRenderer.invoke("graph:read", { repositoryId, refreshRemote }),
    cancelBranchGraph: (repositoryId: string) => ipcRenderer.invoke("graph:cancel", { repositoryId }),
    readBranchHistory: (repositoryId: string, history: BranchHistoryRequest) => ipcRenderer.invoke("graph:history", { repositoryId, history }),
    cancelBranchHistory: (repositoryId: string) => ipcRenderer.invoke("graph:history-cancel", { repositoryId }),
    setRepositoryGraphSettings: (repositoryId: string, settings: RepositoryGraphSettings) => ipcRenderer.invoke("graph:settings", { repositoryId, settings }),
    onEntryProgress: (listener: (progress: EntryProgress) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, progress: EntryProgress) => listener(progress)
        ipcRenderer.on("entry:progress", handler)
        return () => ipcRenderer.off("entry:progress", handler)
    },
})
import type { FileHistoryRequest } from "@git-workbench/shared"
