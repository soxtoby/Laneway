/** @jsxImportSource react */
import type { BranchGraph, CompositionPreview, CompositionRequest } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { canRebaseOnto } from "../src/renderer/react/branch-rebase"
import { workspaceGraph } from "../src/renderer/src/worktrees/worktree-columns"
import { button, installReactDom, press, startReactApp, stopReactApps } from "./react-dom"
import { appState, branchGraph, fakeLaneway, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow
let restoreSizes: () => void
let feature = { kind: "branch" as const, branch: "refs/heads/feature/laneway", tip: "2".repeat(40) }
let team = { kind: "branch" as const, branch: "refs/heads/other/team", tip: "3".repeat(40) }

beforeAll(() => {
    browserWindow = installReactDom()
    restoreSizes = sizeGraphRows()
})

afterEach(stopReactApps)

afterAll(() => {
    restoreSizes()
    browserWindow.close()
})

describe("React Branch Graph rebase", () => {
    test("rebases a chosen branch with its dependents straight away when nothing needs deciding", async () => {
        let { api, calls } = scenario()
        let app = await openGraph(api)

        await app.act(() => choose(app, "feature/laneway"))
        await app.act(() => press(name("other/team")))
        expect(dialog()).toBeNull()
        expect(calls.map(call => [call.request.source, call.request.target, call.request.descendants, call.token])).toEqual([[feature, team, true, undefined], [
            feature,
            team,
            true,
            "reviewed-1",
        ]])
        expect(notice()).toContain("Rebased feature/laneway and child onto other/team.")
    })

    test("asks which tip to rebase onto when the destination's local tip lags its upstream", async () => {
        let upstreamTip = "4".repeat(40)
        let { api, calls } = scenario(graph => {
            Object.assign(graph.branches[0]!, {
                upstreamRef: "refs/remotes/origin/main",
                upstreamTip,
                behind: 2,
                remoteRefs: ["refs/remotes/origin/main"],
                primary: false,
            })
        })
        let app = await openGraph(api)

        await app.act(() => choose(app, "feature/laneway"))
        await app.act(() => press(name("main")))
        let shown = dialog()!
        expect(shown.textContent).toContain("Local tip, 2 commits behind origin/main")
        expect(shown.textContent).toContain("1 commit since main")
        expect(shown.textContent).toContain("Laneway work")
        expect(calls.map(call => call.request.target)).toEqual([{ kind: "branch", branch: "refs/heads/main", tip: "1".repeat(40) }])
        await app.act(() =>
            press([...shown.querySelectorAll<HTMLElement>("[role=radio], label")].find(option => option.textContent?.startsWith("origin/main"))!)
        )
        expect(calls.at(-1)?.request.target).toEqual({ kind: "branch", branch: "refs/remotes/origin/main", tip: upstreamTip })
        await app.act(() => press(button(dialog()!, "Rebase")))
        expect(calls.at(-1)).toMatchObject({ token: "reviewed-2", request: { target: { branch: "refs/remotes/origin/main" } } })
        expect(dialog()).toBeNull()
        expect(notice()).toContain("onto origin/main.")
    })

    test("confirms published rewrites, can leave dependents behind, and goes on with conflicts to resolve later", async () => {
        let { api, calls, review } = scenario()
        let app = await openGraph(api)

        review({ published: ["feature/laneway"] })
        await app.act(() => choose(app, "feature/laneway"))
        await app.act(() => press(name("other/team")))
        expect(dialog()!.textContent).toContain("Rewrites history already published on feature/laneway")
        let dependents = () => [...dialog()!.querySelectorAll<HTMLElement>("label")].find(label => label.textContent?.includes("Move dependent branches too"))!
        expect(dependents().textContent).toContain("Move dependent branches too: child")
        review({ published: ["feature/laneway"], branches: ["feature/laneway"] })
        await app.act(() => press(dependents()))
        expect(calls.at(-1)?.request.descendants).toBe(false)
        // The dependents stay on offer after a review that leaves them out.
        expect(dependents().textContent).toContain("Move dependent branches too: child")
        await app.act(() => press(button(dialog()!, "Rebase")))
        expect(calls.at(-1)).toMatchObject({ token: "reviewed-2", request: { descendants: false, allowConflicts: false } })
        expect(notice()).toContain("Rebased feature/laneway onto other/team.")

        review({ conflicts: [{ subject: "commit 22222222", files: ["src/file.txt"] }] })
        await app.act(() => choose(app, "feature/laneway"))
        await app.act(() => press(name("other/team")))
        expect(dialog()!.textContent).toContain("Conflicts in commit 22222222: src/file.txt")
        await app.act(() => press(button(dialog()!, "Continue and resolve later")))
        expect(calls.at(-1)).toMatchObject({ token: "reviewed-4", request: { allowConflicts: true } })
        expect(notice()).toContain("with conflicts to resolve before publishing.")
    })

    test("chooses a destination by keyboard or from the row's menu, and Escape stops choosing", async () => {
        let { api, calls } = scenario()
        let app = await openGraph(api)

        await app.act(() => choose(app, "feature/laneway"))
        expect(row("feature/laneway").dataset.rebase).toBe("source")
        expect(notice()).toContain("Rebase feature/laneway · Choose a destination branch")
        // Enter on the source itself only explains what to choose.
        await app.act(() => key(row("feature/laneway"), "Enter"))
        expect(calls).toEqual([])
        expect(notice()).toContain("Choose a branch other than feature/laneway")
        await app.act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
        expect(row("feature/laneway").dataset.rebase).toBeUndefined()

        await app.act(() =>
            row("feature/laneway").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }))
        )
        await app.act(() => press(menuItem("Rebase onto…")))
        expect(row("feature/laneway").dataset.rebase).toBe("source")
        // Arrows only select the destination, which Enter then rebases onto.
        await app.act(() => key(row("feature/laneway"), "ArrowDown"))
        expect(row("other/team").dataset.rebase).toBe("target")
        await app.act(() => key(row("other/team"), "Enter"))
        expect(calls.map(call => call.request.target)).toEqual([team, team])
        expect(row("feature/laneway").dataset.rebase).toBeUndefined()
    })

    test("each branch sharing a tip is its own row, which can't land on its sibling or what is stacked on them", async () => {
        let { api, graph } = scenario(graph => {
            Object.assign(graph.branches[1]!, {
                localRefs: ["refs/heads/feature/laneway", "refs/heads/feature/sibling"],
                refs: ["refs/heads/feature/laneway", "refs/heads/feature/sibling"],
                aliases: ["feature/laneway", "feature/sibling"],
            })
        })
        let app = await openGraph(api)
        let ids = [...document.querySelectorAll<HTMLElement>(".graph-row")].map(row => row.dataset.nodeId)
        expect(ids.indexOf("branch:refs/heads/feature/sibling")).toBe(ids.indexOf("branch:refs/heads/feature/laneway") + 1)
        // One commit's node spans both rows, so siblings don't read as a stack.
        expect(row("feature/laneway").querySelector(".graph-node-fill")).not.toBeNull()
        expect(row("feature/sibling").querySelector(".graph-node-fill")).not.toBeNull()
        expect(row("other/team").querySelector(".graph-node-fill")).toBeNull()

        let identities = workspaceGraph(graph)
        let branch = (name: string) => identities.branches.find(candidate => candidate.name == name)!
        expect(canRebaseOnto(identities, branch("main"), branch("other/team"))).toBe(false)
        expect(canRebaseOnto(identities, branch("feature/sibling"), branch("feature/laneway"))).toBe(false)
        expect(canRebaseOnto(identities, branch("feature/laneway"), branch("feature/sibling"))).toBe(false)
        expect(canRebaseOnto(identities, branch("feature/sibling"), branch("child"))).toBe(false)
        expect(canRebaseOnto(identities, branch("other/team"), branch("feature/sibling"))).toBe(true)

        await app.act(() => press(button(row("feature/sibling"), "Open")))
        expect([...document.querySelectorAll(".column-row > .column")].map(column => column.getAttribute("aria-label"))).toEqual(["feature/sibling"])
        // Keyboard actions on the selected row act on that identity, not the one leading its tip.
        await app.act(() => press(name("feature/sibling")))
        await app.act(() => key(row("feature/sibling"), "F2"))
        expect([...document.querySelectorAll<HTMLInputElement>("[role=dialog] input")].some(input => input.value == "feature/sibling")).toBe(true)
    })
})

