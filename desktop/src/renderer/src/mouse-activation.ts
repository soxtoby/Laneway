const selectionControls = [
    "[role=option]",
    "[role=tab]",
    "button[aria-expanded]",
    "button[aria-pressed]",
    "input[type=checkbox]",
    "input[type=radio]",
    "summary",
    "[data-mousedown-activate]",
].join(",")

function controlFor(event: MouseEvent) {
    const path = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement)
    for (const [index, node] of path.entries()) {
        let control: HTMLElement | undefined
        if (node.matches(selectionControls))
            control = node
        else if (node.tagName == "LABEL") {
            const candidate = (node as HTMLLabelElement).control
            if (candidate?.matches("input[type=checkbox],input[type=radio]"))
                control = candidate
        }
        if (control) {
            // A prevented mousedown never starts a native drag, so anything on a draggable surface waits for the
            // click instead; a control asking for mousedown by name keeps it even there.
            if (control.matches("[data-mousedown-activate]"))
                return control
            return path.slice(index).some(ancestor => ancestor.matches("[data-click-activate],[draggable=true]")) ? undefined : control
        }
        // A nested action belongs to its own button, not the selectable row around it.
        if (node.matches("button,a,input,select,textarea,[contenteditable],[role=button]"))
            return undefined
    }
    return undefined
}

export function activateSelectionsOnMouseDown(document: Document, signal: AbortSignal) {
    let activated = false
    document.addEventListener("mousedown", event => {
        activated = false
        if (event.button != 0)
            return
        const control = controlFor(event)
        if (!control || control.matches(":disabled,[aria-disabled=true]"))
            return
        activated = true
        if (!event.defaultPrevented)
            control.focus({ preventScroll: true })
        // Focus is already assigned; native mousedown focus would override focus moved by the action.
        event.preventDefault()
        control.dispatchEvent(
            new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                composed: true,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
            }),
        )
    }, { signal })
    document.addEventListener("click", event => {
        // Keyboard and assistive activation have detail 0 and keep their native behavior.
        if (event.detail == 0 || !activated)
            return
        activated = false
        event.preventDefault()
        event.stopImmediatePropagation()
    }, { capture: true, signal })
}
