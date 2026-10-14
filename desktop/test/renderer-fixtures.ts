import type { BranchGraph, ChangedFile, FileDiffPage, Workspace } from "@laneway/shared"

export function inspectionScenario() {
    let repository = repositoryInfo("D:\\Source\\inspection")
    let graph: BranchGraph = branchGraph(repository.id)
    let branch = graph.branches[1]
    branch.checkedOut = [{ path: repository.root, name: "inspection", head: branch.tip, main: true }]
    let workspace: Workspace = {
        ...openedWorkspace(repository),
        repositories: [{
            ...openedWorkspace(repository).repositories[0],
            layoutInitialized: true,
            columns: [{ kind: "branch", id: branch.id, ref: branch.preferredRef, lastSeenObjectId: branch.tip, width: 380, worktreePath: repository.root }],
        }],
    }

    let files: ChangedFile[] = ["src/file.txt", "other.txt"].map(path => ({
        path,
        status: "modified",
        staged: true,
        unstaged: true,
        untracked: false,
        ignored: false,
        conflicted: false,
    }))
    let page: FileDiffPage = {
        source: { kind: "working", worktreePath: repository.root },
        file: files[0],
        view: "combined",
        version: "one",
        summary: [],
        selectable: true,
        lines: [{ id: 0, kind: "hunk", text: "@@ -1 +1 @@", hunk: 0 }, { id: 1, kind: "deletion", text: "old", oldLine: 1, hunk: 0 }, {
            id: 2,
            kind: "addition",
            text: "new",
            newLine: 1,
            hunk: 0,
        }],
    }

    let api = fakeLaneway({
        getState: async () => ({ ...appState(), workspace }),
        updateWorkspace: async next => workspace = structuredClone(next),
        readBranchGraph: async () => ({ ok: true, graph }),
        readChanges: async (_id, _requestId, request) => ({
            ok: true,
            inventory: { source: request.source, files, version: "inventory", parents: request.source.kind == "commit" ? [graph.branches[0].tip] : [] },
        }),
        readFileDiff: async (_id, _requestId, request) => ({
            ok: true,
            page: {
                ...page,
                source: request.source,
                file: files.find(file => file.path == request.path)!,
                view: request.view ?? "combined",
                selectable: !request.view || ["combined", "staged", "unstaged"].includes(request.view),
            },
        }),
        readBranchHistory: async () => ({
            ok: true,
            page: {
                branchRef: branch.preferredRef,
                tip: branch.tip,
                baseTips: [graph.branches[0].tip],
                commits: [{
                    objectId: branch.tip,
                    parentIds: [graph.branches[0].tip],
                    subject: "Inspect changes",
                    body: "Inspect every change.",
                    authorName: "Test",
                    authorEmail: "test@example.test",
                    authoredAt: 1788566400,
                }],
            },
        }),
    })
    return { api, page, graph, saved: () => workspace }
}

export function repositoryInfo(path: string) {
    return {
        id: `${path}\\.git`,
        root: path,
        mainWorktree: path,
        selectedWorktree: path,
        commonDirectory: `${path}\\.git`,
        gitDirectory: `${path}\\.git`,
        objectFormat: "sha1" as const,
        shallow: false,
        partial: false,
        sparse: false,
        git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.51.1" },
    }
}

export function openedWorkspace(info: ReturnType<typeof repositoryInfo>) {
    return {
        repositories: [{ status: "available" as const, id: info.id, path: info.mainWorktree, info, columns: [], layoutInitialized: false }],
        activeRepositoryId: info.id,
    }
}

export function branchGraph(repositoryId: string) {
    let main = {
        kind: "branch" as const,
        id: "branch:refs/heads/main",
        name: "main",
        preferredRef: "refs/heads/main",
        refs: ["refs/heads/main"],
        aliases: ["main"],
        localRefs: ["refs/heads/main"],
        remoteRefs: [],
        tip: "1".repeat(40),
        ahead: 0,
        behind: 0,
        base: { status: "unknown" as const, candidates: [] },
        involvement: "uninvolved" as const,
        checkedOut: [],
        markers: [],
        tags: [],
        primary: true,
        remoteOnly: false,
        published: false,
        merged: false,
    }
    let branch = (name: string, involvement: "involved" | "uninvolved") => ({
        ...main,
        id: `branch:refs/heads/${name}`,
        name,
        preferredRef: `refs/heads/${name}`,
        refs: [`refs/heads/${name}`],
        aliases: [name],
        localRefs: [`refs/heads/${name}`],
        tip: involvement == "involved" ? "2".repeat(40) : "3".repeat(40),
        base: { status: "known" as const, branchId: main.id, name: "main", ref: main.preferredRef, tip: main.tip },
        involvement,
        primary: false,
    })
    return {
        repositoryId,
        primaryBranch: { status: "known" as const, remote: "origin", ref: main.preferredRef },
        availableRemotes: ["origin"],
        selectedRemote: "origin",
        remotePatterns: [],
        authorIdentities: { primary: "developer@example.test", secondary: [] },
        effectiveAuthorEmail: "developer@example.test",
        branches: [main, branch("feature/laneway", "involved"), branch("other/team", "uninvolved")],
        history: [{ objectId: "2".repeat(40), lineId: "branch:refs/heads/feature/laneway", parentIds: [main.tip] }, {
            objectId: "3".repeat(40),
            lineId: "branch:refs/heads/other/team",
            parentIds: [main.tip],
        }, { objectId: main.tip, lineId: main.id, parentIds: [] }],
        tags: [],
        virtualBranches: [],
        unassignedStashes: [],
        remoteTips: [] as string[],
        limited: [],
    }
}

