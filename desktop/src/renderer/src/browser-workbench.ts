import type { EntryProgress, GitSettingsState, RepositoryInfo, WorkbenchSession } from "@git-workbench/shared"

let progressListener: ((progress: EntryProgress) => void) | undefined
let cancelled = false
let repositories: RepositoryInfo[] = []
let activeRepositoryId: string | undefined
let settings: GitSettingsState = {
    path: "C:\\Users\\developer\\AppData\\Roaming\\Git Workbench\\settings.json",
    git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.51.1" },
}

function session(): WorkbenchSession {
    return { repositories, activeRepositoryId }
}

function repository(path: string, objectFormat: "sha1" | "sha256" = "sha1"): RepositoryInfo {
    const mainWorktree = path
    return {
        id: `${mainWorktree}\\.git`,
        root: mainWorktree,
        mainWorktree,
        selectedWorktree: mainWorktree,
        commonDirectory: `${mainWorktree}\\.git`,
        gitDirectory: `${mainWorktree}\\.git`,
        objectFormat,
        shallow: false,
        partial: false,
        sparse: false,
        git: settings.git!,
    }
}

function add(path: string, objectFormat: "sha1" | "sha256" = "sha1") {
    const entry = repository(path, objectFormat)
    repositories = [...repositories.filter(item => item.id != entry.id), entry]
    activeRepositoryId = entry.id
    return { ok: true as const, session: session() }
}

const browserWorkbench: Window["workbench"] = {
    async getState() {
        return {
            session: session(),
            settings,
            engine: { state: "ready", path: "D:\\GitWorkbench\\cli\\bin\\workbench-engine.exe", name: "workbench-engine", version: "0.1.0" },
            defaultCloneParent: "C:\\Users\\developer\\Documents",
        }
    },
    async openRepository() {
        return add("D:\\Source\\signal-stack")
    },
    async chooseDirectory(defaultPath) {
        return defaultPath || "D:\\Source\\new-repository"
    },
    async suggestCloneDestination(source, parent) {
        const name = source.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/i, "") || "repository"
        return `${parent}\\${name}`
    },
    async cloneRepository(_source, destination) {
        cancelled = false
        for (const message of ["Enumerating objects", "Receiving objects: 61%", "Resolving deltas"]) {
            await new Promise(resolveDelay => setTimeout(resolveDelay, 280))
            if (cancelled)
                return { ok: false, error: { code: "git.cancelled", message: "Clone cancelled. The partial destination was preserved." } }
            progressListener?.({ message })
        }
        return add(destination, "sha256")
    },
    async initializeRepository(path) {
        return add(path)
    },
    async cancelEntry() {
        cancelled = true
        return true
    },
    async selectRepository(id) {
        activeRepositoryId = id
        return session()
    },
    async chooseGit() {
        settings = { ...settings, override: "D:\\Tools\\Git\\git.exe", git: { path: "D:\\Tools\\Git\\git.exe", version: "2.51.1" } }
        return settings
    },
    async useGitFromPath() {
        settings = { ...settings, override: undefined, git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.51.1" } }
        return settings
    },
    async resetSettings() {
        return settings
    },
    async openSettingsFile() {
        return ""
    },
    onEntryProgress(listener) {
        progressListener = listener
        return () => progressListener = undefined
    },
}

Object.defineProperty(window, "workbench", { value: browserWorkbench, configurable: true })
