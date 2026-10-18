// Drives the React composition views with real pointer drags in Electron; react-composition-electron.test.ts reads the result.
import "../../src/renderer/react/ui/theme.css"
import "../../src/renderer/react/ui/utilities.css"
import "../../src/renderer/react/theme.css"
import "../../src/renderer/react/page.css"
import "../../src/renderer/react/laneway.css"
import type { CompositionRequest, LocalRequest } from "@laneway/shared"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { createComposition, type TransferSelection } from "../../src/renderer/react/composition"
import type { Notice } from "../../src/renderer/react/notice"
import { createStore } from "../../src/renderer/react/store"
import { TransferGrip, TransferReview, TransferSeam, useTransferTarget } from "../../src/renderer/react/transfer"
import { useSnapshot } from "../../src/renderer/react/use-snapshot"

let requests: { request: LocalRequest; token?: string }[] = []
let conflict = false, published = false, immediate = false, resolved = false
let toast: Notice | undefined
let api = {
    async localOperation(_repository: string, request: LocalRequest, token?: string) {
        requests.push({ request: structuredClone(request), token })
        if (immediate) {
            return {
                ok: true as const,
                result: { type: "result" as const, command: "local" as const, status: "performed" as const, message: "Changes transferred." },
            }
        }
        return {
            ok: true as const,
            result: {
                type: "result" as const,
                command: token ? "local" as const : "local-preview" as const,
                status: "performed" as const,
                message: "Changes transferred.",
                preview: {
                    token: "verified",
                    affected: [],
                    uniqueCommits: false,
                    unborn: false,
                    suggestedBranch: "",
                    staged: false,
                    files: [],
                    stashes: [],
                    worktrees: [],
                    composition: {
                        branches: ["feature"],
                        removed: [],
                        published: published ? ["feature"] : [],
                        skipped: [],
                        noop: false,
                        conflicts: conflict ? [{ subject: "Commit", files: ["a.txt"] }] : [],
                    },
                },
            },
        }
    },
}
let composition = createComposition({
    api,
    mutating: () => {},
    changed: async () => {},
    notify(notice) {
        toast = notice
        return () => {
            if (toast == notice)
                toast = undefined
        }
    },
    resolve: () => {
        resolved = true
    },
})
// Read through a call so checks see what the controller notified since, not a narrowed value.
let shownToast = () => toast
let settings = createStore({ selected: false, wholeCommit: false, tip: "2".repeat(40) })

function Fixture() {
    let { selected, wholeCommit, tip } = useSnapshot(settings)
    let selection: TransferSelection = {
        repositoryId: "fixture",
        source: { kind: "commit", objectId: "1".repeat(40) },
        files: wholeCommit ? undefined : selected ? [{ path: "a.txt" }, { path: "b.txt" }] : [{ path: "a.txt" }],
        label: wholeCommit ? "Commit" : selected ? "2 files" : "a.txt",
    }
    let branchTarget = { kind: "branch" as const, branch: "feature", tip }
    let commitTarget = { kind: "commit" as const, branch: "feature", objectId: tip }
    let { target: branchRef, props: branchProps } = useTransferTarget<HTMLDivElement>(composition, {
        kind: "compose",
        repositoryId: "fixture",
        target: branchTarget,
    })
    let { target: commitRef, props: commitProps } = useTransferTarget<HTMLDivElement>(
        composition,
        { kind: "compose", repositoryId: "fixture", target: commitTarget },
        { above: { kind: "seam", branch: "feature", parentId: tip } },
    )
    return (
        <main style={{ width: 680, margin: "40px auto", display: "grid", gap: 12 }}>
            <div className="commit-row" id="source">
                <TransferGrip composition={composition} selection={selection} />Source change
            </div>
            <TransferSeam composition={composition} repositoryId="fixture" target={{ kind: "seam", branch: "feature", parentId: tip }} />
            <div ref={branchRef} {...branchProps} className="commit-row" id="branch">feature</div>
            <TransferReview composition={composition} repositoryId="fixture" target={branchTarget} />
            <div ref={commitRef} {...commitProps} className="commit-row" id="commit">Existing commit</div>
            <TransferReview composition={composition} repositoryId="fixture" target={commitTarget} />
        </main>
    )
}

let root = createRoot(document.getElementById("app")!)
flushSync(() => root.render(<Fixture />))

let change = async (update: Partial<ReturnType<typeof settings.snapshot>>) => {
    flushSync(() => settings.publish({ ...settings.snapshot(), ...update }))
    await flush()
}
let button = (text: string) => [...document.querySelectorAll("button")].find(element => element.textContent == text)!
let seamHeight = () => document.querySelector(".transfer-seam")!.getBoundingClientRect().height
let dropEdges = () => document.querySelector("[data-drop-edge]")

