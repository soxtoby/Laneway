/** @jsxImportSource react */
import type { ReactNode } from "react"
import type { IconImageApi } from "../src/repository-icon-images"
import type { AppController, AppSnapshot } from "./app-controller"
import { ContextMenuHost } from "./context-menu"
import { GitSettingsDialog } from "./git-settings-dialog"
import { ArchiveIcon, MoonIcon, PullIcon, RedoIcon, SearchIcon, SettingsIcon, SunIcon, UndoIcon } from "./icons"
import { LocalBranchDialog } from "./local-branch-dialog"
import { MissingRepository } from "./missing-repository"
import { Notices } from "./notices"
import { EntryDialogs } from "./repository-entry-dialogs"
import { RepositoryIdentityDialog } from "./repository-identity-dialog"
import { RepositoryPanel } from "./repository-panel"
import { Starting, StartupFailed, WorkspaceRecovery } from "./startup"
import { StashesDialog } from "./stashes-dialog"
import { Button } from "./ui/Button"
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
    let columnsBusy = useSnapshot(columns).busy
    let worktreesBusy = useSnapshot(worktrees).busy
    let branchesBusy = useSnapshot(branches).busy
    let operating = columnsBusy || worktreesBusy || branchesBusy
    let settings = useSnapshot(gitSettings).settings
    let busy = snapshot.opening || entering
    let active = workspace.repositories.find(repository => repository.id == workspace.activeRepositoryId)
    return (
        <div className="shell">
            <Header
                tabs={active?.status == "available" && <ColumnTabs columns={columns} />}
                actions={active?.status == "available"
                    ? {
                        busy: operating,
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
                        <main className="columns">
                            {active.status == "missing"
                                ? (
                                    <MissingRepository
                                        repository={active}
                                        onLocate={() => void controller.locateRepository(active.id)}
                                        onClose={() => void controller.closeRepository(active.id)}
                                    />
                                )
                                : <WorkspaceColumns controller={controller} fileListView={snapshot.fileListView} />}
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
            <RepositoryIdentityDialog editor={identity} repositories={workspace.repositories} api={api} />
            <Notices controller={controller} notice={notice} />
        </div>
    )
}

interface HeaderProps {
    tabs: ReactNode
    /** The open repository's operations; absent when none is open. */
    actions?: { busy: boolean; stashes(): void; undo(): void; redo(): void }
    appearance: "light" | "dark"
    busy: boolean
    onToggleAppearance(): void
    onOpenSettings(): void
}

// Pull latest stands in until its screen moves (migration step 8).
function Header({ tabs, actions, appearance, busy, onToggleAppearance, onOpenSettings }: HeaderProps) {
    let appearanceLabel = appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"
    return (
        <header className="header drag-region">
            <span className="brand">Laneway</span>
            {tabs}
            <span className="spacer" />
            <HeaderButton label="Command Lens">
                <SearchIcon />
            </HeaderButton>
            {actions && (
                <>
                    <Button variant="accent">
                        <PullIcon />
                        Pull latest
                    </Button>
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
