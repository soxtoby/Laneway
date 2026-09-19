import { z } from "zod"

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const id = z.string().regex(/^[a-zA-Z0-9-]+$/)
const entry = z.object({ object: oid, mode: z.string().regex(/^(100644|100755|120000|160000)$/) })
export const ConflictFileSchema = z.object({
    path: z.string(),
    base: entry.nullable(),
    left: entry.nullable(),
    right: entry.nullable(),
    provisional: entry.nullable(),
    text: z.boolean(),
})
export const ConflictSubjectSchema = z.object({
    id,
    input: oid,
    tree: oid,
    leftLabel: z.string(),
    rightLabel: z.string(),
    markerSize: z.number().int().min(7).default(7),
    files: z.array(ConflictFileSchema),
    suggestion: oid.optional(),
})
export const ReplayStepSchema = z.object({
    id,
    source: oid,
    current: oid,
    conflict: ConflictSubjectSchema.optional(),
    accepted: z.object({ input: oid, tree: oid }).optional(),
})
export const UnresolvedStackSchema = z.object({
    id,
    temporaryRef: z.string(),
    base: oid,
    dependency: z.object({ stackId: id, branch: z.string() }).optional(),
    branches: z.array(z.object({ ref: z.string(), before: oid, step: id, current: oid })),
    steps: z.array(ReplayStepSchema),
})
export const WorkingConflictSchema = z.object({
    beforeTree: oid.optional(),
    beforeIndex: oid.optional(),
    afterIndex: oid.optional(),
    id,
    path: z.string(),
    branch: z.string().nullable(),
    head: oid,
    stash: oid,
    suspended: oid.optional(),
    conflict: ConflictSubjectSchema,
})
export const ConflictStateSchema = z.object({
    version: z.literal(1),
    stacks: z.array(UnresolvedStackSchema),
    working: z.array(WorkingConflictSchema),
    retainedConflicts: z.array(z.object({ commit: oid, source: oid, conflict: ConflictSubjectSchema })).default([]),
})
export const ResolutionCandidateSchema = z.object({
    subject: id,
    input: oid,
    revision: z.string(),
    files: z.record(z.string(), entry.nullable()),
})
export type ConflictFile = z.infer<typeof ConflictFileSchema>
export type ConflictSubject = z.infer<typeof ConflictSubjectSchema>
export type ConflictState = z.infer<typeof ConflictStateSchema>
export type UnresolvedStack = z.infer<typeof UnresolvedStackSchema>
export type ReplayStep = z.infer<typeof ReplayStepSchema>
export type WorkingConflict = z.infer<typeof WorkingConflictSchema>
export type ResolutionCandidate = z.infer<typeof ResolutionCandidateSchema>

const subjectRequest = { subject: id, input: oid, revision: z.string() }
export const ConflictRequestSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("list") }),
    z.object({ action: z.literal("inspect"), subject: id, files: z.array(z.string()).optional() }),
    z.object({ action: z.literal("rewrite"), branches: z.array(z.string().min(1)).min(1), base: oid, path: z.string().optional() }),
    z.object({
        action: z.literal("choose"),
        ...subjectRequest,
        file: z.string(),
        side: z.enum(["left", "right", "base", "delete", "suggestion"]),
        hunk: z.number().int().nonnegative().optional(),
    }),
    z.object({ action: z.literal("use-file"), ...subjectRequest, file: z.string(), path: z.string() }),
    z.object({ action: z.literal("edit"), ...subjectRequest, file: z.string(), content: z.string().max(2_000_000) }),
    z.object({ action: z.literal("tool"), ...subjectRequest, file: z.string() }),
    z.object({ action: z.literal("accept"), ...subjectRequest }),
    z.object({ action: z.literal("cancel"), ...subjectRequest }),
    z.object({ action: z.literal("keep-stashed"), ...subjectRequest }),
    z.object({ action: z.literal("resume-working"), subject: id, path: z.string() }),
    z.object({ action: z.literal("restore"), stack: id, path: z.string().optional(), adopt: z.string().optional() }),
    z.object({ action: z.literal("discard"), stack: id }),
    z.object({ action: z.literal("publish-check"), branches: z.array(z.string()) }),
])
export type ConflictRequest = z.infer<typeof ConflictRequestSchema>
export const ConflictSummarySchema = z.object({
    id: z.string(),
    stackId: z.string().optional(),
    kind: z.enum(["commit", "working"]),
    branch: z.string(),
    commit: z.string().optional(),
    title: z.string(),
    files: z.number(),
    suspended: z.boolean().optional(),
})
const viewFile = ConflictFileSchema.extend({
    loaded: z.boolean().optional(),
    baseText: z.string().nullable(),
    leftText: z.string().nullable(),
    rightText: z.string().nullable(),
    resultText: z.string().nullable(),
    suggestionText: z.string().nullable(),
    diff: z.string(),
    resolved: z.boolean(),
    hunks: z.array(z.object({ index: z.number(), start: z.number(), end: z.number(), left: z.string(), right: z.string() })),
})
export const ConflictResultSchema = z.object({
    type: z.literal("result"),
    command: z.literal("conflict"),
    conflicts: z.array(ConflictSummarySchema),
    recovery: z.array(z.object({ stack: z.string(), branch: z.string(), message: z.string(), candidates: z.array(z.string()) })),
    view: z.object({
        subject: ConflictSubjectSchema,
        sourceCommit: oid,
        candidate: ResolutionCandidateSchema,
        files: z.array(viewFile),
        reviewTree: oid,
        resultTree: oid,
        ready: z.boolean(),
    }).optional(),
    publishable: z.boolean().optional(),
})
export type ConflictResult = z.infer<typeof ConflictResultSchema>
export type ConflictActionResult = { ok: true; result: ConflictResult } | { ok: false; error: { message: string } }
