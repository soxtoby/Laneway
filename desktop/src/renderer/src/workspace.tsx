import type { Appearance, GitSettingsState } from "@laneway/shared"
import { css, type Handle, on, type RemixNode } from "remix/ui"
import { BrandMark, Icon } from "./icons"
import type { PullControl } from "./pull-latest"

export interface EntryActions {
    busy: boolean
    openRepository(): void
    openClone(): void
    openInitialize(): void
}

let masthead = css({
    padding: "0 10px 0 14px",
    display: "grid",
    alignItems: "center",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    gap: "16px",
    borderBottom: "1px solid var(--line-strong)",
    background: "var(--panel)",
    // The header doubles as the title bar: leave room for the window controls and let empty space drag the window.
    paddingRight: "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 10px)",
    WebkitAppRegion: "drag",
    "& button, & input, & select, & [role=tab], & [role=tablist] *": { WebkitAppRegion: "no-drag" },
})

let brand = css({
    display: "flex",
    alignItems: "center",
    gap: "10px",
    paddingRight: "4px",
    whiteSpace: "nowrap",
})

let brandName = css({
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
    fontSize: "17px",
    fontWeight: "600",
    letterSpacing: "-0.01em",
})

let mastheadCenter = css({
    minWidth: "0",
    alignSelf: "stretch",
    display: "flex",
    alignItems: "stretch",
})

let headerActions = css({
    justifySelf: "end",
    display: "flex",
    alignItems: "center",
    gap: "4px",
})

let repositoryActions = css({
    display: "flex",
    alignItems: "center",
    gap: "4px",
    margin: "0 4px 0 4px",
    padding: "0 8px",
    borderInline: "1px solid var(--line-strong)",
})

let pullProgress = css({
    display: "flex",
    alignItems: "center",
    gap: "6px",
    height: "30px",
    padding: "0 4px 0 8px",
    color: "var(--muted)",
    fontSize: "12px",
    whiteSpace: "nowrap",
})

