import type { Appearance, EntryProgress, Workspace } from "@laneway/shared"
import { css, type Handle, on } from "remix/ui"
import { type BranchWorkspace, createBranchWorkspace } from "./branch-workspace/branch-workspace"
import { errorMessage, FatalError, Notice, type NoticeState } from "./feedback"
import { activateSelectionsOnMouseDown } from "./mouse-activation"
import { createRepositoryEntry, type RepositoryEntry } from "./repository-entry/repository-entry"
import { RepositoryRail } from "./repository-rail"
import { createGitSettings, type GitSettings } from "./settings"
import { LanewayHeader, Welcome } from "./workspace"

type AppState = Awaited<ReturnType<Window["laneway"]["getState"]>>

let bootstrapState = css({
    height: "100%",
    padding: "32px",
    display: "grid",
    placeItems: "center",
    overflow: "auto",
    textAlign: "center",
})

let bootstrapStateP = css({
    color: "var(--muted)",
})

let shell = css({
    "&.rail-collapsed": { "--rail": "var(--rail-collapsed)" },
    width: "100%",
    height: "100%",
    display: "grid",
    gridTemplateRows: "var(--toolbar) minmax(0, 1fr)",
    overflow: "hidden",
})

let workspaceRecovery = css({
    position: "fixed",
    zIndex: "20",
    right: "14px",
    bottom: "12px",
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

let workspaceRecoveryStrong = css({
    fontSize: "13px",
})

let workspaceRecoveryP = css({
    margin: "4px 0 0",
    color: "var(--muted)",
    fontSize: "12px",
})

let workspaceRecoveryButton = css({
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

let workspace = css({
    height: "100%",
    display: "grid",
    gridTemplateColumns: "var(--rail) minmax(0, 1fr)",
})

let missingCopy = css({
    minWidth: "0",
    padding: "28px",
    display: "grid",
    alignContent: "safe center",
    justifyItems: "start",
    overflow: "auto",
})

let missingRepositoryEyebrow = css({
    maxWidth: "70ch",
    overflowWrap: "anywhere",
    color: "var(--muted)",
    fontFamily: "var(--mono)",
    fontSize: "12px",
    lineHeight: "1.5",
})

let missingCopyH1 = css({
    margin: "0 0 10px",
    fontSize: "18px",
    fontWeight: "600",
})

let missingCopyP = css({
    maxWidth: "70ch",
    overflowWrap: "anywhere",
    color: "var(--muted)",
    fontFamily: "var(--mono)",
    fontSize: "12px",
    lineHeight: "1.5",
})

let dialogActions = css({
    padding: "0",
    justifyContent: "flex-start",
    borderTop: "0",
    background: "transparent",
})

export function LanewayApp(handle: Handle<{ api: Window["laneway"] }>) {
    activateSelectionsOnMouseDown(document, handle.signal)
    let initial: AppState | undefined
    let workspace: Workspace | undefined
    let repositoryEntry: RepositoryEntry | undefined
    let gitSettings: GitSettings | undefined
    let branchWorkspace: BranchWorkspace | undefined
    let openingRepository = false
    let notice: NoticeState | undefined
    let fatalError: string | undefined
    let railCollapsed = true
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
                            Starting Laneway…
                        </p>
                    </main>
                )
        }

        let currentWorkspace = workspace
        let active = currentWorkspace.repositories.find(repository => repository.id == currentWorkspace.activeRepositoryId)
        let busy = openingRepository || repositoryEntry.busy
        let repositoryActions = active?.status == "available" ? branchWorkspace.repositoryActions(active.id, active.info.mainWorktree) : undefined

        return (
            <>
                <main class={`shell ${railCollapsed ? "rail-collapsed" : ""}`} mix={shell}>
                    <LanewayHeader
                        openLens={branchWorkspace.openLens}
                        busy={busy}
                        appearance={appearance}
                        openSettings={gitSettings.open}
                        toggleAppearance={() => void toggleAppearance()}
                        repositoryActions={repositoryActions}
                        tabs={active?.status == "available" ? branchWorkspace.columnTabs(active) : undefined}
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
                addRepository: () => repositoryEntry?.openAdd(),
                workspace: () => workspace!,
                workspaceChanged(nextWorkspace) {
                    workspace = nextWorkspace
                    void handle.update()
                },
            })
            repositoryEntry = createRepositoryEntry({
                api: handle.props.api,
                update: handle.update,
                notify,
                openRepository,
                workspaceOpened(nextWorkspace) {
                    workspace = nextWorkspace
                    activateWorkspaceRepository()
                },
            })

            if (workspace.activeRepositoryId)
                branchWorkspace.activate(workspace.activeRepositoryId)
            let unsubscribe = handle.props.api.onEntryProgress(updateProgress)
            handle.signal.addEventListener("abort", unsubscribe, { once: true })
        } catch (error) {
            fatalError = errorMessage(error)
        }
        await handle.update()
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

    function applyAppearance(next: Appearance) {
        appearance = next
        document.documentElement.dataset.appearance = next
    }

    function updateProgress(progress: EntryProgress) {
        repositoryEntry?.updateProgress(progress)
    }

    async function openRepository() {
        await setOpeningRepository(true)
        try {
            let result = await handle.props.api.openRepository()
            if (result.ok) {
                workspace = result.workspace
                activateWorkspaceRepository()
                notify({ code: "repository.opened", message: "Repository opened.", transient: true })
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

    async function setOpeningRepository(value: boolean) {
        openingRepository = value
        document.body.classList.toggle("busy", value)
        await handle.update()
    }

    async function closeRepository(id: string) {
        workspace = await handle.props.api.closeRepository(id)
        activateWorkspaceRepository()
        await handle.update()
    }

    function activateWorkspaceRepository() {
        let activeId = workspace?.activeRepositoryId
        if (activeId && workspace!.repositories.find(repository => repository.id == activeId)?.status == "available")
            branchWorkspace?.activate(activeId)
        else
            branchWorkspace?.deactivate()
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

        let from = workspace.repositories.findIndex(repository => repository.id == id)
        let to = workspace.repositories.findIndex(repository => repository.id == targetId)
        if (from < 0 || to < 0)
            return
        let [repository] = workspace.repositories.splice(from, 1)
        workspace.repositories.splice(to, 0, repository)
        // Show the new order immediately; a dropped repository already appears in its slot.
        void handle.update()
        workspace = await handle.props.api.updateWorkspace(workspace)
        await handle.update()
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

    function notify(nextNotice: NoticeState) {
        notice = nextNotice
        // Withdraws this notice only if nothing has replaced it since.
        return () => {
            if (notice == nextNotice)
                notice = undefined
        }
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

function MissingRepository(
    handle: Handle<
        {
            repository: Extract<Workspace["repositories"][number], { status: "missing" }>
            workspace: Workspace
            select(id: string): void
            locate(id: string): void
            close(id: string): void
            move(id: string, targetId: string): void
            railCollapsed: boolean
            toggleRail(): void
            addRepository(): void
        }
    >,
) {
    return () => (
        <section class="workspace missing-repository" mix={workspace}>
            <RepositoryRail
                railCollapsed={handle.props.railCollapsed}
                toggleRail={handle.props.toggleRail}
                activeId={handle.props.repository.id}
                workspace={handle.props.workspace}
                selectRepository={handle.props.select}
                closeRepository={handle.props.close}
                moveRepository={handle.props.move}
                addRepository={handle.props.addRepository}
            />
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
