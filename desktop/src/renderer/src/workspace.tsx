import type { Appearance, GitSettingsState } from "@git-workbench/shared"
import { css, type Handle, on } from "remix/ui"

export interface EntryActions {
    busy: boolean
    openRepository(): void
    openClone(): void
    openInitialize(): void
}

export function WorkbenchHeader(
    handle: Handle<{
        busy: boolean
        appearance: Appearance
        openSettings(): void
        toggleAppearance(): void
    }>,
) {
    return () => (
        <header class="masthead" mix={masthead}>
            <div class="brand" mix={brand}>
                <span class="brand-mark" aria-hidden="true" mix={brandMark}>
                    <i mix={brandMarkI}>
                    </i>
                    <i mix={brandMarkI}>
                    </i>
                    <i mix={brandMarkI}>
                    </i>
                </span>
                <span mix={brandSpan}>
                    Git Workbench
                </span>
            </div>
            <div class="header-actions" mix={headerActions}>
                <button
                    class="icon-button"
                    type="button"
                    aria-label={handle.props.appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"}
                    title={handle.props.appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"}
                    mix={[iconButton, on("click", handle.props.toggleAppearance)]}
                >
                    {handle.props.appearance == "dark" ? "☀" : "☽"}
                </button>
                <button
                    class="icon-button"
                    type="button"
                    aria-label="Git settings"
                    title="Git settings"
                    disabled={handle.props.busy}
                    mix={[iconButton, on("click", handle.props.openSettings)]}
                >
                    ⚙
                </button>
            </div>
        </header>
    )
}

export function WorkbenchStatus(handle: Handle<{ settings: GitSettingsState; engine: string }>) {
    return () => (
        <footer class="status-bar" mix={statusBar}>
            <span class={`pulse ${handle.props.settings.error ? "error" : ""}`} mix={pulse}>
            </span>
            <span>{handle.props.settings.git ? `Git ${handle.props.settings.git.version}` : "Git unavailable"}</span>
            <span class="status-path" title={handle.props.settings.git?.path ?? ""} mix={statusPath}>
                {handle.props.settings.git?.path ?? ""}
            </span>
            <span class="status-spacer" mix={statusSpacer}>
            </span>
            <span>{handle.props.engine}</span>
        </footer>
    )
}

export function Welcome(handle: Handle<EntryActions & { settings: GitSettingsState }>) {
    return () => (
        <section class="workspace welcome" mix={workspace} aria-live="polite">
            <section class="entry-panel" aria-label="Add repository" mix={entryPanel}>
                <header mix={entryPanelHeader}>
                    <h2 mix={entryPanelH2}>
                        No repository open
                    </h2>
                </header>
                {handle.props.settings.error && (
                    <p class="entry-warning" mix={entryWarning}>
                        Git unavailable. {handle.props.settings.error.message}
                    </p>
                )}
                <EntryOptions
                    busy={handle.props.busy}
                    openRepository={handle.props.openRepository}
                    openClone={handle.props.openClone}
                    openInitialize={handle.props.openInitialize}
                />
            </section>
        </section>
    )
}

export function EntryOptions(handle: Handle<EntryActions>) {
    return () => (
        <div class="entry-grid" mix={entryGrid}>
            <EntryCard title="Open" description="Choose an existing repository root." disabled={handle.props.busy} action={handle.props.openRepository} />
            <EntryCard title="Clone" description="Copy a remote or local repository." disabled={handle.props.busy} action={handle.props.openClone} />
            <EntryCard title="Initialize" description="Create a repository in a directory." disabled={handle.props.busy} action={handle.props.openInitialize} />
        </div>
    )
}

function EntryCard(handle: Handle<{ title: string; description: string; disabled: boolean; action(): void }>) {
    return () => (
        <button class="entry-card" type="button" disabled={handle.props.disabled} mix={[entryCard, on("click", handle.props.action)]}>
            <strong mix={entryCardStrong}>
                {handle.props.title}
            </strong>
            <span mix={entryCardSpan}>
                {handle.props.description}
            </span>
        </button>
    )
}

const masthead = css({
    padding: "0 8px 0 8px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
})

const brand = css({
    height: "28px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    textAlign: "left",
})

const brandMark = css({
    position: "relative",
    width: "18px",
    height: "18px",
    flex: "0 0 auto",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "var(--panel)",
    "&:last-child": {
        fontSize: "13px",
        fontWeight: "600",
        letterSpacing: "0.01em",
    },
    "&::before": {
        position: "absolute",
        top: "3px",
        bottom: "3px",
        left: "7px",
        width: "1px",
        content: '""',
        background: "var(--line-strong)",
    },
})

const brandMarkI = css({
    position: "absolute",
    left: "5px",
    width: "5px",
    height: "5px",
    border: "1px solid var(--accent)",
    borderRadius: "50%",
    background: "var(--panel)",
    "&:nth-child(1)": {
        top: "1px",
    },
    "&:nth-child(2)": {
        top: "6px",
    },
    "&:nth-child(3)": {
        top: "11px",
    },
})

const brandSpan = css({
    "&:last-child": {
        fontSize: "13px",
        fontWeight: "600",
        letterSpacing: "0.01em",
    },
})

const headerActions = css({
    display: "flex",
    alignItems: "center",
    gap: "4px",
})

const iconButton = css({
    width: "28px",
    height: "28px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--muted)",
    border: "1px solid transparent",
    borderRadius: "4px",
    background: "transparent",
    fontSize: "14px",
    lineHeight: "1",
    "&:hover:not(:disabled)": {
        color: "var(--text)",
        borderColor: "var(--line-strong)",
        background: "var(--control)",
    },
    "&:active:not(:disabled)": {
        background: "var(--control-hover)",
    },
})

const statusBar = css({
    minWidth: "0",
    padding: "0 10px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    overflow: "hidden",
    color: "var(--muted)",
    borderTop: "1px solid var(--line)",
    background: "var(--panel-deep)",
    fontSize: "11px",
    whiteSpace: "nowrap",
})

const pulse = css({
    width: "7px",
    height: "7px",
    flex: "0 0 auto",
    borderRadius: "50%",
    background: "var(--accent)",
    "@media (forced-colors: active)": {
        background: "Highlight",
    },
    "&.error": {
        background: "var(--danger)",
    },
})

const statusPath = css({
    minWidth: "0",
    overflow: "hidden",
    fontFamily: "var(--mono)",
    fontSize: "11px",
    textOverflow: "ellipsis",
})

const statusSpacer = css({
    flex: "1 1 auto",
})

const workspace = css({
    padding: "24px",
    display: "grid",
    alignContent: "safe center",
    justifyItems: "center",
    overflow: "auto",
})

const entryPanel = css({
    width: "min(440px, 100%)",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "6px",
    background: "var(--panel)",
    boxShadow: "var(--shadow-popover)",
})

const entryPanelHeader = css({
    padding: "10px 14px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
})

const entryPanelH2 = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

const entryWarning = css({
    margin: "0",
    padding: "9px 14px",
    color: "var(--danger)",
    borderBottom: "1px solid var(--line)",
    background: "var(--danger-wash)",
    fontSize: "12px",
    lineHeight: "1.45",
})

const entryGrid = css({
    display: "grid",
})

const entryCard = css({
    width: "100%",
    padding: "11px 14px",
    display: "grid",
    gap: "3px",
    textAlign: "left",
    border: "0",
    borderBottom: "1px solid var(--line)",
    background: "transparent",
    "&:last-child": {
        borderBottom: "0",
    },
    "&:hover:not(:disabled)": {
        background: "var(--hover)",
    },
})

const entryCardStrong = css({
    fontSize: "13px",
    fontWeight: "600",
})

const entryCardSpan = css({
    color: "var(--muted)",
    fontSize: "12px",
})
