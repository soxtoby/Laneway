import { css, type Handle, on, ref } from "remix/ui"
import { Icon, type IconName } from "./icons"

export interface OverflowAction {
    label: string
    icon?: IconName
    run(): void
}

// A "more" button whose actions open in a modal dialog beneath it. The dialog lives in the top
// layer, so sticky rows and scroll containers can neither clip nor cover the menu.
export function OverflowMenu(
    handle: Handle<{ label: string; title?: string; actions: OverflowAction[]; trigger?: ReturnType<typeof css>; size?: number }>,
) {
    let anchor: DOMRect | undefined
    return () => (
        <>
            <button
                type="button"
                aria-label={handle.props.label}
                title={handle.props.title ?? handle.props.label}
                aria-haspopup="menu"
                aria-expanded={anchor != undefined}
                mix={[
                    handle.props.trigger,
                    on("click", event => {
                        anchor = event.currentTarget.getBoundingClientRect()
                        void handle.update()
                    }),
                ]}
            >
                <Icon name="more" size={handle.props.size ?? 14} />
            </button>
            {anchor && (
                <dialog
                    aria-label={handle.props.label}
                    mix={[
                        menu,
                        ref(element => {
                            element.showModal()
                            // Right-align under the button, then keep the whole menu on screen.
                            const bounds = element.getBoundingClientRect()
                            element.style.left = `${Math.max(0, Math.min(anchor!.right - bounds.width, window.innerWidth - bounds.width))}px`
                            element.style.top = `${Math.max(0, Math.min(anchor!.bottom + 2, window.innerHeight - bounds.height))}px`
                            // Focus the list rather than an item, so a pointer-opened menu shows no focus ring.
                            element.querySelector<HTMLElement>("[role=menu]")?.focus()
                        }),
                        on("close", () => {
                            anchor = undefined
                            void handle.update()
                        }),
                        on("click", event => {
                            if (event.target == event.currentTarget)
                                event.currentTarget.close()
                        }),
                        on("keydown", event => {
                            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                                return
                            event.preventDefault()
                            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")]
                            const index = items.indexOf(document.activeElement as HTMLButtonElement)
                            const next = event.key == "Home" ? 0 : event.key == "End"
                                ? items.length - 1
                                : (index + (event.key == "ArrowDown" ? 1 : -1) + items.length) % items.length
                            items[next]?.focus()
                        }),
                    ]}
                >
                    <div role="menu" aria-label={handle.props.label} tabIndex={-1} mix={list}>
                        {handle.props.actions.map(action => (
                            <button
                                type="button"
                                role="menuitem"
                                mix={[
                                    item,
                                    on("click", event => {
                                        event.currentTarget.closest("dialog")?.close()
                                        action.run()
                                    }),
                                ]}
                            >
                                {action.icon && <Icon name={action.icon} size={14} />}
                                {action.label}
                            </button>
                        ))}
                    </div>
                </dialog>
            )}
        </>
    )
}

// The global dialog rule sizes dialogs for forms, so the menu shrinks to its widest item instead.
const menu = css({
    position: "fixed",
    margin: 0,
    width: "max-content",
    minWidth: "160px",
    maxWidth: "calc(100vw - 16px)",
    padding: "4px",
    border: "1px solid var(--line-strong)",
    borderRadius: "var(--radius)",
    background: "var(--raised)",
    color: "var(--text)",
    boxShadow: "var(--shadow-popover)",
    "&::backdrop": { background: "transparent" },
})

const list = css({ outline: "none" })

const item = css({
    display: "flex",
    alignItems: "center",
    gap: "8px",
    width: "100%",
    padding: "6px 10px 6px 8px",
    border: 0,
    borderRadius: "3px",
    textAlign: "left",
    color: "var(--text)",
    background: "transparent",
    font: "inherit",
    fontSize: "12px",
    cursor: "pointer",
    "& svg": { color: "var(--muted)", flex: "0 0 auto" },
    "&:hover, &:focus-visible": { background: "var(--hover)" },
})
