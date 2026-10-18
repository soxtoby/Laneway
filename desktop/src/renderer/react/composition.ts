import { draggable, dropTargetForElements, monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter"
import type { CompositionRequest, CompositionSource, CompositionTarget, LocalPreview } from "@laneway/shared"
import { errorMessage, type Notice } from "./notice"
import { createStore, type Store } from "./store"

type Api = Window["laneway"]

/** What a move or copy takes: files or lines from a list, a whole commit, or a branch with its commits. */
export interface TransferSelection {
    repositoryId: string
    source: CompositionSource
    /** The files, or lines, to take; a commit dragged by its row takes all of it. */
    files?: CompositionRequest["files"]
    inventoryVersion?: string
    selectedRemote?: string
    view?: CompositionRequest["view"]
    label: string
}

/** Where a selection lands: composed into Working Changes, a commit, a seam between commits, or a branch; or staged. */
export type Landing =
    | { kind: "compose"; repositoryId: string; target: CompositionTarget }
    | {
        kind: "stage"
        repositoryId: string
        worktreePath: string
        /** The list landing in: files from the other one move here. */
        view: "staged" | "unstaged"
        apply(paths: string[]): void
    }

/** The seams a row stands in for: a pointer near its top or bottom edge lands there instead of on the row. */
export interface Edges {
    above?: Extract<CompositionTarget, { kind: "seam" }>
    below?: Extract<CompositionTarget, { kind: "seam" }>
}

export interface CompositionSnapshot {
    /** The selection choosing its destination. */
    active?: TransferSelection
    mode: "move" | "copy"
    /** A transfer landed on its destination and under review there, by the destination's key. */
    pending?: { key: string; selection: TransferSelection; request: CompositionRequest; preview?: LocalPreview }
    busy: boolean
    /** Progress or a failure, shown in the review at the destination. */
    notice?: string
}

/**
 * Moving or copying changes: files, lines, commits, and branches dragged, or chosen with M or C and placed with
 * the arrow keys and Enter, onto Working Changes, a commit, a seam, or a branch. Landing reviews the transfer
 * with the engine; transfers that rewrite nothing published and conflict with nothing run straight away.
 */
export interface Composition extends Store<CompositionSnapshot> {
    /** Whether a transfer that conflicts can open conflict resolution as soon as it runs. */
    readonly resolves: boolean
    choose(selection: TransferSelection, mode: "move" | "copy"): void
    cancel(): void
    /** The key a destination's review shows under. */
    key(repositoryId: string, target: CompositionTarget): string
    accepts(selection: TransferSelection | undefined, landing: Landing): boolean
    land(selection: TransferSelection, landing: Landing, copy: boolean): void
    setMessage(message: string): void
    setDescendants(descendants: boolean): void
    prepare(): Promise<void>
    execute(resolveNow: boolean): Promise<void>
    /** Makes `element` drag the selection; it starts as a move, or a copy with Ctrl held. Returns the cleanup. */
    bindSource(element: HTMLElement, selection: () => TransferSelection): () => void
    /** Makes `element` take drops of the landing, or of the seams at its edges. Returns the cleanup. */
    bindTarget(element: HTMLElement, landing: () => Landing, edges: () => Edges): () => void
    dispose(): void
}

interface CompositionOptions {
    api: Pick<Api, "localOperation">
    notify(notice: Notice): () => void
    /** Runs after a transfer, which can rewrite commits anywhere in the repository. */
    changed(repositoryId: string): Promise<void>
    mutating(busy: boolean): void
    /** Opens conflict resolution after a transfer that left conflicts to resolve now; without it they wait. */
    resolve?(repositoryId: string): void
}

let token = `composition-${crypto.randomUUID()}`
let overEdges = { above: "above", on: "on", below: "below" } as const

export function createComposition({ api, notify, changed, mutating, resolve }: CompositionOptions): Composition {
    let store = createStore<CompositionSnapshot>({ mode: "move", busy: false })
    let state = store.snapshot
    let set = (change: Partial<CompositionSnapshot>) => store.publish({ ...state(), ...change })
    let targets = new Map<HTMLElement, () => Landing>()
    let generation = 0
    let dismissGuidance = () => {}
    let key = (repositoryId: string, target: CompositionTarget) => JSON.stringify([repositoryId, target])
    /** A commit dragged by its row: it moves or squashes as a unit, carrying its own message. */
    let wholeCommit = (selection: TransferSelection) => selection.source.kind == "commit" && !selection.files

    function compatible(selection: TransferSelection | undefined, repositoryId: string, target: CompositionTarget) {
        if (!selection || selection.repositoryId != repositoryId)
            return false
        let source = selection.source
        if (source.kind == "branch")
            return target.kind == "branch"
        if (target.kind == "branch")
            return wholeCommit(selection)
        if (source.kind != "commit")
            return true
        if (target.kind == "commit")
            return target.objectId != source.objectId
        // The seams either side of a commit in its own branch would only put it back where it is.
        return target.kind != "seam" || !wholeCommit(selection) || target.branch != source.branch
            || target.parentId != source.objectId && target.parentId != source.parentId
    }

    function stageable(selection: TransferSelection | undefined, landing: Extract<Landing, { kind: "stage" }>) {
        return !!selection && selection.repositoryId == landing.repositoryId
            && selection.source.kind == "working" && selection.source.worktreePath == landing.worktreePath
            && !!selection.files?.length && (selection.view == "staged" || selection.view == "unstaged") && selection.view != landing.view
    }

    function accepts(selection: TransferSelection | undefined, landing: Landing) {
        return landing.kind == "compose" ? compatible(selection, landing.repositoryId, landing.target) : stageable(selection, landing)
    }

    function choose(selection: TransferSelection, mode: "move" | "copy") {
        if (state().busy)
            return
        generation++
        dismissGuidance()
        let chosen = selection.source.kind == "branch" ? "move" : mode
        store.publish({ active: selection, mode: chosen, busy: false })
        dismissGuidance = notify({
            code: "composition.choose",
            message: `${chosen == "move" ? "Move" : "Copy"} ${selection.label} · Choose a destination, then Enter. Escape cancels.`,
        })
    }

    function cancel() {
        generation++
        dismissGuidance()
        store.publish({ mode: "move", busy: false })
    }

    function land(selection: TransferSelection, landing: Landing, copy: boolean) {
        if (landing.kind == "compose")
            return void drop(selection, landing.repositoryId, landing.target, copy)
        if (!state().busy && stageable(selection, landing)) {
            cancel()
            landing.apply(selection.files!.map(file => file.path))
        }
    }

    async function drop(selection: TransferSelection, repositoryId: string, target: CompositionTarget, copy: boolean) {
        if (state().busy || !compatible(selection, repositoryId, target))
            return
        dismissGuidance()
        let mode = copy && selection.source.kind != "branch" ? "copy" as const : "move" as const
        let request: CompositionRequest = {
            action: "compose",
            source: selection.source,
            target,
            mode,
            files: selection.files,
            inventoryVersion: selection.inventoryVersion,
            selectedRemote: selection.selectedRemote,
            view: selection.view ?? "combined",
            message: "",
            descendants: true,
            allowConflicts: false,
        }
        store.publish({ active: selection, mode, pending: { key: key(repositoryId, target), selection, request }, busy: false })
        // Only a file selection landing on a seam needs a message for its new commit; a whole commit brings its own.
        if (target.kind != "seam" || wholeCommit(selection))
            await prepare()
    }

    async function completed(repositoryId: string, message?: string) {
        notify({ code: "composition.transferred", message: message ?? "Changes transferred.", transient: true })
        store.publish({ mode: "move", busy: true })
        await changed(repositoryId)
    }

    async function prepare() {
        let current = state().pending
        if (!current || state().busy)
            return
        let version = ++generation
        set({ busy: true, notice: "Transferring…" })
        mutating(true)
        try {
            let response = await api.localOperation(current.selection.repositoryId, current.request)
            if (version != generation || state().pending != current)
                return
            if (!response.ok)
                throw new Error(response.error.message)
            if (response.result.status == "failed")
                throw new Error(response.result.message)
            if (response.result.command == "local" && response.result.status == "performed")
                await completed(current.selection.repositoryId, response.result.message)
            else
                set({ pending: { ...current, preview: response.result.preview }, notice: undefined })
        } catch (error) {
            set({ notice: errorMessage(error) })
        } finally {
            set({ busy: false })
            mutating(false)
        }
        // A transfer that rewrites nothing published, drops nothing, and conflicts with nothing runs at once.
        let reviewed = state().pending
        let preview = reviewed?.preview?.composition
        if (
            reviewed && preview && reviewed.request.source.kind != "branch" && !preview.conflicts.length && !preview.removed.length && !preview.published.length
        ) {
            await execute(false)
        }
    }

    async function execute(resolveNow: boolean) {
        let current = state().pending
        if (!current?.preview || state().busy)
            return
        set({ busy: true, notice: "Transferring…" })
        mutating(true)
        try {
            let request = { ...current.request, allowConflicts: !!current.preview.composition?.conflicts.length }
            let result = await api.localOperation(current.selection.repositoryId, request, current.preview.token)
            if (!result.ok)
                throw new Error(result.error.message)
            if (result.result.status == "failed")
                throw new Error(result.result.message)
            await completed(current.selection.repositoryId, result.result.message)
            if (resolveNow)
                resolve?.(current.selection.repositoryId)
        } catch (error) {
            let pending = state().pending
            set({ notice: errorMessage(error), pending: pending && { ...pending, preview: undefined } })
        } finally {
            set({ busy: false })
            mutating(false)
        }
    }

    // While a selection chooses its destination, the arrow keys move between the destinations that take it.
    function keyboard(event: KeyboardEvent) {
        let { active, busy, mode } = state()
        if (!active || busy || (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")))
            return
        if (event.key == "Escape") {
            event.preventDefault()
            event.stopPropagation()
            cancel()
        } else if (event.key == "ArrowDown" || event.key == "ArrowUp") {
            // Destinations register as React mounts them, so they are put back in the order they appear.
            let available = [...targets]
                .filter(([element, landing]) => element.isConnected && element.getClientRects().length && accepts(active, landing()))
                .sort(([a], [b]) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
            let index = available.findIndex(([element]) => element == document.activeElement)
            let next = available[(index + (event.key == "ArrowDown" ? 1 : -1) + available.length) % available.length]
            if (next) {
                event.preventDefault()
                event.stopPropagation()
                next[0].focus()
            }
        } else if (event.key == "Enter" && event.target instanceof HTMLElement) {
            let landing = targets.get(event.target)?.()
            if (landing && accepts(active, landing)) {
                event.preventDefault()
                event.stopPropagation()
                land(active, landing, mode == "copy")
            }
        }
    }
    // The page is only listened to once something on it can be dragged or dropped on, so the controller also
    // runs without a page.
    let stopListening: (() => void) | undefined
    function listen() {
        if (stopListening)
            return
        document.addEventListener("keydown", keyboard, true)
        let stopMonitoring = monitorForElements({
            canMonitor: ({ source }) => !!source.data[token],
            // Cancelling reports no targets, even over a valid one.
            onDrop: ({ location }) => {
                if (!location.current.dropTargets.length)
                    cancel()
            },
        })
        stopListening = () => {
            document.removeEventListener("keydown", keyboard, true)
            stopMonitoring()
        }
    }

    return {
        subscribe: store.subscribe,
        snapshot: store.snapshot,
        resolves: resolve != undefined,
        choose,
        cancel,
        key,
        accepts,
        land,

        setMessage(message) {
            let pending = state().pending
            if (pending)
                set({ pending: { ...pending, request: { ...pending.request, message }, preview: undefined } })
        },

        setDescendants(descendants) {
            let pending = state().pending
            if (pending) {
                set({ pending: { ...pending, request: { ...pending.request, descendants }, preview: undefined } })
                void prepare()
            }
        },

        prepare,
        execute,

        bindSource(element, selection) {
            listen()
            return draggable({
                element,
                getInitialData: () => ({ [token]: selection() }),
                canDrag: ({ input }) => {
                    if (state().busy)
                        return false
                    let target = document.elementFromPoint(input.clientX, input.clientY)
                    return !target?.closest("input, textarea, select, [contenteditable], a[href]")
                },
                onDragStart: ({ location }) => choose(selection(), location.current.input.ctrlKey ? "copy" : "move"),
            })
        },

        bindTarget(element, landing, edges) {
            listen()
            targets.set(element, landing)
            let selectionOf = (source: { data: Record<string, unknown> }) => source.data[token] as TransferSelection | undefined
            let seam = (target: CompositionTarget | undefined, selection: TransferSelection | undefined): Landing | undefined => {
                let value = landing()
                return value.kind == "compose" && target && compatible(selection, value.repositoryId, target)
                    ? { kind: "compose", repositoryId: value.repositoryId, target }
                    : undefined
            }
            // Edges take a quarter of the row beside a usable centre, or half of it otherwise; a lone edge takes the whole row.
            let place = (selection: TransferSelection | undefined, clientY: number) => {
                let value = landing()
                let on = accepts(selection, value) ? value : undefined
                let above = seam(edges().above, selection), below = seam(edges().below, selection)
                let rect = element.getBoundingClientRect(), offset = clientY - rect.top, band = rect.height / (on ? 4 : 2)
                if (above && offset < band)
                    return { landing: above, edge: overEdges.above }
                if (below && offset > rect.height - band)
                    return { landing: below, edge: overEdges.below }
                return on
                    ? { landing: on, edge: overEdges.on }
                    : above
                    ? { landing: above, edge: overEdges.above }
                    : below
                    ? { landing: below, edge: overEdges.below }
                    : undefined
            }
            // The drop edge is marked by an attribute rather than a class, which React would overwrite.
            let show = (placement?: { edge: string }) => {
                if (placement)
                    element.dataset.dropEdge = placement.edge
                else
                    delete element.dataset.dropEdge
            }
            let unregister = dropTargetForElements({
                element,
                canDrop: ({ source, input }) => !state().busy && !!place(selectionOf(source), input.clientY),
                getDropEffect: ({ input, source }) =>
                    landing().kind == "compose" && input.ctrlKey && selectionOf(source)?.source.kind != "branch" ? "copy" : "move",
                onDragEnter: ({ source, location }) => show(place(selectionOf(source), location.current.input.clientY)),
                onDrag: ({ source, location }) => show(place(selectionOf(source), location.current.input.clientY)),
                onDragLeave: () => show(),
                onDrop: ({ source, location, self }) => {
                    show()
                    let selection = selectionOf(source)
                    let placement = place(selection, location.current.input.clientY)
                    if (selection && placement && location.current.dropTargets[0]?.element == self.element)
                        land(selection, placement.landing, location.current.input.ctrlKey)
                },
            })
            return () => {
                unregister()
                targets.delete(element)
            }
        },

        dispose() {
            stopListening?.()
            stopListening = undefined
            store.clear()
        },
    }
}
