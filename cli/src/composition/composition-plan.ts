import { gitText, type RepositoryGit } from "@laneway/git"
import type { CompositionPreview, ConflictState, ConflictSubject, HistoricalEditSession, LocalPreview, ResolutionCandidate } from "@laneway/shared"
import { CompositionPreviewSchema, ConflictStateSchema, ConflictSubjectSchema, HistoricalEditSessionSchema, LocalPreviewSchema, ResolutionCandidateSchema } from "@laneway/shared"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { type GitCheckpoint, GitCheckpointSchema } from "../operations/git-checkpoint"

export interface CommitPlan {
    oid: string
    parent: string
    tree: string
    source?: string
    message?: string
    conflict?: ConflictSubject
}

export interface WorkingPlan {
    path: string
    head: string
    ref: string | null
    tree: string
    index: string
    beforeTree: string
    beforeIndex: string
    /** The symbolic HEAD before the rewrite, so an unchanged one is left alone. */
    beforeRef?: string | null
    conflict?: ConflictSubject
    stashBase: string
    stashTree: string
    stashIndex: string
    conflictBaseline: string
    conflictIndex: string
}

export interface Plan {
    before: GitCheckpoint
    commits: CommitPlan[]
    refs: Array<{ ref: string; before: string | null; after: string | null }>
    working: WorkingPlan[]
    state: ConflictState
    candidates: Array<{ ref: string; before: string; candidate: ResolutionCandidate }>
    /** Historical Edits whose worktree takes part, with their materialized commit as drafted. */
    sessions: Array<{ ref: string; before: string; session: HistoricalEditSession }>
    preview: CompositionPreview
}

let PlanSchema = z.object({
    before: GitCheckpointSchema,
    commits: z.array(
        z.object({
            oid: z.string(),
            parent: z.string(),
            tree: z.string(),
            source: z.string().optional(),
            message: z.string().optional(),
            conflict: ConflictSubjectSchema.optional(),
        }),
    ),
    refs: z.array(z.object({ ref: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
    working: z.array(z.object({
        path: z.string(),
        head: z.string(),
        ref: z.string().nullable(),
        tree: z.string(),
        index: z.string(),
        beforeTree: z.string(),
        beforeIndex: z.string(),
        beforeRef: z.string().nullable().optional(),
        conflict: ConflictSubjectSchema.optional(),
        stashBase: z.string(),
        stashTree: z.string(),
        stashIndex: z.string(),
        conflictBaseline: z.string(),
        conflictIndex: z.string(),
    })),
    state: ConflictStateSchema,
    candidates: z.array(z.object({ ref: z.string(), before: z.string(), candidate: ResolutionCandidateSchema })),
    sessions: z.array(z.object({ ref: z.string(), before: z.string(), session: HistoricalEditSessionSchema })).default([]),
    preview: CompositionPreviewSchema,
})

export async function writePlan(repo: RepositoryGit, preview: LocalPreview, plan: Plan) {
    let directory = join(repo.descriptor.commonDirectory, "laneway")
    let data = JSON.stringify({ version: 1, preview, plan })
    await mkdir(directory, { recursive: true })
    let path = join(directory, "composition-preview.json")
    await writeFile(`${path}.tmp`, JSON.stringify({ data, hash: id(data) }))
    await rename(`${path}.tmp`, path)
}

export async function readPlan(repo: RepositoryGit, token: string) {
    try {
        let stored = JSON.parse(await readFile(join(repo.descriptor.commonDirectory, "laneway", "composition-preview.json"), "utf8"))
        if (typeof stored.data != "string" || stored.hash != id(stored.data))
            return undefined
        let cached = z.object({ version: z.literal(1), preview: LocalPreviewSchema, plan: PlanSchema }).parse(JSON.parse(stored.data))
        if (cached.preview.token != token)
            return undefined
        let objects = [
            ...new Set([
                ...cached.plan.commits.flatMap(commit => [commit.oid, commit.tree]),
                ...cached.plan.working.flatMap(working => [working.tree, working.index, working.beforeTree, working.beforeIndex]),
            ]),
        ]
        let checked = await gitText(repo, ["cat-file", "--batch-check"], objects.join("\n") + "\n")
        return checked.includes(" missing") ? undefined : cached
    } catch {
        // A preview is disposable. Missing, expired or incompatible plans are rebuilt.
        return undefined
    }
}

function id(...values: string[]) {
    return createHash("sha256").update(values.join("\0")).digest("hex")
}
