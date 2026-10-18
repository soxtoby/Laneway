/** @jsxImportSource react */
import type { Ref } from "react"
import { IconButton } from "./controls"
import { CloseIcon } from "./icons"
import type { FileFilter } from "./inspection"
import { Select, SelectItem } from "./ui/Select"
import { TextField } from "./ui/TextField"

let statuses = ["all", "added", "modified", "deleted", "renamed", "copied", "type changed", "conflicted"]

/** A column's file filter: a path to look for and a status to narrow to. Escape closes it, as its button does. */
export function ColumnFilter({ filter, inputRef, onChange, onClose }: {
    filter: FileFilter
    inputRef: Ref<HTMLInputElement>
    onChange(filter: FileFilter): void
    onClose(): void
}) {
    return (
        <div className="column-filter" role="search" aria-label="File filter">
            <TextField
                className="react-aria-TextField column-filter-text"
                aria-label="Filter changed files"
                placeholder="Filter files…"
                value={filter.text}
                inputRef={inputRef}
                onChange={text => onChange({ ...filter, text })}
                autoFocus
            />
            <Select
                className="react-aria-Select column-filter-status"
                aria-label="Filter change status"
                selectedKey={filter.status}
                onSelectionChange={key => key != null && onChange({ ...filter, status: String(key) })}
            >
                {statuses.map(status => (
                    <SelectItem key={status} id={status}>{status == "all" ? "All changes" : status[0]!.toUpperCase() + status.slice(1)}</SelectItem>
                ))}
            </Select>
            <IconButton label="Close file filter" small onPress={onClose}>
                <CloseIcon />
            </IconButton>
        </div>
    )
}
