import type { AvailableOpenRepository, FileListView } from "@laneway/shared"
import { Activity, type ReactNode, useEffect } from "react"
import type { AppController, AppSnapshot } from "./app-controller"
import type { BackgroundFetch } from "./background-fetch"
import { BranchGraphPanel, defaultGraphWidth } from "./branch-graph"
import { CommandLensDialog } from "./command-lens-dialog"
import { CommitAgesShown } from "./commit-age"
import { ContextMenuHost } from "./context-menu"
import { GitSettingsDialog } from "./git-settings-dialog"
import { ReturnDialog } from "./historical-edit-banner"
import { ArchiveIcon, BrandMark, GraphIcon, MoonIcon, RedoIcon, SearchIcon, SettingsIcon, SunIcon, UndoIcon, UpdateIcon } from "./icons"
import { LocalBranchDialog } from "./local-branch-dialog"
import { MissingRepository } from "./missing-repository"
import { Notices } from "./notices"
import { PublishConfirmation, PublishDialog } from "./publish-control"
import { FetchButton } from "./pull-control"
import { PullDialog } from "./pull-dialog"
import { RebaseDialog } from "./rebase-dialog"
import { EntryDialogs } from "./repository-entry-dialogs"
import type { IconImageApi } from "./repository-icon-images"
import { RepositoryIdentityDialog } from "./repository-identity-dialog"
import { RepositoryPanel } from "./repository-panel"
import { ScriptDialog } from "./script-dialog"
import { Starting, StartupFailed, WorkspaceRecovery } from "./startup"
import { StashesDialog } from "./stashes-dialog"
import { Button } from "./ui/Button"
import { ToggleButton } from "./ui/ToggleButton"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { RepositoryScope, useRepositorySnapshot, useSnapshot } from "./use-snapshot"
import { Welcome } from "./welcome"
import { ColumnTabs, WorkspaceColumns } from "./workspace-columns"
import { WorktreeDialog } from "./worktree-dialog"
import "./laneway.css"

export function App({ api, controller }: { api: IconImageApi; controller: AppController }) {
    let snapshot = useSnapshot(controller)
    if (snapshot.status == "starting")
        return <Starting />
    if (snapshot.status == "failed")
        return <StartupFailed error={snapshot.error} onRetry={() => void controller.start()} />
    return (
        <ContextMenuHost>
            <Shell api={api} controller={controller} snapshot={snapshot} />
        </ContextMenuHost>
    )
}

