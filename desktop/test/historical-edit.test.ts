import type { HistoricalEditActionResult, HistoricalEditRequest } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import { applySelection, createHistoricalEdits } from "../src/renderer/react/historical-edit"
import type { ColumnInspection } from "../src/renderer/react/inspection"
import type { Notice } from "../src/renderer/react/notice"

let path = "D:\\Source\\app"
let choice = { repositoryId: "repo", path, branch: "feature", count: 2 }

describe("Historical Edits", () => {
    test("a return with Historical Working Changes left waits for a choice, and the chosen return offers Undo", async () => {
        let { sut, requests, undoOffers } = edits({ message: "Dropped and returned to feature.", recorded: true })

        await sut.return(choice)
        expect(requests).toEqual([])
        expect(sut.snapshot().choosing).toEqual(choice)

        await sut.choose("drop")

        expect(requests).toEqual([{ action: "return", path, mode: "drop" }])
        expect(sut.snapshot().choosing == undefined).toBe(true)
        expect(undoOffers).toEqual(["Dropped and returned to feature."])
    })

    test("a clean return goes at once and reports it without Undo", async () => {
        let { sut, requests, notices, undoOffers } = edits({ message: "Returned to feature.", recorded: false })

        await sut.return({ ...choice, count: 0 })

        expect(requests).toEqual([{ action: "return", path, mode: "clean" }])
        expect(notices.map(notice => notice.message)).toEqual(["Returned to feature."])
        expect(undoOffers).toEqual([])
    })

    test("a chosen return that fails keeps the choice open with its error", async () => {
        let { sut } = edits({ failure: "feature is checked out in D:\\Source\\other." })
        await sut.return(choice)

        await sut.choose("bring")

        expect(sut.snapshot()).toMatchObject({ choosing: choice, error: "feature is checked out in D:\\Source\\other.", busy: false })
    })
})

describe("applySelection", () => {
    test("takes the lines chosen in a diff before chosen files, and every change when nothing is chosen", () => {
        let lines = inspected({
            selected: ["working-unstaged:a.txt"],
            diffs: {
                line: {
                    group: "working-unstaged",
                    path: "b.txt",
                    view: "unstaged",
                    page: { version: "v2", entireFile: false },
                    selection: { lineIds: [3, 4] },
                },
            },
        })
        let files = inspected({
            selected: ["working-unstaged:a.txt", "working-unstaged:c.txt"],
            files: { "working-unstaged": { inventory: { version: "v1" } } },
        })

        expect(applySelection("repo", path, lines)).toMatchObject({
            files: [{ path: "b.txt", version: "v2", entireFile: false, lineIds: [3, 4] }],
            view: "unstaged",
        })
        expect(applySelection("repo", path, files)).toMatchObject({
            files: [{ path: "a.txt" }, { path: "c.txt" }],
            inventoryVersion: "v1",
            view: "unstaged",
        })
        expect(applySelection("repo", path, inspected({})).files == undefined).toBe(true)
    })
})

function edits(outcome: { message?: string; recorded?: boolean; failure?: string }) {
    let requests: HistoricalEditRequest[] = []
    let notices: Notice[] = []
    let undoOffers: string[] = []
    let sut = createHistoricalEdits({
        api: {
            historicalEdit: async (_repositoryId, request): Promise<HistoricalEditActionResult> => {
                requests.push(request)
                if (outcome.failure)
                    return { ok: false, error: { message: outcome.failure } }
                let operation = outcome.recorded
                    ? { id: "operation", timestamp: "2026-10-22T00:00:00.000Z", kind: "edit.drop", summary: "Drop", affectedRefs: [], affectedWorktrees: [] }
                    : undefined
                return { ok: true, result: { type: "result", command: "edit", message: outcome.message ?? "", sessions: [], operation } }
            },
        },
        notify: notice => notices.push(notice),
        mutating: () => {},
        changed: async () => {},
        offerUndo: (_repositoryId, message) => undoOffers.push(message),
    })
    return { sut, requests, notices, undoOffers }
}

function inspected(change: object) {
    return { selected: [], files: {}, diffs: {}, ...change } as unknown as ColumnInspection
}
