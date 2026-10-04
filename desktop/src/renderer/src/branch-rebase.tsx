import type { BranchGraph, BranchGraphBranchNode, CompositionRequest, LocalPreview } from "@laneway/shared"
import { css, on, ref } from "remix/ui"
import radio from "remix/ui/radio"
import type { NoticeState } from "./feedback"

/** A tip a Branch Node offers as the new base: its local tip, or its upstream tip when that has commits the local one lacks. */
interface Destination {
    branch: string
    tip: string
    name: string
    detail: string
}

interface Pending {
    repositoryId: string
    source: BranchGraphBranchNode
    destinations: Destination[]
    destination: Destination
    selectedRemote?: string
    descendants: boolean
    /** Branches carried along by the rebase, as first reviewed with them included. */
    dependents: string[]
    preview?: LocalPreview
    /** Open only for an ambiguity or a decision the rebase can't make by itself. */
    dialog: boolean
    error: string
}

const shortName = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "")
const plural = (count: number, noun: string) => `${count} ${noun}${count == 1 ? "" : "s"}`

/** Only a local line of work with a Base has its own commits to move. */
export function rebaseable(branch: BranchGraphBranchNode) {
    return !branch.remoteOnly && !branch.primary && branch.localRefs.length > 0
}

/**
 * A branch can't be rebased onto itself or onto a branch stacked on it, whose history the rebase rewrites. Branches sharing
 * its tip count as itself: Bases name only one of them.
 */
export function canRebaseOnto(graph: BranchGraph, source: BranchGraphBranchNode, target: BranchGraphBranchNode) {
    if (!rebaseable(source) || target.tip == source.tip)
        return false
    const seen = new Set<string>()
    for (let node: BranchGraphBranchNode | undefined = target; node?.base.status == "known" && !seen.has(node.id);) {
        seen.add(node.id)
        if (node.base.tip == source.tip)
            return false
        const baseId: string = node.base.branchId
        node = graph.branches.find(branch => branch.id == baseId)
    }
    return true
}

function destinations(target: BranchGraphBranchNode): Destination[] {
    const local = { branch: target.preferredRef, tip: target.tip, name: target.name, detail: "" }
    // A node draws its local tip but combines it with its upstream; when the upstream holds commits the local tip lacks,
    // "onto this branch" could mean either.
    if (target.remoteOnly || !target.upstreamRef || !target.upstreamTip || target.upstreamTip == target.tip || target.behind == 0)
        return [local]
    const upstream = shortName(target.upstreamRef)
    local.detail = `Local tip, ${plural(target.behind, "commit")} behind ${upstream}${target.ahead ? ` and ${target.ahead} ahead` : ""}`
    return [local, { branch: target.upstreamRef, tip: target.upstreamTip, name: upstream, detail: "Upstream tip" }]
}

