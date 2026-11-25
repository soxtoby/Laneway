import type { BranchGraph, BranchGraphBranchNode, LocalPreview, LocalRequest, LocalResult } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"
import type { CheckoutRequest } from "./worktree-actions"
import { checkoutWorktrees, worktreeLabel } from "./worktree-columns"

type Api = Window["laneway"]

/** Where a new branch is checked out: in a Registered Worktree, in a new worktree, or nowhere. */
export type BranchCheckout = { kind: "worktree"; path: string } | { kind: "new" } | { kind: "none" }

/** A worktree a new branch can check out in, named as the checkout menus name it. */
export interface CheckoutWorktree {
    path: string
    label: string
    main: boolean
    missing: boolean
}

/** The dialog open: creating a branch or a tag at a commit, or renaming a branch. */
export type BranchDialog =
    /** A new branch checks out in the Main Worktree unless another choice is made; `worktrees` are those it can. */
    | { action: "branch-create"; name: string; commit: string; worktrees: CheckoutWorktree[]; checkout: BranchCheckout }
    | { action: "branch-rename"; name: string; original: string }
    /** A tag also goes to `remote`, the Branch Graph's remote when the dialog opened. */
    | { action: "tag-create"; name: string; commit: string; message: string; remote?: string }

export interface LocalBranchesSnapshot {
    repositoryId?: string
    dialog?: BranchDialog
    busy: boolean
    error?: string
}

/** Creating and renaming local branches, in a dialog or in place, and deleting them at once; and creating tags. */
export interface LocalBranches extends Store<LocalBranchesSnapshot> {
    createAt(repositoryId: string, objectId: string): void
    /** Opens the dialog creating a tag at a commit, here and on the Branch Graph's remote. */
    tagAt(repositoryId: string, objectId: string): void
    rename(repositoryId: string, branch: BranchGraphBranchNode): void
    /** Deletes a branch straight away, with any commits only it holds; a failure shows as a notice. */
    delete(repositoryId: string, branch: BranchGraphBranchNode): Promise<void>
    /** Moves a branch's Base Branch up to its tip straight away, when `movableBase` offers one; a failure shows as a notice. */
    moveIntoBase(repositoryId: string, branch: BranchGraphBranchNode): Promise<void>
    setName(name: string): void
    /** Chooses where a new branch is checked out. */
    setCheckout(checkout: BranchCheckout): void
    /** Sets a new tag's message; a tag with one is annotated. */
    setMessage(message: string): void
    submit(): Promise<void>
    /** Closes the dialog, unless an operation is under way. */
    close(): void
    /** Runs one operation straight away, for names edited in place; throws its failure for the editor to show. */
    perform(repositoryId: string, request: LocalRequest): Promise<void>
}

interface LocalBranchesOptions {
    api: Api
    /** Runs after an operation succeeds and before the dialog closes, with the review it ran from. */
    completed(repositoryId: string, request: LocalRequest, preview: LocalPreview, result: LocalResult): Promise<void>
    /** Creates a branch and checks it out as one operation; throws its failure for the dialog to show. */
    checkOut(repositoryId: string, request: CheckoutRequest): Promise<void>
    mutating(busy: boolean): void
    notify(notice: Notice): void
    /** The Branch Graph shown: new tags are created on its remote too, and new branches check out in its worktrees. */
    graph(): BranchGraph | undefined
}

