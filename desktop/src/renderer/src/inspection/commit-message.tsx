import { css, type Handle, on } from "remix/ui"
import { Icon } from "../icons"

let message = css({
    position: "relative",
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr)",
    padding: "4px 10px 6px 28px",
    borderBottom: "1px solid var(--line)",
    "&::before": {
        position: "absolute",
        top: "-1px",
        bottom: "-1px",
        left: "12px",
        width: "2px",
        content: '""',
        background: "var(--line-strong)",
        pointerEvents: "none",
    },
})

let toggle = css({
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: 0,
    minHeight: "20px",
    padding: 0,
    border: 0,
    borderRadius: 0,
    background: "transparent",
    color: "var(--muted)",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    "& svg": { flexShrink: 0 },
    "&:hover": { color: "var(--text)" },
    "&:focus-visible": { outline: "2px solid var(--ring)", outlineOffset: "2px" },
    '&[aria-expanded="true"]': { gridColumn: "1", alignSelf: "start" },
})

let preview = css({
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
})

let body = css({
    gridColumn: "2",
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    userSelect: "text",
})

export function CommitMessage(handle: Handle<{ body: string }>) {
    let expanded = true

    return () => (
        <div class="commit-message" mix={message}>
            <button
                type="button"
                class="commit-message-toggle"
                aria-label={expanded ? "Collapse commit description" : "Expand commit description"}
                aria-expanded={expanded}
                aria-controls={handle.id}
                title={expanded ? "Collapse description" : handle.props.body}
                mix={[
                    toggle,
                    on("click", () => {
                        expanded = !expanded
                        void handle.update()
                    }),
                ]}
            >
                <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
                {!expanded && <span class="commit-message-preview" mix={preview}>{handle.props.body}</span>}
            </button>
            <p id={handle.id} class="commit-message-body" hidden={!expanded} mix={body}>{handle.props.body}</p>
        </div>
    )
}
