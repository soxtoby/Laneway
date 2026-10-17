/** @jsxImportSource react */
import type { ReactNode } from "react"
import { Button as AriaButton } from "react-aria-components"
import { MoreIcon } from "./icons"
import { Menu, MenuTrigger } from "./ui/Menu"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"

/** A compact icon button for rows and column headers, with a tooltip. */
export function IconButton({ label, children, onPress, small }: { label: string; children: ReactNode; onPress?: () => void; small?: boolean }) {
    return (
        <TooltipTrigger>
            <AriaButton className={small ? "icon-button small" : "icon-button"} aria-label={label} onPress={onPress}>{children}</AriaButton>
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