export function createBranchRebase(options: {
    api: Pick<Window["laneway"], "localOperation">
    update(): Promise<AbortSignal>
    notify(notice: NoticeState): () => void
    completed(repositoryId: string): Promise<void>
    busyChanged(busy: boolean): void
    /** Opens the rebased stack for inline resolution: the named branches, the dragged one first. */
    resolve(repositoryId: string, branches: string[]): void
}) {
    // Reviewing is read-only and can be abandoned; only executing holds the dialog open.
    let pending: Pending | undefined, busy = false, executing = false, generation = 0
    let choosing: { repositoryId: string; sourceId: string } | undefined
    let returnFocus: HTMLElement | null = null, dismissNotice = () => {}
    const update = () => void options.update()
    const setBusy = (value: boolean) => {
        busy = value
        options.busyChanged(value)
    }
    const request = (current: Pending): CompositionRequest => ({
        action: "compose",
        source: { kind: "branch", branch: current.source.preferredRef, tip: current.source.tip },
        target: { kind: "branch", branch: current.destination.branch, tip: current.destination.tip },
        mode: "move",
        selectedRemote: current.selectedRemote,
        view: "combined",
        message: "",
        descendants: current.descendants,
        allowConflicts: false,
    })
    function notify(notice: NoticeState) {
        dismissNotice()
        dismissNotice = options.notify(notice)
    }
    function finish() {
        pending = undefined
        update()
        returnFocus?.focus()
    }
    function cancel() {
        if (executing)
            return
        generation++
        finish()
    }
    function fail(current: Pending, error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        if (current.dialog) {
            current.error = message
            // A failed or changed rebase is reviewed again before it can run.
            current.preview = undefined
        } else {
            notify({ code: "rebase.failed", message: `Couldn't rebase ${current.source.name}: ${message}` })
            pending = undefined
        }
    }

    async function prepare() {
        const current = pending
        if (!current || busy)
            return
        const version = ++generation
        current.preview = undefined
        current.error = ""
        if (!current.dialog)
            notify({ code: "rebase.progress", message: `Rebasing ${current.source.name} onto ${current.destination.name}…` })
        setBusy(true)
        update()
        try {
            const response = await options.api.localOperation(current.repositoryId, request(current))
            if (version != generation || pending != current)
                return
            if (!response.ok)
                throw new Error(response.error.message)
            if (response.result.status == "failed" || !response.result.preview?.composition)
                throw new Error(response.result.message ?? "The rebase couldn't be reviewed.")
            current.preview = response.result.preview
            if (current.descendants)
                current.dependents = current.preview.composition!.branches.filter(name => name != shortName(current.source.preferredRef))
        } catch (error) {
            if (version == generation && pending == current)
                fail(current, error)
        } finally {
            setBusy(false)
        }
        const p = pending == current ? current.preview?.composition : undefined
        if (p && !current.dialog) {
            if (p.noop) {
                notify({ code: "rebase.current", message: `${current.source.name} is already on top of ${current.destination.name}.`, transient: true })
                return finish()
            }
            // Conflicts, rewritten published history and emptied commits each need the user's decision first.
            current.dialog = p.conflicts.length > 0 || p.published.length > 0 || p.removed.length > 0
            if (current.dialog)
                dismissNotice()
            else
                return execute(false)
        }
        update()
    }

    async function execute(resolveNow: boolean) {
        const current = pending, p = current?.preview?.composition
        if (!current?.preview || !p || busy)
            return
        executing = true
        setBusy(true)
        update()
        try {
            const response = await options.api.localOperation(
                current.repositoryId,
                { ...request(current), allowConflicts: p.conflicts.length > 0 },
                current.preview.token,
            )
            if (!response.ok)
                throw new Error(response.error.message)
            if (response.result.status == "failed")
                throw new Error(response.result.message)
            const moved = current.descendants ? current.dependents : []
            notify({
                code: "rebase.completed",
                message: `Rebased ${current.source.name}${moved.length ? ` and ${moved.join(", ")}` : ""} onto ${current.destination.name}${
                    p.conflicts.length ? ", with conflicts to resolve before publishing." : "."
                }`,
                transient: !p.conflicts.length,
            })
            pending = undefined
            await options.completed(current.repositoryId)
            if (resolveNow)
                options.resolve(current.repositoryId, [shortName(current.source.preferredRef), ...moved])
            else
                returnFocus?.focus()
        } catch (error) {
            fail(current, error)
        } finally {
            executing = false
            setBusy(false)
            update()
        }
    }

    return {
        busy: () => busy,
        /** The branch whose destination is being chosen by keyboard, if any. */
        choosing: (repositoryId: string) => choosing?.repositoryId == repositoryId ? choosing.sourceId : undefined,
        /** Starts choosing a destination by keyboard: arrows select it, Enter rebases, Escape cancels. */
        choose(repositoryId: string, source: BranchGraphBranchNode) {
            if (busy || pending || !rebaseable(source))
                return
            choosing = { repositoryId, sourceId: source.id }
            notify({ code: "rebase.choose", message: `Rebase ${source.name} · Choose a destination branch, then Enter. Escape cancels.` })
            update()
        },
        stopChoosing() {
            if (!choosing)
                return
            choosing = undefined
            dismissNotice()
            update()
        },
        async start(repositoryId: string, graph: BranchGraph, sourceId: string, targetId: string) {
            const source = graph.branches.find(branch => branch.id == sourceId), target = graph.branches.find(branch => branch.id == targetId)
            if (busy || pending || !source || !target || !canRebaseOnto(graph, source, target))
                return
            choosing = undefined
            const choices = destinations(target)
            returnFocus = document.activeElement as HTMLElement | null
            pending = {
                repositoryId,
                source,
                destinations: choices,
                destination: choices[0],
                selectedRemote: graph.selectedRemote,
                descendants: true,
                dependents: [],
                dialog: choices.length > 1,
                error: "",
            }
            if (pending.dialog)
                dismissNotice()
            await prepare()
        },
        render() {
            const current = pending
            if (!current?.dialog)
                return null
            const p = current.preview?.composition
            const base = current.source.base
            const baseName = base.status == "known" ? base.name : base.candidates.map(candidate => candidate.name).join(" / ")
            const commits = p?.commits ?? []
            return (
                <dialog
                    class="branch-rebase"
                    aria-label={`Rebase ${current.source.name}`}
                    mix={[
                        dialogStyle,
                        ref(dialog => dialog.showModal()),
                        on("cancel", event => {
                            event.preventDefault()
                            cancel()
                        }),
                    ]}
                >
                    <h2>Rebase {current.source.name}</h2>
                    {current.destinations.length > 1
                        ? (
                            <fieldset mix={choiceStyle}>
                                <legend>Onto</legend>
                                {current.destinations.map(choice => (
                                    <label>
                                        <input
                                            type="radio"
                                            name="branch-rebase-destination"
                                            checked={choice == current.destination}
                                            disabled={busy}
                                            mix={[
                                                radio(),
                                                ...(choice == current.destination
                                                    ? [ref((input: HTMLInputElement) => input.focus())]
                                                    : []),
                                                on("change", event => {
                                                    if (!event.currentTarget.checked)
                                                        return
                                                    current.destination = choice
                                                    void prepare()
                                                }),
                                            ]}
                                        />
                                        <span>
                                            <strong>{choice.name}</strong>
                                            <small>{choice.detail}</small>
                                        </span>
                                    </label>
                                ))}
                            </fieldset>
                        )
                        : (
                            <p>
                                Onto <strong>{current.destination.name}</strong>
                            </p>
                        )}
                    {commits.length > 0 && (
                        <section mix={commitsStyle} aria-label="Commits to move">
                            <p>{plural(commits.length, "commit")} since {baseName}</p>
                            <ol>
                                {commits.slice(0, 8).map(commit => (
                                    <li>
                                        <code>{commit.objectId.slice(0, 8)}</code> {commit.subject}
                                    </li>
                                ))}
                            </ol>
                            {commits.length > 8 && <p>and {plural(commits.length - 8, "more commit")}</p>}
                        </section>
                    )}
                    {current.dependents.length > 0 && (
                        <label mix={checkboxStyle}>
                            <input
                                type="checkbox"
                                checked={current.descendants}
                                disabled={busy}
                                mix={on("change", event => {
                                    current.descendants = event.currentTarget.checked
                                    void prepare()
                                })}
                            />
                            Move dependent branches too: {current.dependents.join(", ")}
                        </label>
                    )}
                    {p?.noop && <p>{current.source.name} is already on top of {current.destination.name}.</p>}
                    {!!p?.published.length && (
                        <p class="rebase-warning" role="alert" mix={warningStyle}>
                            Rewrites history already published on {p.published.join(", ")}. The next Publish needs force-with-lease.
                        </p>
                    )}
                    {!!p?.removed.length && <p>Removes commits left empty: {p.removed.map(commit => commit.slice(0, 8)).join(", ")}</p>}
                    {!!p?.conflicts.length && (
                        <p>
                            Conflicts in {p.conflicts.map(conflict => `${conflict.subject}: ${conflict.files.join(", ")}`).join("; ")}
                        </p>
                    )}
                    {busy && <p role="status" mix={mutedStyle}>{current.preview ? "Rebasing…" : "Reviewing…"}</p>}
                    {current.error && <p role="alert" mix={errorStyle}>{current.error}</p>}
                    <footer>
                        <button type="button" disabled={executing} mix={on("click", cancel)}>Cancel</button>
                        {!current.preview && current.error && (
                            <button type="button" disabled={busy} mix={on("click", () => void prepare())}>Review again</button>
                        )}
                        {p?.conflicts.length
                            ? (
                                <>
                                    <button type="button" disabled={busy} mix={on("click", () => void execute(false))}>Continue and resolve later</button>
                                    <button type="button" class="primary" disabled={busy} mix={on("click", () => void execute(true))}>
                                        Continue and resolve now
                                    </button>
                                </>
                            )
                            : (
                                <button
                                    type="button"
                                    class="primary"
                                    disabled={busy || !p || p.noop}
                                    mix={[
                                        ...(current.destinations.length == 1
                                            ? [ref((button: HTMLButtonElement) => button.focus())]
                                            : []),
                                        on("click", () => void execute(false)),
                                    ]}
                                >
                                    Rebase
                                </button>
                            )}
                    </footer>
                </dialog>
            )
        },
    }
}