function Shell({ api, controller, snapshot }: { api: IconImageApi; controller: AppController; snapshot: Extract<AppSnapshot, { status: "ready" }> }) {
    let { workspace, appearance, notice } = snapshot
    let { entry, gitSettings, identity, columns, worktrees, branches, stashes } = controller
    let entering = useSnapshot(entry).operation != "idle"
    // Repository operations wait for any other that is under way.
    let { busy: columnsBusy, graphView, graph } = useSnapshot(columns)
    let worktreesBusy = useSnapshot(worktrees).busy
    let branchesBusy = useSnapshot(branches).busy
    let operating = columnsBusy || worktreesBusy || branchesBusy
    let settings = useSnapshot(gitSettings).settings
    let busy = snapshot.opening || entering
    useLensShortcut(controller.lens.open)
    let active = workspace.repositories.find(repository => repository.id == workspace.activeRepositoryId)
    return (
        <div className="shell">
            <Header
                onOpenLens={controller.lens.open}
                graph={active?.status == "available" ? { shown: graphView.shown, toggle: columns.toggleGraph } : undefined}
                tabs={active?.status == "available" && <ColumnTabs columns={columns} />}
                actions={active?.status == "available"
                    ? {
                        busy: operating,
                        fetch: { fetching: controller.fetching, repositoryId: active.id, remotes: graph && graph.availableRemotes.length > 0 },
                        stashes: () => void stashes.open(active.id, active.info.mainWorktree),
                        undo: () => void worktrees.transition(active.id, "undo"),
                        redo: () => void worktrees.transition(active.id, "redo"),
                    }
                    : undefined}
                update={snapshot.readyUpdate ? { version: snapshot.readyUpdate, busy: busy || operating, install: controller.installUpdate } : undefined}
                appearance={appearance}
                busy={busy}
                onToggleAppearance={() => void controller.toggleAppearance()}
                onOpenSettings={gitSettings.open}
            />
            {active
                ? (
                    <div className="work-area">
                        <RepositoryPanel
                            repositories={workspace.repositories}
                            activeId={workspace.activeRepositoryId}
                            api={api}
                            busy={busy}
                            onSelect={id => void controller.selectRepository(id)}
                            onReorder={ids => void controller.reorderRepositories(ids)}
                            onCustomize={identity.open}
                            onClose={id => void controller.closeRepository(id)}
                            onAdd={entry.openAdd}
                        />
                        {workspace.repositories.map(repository =>
                            repository.status == "available" && (
                                <Activity key={repository.id} mode={repository.id == active.id ? "visible" : "hidden"}>
                                    <RepositoryWork
                                        controller={controller}
                                        repository={repository}
                                        graphWidth={snapshot.graphWidth ?? defaultGraphWidth}
                                        fileListView={snapshot.fileListView}
                                        showCommitAges={snapshot.showCommitAges}
                                    />
                                </Activity>
                            )
                        )}
                        {active.status == "missing" && (
                            <main className="columns">
                                <MissingRepository
                                    repository={active}
                                    onLocate={() => void controller.locateRepository(active.id)}
                                    onClose={() => void controller.closeRepository(active.id)}
                                />
                            </main>
                        )}
                    </div>
                )
                : (
                    <Welcome
                        settings={settings}
                        busy={busy}
                        onOpen={() => void controller.openRepository()}
                        onClone={() => void entry.openClone()}
                        onInitialize={() => void entry.openInitialize()}
                    />
                )}
            {workspace.persistenceError && workspace.persistenceError.code != "workspace.partial" && (
                <WorkspaceRecovery
                    error={workspace.persistenceError}
                    onReset={() => void controller.resetWorkspace()}
                />
            )}
            <EntryDialogs entry={entry} busy={snapshot.opening} />
            <GitSettingsDialog gitSettings={gitSettings} />
            <LocalBranchDialog branches={branches} />
            <WorktreeDialog worktrees={worktrees} />
            <StashesDialog stashes={stashes} />
            <RebaseDialog rebase={controller.rebase} />
            <ReturnDialog edits={controller.edits} />
            <PublishConfirmation publish={controller.publish} />
            <PublishDialog publish={controller.publish} repositoryId={active?.id} />
            <PullDialog pull={controller.pull} onResolve={(_repositoryId, branch) => columns.open(`branch:refs/heads/${branch}`)} />
            <CommandLensDialog controller={controller} workspace={workspace} />
            <RepositoryIdentityDialog editor={identity} repositories={workspace.repositories} api={api} />
            <ScriptDialog scripts={controller.scripts} workspace={workspace} />
            <Notices controller={controller} notice={notice} />
        </div>
    )
}

/**
 * A repository's Branch Graph and Workspace Columns. Every open repository keeps its own, hidden while another shows,
 * so switching back shows them as they were, scrolled where they were, without drawing them again.
 */
function RepositoryWork({ controller, repository, graphWidth, fileListView, showCommitAges }: {
    controller: AppController
    repository: AvailableOpenRepository
    graphWidth: number
    fileListView: FileListView
    showCommitAges: boolean
}) {
    let snapshot = useRepositorySnapshot(controller.columns, repository.id)
    // A repository that hasn't shown yet has nothing to draw.
    if (!snapshot)
        return null
    return (
        <RepositoryScope value={repository.id}>
            {snapshot.graphView.shown && (
                <BranchGraphPanel
                    controller={controller}
                    repositoryId={repository.id}
                    mainWorktree={repository.info.mainWorktree}
                    snapshot={snapshot}
                    width={graphWidth}
                    onResize={width => void controller.setGraphWidth(width)}
                />
            )}
            <main className="columns">
                <CommitAgesShown value={showCommitAges}>
                    <WorkspaceColumns controller={controller} repositoryId={repository.id} snapshot={snapshot} fileListView={fileListView} />
                </CommitAgesShown>
            </main>
        </RepositoryScope>
    )
}