export function fakeLaneway(overrides: Partial<Window["laneway"]> = {}): Window["laneway"] {
    return {
        recoverWorktree: async () => ({ ok: true }),
        pullLatest: async () => ({ ok: false, error: { message: "Pull latest unavailable" } }),
        cancelPull: async () => false,
        onPullProgress: () => () => undefined,
        readConflictContent: async () => null,
        conflictOperation: async () => ({ ok: true, result: { type: "result", command: "conflict", conflicts: [], recovery: [] } }),
        localOperation: async () => ({
            ok: true,
            result: {
                type: "result",
                command: "local-preview",
                status: "preview",
                preview: {
                    token: "fixture",
                    affected: [],
                    uniqueCommits: false,
                    branch: "feature/laneway",
                    unborn: false,
                    suggestedBranch: "feature/laneway",
                    staged: true,
                    files: [],
                    stashes: [],
                    worktrees: [],
                },
            },
        }),
        readCommitDraft: async () => ({ title: "", message: "", branch: "" }),
        saveCommitDraft: async () => {},
        getState: async () => appState(),
        previewWorktree: async () => ({ ok: false, error: { message: "Worktree operations unavailable" } }),
        executeWorktree: async () => ({ ok: false, error: { message: "Worktree operations unavailable" } }),
        transitionOperation: async () => ({ ok: true }),
        readChanges: async () => ({ ok: false, error: { code: "git.command-failed", message: "Changes unavailable" } }),
        readFileDiff: async () => ({ ok: false, error: { code: "git.command-failed", message: "Diff unavailable" } }),
        readFileImage: async () => ({ ok: false, error: { code: "git.command-failed", message: "Image unavailable" } }),
        cancelInspection: async () => false,
        readFileHistory: async () => ({ ok: true, page: { entries: [] } }),
        openRepository: async () => ({ ok: false, error: { code: "git.cancelled", message: "Cancelled" } }),
        chooseDirectory: async defaultPath => defaultPath,
        entryDefaults: async () => ({ parent: "C:\\Users\\developer\\Documents" }),
        suggestCloneDirectoryName: async () => "project",
        cloneRepository: async () => ({ ok: false, error: { code: "git.cancelled", message: "Cancelled" } }),
        initializeRepository: async () => ({ ok: false, error: { code: "git.cancelled", message: "Cancelled" } }),
        cancelEntry: async () => true,
        selectRepository: async () => ({ repositories: [] }),
        closeRepository: async () => ({ repositories: [] }),
        locateRepository: async () => ({ repositories: [] }),
        updateWorkspace: async workspace => workspace,
        resetWorkspace: async () => ({ repositories: [] }),
        chooseGit: async () => appState().settings,
        useGitFromPath: async () => appState().settings,
        resetSettings: async () => appState().settings,
        setAuthorIdentities: async authorIdentities => ({ ...appState().settings, authorIdentities }),
        openSettingsFile: async () => "",
        setAppearance: async appearance => appearance,
        readBranchGraph: async () => ({ ok: false, error: { code: "git.command-failed", message: "Graph unavailable" } }),
        cancelBranchGraph: async () => false,
        readBranchHistory: async () => ({ ok: false, error: { code: "git.command-failed", message: "History unavailable" } }),
        cancelBranchHistory: async () => false,
        setRepositoryGraphSettings: async (_repositoryId, settings) => settings,
        onEntryProgress: () => () => undefined,
        onRepositoryChanged: () => () => undefined,
        ...overrides,
    }
}

export function appState() {
    return {
        workspace: { repositories: [] },
        settings: {
            path: "C:\\Users\\developer\\settings.json",
            git: { path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.51.1" },
            authorIdentities: { secondary: [] },
        },
        engine: { state: "ready" as const, path: "D:\\Laneway\\cli\\bin\\lane.exe", name: "lane" as const, version: "0.1.0" },
        appearance: "light" as const,
    }
}
