// Mounts a virtualized file list that scrolls with a column, with content below it as the branch's commits sit below
// Working Changes; react-file-tree-electron.test.ts reads the result.
import "../../src/renderer/react/ui/theme.css"
import "../../src/renderer/react/ui/utilities.css"
import "../../src/renderer/react/theme.css"
import "../../src/renderer/react/page.css"
import "../../src/renderer/react/laneway.css"
import type { ChangedFile } from "@laneway/shared"
import { createRoot } from "react-dom/client"
import { type FileInspection, FileRowsLayout, FileTree } from "../../src/renderer/react/file-tree"

let files: ChangedFile[] = Array.from({ length: 40 }, (_, index) => ({
    path: `src/file-${String(index).padStart(2, "0")}.txt`,
    status: "modified" as const,
    staged: false,
    unstaged: true,
    untracked: false,
    ignored: false,
    conflicted: false,
}))
let path = (index: number) => files[index]!.path
// Rows open above the view, each with a tall diff, as pictures that have decoded.
let open = new Set([path(2), path(4), path(6), path(8)])
let tall = new Set(open)
let layout = new FileRowsLayout()
let root = createRoot(document.getElementById("app")!)
// What the browser reports to the window, such as a ResizeObserver loop that couldn't settle.
let errors: string[] = []
window.addEventListener("error", event => errors.push(event.message))
Object.assign(window, { mountFileTree: mount, fileTreeChecks: checks })

function render() {
    let inspect: FileInspection = {
        press: file => {
            if (!open.delete(file.path))
                open.add(file.path)
            render()
        },
        inline: {
            isOpen: file => open.has(file.path),
            close: hidden => {
                for (let file of hidden)
                    open.delete(file.path)
                render()
            },
            controls: () => null,
            diff: file => <div className="fixture-diff" style={{ height: tall.has(file.path) ? 600 : 40 }}>Diff for {file.path}</div>,
        },
    }
    root.render(
        <div className="fixture-column" style={{ height: "100vh", overflow: "auto", padding: "0 8px" }}>
            <FileTree
                label="Working Changes"
                files={files}
                view={{ layout: "flat", grouping: "none" }}
                group="working"
                selected={[]}
                inspect={inspect}
                layout={layout}
            />
            <div className="fixture-below" style={{ height: 3000 }}>Commits</div>
        </div>,
    )
}

async function mount() {
    render()
    await settled()
}

let column = () => document.querySelector<HTMLElement>(".fixture-column")!
let row = (index: number) => [...document.querySelectorAll<HTMLElement>(".file-row[data-row-key]")].find(candidate => candidate.dataset.rowKey == path(index))
let rows = () => document.querySelectorAll(".file-row[data-row-key]").length

// Where the view is: the column's scroll position, the rows drawn, and where the chosen row, the row after it, and the
// content below the list sit on screen.
function place(index: number) {
    let chosen = row(index)
    return {
        scrollTop: Math.round(column().scrollTop),
        drawn: rows(),
        rowTop: chosen && Math.round(chosen.getBoundingClientRect().top),
        rowBottom: chosen && Math.round(chosen.getBoundingClientRect().bottom),
        nextTop: row(index + 1) && Math.round(row(index + 1)!.getBoundingClientRect().top),
        belowTop: Math.round(document.querySelector(".fixture-below")!.getBoundingClientRect().top),
    }
}

// Scrolls the list's last rows to the top of the view, with the content below the list under them, then opens one of
// them, and then grows its diff as a picture does once it decodes. Neither should move what's in view: the rows below
// the diff follow it, and the view keeps its place.
async function checks() {
    let chosen = 36
    // Scrolled down as a user would, so each open row above draws and measures itself on the way.
    for (let step = 0; !row(30); step++) {
        if (step > 40)
            throw new Error(`Row 30 never drew: ${rows()} rows drawn at ${column().scrollTop}px`)
        column().scrollTop += 300
        await settled(3)
    }
    column().scrollTop += row(30)!.getBoundingClientRect().top - column().getBoundingClientRect().top
    await settled()
    let before = place(chosen)
    row(chosen)!.click()
    await settled()
    let opened = place(chosen)
    tall.add(path(chosen))
    render()
    await settled()
    let grown = place(chosen)
    // Narrowing the column, as maximizing or restoring one does, changes every row's width, so the list measures them all again.
    column().style.width = "600px"
    await settled()
    column().style.width = ""
    await settled()
    return { before, opened, grown, errors }
}

async function settled(rounds = 10) {
    for (let round = 0; round < rounds; round++)
        await new Promise(resolve => setTimeout(resolve, 30))
}
