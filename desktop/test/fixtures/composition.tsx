import type { CompositionRequest, LocalRequest } from "@git-workbench/shared"
import { createRoot, css, type Handle, on } from "remix/ui"
import { compositionStyles, createComposition } from "../../src/renderer/src/composition"

const requests: Array<{ request: LocalRequest; token?: string }> = []
let conflict = false
const api = {
    async localOperation(_repository: string, request: LocalRequest, token?: string) {
        requests.push({ request: structuredClone(request), token })
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
                        published: [],
                        skipped: [],
                        noop: false,
                        conflicts: conflict ? [{ subject: "Commit", files: ["a.txt"] }] : [],
                    },
                },
            },
        }
    },
} satisfies Pick<Window["workbench"], "localOperation">
let resolved = false
function Fixture(handle: Handle) {
    let selected = false, wholeCommit = false, tip = "2".repeat(40)
    const controller = createComposition({
        api,
        update: () => handle.update(),
        signal: handle.signal,
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
            <div class="row" id="commit" mix={controller.target("fixture", { kind: "commit", branch: "feature", objectId: tip })}>Existing commit</div>
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
            {controller.status("fixture")}
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
async function drag(target: string, copy = false, cancel = false) {
    const source = document.querySelector("#source button")!, destination = document.querySelector(target)!
    const dataTransfer = new DataTransfer()
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy }))
    await new Promise(resolve => requestAnimationFrame(resolve))
    destination.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy }))
    destination.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy }))
    if (cancel) {
        await flush()
        if (!document.querySelector(".composition-seam.available") || !destination.classList.contains("composition-over"))
            throw new Error("Cancellation test did not start a drag over a valid target")
    } else {
        destination.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy }))
    }
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }))
    await flush()
}
async function checks() {
    await flush()
    await drag("#commit", false, true)
    if (document.querySelector(".composition-seam.available, .composition-over, .composition-review, .composition-status") || requests.length)
        throw new Error("Cancelled drag left transfer placeholders or state behind")
    await click("#select-more")
    await click("#refresh-tip")
    await drag("#branch")
    if (requests.length)
        throw new Error("Files accepted by branch")
    if (document.querySelector(".composition-seam.available, .composition-status"))
        throw new Error("Rejected drop left transfer placeholders behind")
    await drag("#commit", true)
    const copied = requests.at(-1)!
    if (
        copied.token != "verified" || copied.request.action != "compose" || copied.request.files?.length != 2 || copied.request.mode != "copy"
        || copied.request.target.kind != "commit" || copied.request.target.objectId != "3".repeat(40)
    ) {
        throw new Error("Stale Pragmatic drag source or target: " + JSON.stringify(requests))
    }
    requests.length = 0
    await drag(".composition-seam")
    if (requests.length || !document.querySelector("[aria-label='New commit message']"))
        throw new Error("Successful seam drop lost its message prompt")
    button("Cancel").click()
    await flush()
    await click("#source button")
    await click(".composition-seam")
    if (requests.length || !document.querySelector("[aria-label='New commit message']"))
        throw new Error("Seam mutated before message")
    button("Cancel").click()
    await flush()
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
    return { cancellation: true, dragBindingsRefresh: true, branchRejectsFiles: true, inlineMessage: true, conflictPrompt: true, keyboardCopy: true }
}
Object.assign(window, { compositionChecks: checks, compositionRequests: requests })
