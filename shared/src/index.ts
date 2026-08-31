import { z } from "zod"

export const ENGINE_VERSION = "0.1.0"

export const ExitCode = {
    ok: 0,
    failure: 1,
    usage: 2,
    cancelled: 3,
} as const

export const ErrorCodeSchema = z.enum([
    "usage.invalid-argument",
    "usage.unknown-command",
    "engine.internal",
    "git.unavailable",
    "git.too-old",
    "git.invalid-root",
    "git.bare-repository",
    "git.missing-main-worktree",
    "git.unsupported-format",
    "git.authentication-required",
    "git.destination-conflict",
    "git.cancelled",
    "git.command-failed",
    "settings.corrupt",
    "settings.write-failed",
    "operation.history-corrupt",
    "operation.internal",
    "operation.journal-corrupt",
    "operation.locked",
    "operation.precondition-failed",
    "operation.recovery-blocked",
])

export const ProgressEventSchema = z.object({
    type: z.literal("progress"),
    command: z.string(),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    message: z.string(),
})

export const EchoResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("echo"),
    message: z.string(),
})

export const OperationSummarySchema = z.object({
    id: z.string(),
    timestamp: z.string(),
    kind: z.string(),
    summary: z.string(),
    affectedRefs: z.array(z.string()),
    affectedWorktrees: z.array(z.string()),
})

export const OperationAvailabilityReasonSchema = z.enum([
    "empty",
    "ref-changed",
    "index-changed",
    "worktree-changed",
    "git-lockfile-present",
    "precondition-failed",
])

export const OperationTransitionResultSchema = z.object({
    type: z.literal("result"),
    command: z.enum(["undo", "redo"]),
    status: z.enum(["performed", "unavailable"]),
    reason: OperationAvailabilityReasonSchema.optional(),
    operation: OperationSummarySchema.optional(),
})

export const OperationHistoryEntrySchema = OperationSummarySchema.extend({
    state: z.enum(["applied", "undone"]),
    isNextUndo: z.boolean(),
    isNextRedo: z.boolean(),
})

export const OperationAvailabilitySchema = z.object({
    available: z.boolean(),
    operationId: z.string().optional(),
    reason: OperationAvailabilityReasonSchema.optional(),
})

export const OperationHistoryResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("history"),
    position: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    entries: z.array(OperationHistoryEntrySchema).max(10),
    undo: OperationAvailabilitySchema,
    redo: OperationAvailabilitySchema,
})

export const TestMutationResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("test-mutation"),
    operation: OperationSummarySchema,
})

export const RecoveredExecutionSchema = z.object({
    action: z.enum(["apply", "undo", "redo"]),
    operation: OperationSummarySchema,
})

export const RecoveryResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("recover"),
    status: z.enum(["clean", "recovered"]),
    recovered: z.array(RecoveredExecutionSchema),
})

export const CancelledEventSchema = z.object({
    type: z.literal("cancelled"),
    command: z.string(),
    message: z.string(),
})

export const ErrorEventSchema = z.object({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
})

export const EngineMessageSchema = z.union([
    ProgressEventSchema,
    EchoResultSchema,
    OperationTransitionResultSchema,
    OperationHistoryResultSchema,
    TestMutationResultSchema,
    RecoveryResultSchema,
    CancelledEventSchema,
    ErrorEventSchema,
])

export type ErrorCode = z.infer<typeof ErrorCodeSchema>
export type ProgressEvent = z.infer<typeof ProgressEventSchema>
export type EchoResult = z.infer<typeof EchoResultSchema>
export type OperationSummary = z.infer<typeof OperationSummarySchema>
export type OperationAvailabilityReason = z.infer<typeof OperationAvailabilityReasonSchema>
export type OperationTransitionResult = z.infer<typeof OperationTransitionResultSchema>
export type OperationHistoryEntry = z.infer<typeof OperationHistoryEntrySchema>
export type OperationAvailability = z.infer<typeof OperationAvailabilitySchema>
export type OperationHistoryResult = z.infer<typeof OperationHistoryResultSchema>
export type TestMutationResult = z.infer<typeof TestMutationResultSchema>
export type RecoveredExecution = z.infer<typeof RecoveredExecutionSchema>
export type RecoveryResult = z.infer<typeof RecoveryResultSchema>
export type CancelledEvent = z.infer<typeof CancelledEventSchema>
export type ErrorEvent = z.infer<typeof ErrorEventSchema>
export type EngineMessage = z.infer<typeof EngineMessageSchema>

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
    kind: "branch"
    id: string
    ref: string
    lastSeenObjectId: string
    width: number
    worktreePath?: string
}

