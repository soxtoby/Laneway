import { Button, ToggleButton } from "react-aria-components"
import type { ComparisonColumnNode } from "./comparison-columns"
import { WorkingChangesIcon } from "./icons"
import { Menu, MenuItem, MenuTrigger } from "./ui/Menu"
import { Tooltip, TooltipTrigger } from "./ui/Tooltip"

export function ComparisonWorkingChanges(
    { comparison, onChange }: { comparison: ComparisonColumnNode; onChange(side: "from" | "to", include: boolean): void },
) {
    let sides = (["from", "to"] as const).filter(side => comparison[side].worktreePath)
    let first = sides[0]
    if (!first)
        return null
    if (sides.length == 1) {
        let label = `Include Working Changes on ${comparison[first].label}`
        return (
            <TooltipTrigger>
                <ToggleButton
                    className="icon-button"
                    aria-label={label}
                    isSelected={comparison[first].includeWorking}
                    onChange={include => onChange(first, include)}
                >
                    <WorkingChangesIcon />
                </ToggleButton>
                <Tooltip>{label}</Tooltip>
            </TooltipTrigger>
        )
    }

    return (
        <MenuTrigger>
            <TooltipTrigger>
                <Button
                    className="icon-button"
                    aria-label="Include Working Changes"
                    data-selected={sides.some(side => comparison[side].includeWorking) || undefined}
                >
                    <WorkingChangesIcon />
                </Button>
                <Tooltip>Include Working Changes</Tooltip>
            </TooltipTrigger>
            <Menu
                aria-label="Include Working Changes"
                selectionMode="multiple"
                selectedKeys={sides.filter(side => comparison[side].includeWorking)}
                onSelectionChange={keys => {
                    for (let side of sides) {
                        let included = keys == "all" || keys.has(side)
                        if (included != comparison[side].includeWorking)
                            onChange(side, included)
                    }
                }}
            >
                {sides.map(side => <MenuItem key={side} id={side}>{`${side == "from" ? "From" : "To"} · ${comparison[side].label}`}</MenuItem>)}
            </Menu>
        </MenuTrigger>
    )
}
