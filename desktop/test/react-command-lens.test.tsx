/** @jsxImportSource react */
import type { BranchGraph, Workspace } from "@laneway/shared"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Window as HappyWindow } from "happy-dom"
import { button, installReactDom, press, startReactApp, stopReactApps, type } from "./react-dom"
import { appState, branchGraph, fakeLaneway, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

let browserWindow: HappyWindow
let restoreSizes: () => void

beforeAll(() => {
    browserWindow = installReactDom()
    restoreSizes = sizeGraphRows()
})

afterEach(stopReactApps)

afterAll(() => {
    restoreSizes()
    browserWindow.close()
})

describe("React Command Lens", () => {
    test("finds a branch and selects it in the Branch Graph without opening a column", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-project")
        let graph = branchGraph(repository.id)
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        }))

        await app.act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })))
        expect(lens()?.textContent).toContain("Search open repositories and branches.")
        await app.act(() => type(search(), "laneway"))
        expect(results()).toEqual(["feature/laneway"])
        await app.act(() => press(result("feature/laneway")))
        await app.act(frame)
        expect(lens()).toBeNull()
        expect(selected()).toBe("branch:refs/heads/feature/laneway")
        expect(document.querySelectorAll(".column-row > .column")).toHaveLength(0)
        expect(rows().contains(document.activeElement)).toBe(true)

        // A repository's name finds the repository, and nothing found says so.
        await app.act(() => press(button(document.body, "Command Lens")))
        await app.act(() => type(search(), "graph-proj"))
        expect(results()).toEqual(["graph-project"])
        await app.act(() => type(search(), "nothing-like-it"))
        expect(lens()?.querySelector("[role=status]")?.textContent).toBe("No matches.")
    })

    test("offers to move the focused column", async () => {
        let repository = repositoryInfo("D:\\Source\\graph-project")
        let graph = branchGraph(repository.id)
        Object.assign(graph.branches[0]!, { checkedOut: [{ path: repository.root, name: "graph-project", head: graph.branches[0]!.tip, main: true }] })
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async () => ({ ok: true, graph }),
        }))

        await app.act(() => press(button(document.body, "Command Lens")))
        await app.act(() => type(search(), "move col"))
        expect(results()).toEqual(["Move column left", "Move column right"])
    })

    test("scrolls a large graph to the branch it finds", async () => {
        let repository = repositoryInfo("D:\\Source\\large-graph")
        let graph = largeGraph(repository.id)
        let reads: boolean[] = []
        let app = await startReactApp(fakeLaneway({
            getState: async () => ({ ...appState(), workspace: openedWorkspace(repository) }),
            readBranchGraph: async (_repositoryId, _refreshRemote, allBranches) => {
                reads.push(allBranches == true)
                return { ok: true, graph }
            },
        }))

        await reveal(app, "feature/119")
        expect(selected()).toBe("branch:refs/heads/feature/119")
        expect(rows().scrollTop).toBeGreaterThan(1600)
        expect(rows().contains(document.activeElement)).toBe(true)
        // A branch the relevant graph shows needs no read of every branch.
        expect(button(panel()!, "Show all").getAttribute("aria-pressed")).toBe("false")

        await reveal(app, "feature/0")
        expect(selected()).toBe("branch:refs/heads/feature/0")
        expect(rows().scrollTop).toBe(0)
    })

    for (let selectAnother of [false, true]) {
        test(`finds a filtered branch in another repository and ${selectAnother ? "keeps a newer selection" : "reveals it"} after a pending read`, async () => {
            let first = repositoryInfo("D:\\Source\\first")
            let second = repositoryInfo("D:\\Source\\second")
            let graph = branchGraph(second.id)
            let [main, feature] = graph.branches
            let remote = {
                ...feature!,
                id: "branch:refs/remotes/origin/hidden",
                name: "origin/hidden",
                preferredRef: "refs/remotes/origin/hidden",
                refs: ["refs/remotes/origin/hidden"],
                aliases: ["origin/hidden"],
                localRefs: [],
                remoteRefs: ["refs/remotes/origin/hidden"],
                tip: "4".repeat(40),
                remoteOnly: true,
                involvement: "uninvolved" as const,
            }
            let everything: BranchGraph = {
                ...graph,
                branches: [...graph.branches, remote],
                history: [{ objectId: remote.tip, lineId: remote.id, parentIds: [main!.tip] }, ...graph.history],
            }
            let workspace: Workspace = {
                ...openedWorkspace(first),
                repositories: [...openedWorkspace(first).repositories, ...openedWorkspace(second).repositories],
            }
            let finishRefresh = () => {}
            let refresh = new Promise<void>(resolve => finishRefresh = resolve)
            let waiting = false
            let app = await startReactApp(fakeLaneway({
                getState: async () => ({ ...appState(), workspace }),
                updateWorkspace: async next => workspace = next,
                selectRepository: async id => workspace = { ...workspace, activeRepositoryId: id },
                readBranchGraph: async (repositoryId, refreshRemote, allBranches) => {
                    if (repositoryId == first.id)
                        return { ok: true, graph: branchGraph(first.id) }
                    if (refreshRemote) {
                        waiting = true
                        await refresh
                    }
                    return { ok: true, graph: allBranches ? everything : graph }
                },
            }))
            try {
                await app.act(() => press(button(document.body, "Command Lens")))
                await app.act(() => type(search(), remote.name))
                expect(results()).toContain(remote.name)
                await app.act(() => press(result(remote.name)))
                expect(waiting).toBe(true)
                expect(workspace.activeRepositoryId).toBe(second.id)
                if (selectAnother)
                    await app.act(() => press(row(feature!.id).querySelector<HTMLElement>(".graph-name")!))

                await app.act(() => finishRefresh())
                await app.act(frame)
                expect(button(panel()!, "Show relevant").getAttribute("aria-pressed")).toBe("true")
                expect(selected()).toBe(selectAnother ? feature!.id : remote.id)
                expect(document.querySelectorAll(".column-row > .column")).toHaveLength(0)
            } finally {
                finishRefresh()
            }
        })
    }
})

