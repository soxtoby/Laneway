import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react"
import { OverlayArrow, Tooltip as AriaTooltip, type TooltipProps as AriaTooltipProps, TooltipTrigger as AriaTooltipTrigger, type TooltipTriggerComponentProps } from "react-aria-components/Tooltip"
import "./Tooltip.css"

export interface TooltipProps extends Omit<AriaTooltipProps, "children"> {
    children: React.ReactNode
}

export function Tooltip({ children, placement, ...props }: TooltipProps) {
    // Laneway: one placed under the window's controls, which cover a top corner of the page, shows below its trigger.
    let [covered, setCovered] = useState(false)
    let tooltip = useRef<HTMLDivElement>(null)
    return (
        <AriaTooltip {...props} ref={tooltip} placement={covered ? "bottom" : placement}>
            {({ placement: placed }) => (
                <>
                    <OverlayArrow>
                        <svg width={8} height={8} viewBox="0 0 8 8">
                            <path d="M0 0 L4 4 L8 0" />
                        </svg>
                    </OverlayArrow>
                    {children}
                    <WindowControlsCheck tooltip={tooltip} placed={placed} onCovered={setCovered} />
                </>
            )}
        </AriaTooltip>
    )
}

export function TooltipTrigger(props: TooltipTriggerComponentProps) {
    return <AriaTooltipTrigger {...props} />
}

/** Reports a placed tooltip that sits under the window's controls, and forgets it once the tooltip closes. */
function WindowControlsCheck({ tooltip, placed, onCovered }: {
    tooltip: RefObject<HTMLDivElement | null>
    placed: string | null
    onCovered(covered: boolean): void
}) {
    useLayoutEffect(() => {
        let rect = placed && tooltip.current?.getBoundingClientRect()
        if (rect && underWindowControls(rect))
            onCovered(true)
    }, [tooltip, placed, onCovered])
    useEffect(() => () => onCovered(false), [onCovered])
    return null
}

function underWindowControls(rect: DOMRect) {
    let overlay = navigator.windowControlsOverlay
    if (!overlay?.visible)
        return false
    // The controls take the title bar's height beside the area it leaves the page.
    let area = overlay.getTitlebarAreaRect()
    return rect.top < area.bottom && (rect.left < area.left || rect.right > area.right)
}