const dialogStyle = css({
    width: "min(520px, calc(100vw - 32px))",
    maxHeight: "80vh",
    overflow: "auto",
    margin: "auto",
    padding: "18px",
    border: "1px solid var(--line-strong)",
    borderRadius: "6px",
    background: "var(--panel)",
    color: "var(--text)",
    boxShadow: "var(--shadow-dialog)",
    "&::backdrop": { background: "var(--scrim)" },
    "& h2": { margin: "0 0 12px", fontSize: "16px" },
    "& p": { margin: "6px 0", overflowWrap: "anywhere", fontSize: "13px", lineHeight: 1.5 },
    "& footer": { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" },
    "& footer button": {
        padding: "5px 9px",
        background: "var(--control)",
        color: "var(--text)",
        border: "1px solid var(--line-strong)",
        borderRadius: "4px",
        "&.primary": { color: "#fff", borderColor: "var(--focus)", background: "var(--focus)" },
        "&:disabled": { opacity: ".55" },
    },
})
const choiceStyle = css({
    margin: "0 0 10px",
    padding: "0",
    border: "0",
    display: "grid",
    gap: "6px",
    "& legend": { padding: "0 0 6px", fontSize: "12px", fontWeight: 600, color: "var(--muted)" },
    "& label": { display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "13px", cursor: "pointer" },
    "& label span": { display: "grid" },
    "& small": { color: "var(--muted)", fontSize: "12px" },
})
const commitsStyle = css({
    margin: "8px 0",
    "& ol": { margin: "4px 0", padding: "0 0 0 4px", listStyle: "none", display: "grid", gap: "2px", fontSize: "12px" },
    "& li": { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    "& code": { color: "var(--muted)", fontFamily: "var(--mono)" },
})
const checkboxStyle = css({ display: "flex", alignItems: "baseline", gap: "6px", margin: "8px 0", fontSize: "13px", overflowWrap: "anywhere" })
const warningStyle = css({ color: "var(--warning)", fontWeight: 600 })
const errorStyle = css({ color: "var(--danger)" })
const mutedStyle = css({ color: "var(--muted)" })
