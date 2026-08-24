import type { EngineMessage } from "@git-workbench/shared"
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("workbench", {
    getEngineStatus: () => ipcRenderer.invoke("engine:status"),
    runEcho: (message: string, repositoryPath: string) => ipcRenderer.invoke("engine:echo", { message, repositoryPath }),
    cancel: () => ipcRenderer.invoke("engine:cancel"),
    onEngineMessage: (listener: (message: EngineMessage) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, message: EngineMessage) => listener(message)
        ipcRenderer.on("engine:message", handler)
        return () => ipcRenderer.off("engine:message", handler)
    },
})
