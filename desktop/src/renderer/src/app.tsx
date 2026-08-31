import type { EntryProgress, Workspace } from "@git-workbench/shared"
import { on, type Handle } from "remix/ui"
import { createBranchWorkspace, type BranchWorkspace } from "./branch-workspace"
import { errorMessage, FatalError, Notice, type NoticeState } from "./feedback"
import { createRepositoryEntry, type RepositoryEntry } from "./repository-entry"
import { createGitSettings, type GitSettings } from "./settings"
import { Welcome, WorkbenchHeader } from "./workspace"

type AppState = Awaited<ReturnType<Window["workbench"]["getState"]>>

export function WorkbenchApp(handle: Handle<{ api: Window["workbench"] }>) {
    let initial: AppState | undefined
    let workspace: Workspace | undefined
    let repositoryEntry: RepositoryEntry | undefined
    let gitSettings: GitSettings | undefined
    let branchWorkspace: BranchWorkspace | undefined
    let openingRepository = false
    let notice: NoticeState | undefined
    let fatalError: string | undefined
    let showWelcome = false
    let repositoryOrderBeforeDrag: string[] | undefined

    handle.queueTask(() => void bootstrap())
    handle.signal.addEventListener("abort", () => document.body.classList.remove("busy"), { once: true })

    return () => {
        if (!initial || !workspace || !repositoryEntry || !gitSettings || !branchWorkspace) {
            return fatalError
                ? <FatalError message={fatalError} retry={bootstrap} />
                : <main class="bootstrap-state" aria-live="polite"><p>Starting Git Workbench…</p></main>
        }

        const currentWorkspace = workspace
        const active = currentWorkspace.repositories.find(repository => repository.id == currentWorkspace.activeRepositoryId)
        const busy = openingRepository || repositoryEntry.busy
        return <>
            <main class="shell">
                <WorkbenchHeader
                    settings={gitSettings.current}
                    busy={busy}
                    home={() => {
                        showWelcome = true
                        branchWorkspace?.deactivate()
                        handle.update()
                    }}
                    openSettings={gitSettings.open}
                />
                {active?.status == "available" && !showWelcome
                    ? (
                        branchWorkspace.render(active, currentWorkspace)
                    )
                    : active?.status == "missing" && !showWelcome
                    ? <MissingRepository repository={active} workspace={currentWorkspace} select={selectRepository} locate={locateRepository} close={closeRepository} move={moveRepository} previewMove={previewRepositoryMove} commitOrder={commitRepositoryOrder} cancelMove={cancelRepositoryMove} />
                    : (
                        <Welcome
                            settings={gitSettings.current}
                            busy={busy}
                            openRepository={openRepository}
                            openClone={repositoryEntry.openClone}
                            openInitialize={repositoryEntry.openInitialize}
                        />
                    )}
                <footer><span>System Git</span><i></i><span>{initial.engine.state == "ready" ? `Engine ${initial.engine.version}` : "Engine unavailable"}</span></footer>
            </main>
            {repositoryEntry.render()}
            {gitSettings.render()}
            {branchWorkspace.renderLens(currentWorkspace)}
            <Notice notice={notice} dismiss={() => {
                notice = undefined
                handle.update()
            }} />
            {currentWorkspace.persistenceError && currentWorkspace.persistenceError.code != "workspace.partial" && <WorkspaceRecovery error={currentWorkspace.persistenceError.message} reset={currentWorkspace.persistenceError.code == "workspace.corrupt" || currentWorkspace.persistenceError.code == "workspace.unsupported-version" ? resetWorkspace : undefined} />}
        </>
    }

    async function bootstrap() {
        fatalError = undefined
        await handle.update()
        try {
            initial = await handle.props.api.getState()
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
                workspaceOpened(nextWorkspace) {
                    workspace = nextWorkspace
                    showWelcome = false
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
                showWelcome = false
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
            showWelcome = false
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
            showWelcome = true
        } catch (error) {
            notify({ code: "workspace.reset.failed", message: errorMessage(error) })
        }
        await handle.update()
    }
}

function WorkspaceRecovery(handle: Handle<{ error: string; reset?(): void }>) {
    return () => <aside class="workspace-recovery" aria-live="assertive"><div><strong>Workspace State needs attention</strong><p>{handle.props.error}</p></div>{handle.props.reset && <button type="button" mix={[on("click", handle.props.reset)]}>Reset workspace</button>}</aside>
}

let draggingMissingRepositoryId: string | undefined

function MissingRepository(handle: Handle<{ repository: Extract<Workspace["repositories"][number], { status: "missing" }>; workspace: Workspace; select(id: string): void; locate(id: string): void; close(id: string): void; move(id: string, targetId: string): void; previewMove(id: string, targetId: string): void; commitOrder(): void; cancelMove(): void }>) {
    return () => <section class="workspace missing-repository"><aside class="repository-rail"><div class="rail-heading"><p class="eyebrow">Open repositories</p><span>{handle.props.workspace.repositories.length}</span></div><nav aria-label="Open repositories">{handle.props.workspace.repositories.map((repository, index) => <div draggable title="Drag to reorder · Ctrl+< / Ctrl+>" mix={[on("keydown", event => {
        if (event.ctrlKey && event.shiftKey && (event.key == "<" || event.key == ">")) {
            event.preventDefault()
            const target = handle.props.workspace.repositories[index + (event.key == "<" ? -1 : 1)]
            if (target)
                handle.props.move(repository.id, target.id)
        }
    }), on("dragstart", () => {
        draggingMissingRepositoryId = repository.id
    }), on("dragover", event => {
        event.preventDefault()
        if (draggingMissingRepositoryId)
            handle.props.previewMove(draggingMissingRepositoryId, repository.id)
    }), on("drop", event => {
        event.preventDefault()
        handle.props.commitOrder()
        draggingMissingRepositoryId = undefined
    }), on("dragend", () => {
        if (draggingMissingRepositoryId)
            handle.props.cancelMove()
        draggingMissingRepositoryId = undefined
    })]}><button class={`repository-item ${repository.id == handle.props.repository.id ? "active" : ""}`} type="button" mix={[on("click", () => handle.props.select(repository.id))]}><span>{initials(repository.path)}</span><span><strong>{repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name}</strong><small>{repository.status == "available" ? repository.info.selectedWorktree : "Unavailable"}</small></span></button></div>)}</nav></aside><div class="missing-copy"><p class="eyebrow">Repository unavailable</p><h1>{handle.props.repository.name}</h1><p>{handle.props.repository.path}</p><p>{handle.props.repository.error.message}</p><div class="dialog-actions"><button class="primary-button" type="button" mix={[on("click", () => handle.props.locate(handle.props.repository.id))]}>Locate</button><button class="secondary-button" type="button" mix={[on("click", () => handle.props.close(handle.props.repository.id))]}>Close</button></div></div></section>
}

function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}

function initials(path: string) {
    const words = baseName(path).split(/[-_.\s]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "GW").toUpperCase()
}
