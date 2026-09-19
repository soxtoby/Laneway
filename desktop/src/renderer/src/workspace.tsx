import type { Appearance, GitSettingsState } from "@git-workbench/shared"
import { css, type Handle, on } from "remix/ui"
import type { PullControl } from "./pull-latest"

export interface EntryActions {
    busy: boolean
    openRepository(): void
    openClone(): void
    openInitialize(): void
}

export function WorkbenchHeader(
    handle: Handle<{
        busy: boolean
        openLens?(): void
        appearance: Appearance
        openSettings(): void
        toggleAppearance(): void
        repositoryActions?: { busy: boolean; stashes(): void; undo(): void; redo(): void; pull: PullControl }
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
            {handle.props.openLens && (
                <button class="lens-button" type="button" mix={[lensButton, on("click", handle.props.openLens)]}>
                    <span>⌕</span>Command Lens<kbd>Ctrl K</kbd>
                </button>
            )}
            <div class="header-actions" mix={headerActions}>
                {handle.props.repositoryActions && (
                    <div class="repository-actions" mix={repositoryActions}>
                        {handle.props.repositoryActions.pull.running
                            ? (
                                <span class="pull-progress" mix={pullProgress} role="status" aria-live="polite">
                                    <span mix={pullProgressText}>{handle.props.repositoryActions.pull.running.message}</span>
                                    <button
                                        type="button"
                                        class="pull-cancel"
                                        aria-label="Cancel pull"
                                        mix={[topBarButton, on("click", handle.props.repositoryActions.pull.cancel)]}
                                    >
                                        Cancel
                                    </button>
                                </span>
                            )
                            : (
                                <button
                                    type="button"
                                    class="pull-latest"
                                    title={handle.props.repositoryActions.pull.hint}
                                    aria-label="Pull latest"
                                    disabled={handle.props.repositoryActions.busy || !handle.props.repositoryActions.pull.available}
                                    mix={[topBarButton, on("click", handle.props.repositoryActions.pull.start)]}
                                >
                                    Pull latest
                                </button>
                            )}
                        <button
                            type="button"
                            disabled={handle.props.repositoryActions.busy}
                            mix={[topBarButton, on("click", handle.props.repositoryActions.stashes)]}
                        >
                            Stashes
                        </button>
                        <button
                            type="button"
                            aria-label="Undo last operation"
                            title="Undo (Ctrl+Z)"
                            disabled={handle.props.repositoryActions.busy}
                            mix={[iconButton, on("click", handle.props.repositoryActions.undo)]}
                        >
                            ↶
                        </button>
                        <button
                            type="button"
                            aria-label="Redo operation"
                            title="Redo (Ctrl+Shift+Z)"
                            disabled={handle.props.repositoryActions.busy}
                            mix={[iconButton, on("click", handle.props.repositoryActions.redo)]}
                        >
                            ↷
                        </button>
                    </div>
                )}
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
    display: "grid",
    alignItems: "center",
    gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
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
    gridColumn: "3",
    justifySelf: "end",
    display: "flex",
    alignItems: "center",
    gap: "4px",
})

const repositoryActions = css({
    display: "flex",
    alignItems: "center",
    gap: "4px",
    marginRight: "4px",
    paddingRight: "8px",
    borderRight: "1px solid var(--line)",
})

const pullProgress = css({
    display: "flex",
    alignItems: "center",
    gap: "6px",
    height: "28px",
    padding: "0 4px 0 8px",
    color: "var(--muted)",
    fontSize: "12px",
    whiteSpace: "nowrap",
})

const pullProgressText = css({
    maxWidth: "260px",
    overflow: "hidden",
    textOverflow: "ellipsis",
})

const topBarButton = css({
    height: "28px",
    padding: "0 7px",
    color: "var(--muted)",
    border: "1px solid transparent",
    borderRadius: "4px",
    background: "transparent",
    font: "inherit",
    "&:hover:not(:disabled)": { color: "var(--text)", borderColor: "var(--line-strong)", background: "var(--control)" },
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

const lensButton = css({
    width: "clamp(180px, 28vw, 360px)",
    height: "28px",
    padding: "0 8px",
    display: "grid",
    gridTemplateColumns: "auto 1fr auto",
    alignItems: "center",
    gap: "7px",
    overflow: "hidden",
    color: "var(--muted)",
    textAlign: "left",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "var(--control)",
    fontSize: "12px",
    whiteSpace: "nowrap",
    "&:hover": {
        color: "var(--text)",
        background: "var(--control-hover)",
    },
})

export function RepositoryRailToggle(handle: Handle<{ collapsed: boolean; toggle(): void }>) {
    return () => (
        <button
            class={`repository-rail-toggle ${handle.props.collapsed ? "collapsed" : ""}`}
            type="button"
            aria-label={handle.props.collapsed ? "Expand repository sidebar" : "Collapse repository sidebar"}
            title={handle.props.collapsed ? "Expand repository sidebar" : "Collapse repository sidebar"}
            aria-expanded={!handle.props.collapsed}
            mix={[iconButton, repositoryRailToggle, on("click", handle.props.toggle)]}
        >
            {handle.props.collapsed ? "»" : "«"}
        </button>
    )
}

const repositoryRailToggle = css({
    "&.collapsed": { width: "28px" },
    width: "100%",
})
