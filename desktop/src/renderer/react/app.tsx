/** @jsxImportSource react */
import type { ReactNode } from "react"
import type { IconImageApi } from "../src/repository-icon-images"
import type { AppController, AppSnapshot } from "./app-controller"
import { ContextMenuHost } from "./context-menu"
import { GitSettingsDialog } from "./git-settings-dialog"
import { ArchiveIcon, MoonIcon, PullIcon, RedoIcon, SearchIcon, SettingsIcon, SunIcon, UndoIcon } from "./icons"
import { MissingRepository } from "./missing-repository"
import { Notices } from "./notices"
import { EntryDialogs } from "./repository-entry-dialogs"
import { RepositoryIdentityDialog } from "./repository-identity-dialog"
import { RepositoryPanel } from "./repository-panel"
import { Starting, StartupFailed, WorkspaceRecovery } from "./startup"
import { Button } from "./ui/Button"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot } from "./use-snapshot"
import { Welcome } from "./welcome"
import { ColumnTabs, WorkspaceColumns } from "./workspace-columns"
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
    let { entry, gitSettings, identity, columns } = controller
    let entering = useSnapshot(entry).operation != "idle"
    let settings = useSnapshot(gitSettings).settings
    let busy = snapshot.opening || entering
    let active = workspace.repositories.find(repository => repository.id == workspace.activeRepositoryId)
    return (
        <div className="shell">
            <Header
                tabs={active?.status == "available" && <ColumnTabs columns={columns} />}
                repositoryOpen={active?.status == "available"}
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
                                : <WorkspaceColumns columns={columns} notify={controller.notify} />}
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
            <RepositoryIdentityDialog editor={identity} repositories={workspace.repositories} api={api} />
            <Notices controller={controller} notice={notice} />
        </div>
    )
}

interface HeaderProps {
    tabs: ReactNode
    repositoryOpen: boolean
    appearance: "light" | "dark"
    busy: boolean
    onToggleAppearance(): void
    onOpenSettings(): void
}

// Pull latest, Stashes, Undo, and Redo stand in until their screens move (migration steps 5 and 8).
function Header({ tabs, repositoryOpen, appearance, busy, onToggleAppearance, onOpenSettings }: HeaderProps) {
    let appearanceLabel = appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"
    return (
        <header className="header drag-region">
            <span className="brand">Laneway</span>
            {tabs}
            <span className="spacer" />
            <HeaderButton label="Command Lens">
                <SearchIcon />
            </HeaderButton>
            {repositoryOpen && (
                <>
                    <Button variant="accent">
                        <PullIcon />
                        Pull latest
                    </Button>
                    <Button variant="secondary">
                        <ArchiveIcon />
                        Stashes
                    </Button>
                    <span className="header-divider" />
                    <HeaderButton label="Undo last operation">
                        <UndoIcon />
                    </HeaderButton>
                    <HeaderButton label="Redo operation">
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

function HeaderButton({ label, children, isDisabled, onPress }: { label: string; children: ReactNode; isDisabled?: boolean; onPress?: () => void }) {
    return (
        <TooltipTrigger>
            <Button variant="quiet" aria-label={label} isDisabled={isDisabled} onPress={onPress}>{children}</Button>
            <Tooltip>{label}</Tooltip>
        </TooltipTrigger>
    )
}
