import clsx from "clsx"
import type { ElementType, HTMLAttributes, PointerEvent, ReactElement, ReactNode, RefObject } from "react"
import { useContext, useEffect, useRef } from "react"
import { Button as AriaButton, type ButtonProps, TooltipContext, type TooltipProps, type TooltipTriggerState, TooltipTriggerStateContext } from "react-aria-components"
import { MoreIcon } from "./icons"
import { Menu, MenuItem, MenuTrigger, SubmenuTrigger } from "./ui/Menu"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"

interface IconButtonProps extends Pick<ButtonProps, "onPress" | "isDisabled" | "aria-expanded"> {
    label: string
    children: ReactNode
    small?: boolean
    className?: string
}

/** A compact icon button for rows and column headers, with a tooltip. */
export function IconButton({ label, children, small, className, ...props }: IconButtonProps) {
    return (
        <TooltipTrigger>
            <AriaButton {...props} className={clsx("icon-button", small && "small", className)} aria-label={label}>{children}</AriaButton>
            <Tooltip>{label}</Tooltip>
        </TooltipTrigger>
    )
}

/** A compact "More actions" menu button; the same items also open from the row's context menu. */
export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
    return (
        <MenuTrigger>
            <TooltipTrigger>
                <AriaButton className="icon-button small" aria-label={label}>
                    <MoreIcon />
                </AriaButton>
                <Tooltip>More actions</Tooltip>
            </TooltipTrigger>
            <Menu>{children}</Menu>
        </MenuTrigger>
    )
}

interface SplitMenuItemProps {
    label: string
    /** The submenu's name, which its chevron takes. */
    moreLabel: string
    isDisabled?: boolean
    onAction(): void
    /** The submenu, a `Menu` of other ways to do the action. */
    children: ReactElement
}

/**
 * A menu item that acts from its label and opens a submenu from the chevron beside it, as a split button does.
 * React Aria's submenu triggers can't act, so the two are items sharing a row, and the chevron is the next item down.
 */
export function SplitMenuItem({ label, moreLabel, isDisabled, onAction, children }: SplitMenuItemProps) {
    return (
        <>
            <MenuItem className="react-aria-MenuItem split-action" isDisabled={isDisabled} onAction={onAction}>{label}</MenuItem>
            <SubmenuTrigger>
                <MenuItem className="react-aria-MenuItem split-more" aria-label={moreLabel} textValue={moreLabel} />
                {children}
            </SubmenuTrigger>
        </>
    )
}

/**
 * What shows its own tooltip, or none, instead of a hint around it: the controls the pointer presses or edits,
 * a group of them marked `data-controls`, gaps between them included, and elements with hints of their own.
 */
const ownTooltips =
    "button, a[href], input, select, textarea, label, [role=button], [role=checkbox], [role=switch], [role=slider], [data-controls], [aria-description]"

/** How long the pointer rests before a hint starts React Aria's tooltip delay, or shows at once if a tooltip just showed. */
const settleDelay = 250

interface HintProps {
    /** The hint; without one the child shows none. */
    text: string | undefined
    placement?: TooltipProps["placement"]
    /** The hint is the wrapped control's own, shown over it even while it is disabled, which a control's tooltip isn't. */
    forControl?: boolean
    children: ReactElement<HTMLAttributes<HTMLElement>>
}

/**
 * Explains its child in a tooltip like a button's, in place of `title`. The browser shows a title over every
 * descendant without one, buttons included, so a hint shows only while the pointer rests on its child but not
 * on a control or another hint inside it, which shows its own.
 */
export function Hint({ text, placement, forControl, children }: HintProps) {
    let triggerRef = useRef<HintTrigger>(null)
    let resting = useRef(false)
    let opened = useRef(false)
    let settleRef = useRef<ReturnType<typeof setTimeout>>(undefined)
    useEffect(() => () => clearTimeout(settleRef.current), [])
    if (!text)
        return children
    // A pointer passing over, as across a gap between buttons, shows nothing: the hint waits for it to settle.
    let rest = (now: boolean) => {
        let trigger = triggerRef.current
        if (!trigger || now == resting.current)
            return
        resting.current = now
        clearTimeout(settleRef.current)
        if (now) {
            settleRef.current = setTimeout(() => {
                opened.current = true
                trigger.state.open()
            }, settleDelay)
        } else if (opened.current) {
            opened.current = false
            trigger.state.close(true)
        }
    }
    // A control's own hint shows over the control, but other controls and hints inside take their turn.
    let givesWay = (area: HTMLElement, element: Element) => {
        let inner = element.closest(ownTooltips)
        return inner != null && inner != area && area.contains(inner) && !(forControl && !inner.matches("[aria-description]"))
    }
    // The child renders as itself, with its own ref and handlers; the tooltip sits by it once the pointer rests there.
    // React Aria's TooltipTrigger runs the hint, so it takes turns with buttons' tooltips and shares their warm-up.
    // The child sits outside it, where its controls can't take the trigger's props.
    let Target = children.type as ElementType
    let { onPointerOver, onPointerOut, onPointerDown } = children.props
    return (
        <>
            <Target
                {...children.props}
                aria-description={text}
                onPointerOver={(event: PointerEvent<HTMLElement>) => {
                    onPointerOver?.(event)
                    if (triggerRef.current)
                        triggerRef.current.anchor.current = event.currentTarget
                    // React passes on events from portals, such as a button's tooltip or a menu, which aren't on the child.
                    let on = event.currentTarget.contains(event.target as Node)
                    rest(event.pointerType != "touch" && on && !givesWay(event.currentTarget, event.target as Element))
                }}
                // The hint gives way as the pointer leaves for a control, before the control's tooltip starts its
                // delay: closing any tooltip cancels whichever delay is running.
                onPointerOut={(event: PointerEvent<HTMLElement>) => {
                    onPointerOut?.(event)
                    let next = event.relatedTarget as Element | null
                    if (!next || !event.currentTarget.contains(next) || givesWay(event.currentTarget, next))
                        rest(false)
                }}
                onPointerDown={(event: PointerEvent<HTMLElement>) => {
                    onPointerDown?.(event)
                    rest(false)
                }}
            />
            <TooltipTrigger>
                <HintState triggerRef={triggerRef} />
                <Tooltip className="react-aria-Tooltip hint" placement={placement}>{text}</Tooltip>
            </TooltipTrigger>
        </>
    )
}

interface HintTrigger {
    state: TooltipTriggerState
    /** Where the tooltip shows. */
    anchor: RefObject<Element | null>
}

/** Hands its TooltipTrigger's state and anchor to the hint beside it. */
function HintState({ triggerRef }: { triggerRef: RefObject<HintTrigger | null> }) {
    let state = useContext(TooltipTriggerStateContext)!
    let { triggerRef: anchor } = useContext(TooltipContext) as { triggerRef: RefObject<Element | null> }
    useEffect(() => {
        triggerRef.current = { state, anchor }
    })
    return null
}
