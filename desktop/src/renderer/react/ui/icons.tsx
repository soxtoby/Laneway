import { IconCheck, IconChevronDown, IconChevronRight, IconGripVertical, IconPointFilled, type IconProps, IconSearch, IconX, type TablerIcon } from "@tabler/icons-react"

export type { IconProps }

/**
 * A Tabler icon hidden from assistive technology, as `lucide-react`'s are in the upstream kit, since
 * the control around it carries the name; pass `aria-hidden={false}` with a role and label to show
 * it. Tabler's `tabler-icon-<name>` classes are what the kit's CSS targets.
 */
export function tablerIcon(Icon: TablerIcon) {
    function HiddenIcon(props: IconProps) {
        return <Icon aria-hidden="true" {...props} />
    }
    HiddenIcon.displayName = Icon.displayName
    return HiddenIcon
}

export let Check = tablerIcon(IconCheck)
export let ChevronDown = tablerIcon(IconChevronDown)
export let ChevronRight = tablerIcon(IconChevronRight)
export let Dot = tablerIcon(IconPointFilled)
export let GripVertical = tablerIcon(IconGripVertical)
export let Search = tablerIcon(IconSearch)
export let X = tablerIcon(IconX)
