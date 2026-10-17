/** @jsxImportSource react */
import React from "react"
import { Header, Keyboard, Menu as AriaMenu, MenuItem as AriaMenuItem, type MenuItemProps, MenuLoadMoreItem as AriaMenuLoadMoreItem, type MenuLoadMoreItemProps, type MenuProps, MenuSection as AriaMenuSection, type MenuSectionProps, MenuTrigger as AriaMenuTrigger, type MenuTriggerProps, Separator, SubmenuTrigger as AriaSubmenuTrigger, type SubmenuTriggerProps } from "react-aria-components/Menu"
import { Text } from "./Content"
import { Check, ChevronRight, Dot } from "./icons"
import { Popover } from "./Popover"
import { ProgressCircle } from "./ProgressCircle"
import "./Menu.css"

export function MenuTrigger(props: MenuTriggerProps) {
    let [trigger, menu] = React.Children.toArray(props.children) as [
        React.ReactElement,
        React.ReactElement,
    ]
    return (
        <AriaMenuTrigger {...props}>
            {trigger}
            <Popover>{menu}</Popover>
        </AriaMenuTrigger>
    )
}

export function Menu<T>(props: MenuProps<T>) {
    return <AriaMenu {...props}>{props.children}</AriaMenu>
}

export function MenuLoadMoreItem(props: MenuLoadMoreItemProps) {
    return (
        <AriaMenuLoadMoreItem {...props}>
            <ProgressCircle isIndeterminate aria-label="Loading more..." />
        </AriaMenuLoadMoreItem>
    )
}

export function MenuItem(props: Omit<MenuItemProps, "children"> & { children?: React.ReactNode }) {
    let textValue = props.textValue || (typeof props.children === "string" ? props.children : undefined)
    return (
        <AriaMenuItem {...props} textValue={textValue}>
            {({ hasSubmenu, isSelected, selectionMode }) => (
                <>
                    {isSelected && selectionMode === "multiple" ? <Check /> : null}
                    {isSelected && selectionMode === "single" ? <Dot /> : null}
                    {typeof props.children === "string" ? <Text slot="label">{props.children}</Text> : (
                        props.children
                    )}
                    {hasSubmenu && <ChevronRight />}
                </>
            )}
        </AriaMenuItem>
    )
}

export function MenuSection<T>(props: MenuSectionProps<T>) {
    return <AriaMenuSection {...props} />
}

export function SubmenuTrigger(props: SubmenuTriggerProps) {
    let [trigger, menu] = React.Children.toArray(props.children) as [
        React.ReactElement,
        React.ReactElement,
    ]
    return (
        <AriaSubmenuTrigger {...props}>
            {trigger}
            <Popover hideArrow offset={-2} crossOffset={-4}>
                {menu}
            </Popover>
        </AriaSubmenuTrigger>
    )
}

export { Header, Keyboard, Separator, Text }
