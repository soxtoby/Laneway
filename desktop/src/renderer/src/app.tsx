import type { Appearance, EntryProgress, Workspace } from "@git-workbench/shared"
import { css, type Handle, on } from "remix/ui"
import { type BranchWorkspace, createBranchWorkspace } from "./branch-workspace"
import { errorMessage, FatalError, Notice, type NoticeState } from "./feedback"
import { activateSelectionsOnMouseDown } from "./mouse-activation"
import { createRepositoryEntry, type RepositoryEntry } from "./repository-entry"
import { createGitSettings, type GitSettings } from "./settings"
import { RepositoryRailToggle, Welcome, WorkbenchHeader, WorkbenchStatus } from "./workspace"

type AppState = Awaited<ReturnType<Window["workbench"]["getState"]>>

export function WorkbenchApp(handle: Handle<{ api: Window["workbench"] }>) {
    activateSelectionsOnMouseDown(document, handle.signal)
    let initial: AppState | undefined
    let workspace: Workspace | undefined
    let repositoryEntry: RepositoryEntry | undefined
    let gitSettings: GitSettings | undefined
    let branchWorkspace: BranchWorkspace | undefined
    let openingRepository = false
    let notice: NoticeState | undefined
    let fatalError: string | undefined
    let repositoryOrderBeforeDrag: string[] | undefined
    let railCollapsed = false
    let appearance: Appearance = "light"

    handle.queueTask(() => void bootstrap())
    handle.signal.addEventListener("abort", () => document.body.classList.remove("busy"), { once: true })

    return () => {
        if (!initial || !workspace || !repositoryEntry || !gitSettings || !branchWorkspace) {
            return fatalError
                ? <FatalError message={fatalError} retry={bootstrap} />
                : (
                    <main class="bootstrap-state" mix={bootstrapState} aria-live="polite">
                        <p mix={bootstrapStateP}>
                            Starting Git Workbench…
                        </p>
                    </main>
                )
        }

        const currentWorkspace = workspace
        const active = currentWorkspace.repositories.find(repository => repository.id == currentWorkspace.activeRepositoryId)
        const busy = openingRepository || repositoryEntry.busy
        return (
            <>
                <main class={`shell ${railCollapsed ? "rail-collapsed" : ""}`} mix={shell}>
                    <WorkbenchHeader
                        openLens={branchWorkspace.openLens}
                        toggleGraph={active?.status == "available"
                            ? () => branchWorkspace!.toggleGraph(active.id)
                            : undefined}
                        graphCollapsed={active?.status == "available" && branchWorkspace.graphCollapsed(active.id)}
                        busy={busy}
                        appearance={appearance}
                        openSettings={gitSettings.open}
                        toggleAppearance={() => void toggleAppearance()}
                    />
                    {active?.status == "available"
                        ? (
                            branchWorkspace.render(active, currentWorkspace, railCollapsed, toggleRail)
                        )
                        : active?.status == "missing"
                        ? (
                            <MissingRepository
                                railCollapsed={railCollapsed}
                                toggleRail={toggleRail}
                                repository={active}
                                workspace={currentWorkspace}
                                select={selectRepository}
                                locate={locateRepository}
                                close={closeRepository}
                                move={moveRepository}
                                previewMove={previewRepositoryMove}
                                commitOrder={commitRepositoryOrder}
                                cancelMove={cancelRepositoryMove}
                                addRepository={() => repositoryEntry?.openAdd()}
                            />
                        )
                        : (
                            <Welcome
                                settings={gitSettings.current}
                                busy={busy}
                                openRepository={openRepository}
                                openClone={repositoryEntry.openClone}
                                openInitialize={repositoryEntry.openInitialize}
                            />
                        )}
                    <WorkbenchStatus
                        settings={gitSettings.current}
                        engine={initial.engine.state == "ready" ? `Engine ${initial.engine.version}` : "Engine unavailable"}
                    />
                </main>
                {repositoryEntry.render()}
                {gitSettings.render()}
                {branchWorkspace.renderLens(currentWorkspace)}
                <Notice
                    notice={notice}
                    dismiss={() => {
                        notice = undefined
                        handle.update()
                    }}
                />
                {currentWorkspace.persistenceError && currentWorkspace.persistenceError.code != "workspace.partial" && (
                    <WorkspaceRecovery
                        error={currentWorkspace.persistenceError.message}
                        reset={currentWorkspace.persistenceError.code == "workspace.corrupt"
                                || currentWorkspace.persistenceError.code == "workspace.unsupported-version"
                            ? resetWorkspace
                            : undefined}
                    />
                )}
            </>
        )
    }

    function toggleRail() {
        railCollapsed = !railCollapsed
        void handle.update()
    }

    async function bootstrap() {
        fatalError = undefined
        await handle.update()
        try {
            initial = await handle.props.api.getState()
            applyAppearance(initial.appearance)
            workspace = initial.workspace
            if (workspace.persistenceError?.code == "workspace.partial")
                notify({ code: workspace.persistenceError.code, message: workspace.persistenceError.message })
            gitSettings = createGitSettings({
                api: handle.props.api,
                initial: initial.settings,
                update: handle.update,
                notify,
            })
            branchWorkspace = createBranchWorkspace({
                api: handle.props.api,
                update: handle.update,
                signal: handle.signal,
                notify,
                selectRepository,
                closeRepository,
                moveRepository,
                previewRepositoryMove,
                commitRepositoryOrder,
                cancelRepositoryMove,
                addRepository: () => repositoryEntry?.openAdd(),
                workspace: () => workspace!,
                workspaceChanged(nextWorkspace) {
                    workspace = nextWorkspace
                    void handle.update()
                },
            })
            repositoryEntry = createRepositoryEntry({
                api: handle.props.api,
                defaultCloneParent: initial.defaultCloneParent,
                update: handle.update,
                notify,
                openRepository,
                workspaceOpened(nextWorkspace) {
                    workspace = nextWorkspace
                    if (nextWorkspace.activeRepositoryId)
                        branchWorkspace?.activate(nextWorkspace.activeRepositoryId)
                },
            })
            if (workspace.activeRepositoryId)
                branchWorkspace.activate(workspace.activeRepositoryId)
            const unsubscribe = handle.props.api.onEntryProgress(updateProgress)
            handle.signal.addEventListener("abort", unsubscribe, { once: true })
        } catch (error) {
            fatalError = errorMessage(error)
        }
        await handle.update()
    }

    function applyAppearance(next: Appearance) {
        appearance = next
        document.documentElement.dataset.appearance = next
    }

    async function toggleAppearance() {
        applyAppearance(appearance == "dark" ? "light" : "dark")
        await handle.update()
        try {
            await handle.props.api.setAppearance(appearance)
        } catch (error) {
            notify({ code: "settings.appearance.failed", message: errorMessage(error) })
            await handle.update()
        }
    }

    function updateProgress(progress: EntryProgress) {
        repositoryEntry?.updateProgress(progress)
    }

    function notify(nextNotice: NoticeState) {
        notice = nextNotice
    }

    async function setOpeningRepository(value: boolean) {
        openingRepository = value
        document.body.classList.toggle("busy", value)
        await handle.update()
    }

    async function openRepository() {
        await setOpeningRepository(true)
        try {
            const result = await handle.props.api.openRepository()
            if (result.ok) {
                workspace = result.workspace
                notify({ code: "repository.opened", message: "Repository opened." })
            } else if (result.error.code != "git.cancelled") {
                notify({ code: result.error.code, message: result.error.message })
            }
        } catch (error) {
            notify({ code: "repository.open.failed", message: errorMessage(error) })
        } finally {
            await setOpeningRepository(false)
        }
    }

    async function selectRepository(id: string) {
        await setOpeningRepository(true)
        try {
            workspace = await handle.props.api.selectRepository(id)
            if (workspace.repositories.find(repository => repository.id == id)?.status == "available")
                branchWorkspace?.activate(id)
            else
                branchWorkspace?.deactivate()
        } catch (error) {
            notify({ code: "repository.select.failed", message: errorMessage(error) })
        } finally {
            await setOpeningRepository(false)
        }
    }

    async function closeRepository(id: string) {
        workspace = await handle.props.api.closeRepository(id)
        if (workspace.activeRepositoryId && workspace.repositories.find(repository => repository.id == workspace!.activeRepositoryId)?.status == "available")
            branchWorkspace?.activate(workspace.activeRepositoryId)
        else
            branchWorkspace?.deactivate()
        await handle.update()
    }

    async function locateRepository(id: string) {
        try {
            workspace = await handle.props.api.locateRepository(id)
            if (workspace.repositories.find(repository => repository.id == id)?.status == "available")
                branchWorkspace?.activate(id)
        } catch (error) {
            notify({ code: "repository.locate.failed", message: errorMessage(error) })
        }
        await handle.update()
    }

    async function moveRepository(id: string, targetId: string) {
        if (!workspace)
            return
        const from = workspace.repositories.findIndex(repository => repository.id == id)
        const to = workspace.repositories.findIndex(repository => repository.id == targetId)
        if (from < 0 || to < 0)
            return
        const [repository] = workspace.repositories.splice(from, 1)
        workspace.repositories.splice(to, 0, repository)
        workspace = await handle.props.api.updateWorkspace(workspace)
        await handle.update()
    }

    function previewRepositoryMove(id: string, targetId: string) {
        if (!workspace)
            return
        repositoryOrderBeforeDrag ??= workspace.repositories.map(repository => repository.id)
        const from = workspace.repositories.findIndex(repository => repository.id == id)
        const to = workspace.repositories.findIndex(repository => repository.id == targetId)
        if (from < 0 || to < 0 || from == to)
            return
        const [repository] = workspace.repositories.splice(from, 1)
        workspace.repositories.splice(to, 0, repository)
        void handle.update()
    }

    async function commitRepositoryOrder() {
        repositoryOrderBeforeDrag = undefined
        if (workspace)
            workspace = await handle.props.api.updateWorkspace(workspace)
        await handle.update()
    }

    function cancelRepositoryMove() {
        if (!workspace || !repositoryOrderBeforeDrag)
            return
        const order = new Map(repositoryOrderBeforeDrag.map((id, index) => [id, index]))
        workspace.repositories.sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER))
        repositoryOrderBeforeDrag = undefined
        void handle.update()
    }

    async function resetWorkspace() {
        try {
            workspace = await handle.props.api.resetWorkspace()
            branchWorkspace?.deactivate()
        } catch (error) {
            notify({ code: "workspace.reset.failed", message: errorMessage(error) })
        }
        await handle.update()
    }
}

