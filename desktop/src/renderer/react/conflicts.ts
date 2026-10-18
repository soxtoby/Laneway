import type { ConflictRequest, ConflictResult, DiffLine, FileDiffPage } from "@laneway/shared"
import { errorMessage } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export type ConflictView = NonNullable<ConflictResult["view"]>
export type ConflictViewFile = ConflictView["files"][number]
export type ConflictSummary = ConflictResult["conflicts"][number]

/** What a resolution can do to its conflict; the subject, input, and revision come from the conflict as shown. */
export type ResolutionAction =
    | { action: "choose"; file: string; side: "left" | "right" | "base" | "delete" | "suggestion" }
    | { action: "accept" | "cancel" | "keep-stashed" }
    | { action: "use-file"; file: string; path: string }
    | { action: "tool"; file: string }
    | { action: "edit"; file: string; content: string }

/** One conflict being resolved: its files as the engine last showed them. */
export interface SubjectState {
    view?: ConflictView
    summary?: ConflictSummary
    error: string
    busy: boolean
}

export interface ConflictsSnapshot {
    /** Conflicts being resolved, by `subjectKey`. */
    subjects: Record<string, SubjectState>
    /** Each repository's conflicts and recoveries, as last listed. */
    lists: Record<string, { result?: ConflictResult; error: string; busy: boolean }>
    /** A conflict to open where it shows, such as after a transfer chose to resolve now; `serial` tells repeats apart. */
    requested?: { repositoryId: string; subject: string; serial: number }
}

export interface Conflicts extends Store<ConflictsSnapshot> {
    /** Lists a repository's conflicts and the unresolved stacks that need recovering. */
    list(repositoryId: string): Promise<void>
    /** A list-level operation: resuming suspended Working Changes, restoring or discarding a recovery. */
    run(repositoryId: string, request: Extract<ConflictRequest, { action: "resume-working" | "restore" | "discard" }>): Promise<void>
    /** Reads a conflict's files, without their contents, which load as each file opens. */
    inspect(repositoryId: string, subject: string): Promise<void>
    /** Changes the conflict's resolution as shown; false when it failed, its error then showing. */
    act(repositoryId: string, subject: string, action: ResolutionAction): Promise<boolean>
    /** A file's conflict with its contents, read once per revision of the resolution. */
    loadFile(repositoryId: string, subject: string, file: string): Promise<ConflictView>
    /** Opens a conflict where it shows. */
    open(repositoryId: string, subject: string): void
}

interface ConflictOptions {
    api: Pick<Api, "conflictOperation" | "readConflictContent">
    /** Runs after anything that changes branches or Working Changes. */
    changed(repositoryId: string): Promise<void>
}

export function subjectKey(repositoryId: string, subject: string) {
    return JSON.stringify([repositoryId, subject])
}

