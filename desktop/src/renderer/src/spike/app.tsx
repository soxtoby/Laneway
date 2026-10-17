/** @jsxImportSource react */
import type { BranchHistoryCommit, ChangedFile } from "@laneway/shared"
import { type ReactNode, useEffect, useState } from "react"
import { Button as AriaButton, GridList, GridListItem, type Key } from "react-aria-components"
import { ContextMenuArea } from "./context-menu-area"
import { IconButton, MoreMenu } from "./controls"
import { readRepositoryView, type RepositoryView, type WorktreeColumn } from "./data"
import { AddIcon, ArchiveIcon, BranchIcon, CloseIcon, DeletedIcon, FolderIcon, MaximizeIcon, ModifiedIcon, MoonIcon, MoreIcon, OpenColumnIcon, PullIcon, RedoIcon, SearchIcon, SettingsIcon, SunIcon, TreeIcon, UndoIcon } from "./icons"
import { RepositoryPanel } from "./repository-panel"
import { Button } from "./ui/Button"
import { Checkbox } from "./ui/Checkbox"
import { Disclosure, DisclosureHeader, DisclosurePanel } from "./ui/Disclosure"
import { Menu, MenuItem, MenuTrigger } from "./ui/Menu"
import { ProgressCircle } from "./ui/ProgressCircle"
import { Tab, TabList, Tabs } from "./ui/Tabs"
import { MyToastRegion, queue } from "./ui/Toast"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"
import "./laneway.css"

type Api = Window["laneway"]

export function SpikeApp({ api }: { api: Api }) {
    let [view, setView] = useState<RepositoryView>()
    let [appearance, setAppearance] = useState<"light" | "dark">("light")
    let load = () => readRepositoryView(api).then(setView)

    useEffect(() => {
        let alive = true
        void readRepositoryView(api).then(next => {
            if (!alive)
                return
            setView(next)
            setAppearance(next.appearance)
        })
        let unsubscribe = api.onRepositoryChanged(() =>
            void readRepositoryView(api).then(next => {
                if (alive)
                    setView(next)
            })
        )
        return () => {
            alive = false
            unsubscribe()
        }
    }, [api])

    // The main process applies the appearance to Electron's native theme, which the starter's
    // prefers-color-scheme rules follow.
    async function toggleAppearance() {
        setAppearance(await api.setAppearance(appearance == "dark" ? "light" : "dark"))
    }

    async function selectRepository(id: string) {
        await api.selectRepository(id)
        await load()
    }

    // The new order shows at once; a dropped repository already appears in its slot while the workspace saves.
    async function reorderRepositories(ids: string[]) {
        let byOrder = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
        setView(current => current && { ...current, repositories: byOrder(current.repositories) })
        let { workspace } = await api.getState()
        await api.updateWorkspace({ ...workspace, repositories: byOrder(workspace.repositories) })
        await load()
    }

    async function closeRepository(id: string) {
        await api.closeRepository(id)
        await load()
    }

    async function addRepository() {
        let result = await api.openRepository()
        if (result.ok)
            await load()
    }

    return (
        <div className="shell">
            <Header view={view} appearance={appearance} onToggleAppearance={() => void toggleAppearance()} />
            <div className="work-area">
                <RepositoryPanel
                    repositories={view?.repositories ?? []}
                    activeId={view?.activeRepositoryId}
                    api={api}
                    onSelect={id => void selectRepository(id)}
                    onReorder={ids => void reorderRepositories(ids)}
                    onClose={id => void closeRepository(id)}
                    onAdd={() => void addRepository()}
                />
                <main className="columns">
                    {!view && <ProgressCircle isIndeterminate aria-label="Loading repository" />}
                    {view?.error && <p>{view.error}</p>}
                    {view?.columns.map(column => <Column key={column.id} column={column} />)}
                </main>
            </div>
            <MyToastRegion />
        </div>
    )
}

function Header({ view, appearance, onToggleAppearance }: { view?: RepositoryView; appearance: "light" | "dark"; onToggleAppearance: () => void }) {
    let columns = view?.columns ?? []
    let [selected, setSelected] = useState<Key>()
    let selectedKey = columns.some(column => column.id == selected) ? selected : columns[0]?.id
    let showColumn = (id: Key) => {
        setSelected(id)
        document.querySelector(`[data-column-id="${CSS.escape(String(id))}"]`)?.scrollIntoView({ behavior: "smooth", inline: "nearest" })
    }
    return (
        <header className="header spike-drag-region">
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
            <Button variant="accent">
                <PullIcon />
                Pull latest
            </Button>
            <Button variant="secondary">
                <ArchiveIcon />
                Stashes
            </Button>
            <span className="header-divider" />
            <HeaderButton label="Undo">
                <UndoIcon />
            </HeaderButton>
            <HeaderButton label="Redo">
                <RedoIcon />
            </HeaderButton>
            <span className="header-divider" />
            <HeaderButton label={appearance == "dark" ? "Use light appearance" : "Use dark appearance"} onPress={onToggleAppearance}>
                {appearance == "dark" ? <SunIcon /> : <MoonIcon />}
            </HeaderButton>
            <HeaderButton label="Settings">
                <SettingsIcon />
            </HeaderButton>
        </header>
    )
}

