import type { Appearance, GitSettingsState } from "@git-workbench/shared"
import { on, type Handle } from "remix/ui"

export interface EntryActions {
    busy: boolean
    openRepository(): void
    openClone(): void
    openInitialize(): void
}

export function WorkbenchHeader(handle: Handle<{
    busy: boolean
    appearance: Appearance
    openSettings(): void
    toggleAppearance(): void
}>) {
    return () => (
        <header class="masthead">
            <div class="brand">
                <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
                <span>Git Workbench</span>
            </div>
            <div class="header-actions">
                <button class="icon-button" type="button" aria-label={handle.props.appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"} title={handle.props.appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"} mix={[on("click", handle.props.toggleAppearance)]}>{handle.props.appearance == "dark" ? "☀" : "☽"}</button>
                <button class="icon-button" type="button" aria-label="Git settings" title="Git settings" disabled={handle.props.busy} mix={[on("click", handle.props.openSettings)]}>⚙</button>
            </div>
        </header>
    )
}

export function WorkbenchStatus(handle: Handle<{ settings: GitSettingsState; engine: string }>) {
    return () => (
        <footer class="status-bar">
            <span class={`pulse ${handle.props.settings.error ? "error" : ""}`}></span>
            <span>{handle.props.settings.git ? `Git ${handle.props.settings.git.version}` : "Git unavailable"}</span>
            <span class="status-path" title={handle.props.settings.git?.path ?? ""}>{handle.props.settings.git?.path ?? ""}</span>
            <span class="status-spacer"></span>
            <span>{handle.props.engine}</span>
        </footer>
    )
}

export function Welcome(handle: Handle<EntryActions & { settings: GitSettingsState }>) {
    return () => (
        <section class="workspace welcome" aria-live="polite">
            <section class="entry-panel" aria-label="Add repository">
                <header><h2>No repository open</h2></header>
                {handle.props.settings.error && <p class="entry-warning">Git unavailable. {handle.props.settings.error.message}</p>}
                <EntryOptions busy={handle.props.busy} openRepository={handle.props.openRepository} openClone={handle.props.openClone} openInitialize={handle.props.openInitialize} />
            </section>
        </section>
    )
}

export function EntryOptions(handle: Handle<EntryActions>) {
    return () => (
        <div class="entry-grid">
            <EntryCard title="Open" description="Choose an existing repository root." disabled={handle.props.busy} action={handle.props.openRepository} />
            <EntryCard title="Clone" description="Copy a remote or local repository." disabled={handle.props.busy} action={handle.props.openClone} />
            <EntryCard title="Initialize" description="Create a repository in a directory." disabled={handle.props.busy} action={handle.props.openInitialize} />
        </div>
    )
}

function EntryCard(handle: Handle<{ title: string; description: string; disabled: boolean; action(): void }>) {
    return () => (
        <button class="entry-card" type="button" disabled={handle.props.disabled} mix={[on("click", handle.props.action)]}>
            <strong>{handle.props.title}</strong>
            <span>{handle.props.description}</span>
        </button>
    )
}
