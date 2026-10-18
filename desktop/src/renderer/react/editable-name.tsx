/** @jsxImportSource react */
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { Button as AriaButton } from "react-aria-components"
import { errorMessage } from "./notice"

interface EditableNameProps {
    name: string
    /** What the name belongs to, for assistive labels: "branch feature/x". */
    label: string
    isDisabled?: boolean
    /** Returns a message to keep the editor open, or nothing once the new name is accepted. */
    onCommit(name: string): Promise<string | undefined | void> | string | undefined | void
    /** Leaving the field keeps the typed name instead of discarding it; renames should wait for Enter. */
    saveOnBlur?: boolean
}

/**
 * A name shown as text until it is pressed or F2 is pressed on it, then edited in place. Enter keeps
 * the new name through `onCommit`, Escape restores the old one, and the editor stays open showing any error.
 */
export function EditableName({ name, label, isDisabled, onCommit, saveOnBlur }: EditableNameProps) {
    let [editing, setEditing] = useState(false)
    let [value, setValue] = useState("")
    let [busy, setBusy] = useState(false)
    let [error, setError] = useState("")
    let input = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (editing) {
            input.current?.focus()
            input.current?.select()
        }
    }, [editing])

    let start = () => {
        if (isDisabled)
            return
        setEditing(true)
        setValue(name)
        setError("")
    }
    let cancel = () => {
        setEditing(false)
        setError("")
    }
    let finish = async () => {
        let next = value.trim()
        if (busy)
            return
        if (!next || next == name)
            return cancel()
        setBusy(true)
        try {
            let message = await onCommit(next) || ""
            setError(message)
            if (!message)
                setEditing(false)
        } catch (reason) {
            setError(errorMessage(reason))
        } finally {
            setBusy(false)
        }
    }
    // The column restores and the lists navigate on these keys too, so the editor keeps them.
    let keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key == "Enter" || event.key == "Escape") {
            event.preventDefault()
            event.stopPropagation()
            if (event.key == "Enter")
                void finish()
            else
                cancel()
        }
    }

    if (editing) {
        return (
            <span className="editable-name editing">
                <input
                    ref={input}
                    className="editable-name-input"
                    aria-label={`New name for ${label}`}
                    value={value}
                    disabled={busy}
                    onChange={event => {
                        setValue(event.currentTarget.value)
                        setError("")
                    }}
                    onKeyDown={keyDown}
                    onBlur={() => {
                        if (busy)
                            return
                        if (saveOnBlur)
                            void finish()
                        else
                            cancel()
                    }}
                />
                {error && <small role="alert">{error}</small>}
            </span>
        )
    }
    // React Aria's Button leaves out `title`, so the hint sits on its wrapper.
    return (
        <span className="editable-name" title={isDisabled ? undefined : "Click or press F2 to rename"}>
            <AriaButton
                className="editable-name-button"
                aria-label={`Rename ${label}`}
                isDisabled={isDisabled}
                onPress={start}
                onKeyDown={event => {
                    if (event.key == "F2") {
                        event.preventDefault()
                        start()
                    } else {
                        event.continuePropagation()
                    }
                }}
            >
                {name}
            </AriaButton>
        </span>
    )
}