function HeaderButton({ label, children, onPress }: { label: string; children: ReactNode; onPress?: () => void }) {
    return (
        <TooltipTrigger>
            <Button variant="quiet" aria-label={label} onPress={onPress}>{children}</Button>
            <Tooltip>{label}</Tooltip>
        </TooltipTrigger>
    )
}

function Column({ column }: { column: WorktreeColumn }) {
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
                <WorkingChanges files={column.changes} />
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

function WorkingChanges({ files }: { files: ChangedFile[] }) {
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
                    {files.length > 0 && <FileList files={files} />}
                    <div className="commit-bar">
                        <Button variant="accent" isDisabled={files.length == 0}>Commit…</Button>
                    </div>
                </DisclosurePanel>
            </Disclosure>
        </div>
    )
}

/** Changed files at Laneway's density: a React Aria GridList with the starter's Checkbox. */
function FileList({ files }: { files: ChangedFile[] }) {
    return (
        <GridList aria-label="Working Changes" selectionMode="multiple" className="dense-list">
            {files.map(file => {
                let slash = file.path.lastIndexOf("/") + 1
                return (
                    <GridListItem key={file.path} id={file.path} textValue={file.path} className="dense-row compact">
                        {({ isHovered, isFocusVisibleWithin }) => (
                            <MenuTrigger trigger="contextMenu">
                                <ContextMenuArea>
                                    <div className="row-content file-content">
                                        <Checkbox slot="selection" />
                                        <FileStatus file={file} />
                                        <span className="file-path">
                                            <span className="file-directory">{file.path.slice(0, slash)}</span>
                                            {file.path.slice(slash)}
                                        </span>
                                        <span className="row-actions" data-visible={isHovered || isFocusVisibleWithin || undefined}>
                                            <MoreMenu label={`Actions for ${file.path}`}>
                                                <FileMenuItems path={file.path} />
                                            </MoreMenu>
                                        </span>
                                    </div>
                                </ContextMenuArea>
                                <Menu>
                                    <FileMenuItems path={file.path} />
                                </Menu>
                            </MenuTrigger>
                        )}
                    </GridListItem>
                )
            })}
        </GridList>
    )
}

function FileMenuItems({ path }: { path: string }) {
    return (
        <>
            <MenuItem onAction={() => discardWithUndo(path)}>Discard changes</MenuItem>
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

// The undo window replaces a confirmation dialog: the action applies immediately.
function discardWithUndo(path: string) {
    queue.add({
        title: "Discarded changes",
        description: path,
        action: { label: "Undo", onAction: () => queue.add({ title: "Restored changes", description: path }, { timeout: 3000 }) },
    }, { timeout: 6000 })
}

/** The Commit Trail: the same dense rows with a graph gutter. */
function CommitTrail({ branchName, commits }: { branchName: string; commits: BranchHistoryCommit[] }) {
    return (
        <GridList aria-label={`Commits on ${branchName}`} selectionMode="multiple" selectionBehavior="replace" className="dense-list">
            {commits.map((commit, index) => (
                <GridListItem key={commit.objectId} id={commit.objectId} textValue={commit.subject} className="dense-row">
                    {({ isHovered, isFocusVisibleWithin }) => (
                        <MenuTrigger trigger="contextMenu">
                            <ContextMenuArea>
                                <div className="row-content commit-content">
                                    <span className="graph-cell" aria-hidden>
                                        <span
                                            className="graph-line"
                                            data-first={index == 0 || undefined}
                                            data-last={index == commits.length - 1 || undefined}
                                        />
                                        <span className="graph-dot" data-head={index == 0 || undefined} />
                                    </span>
                                    <span className="commit-subject">{commit.subject}</span>
                                    <span className="commit-time">{relativeTime(commit.authoredAt)}</span>
                                    <span className="row-actions" data-visible={isHovered || isFocusVisibleWithin || undefined}>
                                        <MoreMenu label={`Actions for ${commit.subject}`}>
                                            <CommitMenuItems />
                                        </MoreMenu>
                                    </span>
                                </div>
                            </ContextMenuArea>
                            <Menu>
                                <CommitMenuItems />
                            </Menu>
                        </MenuTrigger>
                    )}
                </GridListItem>
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