async function checks() {
    await flush()
    await drag("#commit", false, true)
    if (dropEdges() || document.querySelector(".transfer-review") || shownToast() || requests.length)
        throw new Error("Cancelled drag left transfer placeholders or state behind")
    await change({ selected: true, tip: "3".repeat(40) })
    await drag("#branch")
    if (requests.length)
        throw new Error("Files accepted by branch")
    if (dropEdges() || shownToast())
        throw new Error("Rejected drop left transfer placeholders behind")
    await drag("#commit", true)
    if (shownToast()?.code != "composition.transferred")
        throw new Error("Completed transfer was not announced as a toast")
    let copied = requests.at(-1)!
    let copiedRequest = copied.request as CompositionRequest
    if (
        copied.token != "verified" || copiedRequest.action != "compose" || copiedRequest.files?.length != 2 || copiedRequest.mode != "copy"
        || copiedRequest.target.kind != "commit" || copiedRequest.target.objectId != "3".repeat(40)
    ) {
        throw new Error("Stale drag source or target: " + JSON.stringify(requests))
    }
    requests.length = 0
    await drag("#commit", false, false, undefined, "top")
    if (requests.length || !document.querySelector("[aria-label='New commit message']"))
        throw new Error("Seam drop lost its message prompt")
    button("Cancel").click()
    await flush()
    // A whole commit brings its own message: the seam offers to move it and transfers on drop.
    await change({ wholeCommit: true })
    let seamLabel = ""
    await drag("#commit", false, true, () => seamLabel = document.querySelector(".transfer-seam")?.textContent ?? "", "top")
    if (seamLabel != "Move commit here")
        throw new Error(`Seam offered "${seamLabel}" to a whole commit`)
    await drag("#commit", false, false, undefined, "top")
    let moved = requests.at(-1)?.request as CompositionRequest | undefined
    if (
        requests.length != 2 || moved?.target.kind != "seam" || moved.files || moved.message || !requests.at(-1)!.token
        || document.querySelector("[aria-label='New commit message']") || shownToast()?.code != "composition.transferred"
    ) {
        throw new Error("Whole-commit seam drop did not transfer at once: " + JSON.stringify(requests))
    }
    await change({ wholeCommit: false })
    requests.length = 0
    // Rewriting published history waits for confirmation behind a warning instead of transferring at once.
    published = true
    await drag("#commit")
    let warning = document.querySelector(".transfer-review [role=alert]")?.textContent ?? ""
    if (requests.some(request => request.token) || !warning.includes("published on feature") || !warning.includes("force-with-lease"))
        throw new Error("Published history rewrite did not wait behind a warning: " + warning)
    button("Transfer").click()
    await flush()
    if (!requests.at(-1)?.token || shownToast()?.code != "composition.transferred")
        throw new Error("Confirmed published rewrite did not transfer")
    published = false
    requests.length = 0
    conflict = true
    await drag("#commit")
    if (requests.some(request => request.token))
        throw new Error("Conflict applied without approval")
    button("Continue and resolve now").click()
    await flush()
    if (!resolved || !(requests.at(-1)?.request as CompositionRequest).allowConflicts)
        throw new Error("Resolve-now not honored")
    conflict = false
    requests.length = 0
    document.querySelector("#source button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))
    await flush()
    let target = document.querySelector<HTMLElement>("#commit")!
    target.focus()
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush()
    if ((requests.at(-1)?.request as CompositionRequest | undefined)?.mode != "copy")
        throw new Error("Keyboard copy failed: " + JSON.stringify(requests))
    requests.length = 0
    immediate = true
    await drag("#commit")
    if (requests.length != 1 || requests[0]?.token || shownToast()?.code != "composition.transferred" || document.querySelector(".transfer-review"))
        throw new Error("Immediate transfer did not finish with one request")
    return {
        cancellation: true,
        dragBindingsRefresh: true,
        branchRejectsFiles: true,
        inlineMessage: true,
        positionalDrop: true,
        wholeCommitSeam: true,
        publishedWarning: true,
        conflictPrompt: true,
        keyboardCopy: true,
        immediateTransfer: true,
    }
}

// The pointer's place within the destination decides between landing on it and inserting at its top edge.
async function drag(target: string, copy = false, cancel = false, during?: () => void, position: "top" | "middle" = "middle") {
    let source = document.querySelector("#source")!, destination = document.querySelector(target)!
    let rect = destination.getBoundingClientRect()
    let clientX = rect.left + rect.width / 2, clientY = position == "top" ? rect.top + 1 : rect.top + rect.height / 2
    let dataTransfer = new DataTransfer()
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, clientX, clientY }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    destination.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, clientX, clientY }))
    destination.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, clientX, clientY }))
    if (cancel) {
        await flush()
        if (seamHeight() != 0)
            throw new Error("Starting a drag expanded a seam")
        let edge = (destination as HTMLElement).dataset.dropEdge
        if (edge != (position == "top" ? "above" : "on"))
            throw new Error(`Cancellation test did not start a drag over a valid target (${edge})`)
        during?.()
    } else {
        destination.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, clientX, clientY }))
    }
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }))
    await flush()
}

async function flush() {
    await new Promise(resolve => setTimeout(resolve, 30))
    flushSync(() => {})
    await new Promise(resolve => setTimeout(resolve, 30))
}

Object.assign(window, { compositionChecks: checks, compositionRequests: requests })
