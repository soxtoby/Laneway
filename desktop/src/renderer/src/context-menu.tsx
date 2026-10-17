import { css, type Handle, on, ref, type RemixNode } from "remix/ui"

export interface ContextAction {
    label: string
    /** Draws a rule above this item, starting a new group. */
    separator?: boolean
    disabled?: boolean
    run(): void
}

let menu = css({
    position: "fixed",
    margin: 0,
    width: "max-content",
    maxWidth: "calc(100vw - 16px)",
    padding: "4px",
    borderRadius: "3px",
    border: "1px solid var(--line-strong)",
    background: "var(--panel)",
    "& button": {
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "4px 8px",
        border: 0,
        background: "transparent",
        color: "var(--text)",
        font: "inherit",
        cursor: "pointer",
    },
    "& button:hover:not(:disabled)": { background: "var(--control-hover)" },
    "&::backdrop": { background: "transparent" },
})

let rule = css({
    margin: "4px 0",
    border: 0,
    borderTop: "1px solid var(--line)",
})

/**
 * Wraps its children so a right click, the Menu key, or Shift+F10 opens the actions beside the pointer.
 * The menu is a modal dialog in the top layer, so no scroll container clips it.
 */
export function ContextMenu(handle: Handle<{ label: string; actions: ContextAction[]; children?: RemixNode; class?: string }>) {
    let position: { x: number; y: number } | undefined
    return () => (
        <div
            class={handle.props.class}
            mix={ref((element, signal) => {
                let open = (x: number, y: number) => {
                    if (handle.props.actions.length) {
                        position = { x, y }
                        void handle.update()
                    }
                }
                element.addEventListener("contextmenu", event => {
                    event.preventDefault()
                    event.stopPropagation()
                    open(event.clientX, event.clientY)
                }, { signal })
                element.addEventListener("keydown", event => {
                    if (event.key == "ContextMenu" || event.shiftKey && event.key == "F10") {
                        event.preventDefault()
                        event.stopPropagation()
                        // A host with display: contents has no box, so its first child stands in for it.
                        let bounds = (element.firstElementChild ?? element).getBoundingClientRect()
                        open(bounds.left, bounds.top)
                    }
                }, { signal })
            })}
        >
            {handle.props.children}
            {position && (
                <dialog
                    aria-label={handle.props.label}
                    mix={[
                        menu,
                        ref(element => {
                            element.style.left = `${position!.x}px`
                            element.style.top = `${position!.y}px`
                            element.showModal()
                            let bounds = element.getBoundingClientRect()
                            element.style.left = `${Math.max(0, Math.min(position!.x, window.innerWidth - bounds.width))}px`
                            element.style.top = `${Math.max(0, Math.min(position!.y, window.innerHeight - bounds.height))}px`
                        }),
                        on("close", () => {
                            position = undefined
                            void handle.update()
                        }),
                        on("click", event => {
                            if (event.target == event.currentTarget)
                                event.currentTarget.close()
                        }),
                    ]}
                >
                    {handle.props.actions.map((action, index) => (
                        <>
                            {action.separator && index > 0 && <hr mix={rule} />}
                            <button
                                type="button"
                                role="menuitem"
                                disabled={action.disabled}
                                mix={on("click", () => {
                                    position = undefined
                                    void handle.update()
                                    action.run()
                                })}
                            >
                                {action.label}
                            </button>
                        </>
                    ))}
                </dialog>
            )}
        </div>
    )
}