/** Resolving conflicts that rewrites deferred: a stack's commits, or Working Changes a stash couldn't restore. */
export function createConflicts({ api, changed }: ConflictOptions): Conflicts {
    let store = createStore<ConflictsSnapshot>({ subjects: {}, lists: {} })
    let state = store.snapshot
    let fileCache = new Map<string, ConflictView>()
    let setSubject = (key: string, change: Partial<SubjectState>) => {
        let previous: SubjectState = state().subjects[key] ?? { error: "", busy: false }
        store.publish({ ...state(), subjects: { ...state().subjects, [key]: { ...previous, ...change } } })
    }
    let setList = (repositoryId: string, change: Partial<ConflictsSnapshot["lists"][string]>) => {
        let previous: ConflictsSnapshot["lists"][string] = state().lists[repositoryId] ?? { error: "", busy: false }
        store.publish({ ...state(), lists: { ...state().lists, [repositoryId]: { ...previous, ...change } } })
    }

    async function request(repositoryId: string, subject: string, body: ConflictRequest) {
        let key = subjectKey(repositoryId, subject)
        if (state().subjects[key]?.busy)
            return false
        setSubject(key, { busy: true, error: "" })
        try {
            let response = await api.conflictOperation(repositoryId, body)
            if (!response.ok)
                throw new Error(response.error.message)
            setSubject(key, {
                view: response.result.view,
                summary: response.result.conflicts.find(conflict => conflict.id == subject) ?? state().subjects[key]?.summary,
            })
            if (body.action == "accept" || body.action == "keep-stashed")
                await changed(repositoryId)
            return true
        } catch (error) {
            setSubject(key, { error: errorMessage(error) })
            return false
        } finally {
            setSubject(key, { busy: false })
        }
    }

    function cache(key: string, view: ConflictView) {
        fileCache.set(key, view)
        if (fileCache.size > 16)
            fileCache.delete(fileCache.keys().next().value!)
        return view
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        async list(repositoryId) {
            setList(repositoryId, { busy: true, error: "" })
            try {
                let response = await api.conflictOperation(repositoryId, { action: "list" })
                if (!response.ok)
                    throw new Error(response.error.message)
                setList(repositoryId, { result: response.result })
            } catch (error) {
                setList(repositoryId, { error: errorMessage(error) })
            } finally {
                setList(repositoryId, { busy: false })
            }
        },

        async run(repositoryId, body) {
            setList(repositoryId, { busy: true, error: "" })
            try {
                let response = await api.conflictOperation(repositoryId, body)
                if (!response.ok)
                    throw new Error(response.error.message)
                setList(repositoryId, { result: response.result })
                await changed(repositoryId)
            } catch (error) {
                setList(repositoryId, { error: errorMessage(error) })
            } finally {
                setList(repositoryId, { busy: false })
            }
        },

        async inspect(repositoryId, subject) {
            await request(repositoryId, subject, { action: "inspect", subject, files: [] })
        },

        act(repositoryId, subject, action) {
            let view = state().subjects[subjectKey(repositoryId, subject)]?.view
            if (!view)
                return Promise.resolve(false)
            return request(
                repositoryId,
                subject,
                { ...action, subject: view.subject.id, input: view.subject.input, revision: view.candidate.revision } as ConflictRequest,
            )
        },

        async loadFile(repositoryId, subject, file) {
            let current = state().subjects[subjectKey(repositoryId, subject)]?.view
            if (!current)
                throw new Error("Reload the conflict before continuing.")
            let key = JSON.stringify([repositoryId, current.subject.id, current.subject.input, current.candidate.revision, file])
            let cached = fileCache.get(key)
            if (cached)
                return cached
            let item = current.files.find(candidate => candidate.path == file)!
            // An unresolved file's result is one blob away; a resolved one needs its review read.
            if (!item.resolved) {
                let entry = file in current.candidate.files ? current.candidate.files[file] : item.provisional
                let resultText = entry && entry.mode != "160000" ? await api.readConflictContent(repositoryId, entry.object) : null
                return cache(key, {
                    ...current,
                    files: current.files.map(candidate => candidate.path == file ? { ...candidate, loaded: true, resultText } : candidate),
                })
            }
            let response = await api.conflictOperation(repositoryId, { action: "inspect", subject: current.subject.id, files: [file] })
            if (!response.ok)
                throw new Error(response.error.message)
            let loaded = response.result.view!
            if (loaded.subject.input != current.subject.input || loaded.candidate.revision != current.candidate.revision)
                throw new Error("Resolution progress changed. Reload the conflict before continuing.")
            return cache(key, loaded)
        },

        open(repositoryId, subject) {
            store.publish({ ...state(), requested: { repositoryId, subject, serial: (state().requested?.serial ?? 0) + 1 } })
        },
    }
}

/** The two sides a conflict's files choose between, named for what they are: a commit's, or a stash's. */
export function conflictSides(view: ConflictView | undefined, summary: ConflictSummary | undefined) {
    let working = summary?.kind == "working"
    let source = view?.sourceCommit.slice(0, 8) ?? ""
    return {
        left: {
            label: working ? "Current files" : "Before this commit",
            action: working ? "Use pre-stash version" : "Use version before this commit",
            description: working ? "Files before restoring the stash." : "Destination files, including earlier commits in this stack.",
        },
        right: {
            label: working ? "Stashed changes" : "This commit",
            action: working ? "Use stashed changes" : "Use this commit",
            description: working ? `Stash ${source}` : `${source} · ${summary?.title ?? ""}`,
        },
    }
}

export type ConflictSides = ReturnType<typeof conflictSides>

/** A resolved file's changes against the version before the commit, as a diff page. */
export function resolutionReview(view: ConflictView, file: ConflictViewFile): FileDiffPage {
    let lines: DiffLine[] = []
    let oldLine = 0, newLine = 0, hunk = -1
    for (let text of file.diff.split("\n")) {
        let header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
        if (header) {
            oldLine = Number(header[1])
            newLine = Number(header[2])
            hunk++
            lines.push({ id: lines.length, kind: "hunk", text, hunk })
        } else if (hunk >= 0 && /^[ +-]/.test(text)) {
            let kind: DiffLine["kind"] = text[0] == "+" ? "addition" : text[0] == "-" ? "deletion" : "context"
            lines.push({
                id: lines.length,
                kind,
                text: text.slice(1),
                hunk,
                ...(kind != "addition" ? { oldLine: oldLine++ } : {}),
                ...(kind != "deletion" ? { newLine: newLine++ } : {}),
            })
        } else if (hunk >= 0 && text.startsWith("\\ No newline")) {
            lines.push({ id: lines.length, kind: "notice", text, hunk })
        }
    }
    return {
        source: { kind: "comparison", fromObjectId: view.reviewTree, toObjectId: view.resultTree },
        file: { path: file.path, status: "M", staged: false, unstaged: false, untracked: false, ignored: false, conflicted: false },
        view: "combined",
        version: `${view.candidate.revision}:${file.path}`,
        lines,
        summary: [],
        selectable: false,
    }
}
