import type { AvailableOpenRepository, GitSettingsState, Workspace } from "@git-workbench/shared"
import { on, type Handle } from "remix/ui"

export interface EntryActions {
    busy: boolean
    openRepository(): void
    openClone(): void
    openInitialize(): void
}

export function WorkbenchHeader(handle: Handle<{
    settings: GitSettingsState
    busy: boolean
    home(): void
    openSettings(): void
}>) {
    return () => (
        <header class="masthead">
            <button class="brand" type="button" aria-label="Git Workbench home" disabled={handle.props.busy} mix={[on("click", handle.props.home)]}>
                <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
                <span><small>Git Workbench</small><strong>Repository desk</strong></span>
            </button>
            <div class="header-actions">
                <span class={`git-badge ${handle.props.settings.error ? "error" : ""}`}><i></i><span>{handle.props.settings.git ? `Git ${handle.props.settings.git.version}` : "Git unavailable"}</span></span>
                <button class="icon-button" type="button" aria-label="Git settings" title="Git settings" disabled={handle.props.busy} mix={[on("click", handle.props.openSettings)]}>⌘</button>
            </div>
        </header>
    )
}

export function Welcome(handle: Handle<EntryActions & { settings: GitSettingsState }>) {
    return () => (
        <section class="workspace welcome" aria-live="polite">
            <section class="welcome-copy">
                <p class="eyebrow">Repository entry</p>
                <h1>Put a line of work<br />on the bench.</h1>
                <p>Open an exact Git root, bring down a remote, or initialize work already on disk.</p>
                <div class="git-readout">
                    <span class={`pulse ${handle.props.settings.error ? "error" : ""}`}></span>
                    <span>{handle.props.settings.error ? "Git unavailable" : handle.props.settings.git?.path ?? "Git unavailable"}</span>
                    {!handle.props.settings.error && <strong>{handle.props.settings.git?.version ?? ""}</strong>}
                </div>
            </section>
            <section class="entry-grid" aria-label="Repository entry actions">
                <EntryCard sequence="01" title="Open" label="Existing repository" description="Choose the root of a Main or linked worktree." disabled={handle.props.busy} action={handle.props.openRepository} />
                <EntryCard sequence="02" title="Clone" label="Remote or local source" description="Use your system credentials, SSH agent, filters, and hooks." disabled={handle.props.busy} action={handle.props.openClone} />
                <EntryCard sequence="03" title="Initialize" label="Directory on disk" description="Keep existing files and let system Git create the repository." disabled={handle.props.busy} action={handle.props.openInitialize} />
            </section>
        </section>
    )
}

export function RepositoryView(handle: Handle<EntryActions & {
    active: AvailableOpenRepository
    workspace: Workspace
    selectRepository(id: string): void
}>) {
    return () => {
        const active = handle.props.active.info
        return (
            <section class="workspace repository-view" aria-live="polite">
                <aside class="repository-rail">
                    <div class="rail-heading"><p class="eyebrow">Open repositories</p><span>{handle.props.workspace.repositories.length}</span></div>
                    <nav aria-label="Open repositories">
                        {handle.props.workspace.repositories.map(repository => (
                            <button
                                class={`repository-item ${repository.id == active.id ? "active" : ""}`}
                                type="button"
                                disabled={handle.props.busy}
                                mix={[on("click", () => handle.props.selectRepository(repository.id))]}
                            >
                                <span>{initials(repository.path)}</span>
                                <span><strong>{repository.status == "available" ? baseName(repository.info.mainWorktree) : repository.name}</strong><small>{repository.status == "available" ? repository.info.selectedWorktree : "Unavailable"}</small></span>
                            </button>
                        ))}
                    </nav>
                    <div class="rail-actions">
                        <button type="button" disabled={handle.props.busy} mix={[on("click", handle.props.openRepository)]}>Open</button>
                        <button type="button" disabled={handle.props.busy} mix={[on("click", handle.props.openClone)]}>Clone</button>
                        <button type="button" disabled={handle.props.busy} mix={[on("click", handle.props.openInitialize)]}>Init</button>
                    </div>
                </aside>
                <section class="repository-shell">
                    <div class="repository-kicker"><span class="pulse"></span>Repository ready</div>
                    <h1>{baseName(active.mainWorktree)}</h1>
                    <p class="repository-path">{active.selectedWorktree}</p>
                    <div class="fact-grid">
                        <Fact label="Selected worktree" value={active.selectedWorktree} />
                        <Fact label="Main Worktree" value={active.mainWorktree} />
                        <Fact label="Object format" value={active.objectFormat.toUpperCase()} />
                        <Fact label="System Git" value={`${active.git.version} · ${active.git.path}`} />
                    </div>
                    <div class="shape-flags">
                        {active.shallow && <span>Shallow</span>}
                        {active.partial && <span>Partial clone</span>}
                        {active.sparse && <span>Sparse checkout</span>}
                        {!active.shallow && !active.partial && !active.sparse && <span>Full repository</span>}
                    </div>
                    <div class="next-module"><span>Next module</span><p>Repository evidence and the Branch Graph arrive in SOX-131.</p></div>
                </section>
            </section>
        )
    }
}

function EntryCard(handle: Handle<{ sequence: string; title: string; label: string; description: string; disabled: boolean; action(): void }>) {
    return () => (
        <button class="entry-card" type="button" disabled={handle.props.disabled} mix={[on("click", handle.props.action)]}>
            <span class="sequence">{handle.props.sequence}</span>
            <span><small>{handle.props.label}</small><strong>{handle.props.title}</strong><p>{handle.props.description}</p></span>
            <i aria-hidden="true">↗</i>
        </button>
    )
}

function Fact(handle: Handle<{ label: string; value: string }>) {
    return () => <div><dt>{handle.props.label}</dt><dd title={handle.props.value}>{handle.props.value}</dd></div>
}

function baseName(path: string) {
    return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path
}

function initials(path: string) {
    const words = baseName(path).split(/[-_.\s]+/).filter(Boolean)
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0]?.slice(0, 2) ?? "GW").toUpperCase()
}
