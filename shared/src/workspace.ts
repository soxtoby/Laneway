import { type ComparisonRef, type DiffLayout } from "./changes"
import type { RepositoryIdentity } from "./repository-icon"

export type ObjectFormat = "sha1" | "sha256"

export interface GitInstallationInfo {
    path: string
    version: string
}

export interface RepositoryInfo {
    id: string
    root: string
    mainWorktree: string
    selectedWorktree: string
    commonDirectory: string
    gitDirectory: string
    objectFormat: ObjectFormat
    shallow: boolean
    partial: boolean
    sparse: boolean
    git: GitInstallationInfo
}

export interface BranchWorkspaceColumn {
    worktreeId?: string
    collapsed?: boolean
    diffLayout?: DiffLayout
    kind: "branch"
    id: string
    ref: string
    lastSeenObjectId: string
    width: number
    worktreePath?: string
}

export interface VirtualBranchWorkspaceColumn {
    worktreeId?: string
    collapsed?: boolean
    diffLayout?: DiffLayout
    kind: "virtual"
    id: string
    worktreePath: string
    lastSeenObjectId: string
    width: number
}

/** A Branch Comparison Column. Its refs are identities, so the comparison stays live across restarts. */
export interface ComparisonWorkspaceColumn {
    collapsed?: boolean
    diffLayout?: DiffLayout
    kind: "comparison"
    id: string
    from: ComparisonRef
    to: ComparisonRef
    width: number
}

export type WorkspaceColumn = BranchWorkspaceColumn | VirtualBranchWorkspaceColumn | ComparisonWorkspaceColumn

export interface AvailableOpenRepository extends RepositoryIdentity {
    status: "available"
    id: string
    path: string
    info: RepositoryInfo
    /** The repository's one unambiguous favicon, shown when the user has not chosen an icon. */
    favicon?: string
    columns: WorkspaceColumn[]
    focusedColumnId?: string
    layoutInitialized: boolean
}

export interface MissingOpenRepository extends RepositoryIdentity {
    status: "missing"
    id: string
    path: string
    name: string
    columns: WorkspaceColumn[]
    focusedColumnId?: string
    layoutInitialized: boolean
    error: EntryError
}

export type OpenRepository = AvailableOpenRepository | MissingOpenRepository

export interface Workspace {
    repositories: OpenRepository[]
    activeRepositoryId?: string
    persistenceError?: EntryError
}

export type EntryErrorCode =
    | "git.unavailable"
    | "git.too-old"
    | "git.invalid-root"
    | "git.bare-repository"
    | "git.missing-main-worktree"
    | "git.unsupported-format"
    | "git.authentication-required"
    | "git.destination-conflict"
    | "git.cancelled"
    | "git.command-failed"
    | "settings.corrupt"
    | "settings.write-failed"
    | "workspace.corrupt"
    | "workspace.unsupported-version"
    | "workspace.write-failed"
    | "workspace.partial"

export interface EntryError {
    code: EntryErrorCode
    message: string
    destination?: string
}

export type EntryResult =
    | { ok: true; workspace: Workspace }
    | { ok: false; error: EntryError }

export interface EntryProgress {
    message: string
}

export interface EntryDefaults {
    parent: string
    source?: string
}

export type Appearance = "light" | "dark"

export interface GitSettingsState {
    path: string
    override?: string
    git?: GitInstallationInfo
    authorIdentities: AuthorIdentitySettings
    error?: EntryError
}

export interface AuthorIdentitySettings {
    primary?: string
    secondary: string[]
}

export interface RepositoryGraphSettings {
    selectedRemote?: string
    remotePatterns: string[]
}
