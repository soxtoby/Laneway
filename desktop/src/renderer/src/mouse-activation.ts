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
    for (const node of event.composedPath()) {
        if (!(node instanceof HTMLElement))
            continue
        if (node.matches(selectionControls))
            return node
        if (node.tagName == "LABEL") {
            const control = (node as HTMLLabelElement).control
            if (control?.matches("input[type=checkbox],input[type=radio]"))
                return control
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
