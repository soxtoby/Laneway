import { Children, type ReactNode } from "react"
import { Button as RACButton, type ButtonProps as RACButtonProps } from "react-aria-components/Button"
import { composeRenderProps } from "react-aria-components/composeRenderProps"
import { ProgressCircle } from "./ProgressCircle"
import "./Button.css"

interface ButtonProps extends RACButtonProps {
    /**
     * The visual style of the button (Vanilla CSS implementation specific). Laneway adds `accent`,
     * styled in laneway.css.
     *
     * @default 'primary'
     */
    variant?: "primary" | "secondary" | "quiet" | "accent"
    /**
     * Names the progress shown in place of the label while pending, such as "Publishing…" (Laneway).
     *
     * @default 'Saving...'
     */
    pendingLabel?: string
}

export function Button({ pendingLabel = "Saving...", ...props }: ButtonProps) {
    // Laneway places some buttons with its own classes, kept alongside the kit's.
    let className = composeRenderProps(props.className, extra => extra ? `react-aria-Button button-base ${extra}` : "react-aria-Button button-base")
    return (
        <RACButton {...props} className={className} data-variant={props.variant || "primary"}>
            {composeRenderProps(props.children, (children, { isPending }) => (
                <>
                    {!isPending && labelled(children)}
                    {isPending && <ProgressCircle aria-label={pendingLabel} isIndeterminate />}
                </>
            ))}
        </RACButton>
    )
}

// Laneway: Button.css treats a lone svg child as an icon-only button, and bare text is not a child
// element, so text beside an icon is wrapped to keep the button's label width.
function labelled(children: ReactNode) {
    return Children.map(children, child => typeof child == "string" ? <span>{child}</span> : child)
}