function scenario(configure: (graph: BranchGraph) => void = () => {}) {
    let repository = repositoryInfo("D:\\Source\\rebase-graph")
    let graph = branchGraph(repository.id)
    let base = graph.branches[1]!
    graph.branches[2]!.involvement = "involved"
    graph.branches.push({
        ...base,
        id: "branch:refs/heads/child",
        name: "child",
        preferredRef: "refs/heads/child",
        refs: ["refs/heads/child"],
        aliases: ["child"],
        localRefs: ["refs/heads/child"],
        tip: "5".repeat(40),
        base: { status: "known", branchId: base.id, name: base.name, ref: base.preferredRef, tip: base.tip },
    })
    graph.history.unshift({ objectId: "5".repeat(40), lineId: "branch:refs/heads/child", parentIds: [base.tip] })
    configure(graph)
    let calls: { request: CompositionRequest; token?: string }[] = []
    let reviewed: Partial<CompositionPreview> = {}
    let api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
        readBranchGraph: async () => ({ ok: true, graph }),
        localOperation: async (_id, request, token) => {
            calls.push({ request: request as CompositionRequest, token })
            if (token)
                return { ok: true, result: { type: "result", command: "local", status: "performed" } }
            let composition: CompositionPreview = {
                branches: ["feature/laneway", "child"],
                removed: [],
                conflicts: [],
                published: [],
                skipped: [],
                noop: false,
                commits: [{ objectId: base.tip, subject: "Laneway work" }],
                ...reviewed,
            }
            return {
                ok: true,
                result: {
                    type: "result",
                    command: "local-preview",
                    status: "preview",
                    preview: {
                        token: `reviewed-${calls.length}`,
                        affected: [],
                        uniqueCommits: false,
                        unborn: false,
                        suggestedBranch: "",
                        staged: false,
                        files: [],
                        stashes: [],
                        worktrees: [],
                        composition,
                    },
                },
            }
        },
    })
    return { api, graph, calls, review: (value: Partial<CompositionPreview>) => reviewed = value }
}