function WorkspaceRecovery(handle: Handle<{ error: string; reset?(): void }>) {
    return () => (
        <aside class="workspace-recovery" mix={workspaceRecovery} aria-live="assertive">
            <div>
                <strong mix={workspaceRecoveryStrong}>
                    Workspace State needs attention
                </strong>
                <p mix={workspaceRecoveryP}>
                    {handle.props.error}
                </p>
            </div>
            {handle.props.reset && (
                <button type="button" mix={[workspaceRecoveryButton, on("click", handle.props.reset)]}>
                    Reset workspace
                </button>
            )}
        </aside>
    )
}

let draggingMissingRepositoryId: string | undefined

function MissingRepository(
    handle: Handle<
        {
            repository: Extract<Workspace["repositories"][number], { status: "missing" }>
            workspace: Workspace
            select(id: string): void
            locate(id: string): void
            close(id: string): void
            move(id: string, targetId: string): void
            previewMove(id: string, targetId: string): void
            commitOrder(): void
            cancelMove(): void
            railCollapsed: boolean
            toggleRail(): void
            addRepository(): void
        }
    >,
) {
    return () => (
        <section class="workspace missing-repository" mix={workspace}>
            <aside class="repository-rail" mix={repositoryRail}>
                <div class="rail-heading" mix={railHeading}>
                    <RepositoryRailToggle collapsed={handle.props.railCollapsed} toggle={handle.props.toggleRail} />
                    <p class="eyebrow" mix={eyebrow}>
                        Open repositories
                    </p>
                </div>
                <nav aria-label="Open repositories" mix={openRepositoriesNav}>
                    {handle.props.workspace.repositories.map((repository, index) => (
                        <div
                            draggable
                            title="Drag to reorder · Ctrl+< / Ctrl+>"
                            mix={[
                                on("keydown", event => {
                                    if (event.ctrlKey && event.shiftKey && (event.key == "<" || event.key == ">")) {
                                        event.preventDefault()
                                        const target = handle.props.workspace.repositories[index + (event.key == "<" ? -1 : 1)]
                                        if (target)
                                            handle.props.move(repository.id, target.id)
                                    }
                                }),
                                on("dragstart", () => {
                                    draggingMissingRepositoryId = repository.id
                                }),
                                on("dragover", event => {
                                    event.preventDefault()
                                    if (draggingMissingRepositoryId)
                                        handle.props.previewMove(draggingMissingRepositoryId, repository.id)
                                }),
                                on("drop", event => {
                                    event.preventDefault()
                                    handle.props.commitOrder()
                                    draggingMissingRepositoryId = undefined
                                }),
                                on("dragend", () => {
                                    if (draggingMissingRepositoryId)
                                        handle.props.cancelMove()
                                    draggingMissingRepositoryId = undefined
                                }),
                            ]}
                        >
                            <button
                                class={`repository-item ${handle.props.railCollapsed ? "collapsed" : ""} ${
                                    repository.id == handle.props.repository.id ? "active" : ""
                                }`}
                                type="button"
                                title={repository.path}
                                aria-label={repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name}
                                data-mousedown-activate
                                mix={[repositoryItem, on("click", () => handle.props.select(repository.id))]}
                            >
                                <span mix={repositoryItemSpan}>
                                    {initials(repository.path)}
                                </span>
                                {!handle.props.railCollapsed && (
                                    <span mix={repositoryItemSpan}>
                                        <strong mix={repositoryItemStrong}>
                                            {repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name}
                                        </strong>
                                        <small mix={repositoryItemSmall}>
                                            {repository.status == "available" ? repository.info.selectedWorktree : "Unavailable"}
                                        </small>
                                    </span>
                                )}
                            </button>
                        </div>
                    ))}
                    <button
                        class={`rail-add ${handle.props.railCollapsed ? "collapsed" : ""}`}
                        type="button"
                        aria-label="Add repository"
                        title="Add repository"
                        mix={[railAdd, on("click", handle.props.addRepository)]}
                    >
                        <span aria-hidden="true">+</span>
                        {!handle.props.railCollapsed && <span class="rail-add-label">Add repository</span>}
                    </button>
                </nav>
            </aside>
            <div class="missing-copy" mix={missingCopy}>
                <p class="eyebrow" mix={missingRepositoryEyebrow}>
                    Repository unavailable
                </p>
                <h1 mix={missingCopyH1}>
                    {handle.props.repository.name}
                </h1>
                <p mix={missingCopyP}>
                    {handle.props.repository.path}
                </p>
                <p mix={missingCopyP}>
                    {handle.props.repository.error.message}
                </p>
                <div class="dialog-actions" mix={dialogActions}>
                    <button class="primary-button" type="button" mix={[on("click", () => handle.props.locate(handle.props.repository.id))]}>Locate</button>
                    <button class="secondary-button" type="button" mix={[on("click", () => handle.props.close(handle.props.repository.id))]}>Close</button>
                </div>
            </div>
        </section>
    )
}

