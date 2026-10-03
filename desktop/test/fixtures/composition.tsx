import type { CompositionRequest, LocalRequest } from "@laneway/shared"
import { createRoot, css, type Handle, on } from "remix/ui"
import { compositionStyles, createComposition } from "../../src/renderer/src/composition"
import type { NoticeState } from "../../src/renderer/src/feedback"

const requests: Array<{ request: LocalRequest; token?: string }> = []
let conflict = false, published = false, immediate = false
const api = {
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
} satisfies Pick<Window["laneway"], "localOperation">
let resolved = false
let toast: NoticeState | undefined
// Read through a call so checks see updates made by the controller, not a narrowed snapshot.
const shownToast = () => toast
function Fixture(handle: Handle) {
    let selected = false, wholeCommit = false, tip = "2".repeat(40)
    const controller = createComposition({
        api,
        update: () => handle.update(),
        signal: handle.signal,
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
    return () => (
        <main
            mix={[
                compositionStyles,
                css({
                    width: "680px",
                    margin: "40px auto",
                    display: "grid",
                    gap: "12px",
                    "& .row": { border: "1px solid var(--border)", padding: "12px", display: "flex", gap: "8px" },
                }),
            ]}
        >
            <h2>Commit composition</h2>
            <p>Drag the grip to a commit or seam. Ctrl-drag copies. Files cannot target branches.</p>
            <label>
                <input
                    id="select-more"
                    type="checkbox"
                    checked={selected}
                    mix={on("change", e => {
                        selected = e.currentTarget.checked
                        handle.update()
                    })}
                />{" "}
                Select two files
            </label>
            <label>
                <input
                    id="whole-commit"
                    type="checkbox"
                    checked={wholeCommit}
                    mix={on("change", e => {
                        wholeCommit = e.currentTarget.checked
                        handle.update()
                    })}
                />{" "}
                Transfer whole commit
            </label>
            <div class="row" id="source">
                {controller.source({
                    repositoryId: "fixture",
                    source: { kind: "commit", objectId: "1".repeat(40) },
                    files: wholeCommit ? undefined : selected ? [{ path: "a.txt" }, { path: "b.txt" }] : [{ path: "a.txt" }],
                    label: wholeCommit ? "Commit" : selected ? "2 files" : "a.txt",
                })}Source change
            </div>
            {controller.seam("fixture", { kind: "seam", branch: "feature", parentId: tip })}
            <div class="row" id="branch" mix={controller.target("fixture", { kind: "branch", branch: "feature", tip })}>feature</div>
            {controller.panel("fixture", { kind: "branch", branch: "feature", tip })}
            <div
                class="row"
                id="commit"
                mix={controller.target("fixture", { kind: "commit", branch: "feature", objectId: tip }, {
                    above: { kind: "seam", branch: "feature", parentId: tip },
                })}
            >
                Existing commit
            </div>
            {controller.panel("fixture", { kind: "commit", branch: "feature", objectId: tip })}
            <button
                id="refresh-tip"
                mix={on("click", () => {
                    tip = "3".repeat(40)
                    handle.update()
                })}
            >
                Refresh branch tip
            </button>
        </main>
    )
}
const root = createRoot(document.getElementById("app")!)
root.render(<Fixture />)
async function flush() {
    await root.flush()
    await new Promise(resolve => setTimeout(resolve, 30))
    await root.flush()
}
const click = async (selector: string) => {
    document.querySelector<HTMLElement>(selector)!.click()
    await flush()
}
const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent == text)!
const seamHeight = () => document.querySelector(".composition-seam")!.getBoundingClientRect().height
// Pointer position within the destination decides between landing on it and inserting at its top edge.
async function drag(target: string, copy = false, cancel = false, during?: () => void, position: "top" | "middle" = "middle") {
    const source = document.querySelector("#source button")!, destination = document.querySelector(target)!
    const rect = destination.getBoundingClientRect()
    const clientX = rect.left + rect.width / 2, clientY = position == "top" ? rect.top + 1 : rect.top + rect.height / 2
    const dataTransfer = new DataTransfer()
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, clientX, clientY }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    destination.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, clientX, clientY }))
    destination.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, clientX, clientY }))
    if (cancel) {
        await flush()
        if (seamHeight() != 0)
            throw new Error("Starting a drag expanded a seam")
        if (!destination.classList.contains(position == "top" ? "composition-over-above" : "composition-over"))
            throw new Error("Cancellation test did not start a drag over a valid target")
        during?.()
    } else {
        destination.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, clientX, clientY }))
    }
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }))
    await flush()
}
async function checks() {
    await flush()
    await drag("#commit", false, true)
    if (document.querySelector(".composition-over, .composition-over-above, .composition-review") || shownToast() || requests.length)
        throw new Error("Cancelled drag left transfer placeholders or state behind")
    await click("#select-more")
    await click("#refresh-tip")
    await drag("#branch")
    if (requests.length)
        throw new Error("Files accepted by branch")
    if (document.querySelector(".composition-over, .composition-over-above") || shownToast())
        throw new Error("Rejected drop left transfer placeholders behind")
    await drag("#commit", true)
    if (shownToast()?.code != "composition.transferred")
        throw new Error("Completed transfer was not announced as a toast")
    const copied = requests.at(-1)!
    if (
        copied.token != "verified" || copied.request.action != "compose" || copied.request.files?.length != 2 || copied.request.mode != "copy"
        || copied.request.target.kind != "commit" || copied.request.target.objectId != "3".repeat(40)
    ) {
        throw new Error("Stale Pragmatic drag source or target: " + JSON.stringify(requests))
    }
    requests.length = 0
    await drag("#commit", false, false, undefined, "top")
    const seamDrop = requests.at(-1)
    if (seamDrop || !document.querySelector("[aria-label='New commit message']"))
        throw new Error("Successful seam drop lost its message prompt")
    button("Cancel").click()
    await flush()
    await click("#source button")
    await click(".composition-seam")
    if (requests.length || !document.querySelector("[aria-label='New commit message']"))
        throw new Error("Seam mutated before message")
    button("Cancel").click()
    await flush()
    // A whole commit brings its own message: the seam offers to move it and transfers on drop.
    await click("#whole-commit")
    let seamLabel = ""
    await drag("#commit", false, true, () => seamLabel = document.querySelector(".composition-seam")?.textContent ?? "", "top")
    if (seamLabel != "Move commit here")
        throw new Error(`Seam offered "${seamLabel}" to a whole commit`)
    await drag("#commit", false, false, undefined, "top")
    const moved = requests.at(-1)?.request as CompositionRequest | undefined
    if (
        requests.length != 2 || moved?.target.kind != "seam" || moved.files || moved.message || !requests.at(-1)!.token
        || document.querySelector("[aria-label='New commit message']") || shownToast()?.code != "composition.transferred"
    ) {
        throw new Error("Whole-commit seam drop did not transfer immediately: " + JSON.stringify(requests))
    }
    await click("#whole-commit")
    requests.length = 0
    // Rewriting published history waits for confirmation behind a warning instead of transferring at once.
    published = true
    await drag("#commit")
    const warning = document.querySelector(".composition-review [role=alert]")?.textContent ?? ""
    if (requests.some(r => r.token) || !warning.includes("published on feature") || !warning.includes("force-with-lease"))
        throw new Error("Published history rewrite did not wait behind a warning: " + warning)
    button("Transfer").click()
    await flush()
    if (!requests.at(-1)?.token || shownToast()?.code != "composition.transferred")
        throw new Error("Confirmed published rewrite did not transfer")
    published = false
    requests.length = 0
    conflict = true
    await drag("#commit")
    if (requests.some(r => r.token))
        throw new Error("Conflict applied without approval")
    button("Continue and resolve now").click()
    await flush()
    if (!resolved || !(requests.at(-1)?.request as CompositionRequest).allowConflicts)
        throw new Error("Resolve-now not honored")
    conflict = false
    requests.length = 0
    document.querySelector("#source button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))
    const target = document.querySelector<HTMLElement>("#commit")!
    target.focus()
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await flush()
    if ((requests.at(-1)?.request as CompositionRequest).mode != "copy")
        throw new Error("Keyboard copy failed")
    requests.length = 0
    immediate = true
    await drag("#commit")
    if (requests.length != 1 || requests[0]?.token || shownToast()?.code != "composition.transferred" || document.querySelector(".composition-review"))
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
Object.assign(window, { compositionChecks: checks, compositionRequests: requests })
