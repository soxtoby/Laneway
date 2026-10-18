/** @jsxImportSource react */
import type { BranchHistoryCommit, ChangedFile } from "@laneway/shared"
import { type ReactNode, useState } from "react"
import { Button as AriaButton, GridList, type Key } from "react-aria-components"
import type { IconImageApi } from "../src/repository-icon-images"
import type { AppController, AppSnapshot } from "./app-controller"
import type { WorktreeColumn } from "./column-preview"
import { ContextMenuHost } from "./context-menu"
import { IconButton, MoreMenu } from "./controls"
import { DenseRow } from "./dense-row"
import { GitSettingsDialog } from "./git-settings-dialog"
import { AddIcon, ArchiveIcon, BranchIcon, CloseIcon, DeletedIcon, FolderIcon, MaximizeIcon, ModifiedIcon, MoonIcon, MoreIcon, OpenColumnIcon, PullIcon, RedoIcon, SearchIcon, SettingsIcon, SunIcon, TreeIcon, UndoIcon } from "./icons"
import { Notices } from "./notices"
import { EntryDialogs } from "./repository-entry-dialogs"
import { RepositoryPanel } from "./repository-panel"
import { Starting, StartupFailed, WorkspaceRecovery } from "./startup"
import { Button } from "./ui/Button"
import { Checkbox } from "./ui/Checkbox"
import { Disclosure, DisclosureHeader, DisclosurePanel } from "./ui/Disclosure"
import { Menu, MenuItem, MenuTrigger } from "./ui/Menu"
import { ProgressCircle } from "./ui/ProgressCircle"
import { Tab, TabList, Tabs } from "./ui/Tabs"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import { useSnapshot } from "./use-snapshot"
import { Welcome } from "./welcome"
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
    let { workspace, preview, appearance, notice } = snapshot
    let { entry, gitSettings } = controller
    let entering = useSnapshot(entry).operation != "idle"
    let settings = useSnapshot(gitSettings).settings
    let busy = snapshot.opening || entering
    let active = workspace.repositories.find(repository => repository.id == workspace.activeRepositoryId)
    let columns = preview?.status == "ready" ? preview.columns : []
    return (
        <div className="shell">
            <Header
                columns={columns}
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
                            onSelect={id => void controller.selectRepository(id)}
                            onReorder={ids => void controller.reorderRepositories(ids)}
                            onClose={id => void controller.closeRepository(id)}
                            onAdd={entry.openAdd}
                        />
                        <main className="columns">
                            {preview?.status == "loading" && <ProgressCircle isIndeterminate aria-label="Loading repository" />}
                            {preview?.status == "failed" && <p>{preview.error}</p>}
                            {active.status == "missing" && <p>{active.error.message}</p>}
                            {columns.map(column => <Column key={column.id} column={column} controller={controller} />)}
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
            <Notices controller={controller} notice={notice} />
        </div>
    )
}

interface HeaderProps {
    columns: WorktreeColumn[]
    repositoryOpen: boolean
    appearance: "light" | "dark"
    busy: boolean
    onToggleAppearance(): void
    onOpenSettings(): void
}

