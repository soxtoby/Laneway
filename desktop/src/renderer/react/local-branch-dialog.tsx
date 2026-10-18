import { useState } from "react"
import { FormError } from "./form-error"
import type { LocalBranches } from "./local-branches"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Form } from "./ui/Form"
import { Modal } from "./ui/Modal"
import { TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"

let titles = { "branch-create": "Create branch", "branch-rename": "Rename branch" }
let submits = { "branch-create": "Create branch", "branch-rename": "Rename" }

/** Creating or renaming a local branch; Escape and Cancel wait while Git runs. */
export function LocalBranchDialog({ branches }: { branches: LocalBranches }) {
    let { dialog: open, busy, error } = useSnapshot(branches)
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(open)
    if (open && open != last)
        setLast(open)
    let dialog = open ?? last
    return (
        <Modal isOpen={open != undefined} onOpenChange={open => open || branches.close()}>
            <Dialog className="react-aria-Dialog branch-dialog">
                {dialog && (
                    <Form
                        className="react-aria-Form entry-form"
                        onSubmit={event => {
                            event.preventDefault()
                            void branches.submit()
                        }}
                    >
                        <Heading slot="title">{titles[dialog.action]}</Heading>
                        <TextField
                            label="Branch name"
                            value={dialog.name}
                            onChange={branches.setName}
                            isDisabled={busy}
                            autoComplete="off"
                            spellCheck="false"
                            autoFocus
                        />
                        <FormError message={error} />
                        <div className="dialog-actions">
                            <Button variant="secondary" isDisabled={busy} onPress={branches.close}>Cancel</Button>
                            <Button type="submit" variant="accent" isDisabled={busy || dialog.name.trim() == ""}>{submits[dialog.action]}</Button>
                        </div>
                    </Form>
                )}
            </Dialog>
        </Modal>
    )
}
