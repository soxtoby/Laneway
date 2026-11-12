import { FormError } from "./form-error"
import type { Stashes } from "./stashes"
import { Button } from "./ui/Button"
import { Dialog, Heading } from "./ui/Dialog"
import { Modal } from "./ui/Modal"
import { Select, SelectItem } from "./ui/Select"
import { useSnapshot } from "./use-snapshot"

/** Every stash in the repository, applied to a chosen worktree or dropped. */
export function StashesDialog({ stashes }: { stashes: Stashes }) {
    let { open, preview, chosen, busy, error } = useSnapshot(stashes)
    return (
        <Modal isOpen={open} onOpenChange={isOpen => isOpen || stashes.close()}>
            <Dialog className="react-aria-Dialog stashes-dialog">
                <Heading slot="title">Stashes</Heading>
                {!preview && !error && <p role="status">Reading stashes…</p>}
                {preview && !preview.stashes.length && <p>No stashes.</p>}
                {preview && preview.stashes.length > 0 && (
                    <ul className="stash-list" aria-label="Stashes">
                        {preview.stashes.map(stash => (
                            <li key={stash.objectId} className="stash-entry" data-chosen={chosen?.objectId == stash.objectId || undefined}>
                                <span className="stash-entry-label">
                                    {stash.label}
                                    <small>{stash.branch ?? "Unassigned"}</small>
                                </span>
                                <Button
                                    variant="secondary"
                                    isDisabled={busy}
                                    onPress={() => stashes.choose(stash.objectId)}
                                >
                                    Apply…
                                </Button>
                                <Button variant="quiet" isDisabled={busy} onPress={() => void stashes.drop(stash.objectId)}>Drop</Button>
                            </li>
                        ))}
                    </ul>
                )}
                {chosen && preview && (
                    <Select
                        label="Destination worktree"
                        selectedKey={chosen.destination}
                        onSelectionChange={key => stashes.setDestination(String(key))}
                        isDisabled={busy}
                    >
                        {preview.worktrees.map(worktree => (
                            <SelectItem key={worktree.path} id={worktree.path}>{`${worktree.branch ?? "detached"} · ${worktree.name}`}</SelectItem>
                        ))}
                    </Select>
                )}
                <FormError message={error} />
                <div className="dialog-actions">
                    {chosen && <Button variant="accent" isDisabled={busy} onPress={() => void stashes.apply()}>Apply stash</Button>}
                    <Button variant="secondary" isDisabled={busy} onPress={stashes.close}>Close</Button>
                </div>
            </Dialog>
        </Modal>
    )
}
