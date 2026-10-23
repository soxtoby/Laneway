import "../../src/renderer/react/ui/theme.css"
import "../../src/renderer/react/ui/utilities.css"
import "../../src/renderer/react/theme.css"
import "../../src/renderer/react/page.css"
import "../../src/renderer/react/laneway.css"
import type { PullResult } from "@laneway/shared"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { PullDialog } from "../../src/renderer/react/pull-dialog"
import type { PullLatest, PullSnapshot } from "../../src/renderer/react/pull-latest"
import { createStore } from "../../src/renderer/react/store"

let branches = ["sox/pare-down-regression-reports", "backup/package-directory-before-pr69-feedback-20260928", "sox/package-directory", "sox/whats-in-the-box"]
let result: PullResult = {
    type: "result",
    command: "pull",
    status: "updated",
    message: "Pull complete: 1 need resolution, 2 updated.",
    fetches: [{ remote: "origin", status: "fetched" }],
    stacks: [{ id: "conflict", branches, status: "needs-resolution", message: "8 commit conflicts deferred for inline resolution." }, {
        id: "updated",
        branches: [branches[0]!, "sox/all-wrapped-up"],
        status: "updated",
    }, { id: "base", branches: [branches[0]!], status: "updated" }],
}
let store = createStore<PullSnapshot>({ running: {}, outcome: { repositoryId: "fixture", result } })
let pull: PullLatest = { ...store, start: async () => {}, cancel: async () => {}, close: () => {}, dispose: () => {} }
flushSync(() => createRoot(document.getElementById("app")!).render(<PullDialog pull={pull} onResolve={() => {}} />))

Object.assign(window, { pullDialogChecks: checks, manyPullStacks: manyStacks })

function manyStacks() {
    flushSync(() =>
        store.publish({
            running: {},
            outcome: {
                repositoryId: "fixture",
                result: {
                    ...result,
                    fetches: [{ remote: "origin", status: "failed", message: `Could not reach ${"long-remote-name".repeat(12)}.` }],
                    stacks: Array.from({ length: 12 }, (_, index) => ({
                        id: String(index),
                        branches: [...branches, `feature/${"long-branch-name".repeat(12)}-${index}`],
                        status: "failed",
                        message: "Fetch failed. Try again when the remote is available.",
                    })),
                },
            },
        })
    )
}

async function checks() {
    await new Promise(requestAnimationFrame)
    await Promise.all(document.getAnimations().map(animation => animation.finished))
    await new Promise(requestAnimationFrame)
    let dialog = document.querySelector<HTMLElement>(".pull-outcome")!
    let cards = [...dialog.querySelectorAll<HTMLElement>(".pull-stack")]
    let bounds = dialog.getBoundingClientRect()
    let contentWidth = dialog.querySelector<HTMLElement>(".pull-stacks")!.clientWidth
    let close = [...dialog.querySelectorAll("button")].find(button => button.textContent == "Close")!.getBoundingClientRect()
    let fits = [...dialog.querySelectorAll<HTMLElement>("*")].filter(element => element.getBoundingClientRect().width > 0)
        .every(element => element.scrollWidth <= element.clientWidth + 1)
    let separated = cards.every(card => {
        let badge = card.querySelector(".pull-status")!.getBoundingClientRect()
        let branch = card.querySelector("strong")!.getBoundingClientRect()
        return badge.right + 4 <= branch.left || branch.right + 4 <= badge.left || badge.bottom + 4 <= branch.top || branch.bottom + 4 <= badge.top
    })
    return {
        fullWidth: cards.every(card => Math.abs(card.getBoundingClientRect().width - contentWidth) <= 1),
        headerSeparated: separated,
        fits: fits && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
        closeVisible: close.top >= bounds.top && close.bottom <= bounds.bottom,
    }
}
