/** @jsxImportSource react */
import { composeRenderProps } from "react-aria-components/composeRenderProps"
import { Header, ListBox as AriaListBox, ListBoxItem as AriaListBoxItem, type ListBoxItemProps, ListBoxLoadMoreItem as AriaListBoxLoadMoreItem, type ListBoxLoadMoreItemProps, type ListBoxProps, ListBoxSection as AriaListBoxSection, type ListBoxSectionProps } from "react-aria-components/ListBox"
import { Text } from "./Content"
import { Check } from "./icons"
import { ProgressCircle } from "./ProgressCircle"
import "./ListBox.css"

export function ListBox<T>({ children, ...props }: ListBoxProps<T>) {
    return <AriaListBox {...props}>{children}</AriaListBox>
}

export function ListBoxItem(props: ListBoxItemProps) {
    let textValue = props.textValue || (typeof props.children === "string" ? props.children : undefined)
    return (
        <AriaListBoxItem {...props} textValue={textValue}>
            {composeRenderProps(props.children, children => typeof children === "string" ? <Text slot="label">{children}</Text> : children)}
        </AriaListBoxItem>
    )
}

export function ListBoxSection<T>(props: ListBoxSectionProps<T>) {
    return <AriaListBoxSection {...props} />
}

export function ListBoxLoadMoreItem(props: ListBoxLoadMoreItemProps) {
    return (
        <AriaListBoxLoadMoreItem {...props}>
            <ProgressCircle isIndeterminate aria-label="Loading more..." />
        </AriaListBoxLoadMoreItem>
    )
}

export function DropdownListBox<T>(props: ListBoxProps<T>) {
    return <AriaListBox {...props} className="dropdown-listbox" />
}

export function DropdownItem(props: ListBoxItemProps) {
    let textValue = props.textValue || (typeof props.children === "string" ? props.children : undefined)
    return (
        <ListBoxItem {...props} textValue={textValue} className="dropdown-item">
            {composeRenderProps(props.children, (children, { isSelected }) => (
                <>
                    {isSelected && <Check />}
                    {typeof children === "string" ? <Text slot="label">{children}</Text> : children}
                </>
            ))}
        </ListBoxItem>
    )
}

export { Header, Text }