export function createLocalBranches({ api, completed, checkOut, mutating, notify, graph }: LocalBranchesOptions): LocalBranches {
    let store = createStore<LocalBranchesSnapshot>({ busy: false })
    let state = store.snapshot
    let set = (change: Partial<LocalBranchesSnapshot>) => store.publish({ ...state(), ...change })

    function open(repositoryId: string, dialog: BranchDialog) {
        if (!state().busy)
            store.publish({ repositoryId, dialog, busy: false })
    }

    async function inspect(repositoryId: string, request: LocalRequest) {
        let response = await api.localOperation(repositoryId, request)
        if (!response.ok)
            throw new Error(response.error.message)
        return response.result.preview!
    }

    async function run(repositoryId: string, request: LocalRequest, preview: LocalPreview) {
        let response = await api.localOperation(repositoryId, request, preview.token)
        if (!response.ok)
            throw new Error(response.error.message)
        if (response.result.status == "failed")
            throw new Error(response.result.message)
        await completed(repositoryId, request, preview, response.result)
    }

    // Deleting a branch and moving it into its base go without asking: Undo in their notice takes them back.
    async function immediately(repositoryId: string, value: LocalRequest, failure: string) {
        if (state().busy)
            return
        set({ busy: true })
        mutating(true)
        try {
            await run(repositoryId, value, await inspect(repositoryId, value))
        } catch (error) {
            notify({ code: failure, message: errorMessage(error) })
        } finally {
            set({ busy: false })
            mutating(false)
        }
    }

    // A new branch that's checked out is made by the checkout, so one Undo takes both back.
    function checkoutRequest(dialog: BranchDialog): CheckoutRequest | undefined {
        if (dialog.action != "branch-create" || dialog.checkout.kind == "none")
            return
        let created = { commit: dialog.commit, newBranch: dialog.name.trim(), move: false }
        return dialog.checkout.kind == "new" ? { action: "create", ...created } : { action: "switch", path: dialog.checkout.path, ...created }
    }

    function request(dialog: BranchDialog): LocalRequest {
        if (dialog.action == "branch-create")
            return { action: dialog.action, name: dialog.name.trim(), commit: dialog.commit }
        if (dialog.action == "tag-create")
            return { action: dialog.action, name: dialog.name.trim(), commit: dialog.commit, message: dialog.message, remote: dialog.remote }
        return { action: dialog.action, name: dialog.original, newName: dialog.name.trim() }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,

        createAt(repositoryId, objectId) {
            let shown = graph()
            let worktrees = shown ? checkoutChoices(shown) : []
            let main = worktrees.find(worktree => worktree.main && !worktree.missing)
            let checkout: BranchCheckout = main ? { kind: "worktree", path: main.path } : { kind: "none" }
            open(repositoryId, { action: "branch-create", name: "", commit: objectId, worktrees, checkout })
        },

        tagAt: (repositoryId, objectId) =>
            open(repositoryId, { action: "tag-create", name: "", commit: objectId, message: "", remote: graph()?.selectedRemote }),

        rename: (repositoryId, branch) => open(repositoryId, { action: "branch-rename", name: branch.name, original: branch.name }),

        delete: (repositoryId, branch) => immediately(repositoryId, { action: "branch-delete", name: branch.name, confirmed: true }, "branch.delete.failed"),

        async moveIntoBase(repositoryId, branch) {
            let base = movableBase(branch)
            if (base) {
                let value: LocalRequest = { action: "move-into-base", branch: branch.preferredRef, tip: branch.tip, base: base.ref, baseTip: base.tip }
                await immediately(repositoryId, value, "branch.move-into-base.failed")
            }
        },

        setName(name) {
            let dialog = state().dialog
            if (dialog)
                set({ dialog: { ...dialog, name }, error: undefined })
        },

        setCheckout(checkout) {
            let dialog = state().dialog
            if (dialog?.action == "branch-create")
                set({ dialog: { ...dialog, checkout }, error: undefined })
        },

        setMessage(message) {
            let dialog = state().dialog
            if (dialog?.action == "tag-create")
                set({ dialog: { ...dialog, message }, error: undefined })
        },

        async submit() {
            let { repositoryId, dialog, busy } = state()
            if (!repositoryId || !dialog || busy)
                return
            let checkout = checkoutRequest(dialog)
            let value = request(dialog)
            set({ busy: true, error: undefined })
            mutating(true)
            try {
                if (checkout)
                    await checkOut(repositoryId, checkout)
                else
                    await run(repositoryId, value, await inspect(repositoryId, value))
                store.publish({ busy: false })
            } catch (error) {
                set({ error: errorMessage(error) })
            } finally {
                if (state().busy)
                    set({ busy: false })
                mutating(false)
            }
        },

        close() {
            if (!state().busy)
                store.publish({ busy: false })
        },

        async perform(repositoryId, value) {
            mutating(true)
            try {
                await run(repositoryId, value, await inspect(repositoryId, value))
            } finally {
                mutating(false)
            }
        },
    }
}

/** The worktrees a new branch can check out in, the Main Worktree first. */
function checkoutChoices(graph: BranchGraph): CheckoutWorktree[] {
    return checkoutWorktrees(graph).map(worktree => ({
        path: worktree.path,
        label: worktreeLabel(graph, worktree),
        main: worktree.main,
        missing: worktree.missing == true,
    }))
}

/** The Base Branch a branch's commits can move into: a local branch whose tip is still in the branch's history. */
export function movableBase(branch: BranchGraphBranchNode) {
    let base = branch.base
    return base.status == "known" && base.ref.startsWith("refs/heads/") && !branch.behindBase && base.tip != branch.tip ? base : undefined
}

/** Names a Move into Base by its destination, and by how many commits move once they're all known. */
export function moveIntoBaseLabel(base: { name: string }, count?: number) {
    return count == undefined ? `Move commits into ${base.name}` : `Move ${count} commit${count == 1 ? "" : "s"} into ${base.name}`
}
