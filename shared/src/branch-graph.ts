import { type HistoricalEdit } from "./historical-edit"
import { type AuthorIdentitySettings, type EntryError } from "./workspace"
import { type WorktreeRecovery } from "./worktree-recovery"

export interface BranchGraphWorktree {
    id?: string
    locked?: boolean
    lockReason?: string
    missing?: boolean
    path: string
    name: string
    head: string
    branchRef?: string
    main: boolean
    /** The worktree's Historical Edit, with the subject of the commit it edits; its column stays its original branch's. */
    historicalEdit?: HistoricalEdit & { subject: string }
}

export interface BranchGraphMarker {
    branchName?: string | null
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
    unresolved?: { stackId?: string; subjects: string[]; recovery?: string; temporaryRef?: string }
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
    /** One of this branch's own remote refs reaches its tip; commits published through other branches don't count. */
    published: boolean
    merged: boolean
}

export interface BranchGraphPoint {
    objectId: string
    /** Owning branch, tag, or virtual branch; used to filter its connecting line. */
    lineId: string
    /** Older waypoints in Git parent order, with ordinary commits compressed out. */
    parentIds: string[]
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
    history: BranchGraphPoint[]
    tags: BranchGraphTagNode[]
    virtualBranches: BranchGraphVirtualBranch[]
    unassignedStashes: BranchGraphMarker[]
    /** Distinct tips of every remote-tracking branch, visible or not. */
    remoteTips: string[]
    limited: Array<"shallow" | "partial" | "sparse">
}

export interface BranchGraphReadOptions {
    authorIdentities: AuthorIdentitySettings
    selectedRemote?: string
    remotePatterns: string[]
    /** Include every branch, not only local, Involved, Primary, pattern-matched, and Base branches. */
    allBranches?: boolean
    refreshRemote?: boolean
}

export interface BranchHistoryRequest {
    requestId?: string
    branchRef: string
    tip: string
    baseTips: string[]
    /** Remote-tracking tips; commits they reach are reported as remote. */
    remoteTips?: string[]
    offset?: number
    limit?: number
}

export interface BranchHistoryCommit {
    conflictId?: string
    objectId: string
    parentIds: string[]
    authorName: string
    authorEmail: string
    authoredAt: number
    subject: string
    /** The message after its subject, without trailing blank lines. */
    body?: string
    /** Reachable from one of the request's remote tips. */
    remote?: boolean
}

export interface BranchHistoryPage {
    branchRef: string
    tip: string
    baseTips: string[]
    commits: BranchHistoryCommit[]
    nextOffset?: number
}

export type BranchGraphResult =
    | { ok: true; graph: BranchGraph; worktreeRecoveries?: WorktreeRecovery[] }
    | { ok: false; error: EntryError }

export type BranchHistoryResult =
    | { ok: true; page: BranchHistoryPage }
    | { ok: false; error: EntryError }
