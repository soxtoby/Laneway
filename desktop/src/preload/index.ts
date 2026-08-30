import type { AuthorIdentitySettings, BranchHistoryRequest, EntryProgress, RepositoryGraphSettings } from "@git-workbench/shared"
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("workbench", {
    getState: () => ipcRenderer.invoke("app:state"),
    openRepository: () => ipcRenderer.invoke("entry:open"),
    chooseDirectory: (defaultPath?: string) => ipcRenderer.invoke("entry:choose-directory", { defaultPath }),
    suggestCloneDestination: (source: string, parent: string) => ipcRenderer.invoke("entry:suggest-clone", { source, parent }),
    cloneRepository: (source: string, destination: string) => ipcRenderer.invoke("entry:clone", { source, destination }),
    initializeRepository: (path: string, initialBranch?: string) => ipcRenderer.invoke("entry:initialize", { path, initialBranch }),
    cancelEntry: () => ipcRenderer.invoke("entry:cancel"),
    selectRepository: (id: string) => ipcRenderer.invoke("session:select", { id }),
    chooseGit: () => ipcRenderer.invoke("settings:choose-git"),
    useGitFromPath: () => ipcRenderer.invoke("settings:use-path"),
    resetSettings: () => ipcRenderer.invoke("settings:reset"),
    setAuthorIdentities: (settings: AuthorIdentitySettings) => ipcRenderer.invoke("settings:author-identities", settings),
    openSettingsFile: () => ipcRenderer.invoke("settings:open-file"),
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
