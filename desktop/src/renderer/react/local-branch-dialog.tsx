import { useState } from "react"
import { FormError } from "./form-error"
import type { LocalBranches } from "./local-branches"
import { Button } from "./ui/Button"
import { Checkbox } from "./ui/Checkbox"
import { Dialog, Heading } from "./ui/Dialog"
import { Form } from "./ui/Form"
import { Modal } from "./ui/Modal"
import { TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"

let titles = { "branch-create": "Create branch", "branch-rename": "Rename branch", "branch-delete": "Delete branch" }
let submits = { "branch-create": "Create branch", "branch-rename": "Rename", "branch-delete": "Delete" }

/** Creating, renaming, or deleting a local branch; Escape and Cancel wait while Git runs. */
export function LocalBranchDialog({ branches }: { branches: LocalBranches }) {
    let { dialog: open, busy, error } = useSnapshot(branches)
    // The closing dialog keeps its content while it animates away.
    let [last, setLast] = useState(open)
    if (open && open != last)
        setLast(open)
    let dialog = open ?? last
    let ready = dialog?.action == "branch-delete"
        ? dialog.preview != undefined && (!dialog.preview.uniqueCommits || dialog.confirmed)
        : dialog != undefined && dialog.name.trim() != ""
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
                        {dialog.action == "branch-delete"
                            ? (
                                <>
                                    <p>
                                        Delete{" "}
                                        <strong>{dialog.original}</strong>? Checked-out worktrees stay at the same commit with their Working Changes intact.
                                    </p>
                                    {dialog.preview?.uniqueCommits && (
                                        <Checkbox isSelected={dialog.confirmed} onChange={branches.setConfirmed} isDisabled={busy}>
                                            Delete commits not protected by another branch or tag
                                        </Checkbox>
                                    )}
                                </>
                            )
                            : (
                                <TextField
                                    label="Branch name"
                                    value={dialog.name}
                                    onChange={branches.setName}
                                    isDisabled={busy}
                                    autoComplete="off"
                                    spellCheck="false"
                                    autoFocus
                                />
                            )}
                        <FormError message={error} />
                        <div className="dialog-actions">
                            <Button variant="secondary" isDisabled={busy} onPress={branches.close}>Cancel</Button>
                            <Button type="submit" variant="accent" isDisabled={busy || !ready}>{submits[dialog.action]}</Button>
                        </div>
                    </Form>
                )}
            </Dialog>
        </Modal>
    )
}
