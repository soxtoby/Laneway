import type { BranchGraph, Workspace, WorkspaceColumn } from "@laneway/shared"
import { describe, expect, test } from "bun:test"
import { createBranchWorkspace } from "../src/renderer/react/branch-workspace"
import type { Notice } from "../src/renderer/react/notice"
import { branchGraph, fakeLaneway, openedWorkspace, repositoryInfo } from "./renderer-fixtures"

describe("branch workspace", () => {
    test("a repository opened for the first time starts with the worktree it was opened from, then its other worktrees", async () => {
        let { columns, saved } = setUp(graph => {
            graph.branches[0]!.checkedOut = [{ path: "D:\\Source\\project", name: "project", head: graph.branches[0]!.tip, main: true }]
            graph.branches[1]!.checkedOut = [{ path: "D:\\Source\\linked", name: "linked", head: graph.branches[1]!.tip, main: false }]
        }, { selectedWorktree: "D:\\Source\\linked" })

        await activate(columns)

        expect(columns.snapshot().columns.map(column => column.name)).toEqual(["linked", "project"])
        expect(columns.snapshot().focusedId).toBe("branch:refs/heads/feature/laneway")
        expect(saved().repositories[0]).toMatchObject({ layoutInitialized: true })
    })

    test("a header drag keeps its order through a refresh, and the drop saves it", async () => {
        let { columns, saved } = setUp(graph => {
            graph.branches[0]!.checkedOut = [{ path: "D:\\Source\\project", name: "project", head: graph.branches[0]!.tip, main: true }]
            graph.branches[1]!.checkedOut = [{ path: "D:\\Source\\linked", name: "linked", head: graph.branches[1]!.tip, main: false }]
        })
        await activate(columns)
        let [first, second] = columns.snapshot().columns.map(column => column.id)

        columns.dragOver(first!, second!)
        await columns.refresh()
        expect(columns.snapshot().columns.map(column => column.id)).toEqual([second, first])
        columns.drop(first!)
        await settle()

        expect(savedIds(saved())).toEqual([second, first])
    })

    test("a column whose branch is gone closes, with a notice", async () => {
        let notices: Notice[] = []
        let gone = false
        let { columns, saved } = setUp(
            graph => {
                if (gone)
                    graph.branches.splice(2, 1)
            },
            { columns: [branchColumn("other/team")] },
            notices,
        )
        await activate(columns)
        expect(savedIds(saved())).toEqual(["branch:refs/heads/other/team"])

        gone = true
        await columns.refresh()

        expect(savedIds(saved())).toEqual([])
        expect(notices.map(notice => notice.message)).toEqual(["An open branch no longer exists; its column was closed."])
    })

    test("closing a branch's column removes it, but a worktree's column collapses instead", async () => {
        let { columns, saved } = setUp(graph => {
            graph.branches[1]!.checkedOut = [{ path: "D:\\Source\\linked", name: "linked", head: graph.branches[1]!.tip, main: false }]
        }, { columns: [branchColumn("other/team")] })
        await activate(columns)

        columns.close("branch:refs/heads/feature/laneway")
        columns.close("branch:refs/heads/other/team")
        await settle()

        expect(saved().repositories[0]!.columns).toMatchObject([{ id: "branch:refs/heads/feature/laneway", collapsed: true }])
    })
})

function setUp(
    adjust: (graph: BranchGraph) => void,
    repository: { selectedWorktree?: string; columns?: WorkspaceColumn[] } = {},
    notices: Notice[] = [],
) {
    let info = { ...repositoryInfo("D:\\Source\\project"), ...repository.selectedWorktree ? { selectedWorktree: repository.selectedWorktree } : {} }
    let opened = openedWorkspace(info)
    let workspace: Workspace = {
        ...opened,
        repositories: [{ ...opened.repositories[0]!, columns: repository.columns ?? [], layoutInitialized: repository.columns != undefined }],
    }
    let api = fakeLaneway({
        readBranchGraph: async () => {
            let graph = branchGraph(info.id)
            adjust(graph)
            return { ok: true, graph }
        },
    })
    let columns = createBranchWorkspace({
        api,
        notify: notice => notices.push(notice),
        inspection: { retain: () => {}, refreshWorking: () => {} },
        workspace: () => workspace,
        saveColumns: async (id, layout) => {
            workspace = { ...workspace, repositories: workspace.repositories.map(item => item.id == id ? { ...item, ...layout } : item) }
        },
        checkMissing: async () => undefined,
    })
    return { columns, saved: () => workspace, repositoryId: info.id }
}

async function activate(columns: ReturnType<typeof createBranchWorkspace>) {
    columns.activate(columns.snapshot().repositoryId ?? repositoryInfo("D:\\Source\\project").id)
    await settle()
}

function branchColumn(name: string): WorkspaceColumn {
    return { kind: "branch", id: `branch:refs/heads/${name}`, ref: `refs/heads/${name}`, lastSeenObjectId: "3".repeat(40), width: 380 }
}

function savedIds(workspace: Workspace) {
    return workspace.repositories[0]!.columns.map(column => column.id)
}

// Lets the controller's reads run to completion.
async function settle() {
    for (let turn = 0; turn < 20; turn++)
        await new Promise(resolve => setTimeout(resolve, 0))
}
