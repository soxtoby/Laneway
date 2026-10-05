import type { ConflictSubject } from "@laneway/shared"
import { UnresolvedFile } from "@pierre/diffs"
import { css, type Handle, ref } from "remix/ui"

export interface ConflictSides {
    left: { label: string; action: string; description: string }
    right: { label: string; action: string; description: string }
}

let mergeStyle = css({
    borderTop: "1px solid var(--line)",
    "& .merge-sides": {
        padding: "6px 12px",
        background: "var(--raised)",
        color: "var(--muted)",
        fontSize: "11px",
        display: "grid",
        gap: "5px",
        "& > div": { display: "grid", gap: "2px" },
        "& strong": { color: "var(--text)", fontWeight: "500" },
        "& span": { overflowWrap: "anywhere" },
    },
    "& .pierre-merge": { overflow: "auto", maxHeight: "min(65vh, 640px)", minHeight: "40px", userSelect: "text" },
    "& [role=alert]": { color: "var(--danger)", padding: "8px" },
})

export function MergeResolution(
    handle: Handle<
        { name: string; contents: string; subject: ConflictSubject; sides: ConflictSides; busy: boolean; resolve(contents: string): Promise<boolean> }
    >,
) {
    let pending = false, error = ""
    let appearance = () => document.documentElement.dataset.appearance == "dark" ? "dark" : "light"
    return () => (
        <section aria-label={"Merge resolution for " + handle.props.name} aria-busy={pending || handle.props.busy} mix={mergeStyle}>
            <div class="merge-sides">
                <div>
                    <strong>{handle.props.sides.left.label}</strong>
                    <span>{handle.props.sides.left.description}</span>
                </div>
                <div>
                    <strong>{handle.props.sides.right.label}</strong>
                    <span>{handle.props.sides.right.description}</span>
                </div>
            </div>
            {error && <p role="alert">{error}</p>}
            <div
                class="pierre-merge"
                inert={pending || handle.props.busy}
                mix={ref((node, signal) => {
                    // Pierre owns this DOM; Remix updates only the surrounding UI.
                    let host = document.createElement("div")
                    node.attachShadow({ mode: "open" }).append(host)
                    let sheet = new CSSStyleSheet()
                    sheet.replaceSync(`
                        :host { --diffs-font-family: var(--mono); --diffs-font-size: 12px; --diffs-line-height: 24px; }
                        [data-merge-conflict-marker-row] {
                            font-family: var(--diffs-header-font-fallback);
                            font-size: 11px;
                            font-weight: 600;
                            color: var(--muted);
                            background: var(--raised);
                            box-shadow: inset 0 1px var(--line), inset 0 -1px var(--line);
                            user-select: none;
                        }
                        [data-merge-conflict-marker-row]::after { content: none !important; }
                        [data-merge-conflict-marker-row] { display: flex; align-items: center; gap: 12px; }
                        [data-merge-conflict-marker-row] button { margin-left: auto; margin-right: 8px; }
                        [data-merge-conflict-marker-row] button::after { content: none !important; }
                        [data-merge-conflict-action-separator] { display: none !important; }
                    `)
                    let viewer = new UnresolvedFile({
                        theme: { light: "github-light", dark: "github-dark" },
                        themeType: appearance(),
                        preferredHighlighter: "shiki-js",
                        disableFileHeader: true,
                        disableErrorHandling: true,
                        expandUnchanged: true,
                        onPostRender: (element, _instance, phase) => {
                            let shadow = element.shadowRoot
                            if (phase != "unmount" && shadow && !shadow.adoptedStyleSheets.includes(sheet))
                                shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet]
                            if (phase != "unmount" && shadow)
                                placeSideControls(shadow, handle.props.sides)
                        },
                        onMergeConflictAction: (choice, instance) => {
                            if (pending || handle.props.busy)
                                return

                            let result = instance.resolveConflict(choice.conflict.conflictIndex, choice.resolution)
                            if (!result)
                                return
                            pending = true
                            void handle.update()
                            // Keep the current view until the choice is durably saved.
                            void handle.props.resolve(result.file.contents).finally(() => {
                                pending = false
                                if (!signal.aborted)
                                    void handle.update()
                            })
                        },
                    })

                    try {
                        viewer.render({ file: { name: handle.props.name, contents: handle.props.contents }, containerWrapper: host })
                    } catch (e) {
                        error = e instanceof Error ? e.message : String(e)
                        void handle.update()
                    }
                    let observer = new MutationObserver(() => {
                        viewer.setOptions({ ...viewer.options, themeType: appearance() })
                        viewer.rerender()
                    })
                    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] })
                    signal.addEventListener("abort", () => {
                        observer.disconnect()
                        viewer.cleanUp()
                    })
                })}
            />
        </section>
    )
}

// Move Pierre's own buttons, retaining its conflict indices and delegated actions.
// Display changes never alter the markers saved in partially resolved files.
function placeSideControls(shadow: ShadowRoot, sides: ConflictSides) {
    let next: string | undefined
    let conflicts: string[] = []
    for (let row of shadow.querySelectorAll<HTMLElement>("[data-merge-conflict-actions], [data-merge-conflict-marker-row]")) {
        if (row.hasAttribute("data-merge-conflict-actions")) {
            let both = row.querySelector<HTMLButtonElement>('[data-merge-conflict-action="both"]')
            next = both?.dataset.mergeConflictConflictIndex
            if (both)
                both.textContent = "Keep both"
            continue
        }
        let kind = row.dataset.mergeConflict
        if (kind == "marker-start" && next != undefined) {
            conflicts.push(next)
            next = undefined
        }
        let index = conflicts.at(-1)
        if (kind == "marker-end")
            conflicts.pop()
        if (index == undefined || (kind != "marker-start" && kind != "marker-end"))
            continue
        let side = kind == "marker-start" ? sides.left : sides.right
        let action = kind == "marker-start" ? "current" : "incoming"
        let button = shadow.querySelector<HTMLButtonElement>(
            `[data-merge-conflict-action="${action}"][data-merge-conflict-conflict-index="${index}"]`,
        )
        if (!button)
            continue
        let label = document.createElement("span")
        label.textContent = side.label
        label.title = side.description
        button.textContent = "Keep this"
        button.setAttribute("aria-label", `Keep ${side.label.toLowerCase()}`)
        row.replaceChildren(label, button)
    }
}