interface HeaderProps {
    onOpenLens(): void
    /** The open repository's Branch Graph, which shows beside its columns. */
    graph?: { shown: boolean; toggle(): void }
    tabs: ReactNode
    /** The open repository's operations; absent when none is open. */
    actions?: { busy: boolean; fetch: { fetching: BackgroundFetch; repositoryId: string; remotes?: boolean }; stashes(): void; undo(): void; redo(): void }
    /** A newer Laneway, downloaded; it can't restart into it while an operation is under way. */
    update?: { version: string; busy: boolean; install(): void }
    appearance: "light" | "dark"
    busy: boolean
    onToggleAppearance(): void
    onOpenSettings(): void
}

function Header({ onOpenLens, graph, tabs, actions, update, appearance, busy, onToggleAppearance, onOpenSettings }: HeaderProps) {
    let appearanceLabel = appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"
    return (
        <header className="header drag-region">
            <span className="brand">
                <BrandMark />
                Laneway
            </span>
            {graph && (
                <TooltipTrigger>
                    <ToggleButton
                        variant="quiet"
                        aria-label={graph.shown ? "Hide Branch Graph" : "Show Branch Graph"}
                        isSelected={graph.shown}
                        onChange={graph.toggle}
                    >
                        <GraphIcon />
                    </ToggleButton>
                    <Tooltip>{graph.shown ? "Hide Branch Graph" : "Show Branch Graph"}</Tooltip>
                </TooltipTrigger>
            )}
            {tabs}
            <span className="spacer" />
            <HeaderButton label="Command Lens" tooltip="Command Lens (Ctrl+K)" onPress={onOpenLens}>
                <SearchIcon />
            </HeaderButton>
            {actions && (
                <>
                    <FetchButton {...actions.fetch} />
                    <Button variant="secondary" isDisabled={actions.busy} onPress={actions.stashes}>
                        <ArchiveIcon />
                        Stashes
                    </Button>
                    <span className="header-divider" />
                    <HeaderButton label="Undo last operation" tooltip="Undo (Ctrl+Z)" isDisabled={actions.busy} onPress={actions.undo}>
                        <UndoIcon />
                    </HeaderButton>
                    <HeaderButton label="Redo operation" tooltip="Redo (Ctrl+Shift+Z)" isDisabled={actions.busy} onPress={actions.redo}>
                        <RedoIcon />
                    </HeaderButton>
                </>
            )}
            <span className="header-divider" />
            {update && (
                <TooltipTrigger>
                    <Button variant="secondary" isDisabled={update.busy} onPress={update.install}>
                        <UpdateIcon />
                        Restart to update
                    </Button>
                    <Tooltip>Restart into Laneway {update.version}</Tooltip>
                </TooltipTrigger>
            )}
            <HeaderButton label={appearanceLabel} onPress={onToggleAppearance}>
                {appearance == "dark" ? <SunIcon /> : <MoonIcon />}
            </HeaderButton>
            <HeaderButton label="Git settings" isDisabled={busy} onPress={onOpenSettings}>
                <SettingsIcon />
            </HeaderButton>
        </header>
    )
}

// Ctrl+K opens the Command Lens from anywhere.
function useLensShortcut(open: () => void) {
    useEffect(() => {
        let keyDown = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() == "k") {
                event.preventDefault()
                open()
            }
        }
        window.addEventListener("keydown", keyDown)
        return () => window.removeEventListener("keydown", keyDown)
    }, [open])
}

function HeaderButton({ label, tooltip = label, children, isDisabled, onPress }: {
    label: string
    tooltip?: string
    children: ReactNode
    isDisabled?: boolean
    onPress?: () => void
}) {
    return (
        <TooltipTrigger>
            <Button variant="quiet" aria-label={label} isDisabled={isDisabled} onPress={onPress}>{children}</Button>
            <Tooltip>{tooltip}</Tooltip>
        </TooltipTrigger>
    )
}