async function reveal(app: { act(action: () => unknown): Promise<void> }, branch: string) {
    await app.act(() => press(button(document.body, "Command Lens")))
    await app.act(() => type(search(), branch))
    await app.act(() => press(result(branch)))
    await app.act(frame)
}

function largeGraph(repositoryId: string) {
    let graph = branchGraph(repositoryId)
    let template = graph.branches[1]!
    graph.branches = [
        graph.branches[0]!,
        ...Array.from({ length: 120 }, (_, index) => ({
            ...template,
            id: `branch:refs/heads/feature/${index}`,
            name: `feature/${index}`,
            preferredRef: `refs/heads/feature/${index}`,
            refs: [`refs/heads/feature/${index}`],
            aliases: [`feature/${index}`],
            localRefs: [`refs/heads/feature/${index}`],
            tip: index.toString(16).padStart(40, "0"),
        })),
    ]
    graph.history = [...graph.branches.slice(1).map(branch => ({ objectId: branch.tip, lineId: branch.id, parentIds: [graph.branches[0]!.tip] })), {
        objectId: graph.branches[0]!.tip,
        lineId: graph.branches[0]!.id,
        parentIds: [],
    }]
    return graph
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

function lens() {
    return document.querySelector<HTMLElement>(".command-lens")
}

function search() {
    return lens()!.querySelector<HTMLInputElement>("input")!
}

function results() {
    return [...lens()!.querySelectorAll("[role=menuitem] strong")].map(label => label.textContent)
}

function result(label: string) {
    return [...lens()!.querySelectorAll<HTMLElement>("[role=menuitem]")].find(item => item.querySelector("strong")?.textContent == label)!
}

function panel() {
    return document.querySelector<HTMLElement>(".graph-panel")
}

function rows() {
    return panel()!.querySelector<HTMLElement>(".graph-rows")!
}

function row(id: string) {
    return [...panel()!.querySelectorAll<HTMLElement>(".graph-row")].find(element => element.dataset.nodeId == id)!
}

function selected() {
    return panel()?.querySelector<HTMLElement>(".graph-row[data-selected]")?.dataset.nodeId
}

// Focus moves to a revealed row on the next frames, once the virtualizer has drawn it.
async function frame() {
    for (let count = 0; count < 4; count++)
        await new Promise(resolve => requestAnimationFrame(resolve))
}
