import type { ChangedFile, CommitDraft, LocalPreview, LocalRequest, LocalResult } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

export interface ComposerSnapshot {
    /** The saved draft and the first preview have arrived; Commit… waits for them. */
    loaded: boolean
    /** The commit form shows. */
    composing: boolean
    /** The stash form shows. */
    stashing: boolean
    busy: boolean
    draft: CommitDraft
    preview?: LocalPreview
    /** A commit whose hooks changed files, waiting for Continue or Cancel. */
    hook?: LocalResult
    stashLabel: string
    /** The last operation's failure, shown under the files; outcomes go to the app's notices. */
    error?: string
}

/** Committing and stashing one worktree's Working Changes. */
export interface CommitComposer extends Store<ComposerSnapshot> {
    /** Reads the saved draft and the first preview. */
    start(): Promise<void>
    compose(): void
    /** Closes the form, keeping the draft for next time. */
    cancel(): void
    edit(change: Partial<Pick<CommitDraft, "title" | "message">>): void
    /** Names the branch a detached worktree's commit creates. */
    nameBranch(name: string): void
    stage(files: ChangedFile[], unstage: boolean): Promise<void>
    /** Commits the staged files, or every change when none are staged; continues past a hook review. */
    commit(): Promise<void>
    dismissHook(): void
    openStash(): void
    cancelStash(): void
    setStashLabel(label: string): void
    stash(): Promise<void>
    applyStash(objectId: string): Promise<void>
    dropStash(objectId: string): Promise<void>
}

export interface ComposerOptions {
    api: Api
    repositoryId: string
    path: string
    /** An interrupted worktree removal blocks local operations; the composer is recreated once it clears. */
    blocked: boolean
    notify(notice: Notice): void
    /** Reads Working Changes again, and the Branch Graph too when the operation changed what it shows. */
    changed(refreshGraph: boolean): Promise<void>
    /** Marks a local operation running or finished, so quiet refreshes wait for it. */
    mutating(busy: boolean): void
}

export function createCommitComposer({ api, repositoryId, path, blocked, notify, changed, mutating }: ComposerOptions): CommitComposer {
    let store = createStore<ComposerSnapshot>({
        loaded: false,
        composing: false,
        stashing: false,
        busy: false,
        draft: { title: "", message: "", branch: "" },
        stashLabel: "",
    })
    let state = store.snapshot
    let set = (change: Partial<ComposerSnapshot>) => store.publish({ ...state(), ...change })
    // A preview refresh in flight; operations wait for it so they always send the newest token.
    let refreshing: Promise<void> | undefined
    let previewGeneration = 0

    async function act(action: () => Promise<void>) {
        if (state().busy || blocked)
            return
        set({ busy: true, error: undefined })
        mutating(true)
        try {
            await action()
        } catch (error) {
            set({ error: errorMessage(error) })
        } finally {
            set({ busy: false })
            mutating(false)
        }
    }

    async function save() {
        try {
            await api.saveCommitDraft(repositoryId, path, { ...state().draft })
        } catch (error) {
            set({ error: `Could not save commit draft: ${errorMessage(error)}` })
        }
    }

    async function run(request: LocalRequest) {
        await refreshing
        let response = await api.localOperation(repositoryId, request, state().preview?.token)
        if (!response.ok) {
            // A rejected token means Working Changes moved on; show the current files for another attempt.
            await changed(false)
            refreshInBackground()
            throw new Error(response.error.message)
        }
        // Only stashes and performed commits change what the Branch Graph shows; staging just moves files.
        await changed(request.action.startsWith("stash") || request.action == "commit" && response.result.status == "performed")
        refreshInBackground()
        if (response.result.status == "failed") {
            await changed(true)
            throw new Error(response.result.message)
        }
        return response.result
    }

    // Previews take a second of Git work, so they never block the form; the engine checks the token
    // when it runs an operation, and a stale one is refreshed and reported.
    function refreshInBackground() {
        refreshing = refreshPreview()
            .catch(error => set({ error: errorMessage(error) }))
            .finally(() => refreshing = undefined)
    }

    async function refreshPreview() {
        if (blocked)
            return
        // Overlapping refreshes may finish out of order; only the newest result may become the preview.
        let generation = ++previewGeneration
        let result = await api.localOperation(repositoryId, { action: "stage", path, unstage: false })
        if (!result.ok && result.error.code == "operation.recovery-blocked")
            return
        if (!result.ok)
            throw new Error(result.error.message)
        if (generation != previewGeneration)
            return
        let preview = result.result.preview
        let draft = state().draft
        set({ preview, draft: draft.branch ? draft : { ...draft, branch: preview?.suggestedBranch ?? "" } })
    }

    async function commit() {
        await refreshing
        await save()
        let { draft, preview, hook } = state()
        if (!preview?.branch || preview.unborn && draft.branch != preview.branch)
            await run({ action: "branch-create", name: draft.branch, path })
        let result = await run({ action: "commit", path, title: draft.title, message: draft.message, acceptHooks: hook?.hookToken })
        if (result.status == "hook-review")
            return set({ hook: result })
        set({ hook: undefined, composing: false, draft: { title: "", message: "", branch: "" } })
        await save()
        // A post-commit hook failure is reported in the message and deserves to stay until dismissed.
        notify({ code: "commit.created", message: result.message ?? "Commit created.", transient: !result.message })
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        async start() {
            try {
                set({ draft: await api.readCommitDraft(repositoryId, path) })
                await refreshPreview()
                set({ loaded: true })
            } catch (error) {
                set({ error: errorMessage(error) })
            }
        },

        compose() {
            set({ composing: true })
            refreshInBackground()
        },

        cancel() {
            set({ composing: false, hook: undefined })
            void save()
        },

        edit(change) {
            set({ draft: { ...state().draft, ...change }, hook: undefined })
            void save()
        },

        nameBranch(name) {
            set({ draft: { ...state().draft, branch: name } })
            void save()
        },

        // Renamed files stage as their old and new paths together.
        stage: (files, unstage) =>
            act(async () => {
                set({ hook: undefined })
                await run({ action: "stage", path, files: files.flatMap(file => file.oldPath ? [file.oldPath, file.path] : [file.path]), unstage })
            }),

        commit: () => act(commit),

        dismissHook: () => set({ hook: undefined }),

        openStash: () => set({ stashing: true }),

        cancelStash: () => set({ stashing: false }),

        setStashLabel: label => set({ stashLabel: label }),

        stash: () =>
            act(async () => {
                await run({ action: "stash-create", path, label: state().stashLabel })
                set({ stashing: false, stashLabel: "" })
            }),

        applyStash: objectId => act(async () => void await run({ action: "stash-apply", path, objectId })),

        dropStash: objectId => act(async () => void await run({ action: "stash-drop", objectId })),
    }
}

/** The branch a detached worktree's commit creates, until the engine's preview suggests one; mirrors the engine's default. */
export function defaultBranchName(path: string) {
    return `worktree/${(path.split(/[\\/]/).filter(Boolean).at(-1) ?? "changes").replace(/[^\w.-]+/g, "-")}`
}
