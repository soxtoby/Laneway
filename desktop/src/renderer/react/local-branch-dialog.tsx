import { useState } from "react"
import { FormError } from "./form-error"
import type { LocalBranches } from "./local-branches"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Form } from "./ui/Form"
import { Modal } from "./ui/Modal"
import { TextArea, TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"

let titles = { "branch-create": "Create branch", "branch-rename": "Rename branch", "tag-create": "Create tag" }
let submits = { "branch-create": "Create branch", "branch-rename": "Rename", "tag-create": "Create tag" }

/** Creating or renaming a local branch, or creating a tag; Escape and Cancel wait while Git runs. */
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
                            label={dialog.action == "tag-create" ? "Tag name" : "Branch name"}
                            description={dialog.action == "tag-create" && dialog.remote ? `Also created on ${dialog.remote}.` : undefined}
                            value={dialog.name}
                            onChange={branches.setName}
                            isDisabled={busy}
                            autoComplete="off"
                            spellCheck="false"
                            autoFocus
                        />
                        {dialog.action == "tag-create" && (
                            <TextArea
                                label="Message"
                                description="Optional. A tag with a message is annotated."
                                value={dialog.message}
                                onChange={branches.setMessage}
                                isDisabled={busy}
                            />
                        )}
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