export interface VirtualBranchWorkspaceColumn {
    kind: "virtual"
    id: string
    worktreePath: string
    lastSeenObjectId: string
    width: number
}

export type WorkspaceColumn = BranchWorkspaceColumn | VirtualBranchWorkspaceColumn

export interface AvailableOpenRepository {
    status: "available"
    id: string
    path: string
    info: RepositoryInfo
    columns: WorkspaceColumn[]
    focusedColumnId?: string
    layoutInitialized: boolean
}

export interface MissingOpenRepository {
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

export interface BranchGraphWorktree {
    path: string
    name: string
    head: string
    branchRef?: string
    main: boolean
}

export interface BranchGraphMarker {
    id: string
    kind: "stash"
    label: string
    objectId: string
    tooltip: string
}

export interface BranchGraphBaseCandidate {
    branchId: string
    name: string
    ref: string
    tip: string
}

export type BranchGraphBase =
    | { status: "known"; branchId: string; name: string; ref: string; tip: string }
    | { status: "ambiguous"; candidates: BranchGraphBaseCandidate[] }
    | { status: "unknown"; candidates: BranchGraphBaseCandidate[] }

export interface BranchGraphCommitSummary {
    objectId: string
    subject: string
    authoredAt: number
}

export interface BranchGraphBranchNode {
    kind: "branch"
    id: string
    name: string
    preferredRef: string
    refs: string[]
    aliases: string[]
    localRefs: string[]
    remoteRefs: string[]
    tip: string
    upstreamRef?: string
    upstreamTip?: string
    ahead: number
    behind: number
    base: BranchGraphBase
    involvement: "involved" | "uninvolved" | "unknown"
    checkedOut: BranchGraphWorktree[]
    lastUniqueCommit?: BranchGraphCommitSummary
    markers: BranchGraphMarker[]
    tags: string[]
    primary: boolean
    remoteOnly: boolean
}

export interface BranchGraphTagNode {
    kind: "tag"
    id: string
    name: string
    objectId: string
    parentBranchId?: string
    tooltip: string
}

export interface BranchGraphVirtualBranch {
    kind: "virtual"
    id: string
    name: string
    objectId: string
    worktree: BranchGraphWorktree
    tooltip: string
}

export interface BranchGraphPrimaryBranch {
    status: "known" | "unknown"
    remote?: string
    ref?: string
    reason?: string
}

export interface BranchGraph {
    repositoryId: string
    primaryBranch: BranchGraphPrimaryBranch
    availableRemotes: string[]
    selectedRemote?: string
    remotePatterns: string[]
    authorIdentities: AuthorIdentitySettings
    effectiveAuthorEmail?: string
    branches: BranchGraphBranchNode[]
    tags: BranchGraphTagNode[]
    virtualBranches: BranchGraphVirtualBranch[]
    unassignedStashes: BranchGraphMarker[]
    limited: Array<"shallow" | "partial" | "sparse">
}

export interface BranchGraphReadOptions {
    authorIdentities: AuthorIdentitySettings
    selectedRemote?: string
    remotePatterns: string[]
    refreshRemote?: boolean
}

export interface BranchHistoryRequest {
    branchRef: string
    tip: string
    baseTip: string
    offset?: number
    limit?: number
}

export interface BranchHistoryCommit {
    objectId: string
    parentIds: string[]
    authorName: string
    authorEmail: string
    authoredAt: number
    subject: string
}

export interface BranchHistoryPage {
    branchRef: string
    tip: string
    baseTip: string
    commits: BranchHistoryCommit[]
    nextOffset?: number
}

export type BranchGraphResult =
    | { ok: true; graph: BranchGraph }
    | { ok: false; error: EntryError }

export type BranchHistoryResult =
    | { ok: true; page: BranchHistoryPage }
    | { ok: false; error: EntryError }