async function openGraph(api: Window["laneway"]) {
    let app = await startReactApp(api)
    await app.act(() => press(button(document.body, "Show Branch Graph")))
    return app
}

// Selects the branch's row and presses M, which starts choosing where to rebase it.
async function choose(app: { act(action: () => unknown): Promise<void> }, branch: string) {
    await app.act(() => press(name(branch)))
    await app.act(() => key(row(branch), "m"))
}

// Happy DOM lays nothing out, so the graph's scroller is given a size for the virtualizer to fill.
function sizeGraphRows() {
    let names = ["clientHeight", "offsetHeight", "clientWidth", "offsetWidth"]
    let descriptors = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]))
    for (let name of names) {
        Object.defineProperty(HTMLElement.prototype, name, {
            configurable: true,
            get() {
                return this.classList?.contains("graph-rows") ? name.endsWith("Height") ? 400 : 300 : descriptors[name]?.get?.call(this) ?? 0
            },
        })
    }
    return () => {
        for (let [name, descriptor] of Object.entries(descriptors)) {
            if (descriptor)
                Object.defineProperty(HTMLElement.prototype, name, descriptor)
        }
    }
}

function row(branch: string) {
    let found = [...document.querySelectorAll<HTMLElement>(".graph-row")].find(element => element.dataset.nodeId == `branch:refs/heads/${branch}`)
    if (!found)
        throw new Error(`No row for ${branch}`)
    return found
}

// Pressing a row's name presses the row, which selects it.
function name(branch: string) {
    return row(branch).querySelector<HTMLElement>(".graph-name")!
}

function dialog() {
    return document.querySelector<HTMLElement>(".rebase-dialog")
}

function notice() {
    return document.querySelector("[role=alertdialog]")?.textContent ?? ""
}

function menuItem(label: string) {
    return [...document.querySelectorAll<HTMLElement>("[role=menu] [role=menuitem]")].find(item => item.textContent == label)!
}

// React Aria completes a keyboard press on its keyup.
function key(element: HTMLElement, name: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
    element.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true, cancelable: true }))
}
