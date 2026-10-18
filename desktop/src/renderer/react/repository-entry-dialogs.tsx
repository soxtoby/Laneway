import type { FormEvent, ReactNode } from "react"
import { FormError } from "./form-error"
import { type CloneForm, entryErrorMessage, type EntryOperation, type InitializeForm, type RepositoryEntry } from "./repository-entry"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Form } from "./ui/Form"
import { Modal } from "./ui/Modal"
import { ProgressBar } from "./ui/ProgressBar"
import { TextField } from "./ui/TextField"
import { useSnapshot } from "./use-snapshot"
import { EntryOptions } from "./welcome"

/** The Add, Clone, and Initialize dialogs; `busy` covers an Open already under way. */
export function EntryDialogs({ entry, busy }: { entry: RepositoryEntry; busy: boolean }) {
    let { dialog, operation, clone, initialize } = useSnapshot(entry)
    let dismiss = () => void entry.dismiss()
    return (
        <>
            <EntryModal isOpen={dialog == "add"} onDismiss={dismiss}>
                <Heading slot="title">Add repository</Heading>
                <EntryOptions
                    busy={busy || operation != "idle"}
                    onOpen={entry.openRepository}
                    onClone={() => void entry.openClone()}
                    onInitialize={() => void entry.openInitialize()}
                />
                <div className="dialog-actions">
                    <Button variant="secondary" onPress={dismiss}>Cancel</Button>
                </div>
            </EntryModal>
            <EntryModal isOpen={dialog == "clone"} onDismiss={dismiss}>
                <CloneFields entry={entry} clone={clone} operation={operation} />
            </EntryModal>
            <EntryModal isOpen={dialog == "initialize"} onDismiss={dismiss}>
                <InitializeFields entry={entry} initialize={initialize} operation={operation} />
            </EntryModal>
        </>
    )
}

// Escape asks the controller, which keeps the dialog while Git runs.
function EntryModal({ isOpen, onDismiss, children }: { isOpen: boolean; onDismiss(): void; children: ReactNode }) {
    return (
        <Modal isOpen={isOpen} onOpenChange={open => open || onDismiss()}>
            <Dialog className="react-aria-Dialog entry-dialog">{children}</Dialog>
        </Modal>
    )
}

function CloneFields({ entry, clone, operation }: { entry: RepositoryEntry; clone: CloneForm; operation: EntryOperation }) {
    let busy = operation == "cloning" || operation == "cancelling"
    return (
        <Form className="react-aria-Form entry-form" onSubmit={submitWith(entry.submitClone)}>
            <Heading slot="title">Clone repository</Heading>
            <TextField
                label="Git source"
                value={clone.source}
                onChange={source => entry.setClone({ source })}
                placeholder="https://host/team/repository.git"
                isRequired
                isDisabled={busy}
                autoComplete="off"
                spellCheck="false"
                autoFocus
            />
            <div className="field-with-action">
                <TextField
                    label="Parent directory"
                    value={clone.parent}
                    onChange={parent => entry.setClone({ parent })}
                    isRequired
                    isDisabled={busy}
                    autoComplete="off"
                    spellCheck="false"
                />
                <Button variant="secondary" isDisabled={busy} onPress={() => void entry.browseCloneParent()}>Browse</Button>
            </div>
            <TextField
                label="Directory name"
                value={clone.name}
                onChange={name => entry.setClone({ name })}
                placeholder="repository"
                isRequired
                isDisabled={busy}
                autoComplete="off"
                spellCheck="false"
            />
            {clone.progress && <ProgressBar label={clone.progress} isIndeterminate />}
            <FormError message={clone.error && entryErrorMessage(clone.error)} />
            <div className="dialog-actions">
                <Button variant="secondary" isDisabled={operation == "cancelling"} onPress={() => void entry.dismiss()}>
                    {operation == "cancelling" ? "Stopping…" : busy ? "Cancel clone" : "Cancel"}
                </Button>
                <Button type="submit" variant="accent" isDisabled={busy}>Clone and open</Button>
            </div>
        </Form>
    )
}

function InitializeFields({ entry, initialize, operation }: { entry: RepositoryEntry; initialize: InitializeForm; operation: EntryOperation }) {
    let busy = operation == "initializing"
    return (
        <Form className="react-aria-Form entry-form" onSubmit={submitWith(entry.submitInitialize)}>
            <Heading slot="title">Initialize repository</Heading>
            <div className="field-with-action">
                <TextField
                    label="Parent directory"
                    value={initialize.parent}
                    onChange={parent => entry.setInitialize({ parent })}
                    isRequired
                    isDisabled={busy}
                    autoComplete="off"
                    spellCheck="false"
                />
                <Button variant="secondary" isDisabled={busy} onPress={() => void entry.browseInitializeParent()}>Browse</Button>
            </div>
            <TextField
                label="Directory name"
                value={initialize.name}
                onChange={name => entry.setInitialize({ name })}
                isRequired
                isDisabled={busy}
                autoComplete="off"
                spellCheck="false"
                autoFocus
            />
            <TextField
                label="Initial branch"
                description="Optional"
                value={initialize.branch}
                onChange={branch => entry.setInitialize({ branch })}
                placeholder="Use system Git default"
                isDisabled={busy}
                autoComplete="off"
                spellCheck="false"
            />
            <p className="field-note">Existing files stay untouched. Git creates only its repository data.</p>
            <FormError message={initialize.error && entryErrorMessage(initialize.error)} />
            <div className="dialog-actions">
                <Button variant="secondary" isDisabled={busy} onPress={() => void entry.dismiss()}>Cancel</Button>
                <Button type="submit" variant="accent" isDisabled={busy}>Initialize and open</Button>
            </div>
        </Form>
    )
}

function submitWith(submit: () => Promise<void>) {
    return (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        void submit()
    }
}