// Pull latest, Stashes, Undo, and Redo stand in until their screens move (migration steps 5 and 8).
function Header({ columns, repositoryOpen, appearance, busy, onToggleAppearance, onOpenSettings }: HeaderProps) {
    let [selected, setSelected] = useState<Key>()
    let selectedKey = columns.some(column => column.id == selected) ? selected : columns[0]?.id
    let showColumn = (id: Key) => {
        setSelected(id)
        document.querySelector(`[data-column-id="${CSS.escape(String(id))}"]`)?.scrollIntoView({ behavior: "smooth", inline: "nearest" })
    }
    let appearanceLabel = appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"
    return (
        <header className="header drag-region">
            <span className="brand">Laneway</span>
            {columns.length > 0 && selectedKey != null && (
                <Tabs aria-label="Open columns" selectedKey={selectedKey} onSelectionChange={showColumn}>
                    <TabList aria-label="Open columns">
                        {columns.map(column => <Tab key={column.id} id={column.id}>{column.worktree.name}</Tab>)}
                    </TabList>
                </Tabs>
            )}
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

// The spike's column, standing in until Workspace Columns move (migration step 3).
function Column({ column, controller }: { column: WorktreeColumn; controller: AppController }) {
    return (
        <section className="column" aria-label={column.worktree.name} data-column-id={column.id}>
            <div className="column-header">
                <FolderIcon />
                <div className="column-title">
                    <span className="column-name">{column.worktree.name}</span>
                    <span className="column-path">{column.worktree.path}</span>
                </div>
                <IconButton label="Search this column">
                    <SearchIcon />
                </IconButton>
                <IconButton label="Expand column">
                    <MaximizeIcon />
                </IconButton>
                <MenuTrigger>
                    <AriaButton className="icon-button" aria-label="Column actions">
                        <MoreIcon />
                    </AriaButton>
                    <Menu>
                        <MenuItem>Open in Explorer</MenuItem>
                        <MenuItem>Copy path</MenuItem>
                        <MenuItem>Open terminal here</MenuItem>
                    </Menu>
                </MenuTrigger>
            </div>
            <div className="column-body">
                {column.stashes.map(stash => (
                    <div key={stash.id} className="stash-row">
                        <ArchiveIcon />
                        <span className="stash-label">{stash.label}</span>
                        <Button variant="secondary">Apply</Button>
                        <IconButton label="Drop stash">
                            <CloseIcon />
                        </IconButton>
                    </div>
                ))}
                <WorkingChanges files={column.changes} controller={controller} />
                <div className="branch-header">
                    <BranchIcon />
                    <span className="branch-name">{column.branchName}</span>
                    {column.branch.ahead > 0 && <span className="badge" data-variant="ahead">{`${column.branch.ahead} ahead`}</span>}
                    {column.branch.behind > 0 && <span className="badge">{`${column.branch.behind} behind`}</span>}
                    <span className="spacer" />
                    <MoreMenu label={`Actions for ${column.branchName}`}>
                        <MenuItem>Rename branch</MenuItem>
                        <MenuItem>Compare with…</MenuItem>
                        <MenuItem>Push</MenuItem>
                    </MoreMenu>
                </div>
                <CommitTrail branchName={column.branchName} commits={column.commits} />
            </div>
        </section>
    )
}

function WorkingChanges({ files, controller }: { files: ChangedFile[]; controller: AppController }) {
    let title = files.length == 0 ? "No Working Changes" : `Working Changes (${files.length})`
    return (
        <div className="working-changes">
            <Disclosure defaultExpanded={files.length > 0}>
                <div className="changes-header">
                    <DisclosureHeader>{title}</DisclosureHeader>
                    <IconButton label="Show as tree">
                        <TreeIcon />
                    </IconButton>
                    <IconButton label="Open in a column">
                        <OpenColumnIcon />
                    </IconButton>
                </div>
                <DisclosurePanel>
                    {files.length > 0 && <FileList files={files} controller={controller} />}
                    <div className="commit-bar">
                        <Button variant="accent" isDisabled={files.length == 0}>Commit…</Button>
                    </div>
                </DisclosurePanel>
            </Disclosure>
        </div>
    )
}

/** Changed files at Laneway's density, with the kit's Checkbox for selection. */
function FileList({ files, controller }: { files: ChangedFile[]; controller: AppController }) {
    return (
        <GridList aria-label="Working Changes" selectionMode="multiple" className="dense-list">
            {files.map(file => {
                let slash = file.path.lastIndexOf("/") + 1
                return (
                    <DenseRow
                        key={file.path}
                        id={file.path}
                        textValue={file.path}
                        className="compact"
                        menu={{ label: `Actions for ${file.path}`, items: () => <FileMenuItems path={file.path} controller={controller} /> }}
                    >
                        {({ actions }) => (
                            <div className="row-content file-content">
                                <Checkbox slot="selection" />
                                <FileStatus file={file} />
                                <span className="file-path">
                                    <span className="file-directory">{file.path.slice(0, slash)}</span>
                                    {file.path.slice(slash)}
                                </span>
                                {actions}
                            </div>
                        )}
                    </DenseRow>
                )
            })}
        </GridList>
    )
}

// The undo window replaces a confirmation dialog. The spike's discard only shows the notices.
function FileMenuItems({ path, controller }: { path: string; controller: AppController }) {
    let discard = () =>
        controller.notify({
            code: "discard.applied",
            message: `Discarded changes to ${path}.`,
            transient: true,
            duration: 6_000,
            action: { label: "Undo", run: () => controller.notify({ code: "discard.undone", message: `Restored ${path}.`, transient: true }) },
        })
    return (
        <>
            <MenuItem onAction={discard}>Discard changes</MenuItem>
            <MenuItem>Copy path</MenuItem>
            <MenuItem>Show history</MenuItem>
        </>
    )
}

function FileStatus({ file }: { file: ChangedFile }) {
    if (file.untracked || file.status.startsWith("A"))
        return <AddIcon className="file-status" data-status="added" aria-label="Added" />
    if (file.status.includes("D"))
        return <DeletedIcon className="file-status" data-status="deleted" aria-label="Deleted" />
    return <ModifiedIcon className="file-status" data-status="modified" aria-label="Modified" />
}

/** The Commit Trail: the same dense rows with a graph gutter. */
function CommitTrail({ branchName, commits }: { branchName: string; commits: BranchHistoryCommit[] }) {
    return (
        <GridList aria-label={`Commits on ${branchName}`} selectionMode="multiple" selectionBehavior="replace" className="dense-list">
            {commits.map((commit, index) => (
                <DenseRow
                    key={commit.objectId}
                    id={commit.objectId}
                    textValue={commit.subject}
                    menu={{ label: `Actions for ${commit.subject}`, items: () => <CommitMenuItems /> }}
                >
                    {({ actions }) => (
                        <div className="row-content commit-content">
                            <span className="graph-cell" aria-hidden>
                                <span className="graph-line" data-first={index == 0 || undefined} data-last={index == commits.length - 1 || undefined} />
                                <span className="graph-dot" data-head={index == 0 || undefined} />
                            </span>
                            <span className="commit-subject">{commit.subject}</span>
                            <span className="commit-time">{relativeTime(commit.authoredAt)}</span>
                            {actions}
                        </div>
                    )}
                </DenseRow>
            ))}
        </GridList>
    )
}

function CommitMenuItems() {
    return (
        <>
            <MenuItem>Reword…</MenuItem>
            <MenuItem>Copy commit ID</MenuItem>
            <MenuItem>Compare with working tree</MenuItem>
            <MenuItem>Undo commit</MenuItem>
        </>
    )
}

let relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" })

function relativeTime(seconds: number) {
    let minutes = Math.round((seconds * 1000 - Date.now()) / 60000)
    if (Math.abs(minutes) < 60)
        return relativeFormat.format(minutes, "minute")
    let hours = Math.round(minutes / 60)
    if (Math.abs(hours) < 24)
        return relativeFormat.format(hours, "hour")
    return relativeFormat.format(Math.round(hours / 24), "day")
}