function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}

function initials(path: string) {
    const words = baseName(path).split(/[-_.\s]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "GW").toUpperCase()
}

const bootstrapState = css({
    height: "100%",
    padding: "32px",
    display: "grid",
    placeItems: "center",
    overflow: "auto",
    textAlign: "center",
})

const bootstrapStateP = css({
    color: "var(--muted)",
})

const shell = css({
    "&.rail-collapsed": { "--rail": "52px" },
    "&.rail-collapsed .rail-heading": { padding: "2px 0 6px", justifyContent: "center" },
    "&.rail-collapsed .rail-heading .eyebrow": { display: "none" },
    width: "100%",
    height: "100%",
    display: "grid",
    gridTemplateRows: "var(--toolbar) minmax(0, 1fr) var(--status)",
    overflow: "hidden",
})

const workspaceRecovery = css({
    position: "fixed",
    zIndex: "20",
    right: "14px",
    bottom: "calc(var(--status) + 12px)",
    left: "14px",
    padding: "11px 12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    border: "1px solid var(--warning-edge)",
    borderRadius: "6px",
    background: "var(--warning-raised)",
    boxShadow: "var(--shadow-popover)",
})

const workspaceRecoveryStrong = css({
    fontSize: "13px",
})

const workspaceRecoveryP = css({
    margin: "4px 0 0",
    color: "var(--muted)",
    fontSize: "12px",
})