let pullProgressText = css({
    maxWidth: "260px",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

let labeledButton = css({
    height: "30px",
    padding: "0 10px 0 8px",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    borderRadius: "var(--radius)",
    background: "var(--panel)",
    font: "inherit",
    fontSize: "12.5px",
    fontWeight: "500",
    whiteSpace: "nowrap",
    "&:hover:not(:disabled)": { background: "var(--control-hover)" },
})

let primaryButton = css({
    color: "var(--accent-ink)",
    borderColor: "var(--accent)",
    background: "var(--accent)",
    fontWeight: "600",
    "&:hover:not(:disabled)": { background: "var(--accent-hover)", borderColor: "var(--accent-hover)" },
    "&:disabled": { opacity: 1, color: "var(--muted)", borderColor: "var(--line)", background: "var(--control)", fontWeight: "500" },
})

let iconButton = css({
    width: "30px",
    height: "30px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--text)",
    border: "1px solid transparent",
    borderRadius: "var(--radius)",
    background: "transparent",
    "&:hover:not(:disabled)": {
        borderColor: "var(--line-strong)",
        background: "var(--control-hover)",
    },
    "&:active:not(:disabled)": {
        background: "var(--control)",
    },
})

let workspace = css({
    padding: "24px",
    display: "grid",
    alignContent: "safe center",
    justifyItems: "center",
    overflow: "auto",
})

let entryPanel = css({
    width: "min(440px, 100%)",
    overflow: "hidden",
    border: "1px solid var(--line-strong)",
    borderRadius: "6px",
    background: "var(--panel)",
    boxShadow: "var(--shadow-popover)",
})

let entryPanelHeader = css({
    padding: "10px 14px",
    borderBottom: "1px solid var(--line)",
    background: "var(--panel-deep)",
})

let entryPanelH2 = css({
    margin: "0",
    fontSize: "14px",
    fontWeight: "600",
})

let entryWarning = css({
    margin: "0",
    padding: "9px 14px",
    color: "var(--danger)",
    borderBottom: "1px solid var(--line)",
    background: "var(--danger-wash)",
    fontSize: "12px",
    lineHeight: "1.45",
})

let entryGrid = css({
    display: "grid",
})

let entryCard = css({
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

let entryCardStrong = css({
    fontSize: "13px",
    fontWeight: "600",
})

let entryCardSpan = css({
    color: "var(--muted)",
    fontSize: "12px",
})

export function LanewayHeader(
    handle: Handle<{
        busy: boolean
        openLens?(): void
        appearance: Appearance
        openSettings(): void
        toggleAppearance(): void
        repositoryActions?: { busy: boolean; stashes(): void; undo(): void; redo(): void; pull: PullControl }
        tabs?: RemixNode
    }>,
) {
    return () => {
        let props = handle.props
        let themeLabel = props.appearance == "dark" ? "Switch to light appearance" : "Switch to dark appearance"
        return (
            <header class="masthead" mix={masthead}>
                <div class="brand" mix={brand}>
                    <BrandMark size={24} plain />
                    <span mix={brandName}>Laneway</span>
                </div>
                <div class="masthead-center" mix={mastheadCenter}>
                    {props.tabs}
                </div>
                <div class="header-actions" mix={headerActions}>
                    {props.openLens && (
                        <button
                            class="lens-button"
                            type="button"
                            aria-label="Command Lens"
                            title="Command Lens (Ctrl K)"
                            mix={[iconButton, on("click", props.openLens)]}
                        >
                            <Icon name="search" />
                        </button>
                    )}
                    {props.repositoryActions && (
                        <div class="repository-actions" mix={repositoryActions}>
                            {props.repositoryActions.pull.running
                                ? (
                                    <span class="pull-progress" mix={pullProgress} role="status" aria-live="polite">
                                        <span mix={pullProgressText}>{props.repositoryActions.pull.running.message}</span>
                                        <button
                                            type="button"
                                            class="pull-cancel"
                                            aria-label="Cancel pull"
                                            mix={[labeledButton, on("click", props.repositoryActions.pull.cancel)]}
                                        >
                                            Cancel
                                        </button>
                                    </span>
                                )
                                : (
                                    <button
                                        type="button"
                                        class="pull-latest"
                                        title={props.repositoryActions.pull.hint}
                                        aria-label="Pull latest"
                                        disabled={props.repositoryActions.busy || !props.repositoryActions.pull.available}
                                        mix={[labeledButton, primaryButton, on("click", props.repositoryActions.pull.start)]}
                                    >
                                        <Icon name="pull" />
                                        <span>Pull latest</span>
                                    </button>
                                )}
                            <button type="button" disabled={props.repositoryActions.busy} mix={[labeledButton, on("click", props.repositoryActions.stashes)]}>
                                <Icon name="stash" />
                                <span>Stashes</span>
                            </button>
                            <button
                                type="button"
                                aria-label="Undo last operation"
                                title="Undo (Ctrl+Z)"
                                disabled={props.repositoryActions.busy}
                                mix={[iconButton, on("click", props.repositoryActions.undo)]}
                            >
                                <Icon name="undo" />
                            </button>
                            <button
                                type="button"
                                aria-label="Redo operation"
                                title="Redo (Ctrl+Shift+Z)"
                                disabled={props.repositoryActions.busy}
                                mix={[iconButton, on("click", props.repositoryActions.redo)]}
                            >
                                <Icon name="redo" />
                            </button>
                        </div>
                    )}
                    <button
                        class="icon-button"
                        type="button"
                        aria-label={themeLabel}
                        title={themeLabel}
                        mix={[iconButton, on("click", props.toggleAppearance)]}
                    >
                        <Icon name={props.appearance == "dark" ? "sun" : "moon"} />
                    </button>
                    <button
                        class="icon-button"
                        type="button"
                        aria-label="Git settings"
                        title="Git settings"
                        disabled={props.busy}
                        mix={[iconButton, on("click", props.openSettings)]}
                    >
                        <Icon name="sliders" />
                    </button>
                </div>
            </header>
        )
    }
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
