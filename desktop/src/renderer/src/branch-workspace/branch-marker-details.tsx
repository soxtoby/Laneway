import type { BranchGraphMarker } from "@laneway/shared"
import { css, type Handle, on } from "remix/ui"

let markerDetails = css({
    position: "absolute",
    right: "8px",
    bottom: "8px",
    left: "8px",
    padding: "10px",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    border: "1px solid var(--warning-edge)",
    borderRadius: "6px",
    background: "var(--warning-raised)",
    boxShadow: "var(--shadow-popover)",
    "@media (forced-colors: active)": {
        boxShadow: "none",
    },
})

let markerDetailsDiv = css({
    minWidth: "0",
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    overflow: "hidden",
})

let markerDetailsSpan = css({
    color: "var(--faint)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
    letterSpacing: "0",
    textTransform: "none",
})

let markerDetailsSmall = css({
    color: "var(--faint)",
    fontFamily: "var(--mono)",
    fontSize: "10px",
    letterSpacing: "0",
    textTransform: "none",
})

let closeMarkerDetailsButton = css({
    minHeight: "26px",
    padding: "0 7px",
    color: "var(--muted)",
    border: "1px solid var(--line-strong)",
    borderRadius: "4px",
    background: "transparent",
    fontSize: "12px",
    minWidth: "26px",
    borderColor: "transparent",
    "&:hover": {
        color: "var(--text)",
        borderColor: "var(--line-strong)",
        background: "var(--control)",
    },
})

let markerDetailsP = css({
    gridColumn: "1 / -1",
    margin: "7px 0 0",
    color: "var(--muted)",
    fontSize: "12px",
})

export function MarkerDetails(handle: Handle<{ marker: BranchGraphMarker; close(): void }>) {
    return () => (
        <aside class="marker-details" mix={markerDetails}>
            <div mix={markerDetailsDiv}>
                <span mix={markerDetailsSpan}>
                    STASH
                </span>
                <strong>{handle.props.marker.label}</strong>
                <small mix={markerDetailsSmall}>
                    {shortOid(handle.props.marker.objectId)}
                </small>
            </div>
            <button type="button" aria-label="Close marker details" mix={[closeMarkerDetailsButton, on("click", handle.props.close)]}>
                ×
            </button>
            <p mix={markerDetailsP}>
                {handle.props.marker.tooltip}
            </p>
        </aside>
    )
}

function shortOid(objectId: string) {
    return objectId.slice(0, 8)
}