const workspaceRecoveryButton = css({
    minHeight: "28px",
    padding: "0 14px",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: "500",
    letterSpacing: "0",
    textTransform: "none",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    background: "var(--control)",
    "&:hover": {
        background: "var(--control-hover)",
    },
})

const workspace = css({
    height: "100%",
    display: "grid",
    gridTemplateColumns: "var(--rail) minmax(0, 1fr)",
})

const repositoryRail = css({
    minWidth: "0",
    minHeight: "0",
    padding: "6px",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) auto",
    gap: "6px",
    borderRight: "1px solid var(--line)",
    background: "var(--panel-deep)",
})

const railHeading = css({
    padding: "2px 2px 6px 6px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    borderBottom: "1px solid var(--line)",
})

const eyebrow = css({
    color: "var(--muted)",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0",
    textTransform: "none",
    minWidth: "0",
    flex: "1 1 auto",
    margin: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

const railAdd = css({
    "&.collapsed": { gridTemplateColumns: "24px", padding: "0", gap: "0", justifyContent: "center", textAlign: "center", height: "38px" },
    margin: "6px 0 0",
    width: "100%",
    height: "32px",
    gridTemplateColumns: "24px minmax(0, 1fr)",
    gap: "8px",
    textAlign: "left",
    outlineOffset: "-2px",
    flex: "0 0 auto",
    padding: "0 6px",
    display: "grid",
    alignItems: "center",
    color: "var(--muted)",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "var(--control)",
    fontSize: "12px",
    lineHeight: "1",
    "&:hover:not(:disabled)": {
        color: "var(--text)",
        background: "var(--control-hover)",
    },
})

const openRepositoriesNav = css({
    gridTemplateColumns: "minmax(0, 1fr)",
    minWidth: "0",
    overflowX: "hidden",
    minHeight: "0",
    display: "grid",
    alignContent: "start",
    gap: "1px",
    overflowY: "auto",
})

const repositoryItem = css({
    "&.collapsed": { gridTemplateColumns: "24px", padding: "5px 0", gap: "0", justifyContent: "center", height: "38px" },
    minWidth: "0",
    outlineOffset: "-2px",
    width: "100%",
    padding: "5px 6px",
    display: "grid",
    gridTemplateColumns: "24px minmax(0, 1fr)",
    gap: "8px",
    textAlign: "left",
    border: "1px solid transparent",
    borderRadius: "4px",
    background: "transparent",
    "&.active": {
        borderColor: "var(--line)",
        background: "var(--panel)",
        boxShadow: "inset 2px 0 var(--accent)",
    },
    "&.missing > span:first-child": {
        color: "var(--warning)",
    },
    "&:hover:not(:disabled)": {
        background: "var(--hover)",
    },
})

const repositoryItemSpan = css({
    "&:first-child": {
        width: "24px",
        height: "24px",
        display: "grid",
        placeItems: "center",
        color: "var(--accent)",
        border: "1px solid var(--line-strong)",
        borderRadius: "4px",
        fontSize: "10px",
        fontWeight: "600",
    },
    "&:nth-child(2)": {
        minWidth: "0",
        display: "grid",
        alignContent: "center",
        gap: "1px",
    },
})

const repositoryItemStrong = css({
    overflow: "hidden",
    fontSize: "12px",
    fontWeight: "600",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const repositoryItemSmall = css({
    overflow: "hidden",
    color: "var(--faint)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

const missingCopy = css({
    minWidth: "0",
    padding: "28px",
    display: "grid",
    alignContent: "safe center",
    justifyItems: "start",
    overflow: "auto",
})

const missingRepositoryEyebrow = css({
    maxWidth: "70ch",
    overflowWrap: "anywhere",
    color: "var(--muted)",
    fontFamily: "var(--mono)",
    fontSize: "12px",
    lineHeight: "1.5",
})

const missingCopyH1 = css({
    margin: "0 0 10px",
    fontSize: "18px",
    fontWeight: "600",
})

const missingCopyP = css({
    maxWidth: "70ch",
    overflowWrap: "anywhere",
    color: "var(--muted)",
    fontFamily: "var(--mono)",
    fontSize: "12px",
    lineHeight: "1.5",
})

const dialogActions = css({
    padding: "0",
    justifyContent: "flex-start",
    borderTop: "0",
    background: "transparent",
})
