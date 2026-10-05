import type { BranchGraph, RepositoryGraphSettings } from "@laneway/shared"
import { css, type Handle, on } from "remix/ui"
import radio from "remix/ui/radio"
import { Icon } from "../icons"

let graphSettings = css({
    position: "absolute",
    zIndex: "6",
    top: "calc(100% + 4px)",
    right: "8px",
    width: "min(360px, calc(100% - 20px))",
    padding: "10px 12px 14px",
    display: "grid",
    gap: "14px",
    border: "1px solid var(--line-strong)",
    borderRadius: "6px",
    background: "var(--raised)",
    boxShadow: "var(--shadow-popover)",
    "@media (forced-colors: active)": {
        boxShadow: "none",
    },
})

let graphSettingsHeader = css({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
})

let graphSettingsH2 = css({
    margin: "0",
    fontSize: "13px",
    fontWeight: "600",
})

// A quiet icon button, like the other close affordances, rather than a boxed control.
let closeGraphSettingsButton = css({
    width: "24px",
    height: "24px",
    padding: "0",
    display: "grid",
    placeItems: "center",
    color: "var(--muted)",
    border: "0",
    borderRadius: "4px",
    background: "transparent",
    "&:hover": { color: "var(--text)", background: "var(--control-hover)" },
})

let graphSettingsField = css({
    display: "grid",
    gap: "6px",
})

let graphSettingsHint = css({
    margin: "0",
    color: "var(--muted)",
    fontSize: "11.5px",
    lineHeight: "1.45",
})

let graphSettingsCode = css({
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: "11px",
})

let graphSettingsRow = css({
    display: "flex",
    gap: "6px",
    alignItems: "stretch",
})

let graphSettingsInput = css({
    flex: "1",
    minWidth: "0",
    fontFamily: "var(--mono)",
    fontSize: "12px",
})

let remoteOptions = css({
    display: "grid",
    gap: "6px",
    margin: "0",
    padding: "0",
    border: "0",
    minWidth: "0",
})

let remoteOptionsLabel = css({
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "12.5px",
    cursor: "pointer",
})

let remoteOptionsInput = css({
    background: "var(--field)",
    border: "1px solid var(--line-strong)",
    boxShadow: "none",
    "@media (forced-colors: active)": {
        appearance: "auto",
        "&::before": {
            display: "none",
        },
    },
    "&:checked": {
        background: "var(--accent)",
        borderColor: "var(--accent)",
        boxShadow: "none",
    },
    "&:focus-visible": {
        outline: "2px solid var(--accent)",
        outlineOffset: "2px",
        boxShadow: "none",
    },
    "&::before": {
        background: "var(--accent-ink)",
        boxShadow: "none",
    },
})

let graphSettingsLabel = css({
    display: "block",
    padding: "0",
    margin: "0",
    color: "var(--text)",
    fontSize: "12px",
    fontWeight: "600",
})

let secondaryButton = css({
    color: "var(--text)",
    border: "1px solid var(--line-strong)",
    background: "var(--control)",
    "&.active": {
        color: "var(--accent)",
        borderColor: "var(--accent-edge)",
        background: "var(--accent-wash)",
    },
    minHeight: "28px",
    padding: "0 14px",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: "500",
    textTransform: "none",
    "&:hover:not(:disabled)": {
        background: "var(--control-hover)",
    },
})

export function GraphSettings(
    handle: Handle<{ graph: BranchGraph; state: { patterns: string }; apply(settings: RepositoryGraphSettings): void; close(): void }>,
) {
    let applyPatterns = () =>
        handle.props.apply({ selectedRemote: handle.props.graph.selectedRemote, remotePatterns: splitPatterns(handle.props.state.patterns) })
    return () => (
        <section class="graph-settings" role="dialog" aria-labelledby={handle.id + "-title"} mix={graphSettings}>
            <header mix={graphSettingsHeader}>
                <h2 id={handle.id + "-title"} mix={graphSettingsH2}>
                    Branch Graph settings
                </h2>
                <button type="button" aria-label="Close graph settings" title="Close" mix={[closeGraphSettingsButton, on("click", handle.props.close)]}>
                    <Icon name="close" size={12} />
                </button>
            </header>
            {/* With a single remote there is nothing to choose. */}
            {handle.props.graph.availableRemotes.length > 1 && (
                <fieldset class="remote-options" mix={remoteOptions}>
                    <legend mix={graphSettingsLabel}>Remote</legend>
                    <p mix={graphSettingsHint}>The Primary Branch and remote branches come from this remote.</p>
                    {handle.props.graph.availableRemotes.map(remote => (
                        <label mix={remoteOptionsLabel}>
                            <input
                                type="radio"
                                name={handle.id + "-remote"}
                                value={remote}
                                checked={handle.props.graph.selectedRemote == remote}
                                mix={[
                                    radio(),
                                    remoteOptionsInput,
                                    on("change", event => {
                                        if (event.currentTarget.checked)
                                            void handle.props.apply({ selectedRemote: remote, remotePatterns: splitPatterns(handle.props.state.patterns) })
                                    }),
                                ]}
                            />
                            {remote}
                        </label>
                    ))}
                </fieldset>
            )}
            <div mix={graphSettingsField}>
                <label for="remote-patterns" mix={graphSettingsLabel}>
                    Additional remote branches
                </label>
                <p id="remote-patterns-hint" mix={graphSettingsHint}>
                    Also show remote-only branches matching these comma-separated globs, such as <code mix={graphSettingsCode}>origin/release/**</code>.
                </p>
                <div mix={graphSettingsRow}>
                    <input
                        id="remote-patterns"
                        aria-describedby="remote-patterns-hint"
                        value={handle.props.state.patterns}
                        placeholder="origin/release/**, upstream/topic/*"
                        mix={[
                            graphSettingsInput,
                            on("input", event => {
                                handle.props.state.patterns = event.currentTarget.value
                                handle.update()
                            }),
                            on("keydown", event => {
                                if (event.key == "Enter") {
                                    event.preventDefault()
                                    applyPatterns()
                                }
                            }),
                        ]}
                    />
                    <button class="secondary-button" type="button" mix={[secondaryButton, on("click", applyPatterns)]}>
                        Apply
                    </button>
                </div>
            </div>
        </section>
    )
}

function splitPatterns(value: string) {
    return value.split(",").map(pattern => pattern.trim()).filter(Boolean)
}
