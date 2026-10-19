import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps, type } from "./react-dom"
import { inspectionScenario } from "./renderer-fixtures"

let browserWindow: HappyWindow

beforeAll(() => {
    browserWindow = installReactDom()
})

afterEach(stopReactApps)

afterAll(() => browserWindow.close())

describe("React column navigation", () => {
    test("the file filter opens on demand, narrows and marks every list, and clears with Escape", async () => {
        let app = await startReactApp(inspectionScenario().api)
        let search = button(column(), "Filter files")
        expect(column().querySelector(".column-filter") == null).toBe(true)

        await app.act(() => press(search))
        await app.act(frame)
        let input = () => column().querySelector<HTMLInputElement>("[aria-label='Filter changed files']")!
        expect(focused(input())).toBe(true)
        await app.act(() => type(input(), "SRC/FI"))
        // A name leads its folder, so a match across them marks the name's part first.
        expect(marks(".working-changes")).toBe("fisrcfisrc")
        await app.act(() => press(button(trail(), "Inspect changes")))
        expect(marks(".commit-files")).toBe("fisrc")

        await app.act(() => type(input(), "no-matching-file"))
        expect(column().querySelector(".working-changes .file-row") == null).toBe(true)
        expect(column().querySelector(".commit-files")?.textContent).toContain("No files match the filter")
        // Asking again returns to the open filter, keeping its text.
        await app.act(() => press(search))
        expect(focused(input())).toBe(true)
        expect(input().value).toBe("no-matching-file")

        await app.act(() => key(input(), "Escape"))
        expect(column().querySelector(".column-filter") == null).toBe(true)
        expect(column().querySelector(".working-changes .file-row")).not.toBeNull()
        expect(column().querySelectorAll("mark")).toHaveLength(0)
        expect(focused(search)).toBe(true)
        await app.act(() => column().dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true })))
        await app.act(frame)
        expect(input().value).toBe("")
        expect(focused(input())).toBe(true)
    })

    test("a filter closes the diffs of the files it hides", async () => {
        let app = await startReactApp(inspectionScenario().api)
        let row = column().querySelector<HTMLElement>("[data-group='working-staged'] .file-row")!
        await app.act(() => press(row.querySelector<HTMLElement>(".file-path")!))
        expect(column().querySelectorAll(".diff-panel")).toHaveLength(1)

        await app.act(() => press(button(column(), "Filter files")))
        await app.act(() => type(column().querySelector<HTMLInputElement>("[aria-label='Filter changed files']")!, "other"))
        await app.act(() => press(button(column(), "Close file filter")))
        expect(column().querySelectorAll(".diff-panel")).toHaveLength(0)
    })

    test("arrow keys move between commits and files, unfold and fold them, and drive the diff column", async () => {
        let app = await startReactApp(inspectionScenario().api)
        let commit = trail().querySelector<HTMLElement>(".commit-toggle")!
        let commitFile = (path: string) => [...column().querySelectorAll<HTMLElement>(".commit-files .file-row")].find(row => row.textContent?.includes(path))!

        // Right unfolds a commit, and Down then reaches its first file.
        await app.act(() => commit.focus())
        await app.act(() => key(commit, "ArrowRight"))
        expect(commit.getAttribute("aria-expanded")).toBe("true")
        await app.act(() => key(commit, "ArrowDown"))
        let first = commitFile("file.txt")
        expect(focused(first)).toBe(true)

        // Right opens a file's diff beneath it, Left closes it, and Left again returns to the commit.
        await app.act(() => key(first, "ArrowRight"))
        expect(first.querySelector(".diff-panel")).not.toBeNull()
        await app.act(() => key(first, "ArrowLeft"))
        expect(first.querySelector(".diff-panel") == null).toBe(true)
        expect(focused(first)).toBe(true)
        await app.act(() => key(first, "ArrowLeft"))
        expect(focused(commit)).toBe(true)

        // Up from the commit reaches the last Working Changes row.
        await app.act(() => key(commit, "ArrowUp"))
        expect(focused([...column().querySelectorAll(".working-changes .file-row")].at(-1))).toBe(true)
        // Down past the last file reaches the base branch's heading, where the sequence ends.
        let last = commitFile("other.txt")
        await app.act(() => last.focus())
        await app.act(() => key(last, "ArrowDown"))
        let base = trail().querySelector<HTMLElement>(".stack-toggle")!
        expect(focused(base)).toBe(true)
        await app.act(() => key(base, "ArrowDown"))
        expect(focused(base)).toBe(true)

        // Left folds the commit, taking its files out of the sequence.
        await app.act(() => commit.focus())
        await app.act(() => key(commit, "ArrowLeft"))
        expect(commit.getAttribute("aria-expanded")).toBe("false")
        await app.act(() => key(commit, "ArrowDown"))
        expect(focused(base)).toBe(true)

        // With the diff column open, Up and Down show the files they move onto there, keeping focus in the column.
        await app.act(() => key(commit, "ArrowRight"))
        await app.act(() => press(button(trail(), "Show full diff for commit Inspect changes")))
        await app.act(() => commitFile("file.txt").focus())
        await app.act(() => key(commitFile("file.txt"), "ArrowDown"))
        expect(focused(commitFile("other.txt"))).toBe(true)
        expect(commitFile("other.txt").classList.contains("active")).toBe(true)
        await app.act(() => key(commitFile("other.txt"), "ArrowUp"))
        expect(focused(commitFile("file.txt"))).toBe(true)
        expect(commitFile("file.txt").classList.contains("active")).toBe(true)
        // Left on a file shown in the diff column returns to its commit rather than folding anything.
        await app.act(() => key(commitFile("file.txt"), "ArrowLeft"))
        expect(focused(commit)).toBe(true)
        expect(document.querySelector(".diff-column")).not.toBeNull()
    })
})

function column() {
    return document.querySelector<HTMLElement>(".column-row > .column")!
}

function trail() {
    return column().querySelector<HTMLElement>(".commit-trail")!
}

function marks(selector: string) {
    return [...column().querySelectorAll(`${selector} mark`)].map(mark => mark.textContent).join("")
}

function key(element: HTMLElement, name: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
}

// Elements compare as booleans; a failed comparison of two elements would serialize the whole document.
function focused(element: Element | null | undefined) {
    return element != undefined && document.activeElement == element
}

// Focus moves to a field that shows on the next frame.
function frame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
}
