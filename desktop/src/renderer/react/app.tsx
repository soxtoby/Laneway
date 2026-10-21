import { type ReactNode, useEffect } from "react"
import type { AppController, AppSnapshot } from "./app-controller"
import { BranchGraphPanel } from "./branch-graph"
import { CommandLensDialog } from "./command-lens-dialog"
import { CommitAgesShown } from "./commit-age"
import { ContextMenuHost } from "./context-menu"
import { Hint } from "./controls"
import { GitSettingsDialog } from "./git-settings-dialog"
import { ArchiveIcon, BrandMark, GraphIcon, MoonIcon, PullIcon, RedoIcon, SearchIcon, SettingsIcon, SunIcon, UndoIcon } from "./icons"
import { LocalBranchDialog } from "./local-branch-dialog"
import { MissingRepository } from "./missing-repository"
import { Notices } from "./notices"
import { PullDialog } from "./pull-dialog"
import { RebaseDialog } from "./rebase-dialog"
import { EntryDialogs } from "./repository-entry-dialogs"
import type { IconImageApi } from "./repository-icon-images"
import { RepositoryIdentityDialog } from "./repository-identity-dialog"
import { RepositoryPanel } from "./repository-panel"
import { Starting, StartupFailed, WorkspaceRecovery } from "./startup"
import { StashesDialog } from "./stashes-dialog"
import { Button } from "./ui/Button"
import { ToggleButton } from "./ui/ToggleButton"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot } from "./use-snapshot"
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
    let pulling = useSnapshot(controller.pull).running
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
                        pull: {
                            available: graph != undefined && graph.availableRemotes.length > 0,
                            hint: !graph
                                ? "Loading the Branch Graph…"
                                : graph.availableRemotes.length == 0
                                ? "Add a remote to pull."
                                : "Fetch and synchronize open stacks",
                            running: pulling[active.id],
                            start: () => void controller.pull.start(active.id),
                            cancel: () => void controller.pull.cancel(active.id),
                        },
                        stashes: () => void stashes.open(active.id, active.info.mainWorktree),
                        undo: () => void worktrees.transition(active.id, "undo"),
                        redo: () => void worktrees.transition(active.id, "redo"),
                    }
                    : undefined}
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
                        {active.status == "available" && graphView.shown && (
                            <BranchGraphPanel controller={controller} repositoryId={active.id} mainWorktree={active.info.mainWorktree} />
                        )}
                        <main className="columns">
                            {active.status == "missing"
                                ? (
                                    <MissingRepository
                                        repository={active}
                                        onLocate={() => void controller.locateRepository(active.id)}
                                        onClose={() => void controller.closeRepository(active.id)}
                                    />
                                )
                                : (
                                    <CommitAgesShown value={snapshot.showCommitAges}>
                                        <WorkspaceColumns controller={controller} fileListView={snapshot.fileListView} />
                                    </CommitAgesShown>
                                )}
                        </main>
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
            <PullDialog pull={controller.pull} onResolve={(_repositoryId, branch) => columns.open(`branch:refs/heads/${branch}`)} />
            <CommandLensDialog controller={controller} workspace={workspace} />
            <RepositoryIdentityDialog editor={identity} repositories={workspace.repositories} api={api} />
            <Notices controller={controller} notice={notice} />
        </div>
    )
}

interface HeaderProps {
    onOpenLens(): void
    /** The open repository's Branch Graph, which shows beside its columns. */
    graph?: { shown: boolean; toggle(): void }
    tabs: ReactNode
    /** The open repository's operations; absent when none is open. */
    actions?: { busy: boolean; pull: PullControl; stashes(): void; undo(): void; redo(): void }
    appearance: "light" | "dark"
    busy: boolean
    onToggleAppearance(): void
    onOpenSettings(): void
}

/** Pull latest in the header: unavailable without a remote, and while it runs, its progress and Cancel. */
interface PullControl {
    available: boolean
    hint: string
    running?: { message: string }
    start(): void
    cancel(): void
}

function Header({ onOpenLens, graph, tabs, actions, appearance, busy, onToggleAppearance, onOpenSettings }: HeaderProps) {
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
                    {actions.pull.running
                        ? (
                            <span className="pull-progress" role="status">
                                <span className="pull-progress-message">{actions.pull.running.message}</span>
                                <Button variant="secondary" aria-label="Cancel pull" onPress={actions.pull.cancel}>Cancel</Button>
                            </span>
                        )
                        : (
                            // The hint explains a disabled button too, so it sits on a wrapper.
                            <Hint text={actions.pull.hint} forControl>
                                <span className="pull-latest">
                                    <Button variant="accent" isDisabled={actions.busy || !actions.pull.available} onPress={actions.pull.start}>
                                        <PullIcon />
                                        Pull latest
                                    </Button>
                                </span>
                            </Hint>
                        )}
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
