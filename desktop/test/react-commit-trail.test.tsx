import type { BranchHistoryCommit, LocalActionResult, LocalRequest } from "@laneway/shared"
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

describe("React Commit Trail", () => {
    test("marks commits and branches their remote already has as remote", async () => {
        let scenario = inspectionScenario()
        let branch = scenario.graph.branches[1]!
        let local = "4".repeat(40)
        branch.upstreamRef = "refs/remotes/origin/feature/laneway"
        branch.remoteRefs = [branch.upstreamRef]
        branch.upstreamTip = branch.tip
        branch.tip = local
        branch.ahead = 1
        branch.checkedOut[0]!.head = local
        // A remote branch reaches main's tip, so its card is remote even though it is a local branch.
        scenario.graph.branches[0]!.published = true
        scenario.graph.remoteTips = [branch.upstreamTip, "5".repeat(40)]
        let requests: Parameters<Window["laneway"]["readBranchHistory"]>[1][] = []
        let app = await startReactApp({
            ...scenario.api,
            readBranchHistory: async (_repositoryId, request) => {
                requests.push(request)
                let commits = [commit(local, "Unpublished", [branch.upstreamTip!]), { ...commit(branch.upstreamTip!, "Published"), remote: true }]
                return { ok: true, page: { branchRef: request.branchRef, tip: request.tip, baseTips: request.baseTips, commits } }
            },
        })
        await app.act(() => press(button(trail(), "main")))

        expect(requests[0]).toMatchObject({ tip: local, remoteTips: scenario.graph.remoteTips })
        expect(commitRows().slice(0, 2).map(row => [row.querySelector(".commit-subject")?.textContent, row.hasAttribute("data-remote")])).toEqual([[
            "Unpublished",
            false,
        ], ["Published", true]])
        expect([...trail().querySelectorAll(".stack-branch")].map(card => card.classList.contains("remote"))).toEqual([false, true])
    })

    test("marks commits by other authors with their initials, name, and email, but not the developer's own", async () => {
        let scenario = inspectionScenario()
        scenario.graph.authorIdentities = { primary: "developer@example.test", secondary: ["dev@home.test"] }
        await startReactApp({
            ...scenario.api,
            readBranchHistory: async (_repositoryId, request) => {
                let commits = [{ ...commit("4".repeat(40), "Mine"), authorName: "Developer", authorEmail: "Dev@Home.test" }, {
                    ...commit("5".repeat(40), "Theirs"),
                    authorName: "Alex Rivera",
                    authorEmail: "alex@example.test",
                }]
                return { ok: true, page: { branchRef: request.branchRef, tip: request.tip, baseTips: request.baseTips, commits } }
            },
        })

        expect(
            commitRows().map(row => {
                let author = row.querySelector("[role=img][aria-label^='Authored by']")
                return [row.querySelector(".commit-subject")?.textContent, author?.textContent, author?.getAttribute("aria-description")]
            }),
        ).toEqual([["Mine", undefined, undefined], ["Theirs", "AR", "Alex Rivera <alex@example.test>"]])
    })

    test("a commit unfolds to its message and files, and a merge compares the parent chosen", async () => {
        let scenario = inspectionScenario()
        let second = "6".repeat(40)
        let sources: unknown[] = []
        let app = await startReactApp({
            ...scenario.api,
            readBranchHistory: async (_repositoryId, request) => ({
                ok: true,
                page: {
                    branchRef: request.branchRef,
                    tip: request.tip,
                    baseTips: request.baseTips,
                    commits: [{ ...commit(scenario.graph.branches[1]!.tip, "Merge work", [scenario.graph.branches[0]!.tip, second]), body: "Why it merged." }],
                },
            }),
            readChanges: (...args) => {
                sources.push(args[2].source)
                return scenario.api.readChanges(...args)
            },
        })
        let toggle = button(trail(), "Merge work")
        expect(trail().querySelector("[aria-label='Has message body']")).not.toBeNull()

        await app.act(() => press(toggle))
        expect(toggle.getAttribute("aria-expanded")).toBe("true")
        expect(trail().querySelector(".commit-message-body")?.textContent).toBe("Why it merged.")
        expect([...trail().querySelectorAll("[role=treegrid][aria-label='Files in commit Merge work'] .file-row")].map(row => row.getAttribute("aria-label")))
            .toContain("src/file.txt")
        await app.act(() => press(trail().querySelector<HTMLElement>(".trail-choice button")!))
        await app.act(() => press(option(`Parent 2 · ${second.slice(0, 8)}`)))
        expect(sources.at(-1)).toEqual({ kind: "commit", objectId: scenario.graph.branches[1]!.tip, parentId: second })

        await app.act(() => press(toggle))
        expect(trail().querySelector(".commit-files") == null).toBe(true)
    })

    test("an ambiguous branch's history continues into the base chosen after its last page", async () => {
        let scenario = inspectionScenario()
        let branch = scenario.graph.branches[1]!
        let candidates = [scenario.graph.branches[0]!, scenario.graph.branches[2]!]
        branch.base = {
            status: "ambiguous",
            candidates: candidates.map(candidate => ({ branchId: candidate.id, name: candidate.name, ref: candidate.preferredRef, tip: candidate.tip })),
        }
        let requests: Parameters<Window["laneway"]["readBranchHistory"]>[1][] = []
        let app = await startReactApp({
            ...scenario.api,
            readBranchHistory: async (_repositoryId, request) => {
                requests.push(request)
                let first = !request.offset && request.branchRef == branch.preferredRef
                return {
                    ok: true,
                    page: {
                        branchRef: request.branchRef,
                        tip: request.tip,
                        baseTips: request.baseTips,
                        commits: first ? [commit(branch.tip, "Inspect changes")] : [],
                        ...first ? { nextOffset: 1 } : {},
                    },
                }
            },
        })
        expect(requests[0]).toMatchObject({ limit: 50, baseTips: candidates.map(candidate => candidate.tip) })
        expect(trail().querySelector(".trail-choice") == null).toBe(true)

        await app.act(() => press(button(trail(), "Load more")))
        expect(requests[1]).toMatchObject({ offset: 1 })
        await app.act(() => press(trail().querySelector<HTMLElement>(".trail-choice button")!))
        expect([...document.querySelectorAll("[role=listbox] [role=option]")].map(item => item.textContent)).toEqual(["None", "main", "other/team"])
        await app.act(() => press(option("other/team")))
        expect(stackNames()).toEqual(["feature/laneway", "other/team", "main"])

        await app.act(() => press(trail().querySelector<HTMLElement>(".trail-choice button")!))
        await app.act(() => press(option("None")))
        expect(stackNames()).toEqual(["feature/laneway"])
    })

    test("Create branch here names the branch in a dialog, creates it at the commit, and opens its column", async () => {
        let scenario = inspectionScenario()
        let requests: LocalRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            localOperation: async (id, request, token) => {
                if (!token)
                    return scenario.api.localOperation(id, request)
                requests.push(request)
                if (request.action == "branch-create") {
                    scenario.graph.branches.push({
                        ...structuredClone(scenario.graph.branches[2]!),
                        id: "branch:refs/heads/alias",
                        name: "alias",
                        preferredRef: "refs/heads/alias",
                        localRefs: ["refs/heads/alias"],
                    })
                }
                return performed()
            },
        })
        await app.act(() => press(button(commitRows()[0]!, "Actions for commit Inspect changes")))
        await app.act(() => press(menuItem("Create branch here…")))
        let dialog = document.querySelector<HTMLElement>("[role=dialog]")!
        expect(dialog.querySelector("h2")?.textContent).toBe("Create branch")
        expect(button(dialog, "Create branch").hasAttribute("disabled")).toBe(true)

        await app.act(() => type(dialog.querySelector<HTMLInputElement>("input")!, "alias"))
        await app.act(() => press(button(dialog, "Create branch")))

        expect(requests).toEqual([{ action: "branch-create", name: "alias", commit: scenario.graph.branches[1]!.tip }])
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        expect(document.querySelector("[data-column-id='branch:refs/heads/alias']")).not.toBeNull()
    })

    test("rewords a commit from its menu, and confirms published rewrites first", async () => {
        let scenario = inspectionScenario()
        let branch = scenario.graph.branches[1]!
        let rewords: { request: LocalRequest; token?: string }[] = []
        let graphReads = 0
        let published: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            readBranchGraph: async (...args) => {
                graphReads++
                return scenario.api.readBranchGraph(...args)
            },
            localOperation: async (id, request, token) => {
                if (request.action != "reword")
                    return scenario.api.localOperation(id, request, token)
                rewords.push({ request, token })
                if (token || !published.length)
                    return { ok: true, result: { type: "result", command: "local", status: "performed", message: "Commit reworded." } }
                let preview = (await scenario.api.localOperation(id, request)) as Extract<LocalActionResult, { ok: true }>
                let composition = { branches: ["feature/laneway"], removed: [], conflicts: [], published, skipped: [], noop: false }
                return { ok: true, result: { ...preview.result, preview: { ...preview.result.preview!, token: "reword", composition } } }
            },
        })
        let openForm = async () => {
            await app.act(() => press(button(commitRows()[0]!, "Actions for commit Inspect changes")))
            await app.act(() => press(menuItem("Reword commit…")))
            return trail().querySelector<HTMLElement>("[aria-label='Reword commit Inspect changes']")!
        }

        let form = await openForm()
        let title = form.querySelector<HTMLInputElement>("[aria-label='Commit title']")!
        expect(title.value).toBe("Inspect changes")
        expect(form.querySelector<HTMLTextAreaElement>("[aria-label='Commit message']")!.value).toBe("Inspect every change.")
        expect(button(form, "Apply").hasAttribute("disabled")).toBe(true)
        await app.act(() => type(title, "Inspect all changes"))
        let reads = graphReads
        await app.act(() => press(button(form, "Apply")))

        expect(rewords).toEqual([{
            request: {
                action: "reword",
                objectId: branch.tip,
                branch: "refs/heads/feature/laneway",
                title: "Inspect all changes",
                message: "Inspect every change.",
                selectedRemote: "origin",
            },
            token: undefined,
        }])
        expect(trail().querySelector("[aria-label='Reword commit Inspect changes']") == null).toBe(true)
        expect(graphReads).toBeGreaterThan(reads)
        expect(toast()?.textContent).toContain("Commit reworded.")

        // Published history waits for an explicit decision instead of rewriting at once.
        published = ["feature/laneway"]
        rewords.length = 0
        form = await openForm()
        await app.act(() => type(form.querySelector<HTMLInputElement>("[aria-label='Commit title']")!, "Inspect published changes"))
        await app.act(() => press(button(form, "Apply")))
        expect(form.querySelector("[role=alert]")?.textContent).toContain("Rewrites history already published on feature/laneway")
        expect(rewords.map(call => call.token)).toEqual([undefined])
        await app.act(() => press(button(form, "Rewrite history")))
        expect(rewords.map(call => call.token)).toEqual([undefined, "reword"])
        expect(trail().querySelector("[aria-label='Reword commit Inspect changes']") == null).toBe(true)
    })

    test("the column's branch renames in place from its heading, and a refused name keeps the editor open", async () => {
        let scenario = inspectionScenario()
        let branch = scenario.graph.branches[1]!
        let requests: LocalRequest[] = []
        let app = await startReactApp({
            ...scenario.api,
            localOperation: async (id, request, token) => {
                if (!token)
                    return scenario.api.localOperation(id, request)
                requests.push(request)
                if (request.action != "branch-rename")
                    throw new Error(`Unexpected ${request.action}`)
                if (request.newName == "main")
                    return { ok: false, error: { message: "Choose an unused local branch name." } }
                let ref = `refs/heads/${request.newName}`
                Object.assign(branch, {
                    id: `branch:${ref}`,
                    name: request.newName,
                    preferredRef: ref,
                    refs: [ref],
                    aliases: [request.newName],
                    localRefs: [ref],
                })
                return performed()
            },
        })
        let heading = () => trail().querySelector<HTMLElement>(".stack-heading")!
        let field = () => heading().querySelector<HTMLInputElement>("input")!

        // F2 on the name edits in place instead of opening the rename dialog.
        await app.act(() => key(button(heading(), "Rename branch feature/laneway"), "F2"))
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        expect(field().getAttribute("aria-label")).toBe("New name for branch feature/laneway")
        await app.act(() => type(field(), "feature/abandoned"))
        await app.act(() => key(field(), "Escape"))
        expect(heading().querySelector("input") == null).toBe(true)

        await app.act(() => press(button(heading(), "Rename branch feature/laneway")))
        await app.act(() => type(field(), "main"))
        await app.act(() => key(field(), "Enter"))
        expect(heading().querySelector("[role=alert]")?.textContent).toBe("Choose an unused local branch name.")
        await app.act(() => type(field(), "feature/renamed"))
        expect(field().value).toBe("feature/renamed")
        await app.act(() => key(field(), "Enter"))

        expect(requests).toEqual([{ action: "branch-rename", name: "feature/laneway", newName: "main" }, {
            action: "branch-rename",
            name: "feature/laneway",
            newName: "feature/renamed",
        }])
        expect(button(heading(), "Rename branch feature/renamed").textContent).toBe("feature/renamed")
        expect(document.querySelector("[data-column-id='branch:refs/heads/feature/renamed']")).not.toBeNull()
        expect(scenario.saved().repositories[0]!.columns.map(column => column.id)).toContain("branch:refs/heads/feature/renamed")
    })

    test("Delete on a branch column deletes the branch and the commits only it holds at once, with Undo in the notice", async () => {
        let scenario = inspectionScenario()
        let calls: { request: LocalRequest; token?: string }[] = []
        let transitions: string[] = []
        let app = await startReactApp({
            ...scenario.api,
            localOperation: async (id, request, token) => {
                calls.push({ request, token })
                if (token)
                    return performed()
                let preview = (await scenario.api.localOperation(id, request)) as Extract<LocalActionResult, { ok: true }>
                return { ok: true, result: { ...preview.result, preview: { ...preview.result.preview!, token: "reviewed", uniqueCommits: true } } }
            },
            transitionOperation: async (_id, action) => {
                transitions.push(action)
                return { ok: true }
            },
        })
        let column = document.querySelector<HTMLElement>("[data-column-id='branch:refs/heads/feature/laneway']")!

        await app.act(() => key(column, "Delete"))

        let deletion: LocalRequest = { action: "branch-delete", name: "feature/laneway", confirmed: true }
        expect(calls.filter(call => call.request.action == "branch-delete")).toEqual([{ request: deletion, token: undefined }, {
            request: deletion,
            token: "reviewed",
        }])
        expect(document.querySelector("[role=dialog]") == null).toBe(true)
        expect(toast()?.textContent).toContain("Deleted branch feature/laneway and the commits only it held.")
        await app.act(() => press(button(toast()!, "Undo")))
        expect(transitions).toEqual(["undo"])
    })

    test("a deletion's Undo notice goes as soon as another operation starts, since Undo undoes the latest one", async () => {
        let scenario = inspectionScenario()
        let app = await startReactApp({
            ...scenario.api,
            localOperation: async (id, request, token) => token ? performed() : scenario.api.localOperation(id, request),
        })
        let column = document.querySelector<HTMLElement>("[data-column-id='branch:refs/heads/feature/laneway']")!
        await app.act(() => key(column, "Delete"))
        expect(toast()?.textContent).toContain("Deleted branch feature/laneway.")

        await app.act(() => press(button(document.body, "Undo last operation")))

        expect(toast() == null).toBe(true)
    })
})

function commit(objectId: string, subject: string, parentIds = ["1".repeat(40)]): BranchHistoryCommit {
    return { objectId, parentIds, subject, authorName: "Developer", authorEmail: "developer@example.test", authoredAt: 1788566400 }
}

function performed(): LocalActionResult {
    return { ok: true, result: { type: "result", command: "local", status: "performed" } }
}

function trail() {
    return document.querySelector<HTMLElement>(".commit-trail")!
}

function commitRows() {
    return [...trail().querySelectorAll<HTMLElement>(".trail-commit")]
}

function stackNames() {
    return [...trail().querySelectorAll(".stack-name, .editable-name-button")].map(name => name.textContent)
}

function toast() {
    return document.querySelector<HTMLElement>("[role=alertdialog]")
}

function menuItem(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(item => item.textContent == label)
    if (!item)
        throw new Error(`No ${label} menu item`)
    return item
}

function option(label: string) {
    let item = [...document.querySelectorAll<HTMLElement>("[role=listbox] [role=option]")].find(item => item.textContent == label)
    if (!item)
        throw new Error(`No ${label} option in: ${document.querySelector("[role=listbox]")?.textContent}`)
    return item
}

function key(target: Element, key: string) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}
