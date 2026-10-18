/** @jsxImportSource react */
import type { ReactNode } from "react"
import { Button as AriaButton, type ButtonProps } from "react-aria-components"
import { MoreIcon } from "./icons"
import { Menu, MenuTrigger } from "./ui/Menu"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"

interface IconButtonProps extends Pick<ButtonProps, "onPress" | "isDisabled" | "aria-expanded"> {
    label: string
    children: ReactNode
    small?: boolean
}

/** A compact icon button for rows and column headers, with a tooltip. */
export function IconButton({ label, children, small, ...props }: IconButtonProps) {
    return (
        <TooltipTrigger>
            <AriaButton {...props} className={small ? "icon-button small" : "icon-button"} aria-label={label}>{children}</AriaButton>
            <Tooltip>{label}</Tooltip>
        </TooltipTrigger>
    )
}

/** A compact "More actions" menu button; the same items also open from the row's context menu. */
export function MoreMenu({ label, children }: { label: string; children: ReactNode }) {
    return (
        <MenuTrigger>
            <AriaButton className="icon-button small" aria-label={label}>
                <MoreIcon />
            </AriaButton>
            <Menu>{children}</Menu>
        </MenuTrigger>
    )
}
